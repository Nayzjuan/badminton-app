"use server";

// ============================================================
// Leaderboard Server Actions
// ============================================================
// Public read — no auth required (mirrors /tv/[sessionId]).
//
// getSessionLeaderboard(sessionId)
//   Fetches v_session_leaderboard, merges win streaks,
//   assigns ranks with tie-breaker chain, returns enriched rows.
//   Anti-ghost: players with < MIN_SESSION_GP are excluded.
//
// getAllTimeLeaderboard()
//   Fetches v_alltime_leaderboard_mat, merges win streaks,
//   computes rank movement (current vs. 7 days ago),
//   assigns ranks with tie-breaker chain, returns enriched rows.
//   Anti-ghost: players with < MIN_ALLTIME_GP are excluded.
// ============================================================

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { isValidUUID } from "@/lib/validate";
import type {
  SessionLeaderboardEntry,
  AllTimeLeaderboardEntry,
  PlayerStreak,
  LeaderboardRow,
  GetSessionLeaderboardResult,
  GetAllTimeLeaderboardResult,
  GetPlayerStatsResult,
} from "@/types/leaderboard";

// ── Constants ─────────────────────────────────────────────────
const MIN_SESSION_GP = 1;          // minimum games to appear on session board
const MIN_ALLTIME_GP = 10;         // minimum games to appear on all-time board
const RANK_MOVEMENT_DAYS = 7;      // compare current rank vs. N days ago
const SESSION_CONFIDENCE_K = 3;    // confidence smoothing constant for session ranking
const ALLTIME_CONFIDENCE_K = 10;   // confidence smoothing constant for all-time ranking

// ── Confidence-Weighted Score ─────────────────────────────────
// Adjusts raw win% to reward playing more games.
// Formula: win% × GP / (GP + k)
//   - A player with 100% win rate across 3 GP (k=3) scores 50.0
//   - A player with  80% win rate across 10 GP (k=3) scores 61.5
// This prevents a player who played the minimum games and won all of
// them from outranking a veteran with a strong long-term record.
function computeConfidenceScore(win_pct: number, games_played: number, k: number): number {
  return (win_pct * games_played) / (games_played + k);
}

// ── Tie-Breaker Sort ─────────────────────────────────────────
// Primary: confidence-weighted win rate DESC
// Then:    raw win% DESC → point diff DESC → points for DESC → name ASC
function sortLeaderboard<T extends { win_pct: number; games_played: number; point_diff: number; points_for: number; display_name: string }>(
  rows: T[],
  confidenceK: number
): T[] {
  return [...rows].sort((a, b) => {
    const scoreA = computeConfidenceScore(a.win_pct, a.games_played, confidenceK);
    const scoreB = computeConfidenceScore(b.win_pct, b.games_played, confidenceK);
    if (Math.abs(scoreB - scoreA) > 0.001) return scoreB - scoreA;
    if (b.win_pct !== a.win_pct) return b.win_pct - a.win_pct;
    if (b.point_diff !== a.point_diff) return b.point_diff - a.point_diff;
    if (b.points_for !== a.points_for) return b.points_for - a.points_for;
    return a.display_name.localeCompare(b.display_name);
  });
}

// ── Rank Assignment ───────────────────────────────────────────
// Assigns 1-based ranks using standard (competition) ranking:
// two players tied at position 1 both receive rank 1, and the
// next distinct player receives rank 3 — not rank 2 (dense).
function assignRanks<T extends { win_pct: number; games_played: number; point_diff: number; points_for: number }>(
  sorted: T[],
  confidenceK: number
): (T & { rank: number })[] {
  let currentRank = 1;
  return sorted.map((row, i) => {
    if (i > 0) {
      const prev = sorted[i - 1];
      const scoreRow  = computeConfidenceScore(row.win_pct,  row.games_played,  confidenceK);
      const scorePrev = computeConfidenceScore(prev.win_pct, prev.games_played, confidenceK);
      const tied =
        Math.abs(scoreRow - scorePrev) <= 0.001 &&
        row.win_pct     === prev.win_pct &&
        row.point_diff  === prev.point_diff &&
        row.points_for  === prev.points_for;
      if (!tied) currentRank = i + 1;
    }
    return { ...row, rank: currentRank };
  });
}

// ── Streak Map Builder ────────────────────────────────────────
function buildStreakMap(streaks: PlayerStreak[]): Map<string, number> {
  return new Map(streaks.map((s) => [s.player_id, s.win_streak]));
}

// ── VIP Map Builder ───────────────────────────────────────────
// Fetches vip_tag + vip_theme from profiles for a list of player IDs.
// Returns a Map<player_id, { vip_tag, vip_theme }>.
async function buildVipMap(
  supabase: Awaited<ReturnType<typeof import("@/utils/supabase/server").createServerSupabaseClient>>,
  playerIds: string[]
): Promise<Map<string, { vip_tag: string | null; vip_theme: string | null }>> {
  if (playerIds.length === 0) return new Map();
  const { data } = await supabase
    .from("profiles")
    .select("id, vip_tag, vip_theme")
    .in("id", playerIds);
  return new Map(
    (data ?? []).map((p) => [
      p.id,
      { vip_tag: p.vip_tag ?? null, vip_theme: p.vip_theme ?? null },
    ])
  );
}

// ============================================================
// getSessionLeaderboard
// ============================================================
export async function getSessionLeaderboard(
  sessionId: string
): Promise<GetSessionLeaderboardResult> {
  if (!isValidUUID(sessionId)) return { success: false, error: "Invalid session ID." };
  try {
    const supabase = await createServerSupabaseClient();

    // Fetch session stats and streaks in parallel
    const [statsResult, streaksResult] = await Promise.all([
      supabase
        .from("v_session_leaderboard")
        .select("*")
        .eq("session_id", sessionId)
        .gte("games_played", MIN_SESSION_GP),
      supabase.rpc("get_player_streaks", { p_session_id: sessionId }),
    ]);

    if (statsResult.error) {
      console.error("[getSessionLeaderboard] stats error:", statsResult.error);
      return { success: false, error: statsResult.error.message };
    }

    // Streak failure is non-fatal — degrade gracefully with empty streak map
    if (streaksResult.error) {
      console.warn("[getSessionLeaderboard] streaks unavailable (non-fatal):", streaksResult.error.message);
    }

    const rawStats = (statsResult.data ?? []) as SessionLeaderboardEntry[];
    const streakMap = buildStreakMap(
      streaksResult.error ? [] : ((streaksResult.data ?? []) as PlayerStreak[])
    );

    // Sort, assign ranks, merge streaks
    const sorted = sortLeaderboard(rawStats, SESSION_CONFIDENCE_K);
    const ranked = assignRanks(sorted, SESSION_CONFIDENCE_K);

    // Batch-fetch VIP fields for all qualified players
    const vipMap = await buildVipMap(supabase, ranked.map((r) => r.player_id));

    const rows: LeaderboardRow[] = ranked.map((entry) => ({
      player_id: entry.player_id,
      display_name: entry.display_name,
      games_played: entry.games_played,
      wins: entry.wins,
      losses: entry.losses,
      points_for: entry.points_for,
      points_against: entry.points_against,
      point_diff: entry.point_diff,
      win_pct: entry.win_pct,
      rank: entry.rank,
      win_streak: streakMap.get(entry.player_id) ?? 0,
      rank_movement: null, // session tab never shows rank movement
      vip_tag:   vipMap.get(entry.player_id)?.vip_tag   ?? null,
      vip_theme: vipMap.get(entry.player_id)?.vip_theme ?? null,
    }));

    return { success: true, rows };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[getSessionLeaderboard] unexpected error:", message);
    return { success: false, error: message };
  }
}

// ============================================================
// getAllTimeLeaderboard
// ============================================================
// Rank movement strategy (no snapshot table):
//   1. Fetch current all-time stats from materialized view.
//   2. Fetch "previous" stats: same aggregation but restricted
//      to matches completed > RANK_MOVEMENT_DAYS days ago.
//   3. Sort + rank both sets independently with the same
//      tie-breaker chain.
//   4. For each player: delta = previous_rank - current_rank.
//      Positive = moved up. Negative = moved down.
//      null = new entrant (not present in previous snapshot).
// ============================================================
export async function getAllTimeLeaderboard(): Promise<GetAllTimeLeaderboardResult> {
  try {
    const supabase = await createServerSupabaseClient();

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RANK_MOVEMENT_DAYS);
    const cutoffISO = cutoff.toISOString();

    // Fetch current mat-view, previous stats, and streaks in parallel
    const [currentResult, previousResult, streaksResult] = await Promise.all([
      // Current: from materialized view (fast, pre-aggregated)
      supabase
        .from("v_alltime_leaderboard_mat")
        .select("*")
        .gte("games_played", MIN_ALLTIME_GP),

      // Previous: raw aggregation on v_match_history filtered by date
      // We re-aggregate here rather than using the matview because the
      // matview always reflects all history — we need a point-in-time slice.
      supabase.rpc("get_alltime_snapshot_before", { p_cutoff: cutoffISO }),

      // Cross-session streaks (no session filter = lifetime streak)
      supabase.rpc("get_player_streaks", { p_session_id: null }),
    ]);

    if (currentResult.error) {
      console.error("[getAllTimeLeaderboard] current error:", currentResult.error);
      return { success: false, error: currentResult.error.message };
    }

    if (streaksResult.error) {
      console.error("[getAllTimeLeaderboard] streaks error:", streaksResult.error);
      return { success: false, error: streaksResult.error.message };
    }

    const currentStats = (currentResult.data ?? []) as AllTimeLeaderboardEntry[];
    const streakMap = buildStreakMap((streaksResult.data ?? []) as PlayerStreak[]);

    // Sort + rank current stats
    const sortedCurrent = sortLeaderboard(currentStats, ALLTIME_CONFIDENCE_K);
    const rankedCurrent = assignRanks(sortedCurrent, ALLTIME_CONFIDENCE_K);

    // Build previous rank map (player_id → rank)
    const previousRankMap = new Map<string, number>();
    if (!previousResult.error && previousResult.data) {
      const prevStats = previousResult.data as AllTimeLeaderboardEntry[];
      const filteredPrev = prevStats.filter((r) => r.games_played >= MIN_ALLTIME_GP);
      const sortedPrev = sortLeaderboard(filteredPrev, ALLTIME_CONFIDENCE_K);
      const rankedPrev = assignRanks(sortedPrev, ALLTIME_CONFIDENCE_K);
      rankedPrev.forEach((r) => previousRankMap.set(r.player_id, r.rank));
    }

    // Batch-fetch VIP fields for all qualified players
    const vipMap = await buildVipMap(supabase, rankedCurrent.map((r) => r.player_id));

    // Assemble final rows with rank movement + VIP fields
    const rows: LeaderboardRow[] = rankedCurrent.map((entry) => {
      const previousRank = previousRankMap.get(entry.player_id);
      const rank_movement: number | null =
        previousRank === undefined
          ? null // new entrant — show ✦ NEW
          : previousRank - entry.rank; // positive = moved up

      return {
        player_id: entry.player_id,
        display_name: entry.display_name,
        games_played: entry.games_played,
        wins: entry.wins,
        losses: entry.losses,
        points_for: entry.points_for,
        points_against: entry.points_against,
        point_diff: entry.point_diff,
        win_pct: entry.win_pct,
        rank: entry.rank,
        win_streak: streakMap.get(entry.player_id) ?? 0,
        rank_movement,
        vip_tag:   vipMap.get(entry.player_id)?.vip_tag   ?? null,
        vip_theme: vipMap.get(entry.player_id)?.vip_theme ?? null,
      };
    });

    return { success: true, rows };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[getAllTimeLeaderboard] unexpected error:", message);
    return { success: false, error: message };
  }
}

// ============================================================
// getPlayerStats
// ============================================================
// Fetches a single player's raw stats regardless of the MIN_GP
// threshold. Used exclusively by LeaderboardHeroCard to show
// below-threshold and zero-games states for the logged-in user.
//
// Design notes:
//   • rank is set to 0 — the player is not on the ranked board.
//   • win_streak is set to 0 — the hero card only shows streak
//     in the qualified state, where the main board's myRow (which
//     already carries the real streak) takes precedence.
//   • vip_tag/vip_theme are set to null for the same reason —
//     VIP badges are only rendered in the qualified state.
//   • maybeSingle() → null means the player has zero games in
//     this scope, so the hero card shows its zero-games state.
// ============================================================
export async function getPlayerStats(
  playerId: string,
  sessionId: string | null   // null = all-time scope
): Promise<GetPlayerStatsResult> {
  if (!isValidUUID(playerId)) return { success: false, error: "Invalid player ID." };
  if (sessionId !== null && !isValidUUID(sessionId)) {
    return { success: false, error: "Invalid session ID." };
  }
  try {
    const supabase = await createServerSupabaseClient();

    if (sessionId) {
      // ── Session scope ────────────────────────────────────────
      const { data, error } = await supabase
        .from("v_session_leaderboard")
        .select("*")
        .eq("session_id", sessionId)
        .eq("player_id", playerId)
        .maybeSingle();

      if (error) {
        console.error("[getPlayerStats] session error:", error);
        return { success: false, error: error.message };
      }

      if (!data) return { success: true, row: null }; // zero games this session

      const entry = data as SessionLeaderboardEntry;
      const row: LeaderboardRow = {
        player_id:      entry.player_id,
        display_name:   entry.display_name,
        games_played:   entry.games_played,
        wins:           entry.wins,
        losses:         entry.losses,
        points_for:     entry.points_for,
        points_against: entry.points_against,
        point_diff:     entry.point_diff,
        win_pct:        entry.win_pct,
        rank:           0,    // not on ranked board
        win_streak:     0,    // not shown in below-threshold state
        rank_movement:  null,
        vip_tag:        null, // not shown in below-threshold state
        vip_theme:      null,
      };

      return { success: true, row };
    } else {
      // ── All-time scope ───────────────────────────────────────
      const { data, error } = await supabase
        .from("v_alltime_leaderboard_mat")
        .select("*")
        .eq("player_id", playerId)
        .maybeSingle();

      if (error) {
        console.error("[getPlayerStats] alltime error:", error);
        return { success: false, error: error.message };
      }

      if (!data) return { success: true, row: null }; // zero all-time games

      const entry = data as AllTimeLeaderboardEntry;
      const row: LeaderboardRow = {
        player_id:      entry.player_id,
        display_name:   entry.display_name,
        games_played:   entry.games_played,
        wins:           entry.wins,
        losses:         entry.losses,
        points_for:     entry.points_for,
        points_against: entry.points_against,
        point_diff:     entry.point_diff,
        win_pct:        entry.win_pct,
        rank:           0,    // not on ranked board
        win_streak:     0,    // not shown in below-threshold state
        rank_movement:  null,
        vip_tag:        null, // not shown in below-threshold state
        vip_theme:      null,
      };

      return { success: true, row };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[getPlayerStats] unexpected error:", message);
    return { success: false, error: message };
  }
}
