"use server";

// ============================================================
// Leaderboard Server Actions
// ============================================================
// Three boards, three different access models. Read this before changing which
// client any of them uses (TENANCY_AUDIT_2026-07-21.md #6, PR2):
//
//   SESSION  — public, no auth. /leaderboard/[sessionId] is the documented
//     share-link contract (same class as /tv and /wrapped): it needs one
//     already-known session UUID and works logged out. Reads run on the SERVICE
//     client because migration 20260722010001 revoked anon/authenticated from
//     get_session_leaderboard_public — the revoke closes the *unscoped* PostgREST
//     dump (any caller could enumerate), not this deliberate per-session surface.
//
//   ALL-TIME — v_alltime_leaderboard_mat is a MATERIALIZED view, so RLS is
//     impossible on it and the GRANT was the entire access control. Once the
//     read moves to the service client that backstop is gone, so the action
//     authorizes in TypeScript instead: a caller must be logged in, and only
//     ever sees clubs they are an active member of. A logged-out caller gets
//     `rows: []`, deliberately — see src/app/leaderboard/page.tsx.
//
//   MONTHLY  — untouched, on the CALLER's client. get_monthly_leaderboard and
//     get_leaderboard_months are invoker-rights over the base tables, so RLS
//     already scopes them correctly (anon gets [] at every join). Moving them to
//     the service role would delete working RLS and replace it with hand-written
//     checks.
//
// getSessionLeaderboard(sessionId)
//   Fetches get_session_leaderboard_public, merges win streaks,
//   assigns ranks with tie-breaker chain, returns enriched rows.
//   Anti-ghost: players with < MIN_SESSION_GP are excluded.
//
// getAllTimeLeaderboard(clubSlug?)
//   Fetches v_alltime_leaderboard_mat, merges win streaks,
//   computes rank movement (current vs. 7 days ago),
//   assigns ranks with tie-breaker chain, returns enriched rows.
//   Anti-ghost: players with < MIN_ALLTIME_GP are excluded.
// ============================================================

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { isValidUUID } from "@/lib/validate";
import { formatMonthLabel } from "@/lib/month";
import { getClubBySlug, getMyActiveClubIds } from "@/lib/clubs";
import type {
  SessionLeaderboardEntry,
  AllTimeLeaderboardEntry,
  MonthlyLeaderboardEntry,
  LeaderboardMonth,
  PlayerStreak,
  LeaderboardRow,
  GetSessionLeaderboardResult,
  GetAllTimeLeaderboardResult,
  GetMonthlyLeaderboardResult,
  GetLeaderboardMonthsResult,
  GetPlayerStatsResult,
} from "@/types/leaderboard";

// ── Constants ─────────────────────────────────────────────────
const MIN_SESSION_GP = 1; // minimum games to appear on session board
const MIN_MONTH_GP = 8; // minimum games to appear on monthly board (one+ session's worth)
const MIN_ALLTIME_GP = 10; // minimum games to appear on all-time board
const RANK_MOVEMENT_DAYS = 7; // compare current rank vs. N days ago
const SESSION_CONFIDENCE_K = 3; // confidence smoothing constant for session ranking
const MONTH_CONFIDENCE_K = 6; // confidence smoothing constant for monthly ranking
const ALLTIME_CONFIDENCE_K = 10; // confidence smoothing constant for all-time ranking

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
function sortLeaderboard<
  T extends {
    win_pct: number;
    games_played: number;
    point_diff: number;
    points_for: number;
    display_name: string;
  },
>(rows: T[], confidenceK: number): T[] {
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
function assignRanks<
  T extends { win_pct: number; games_played: number; point_diff: number; points_for: number },
>(sorted: T[], confidenceK: number): (T & { rank: number })[] {
  let currentRank = 1;
  return sorted.map((row, i) => {
    if (i > 0) {
      const prev = sorted[i - 1];
      const scoreRow = computeConfidenceScore(row.win_pct, row.games_played, confidenceK);
      const scorePrev = computeConfidenceScore(prev.win_pct, prev.games_played, confidenceK);
      const tied =
        Math.abs(scoreRow - scorePrev) <= 0.001 &&
        row.win_pct === prev.win_pct &&
        row.point_diff === prev.point_diff &&
        row.points_for === prev.points_for;
      if (!tied) currentRank = i + 1;
    }
    return { ...row, rank: currentRank };
  });
}

// ── Streak Map Builder ────────────────────────────────────────
function buildStreakMap(streaks: PlayerStreak[]): Map<string, number> {
  return new Map(streaks.map((s) => [s.player_id, s.win_streak]));
}

// ── All-Time Row Merger ───────────────────────────────────────
// v_alltime_leaderboard_mat is keyed (club_id, player_id), so a player active
// in 2+ clubs has one row per club. Both the current board and the
// point-in-time snapshot are summed per player before they are sorted, because
// ranking is POSITIONAL: duplicate rows would list the same player twice and
// shift everyone below them, and in the snapshot half that corrupts every
// rank_movement arrow on the board. Single-club scope — the only shape that
// exists today — makes this a no-op.
function mergeAllTimeEntries(entries: AllTimeLeaderboardEntry[]): AllTimeLeaderboardEntry[] {
  const byPlayer = new Map<string, AllTimeLeaderboardEntry>();
  for (const entry of entries) {
    const prev = byPlayer.get(entry.player_id);
    if (!prev) {
      byPlayer.set(entry.player_id, { ...entry });
      continue;
    }
    prev.games_played += entry.games_played;
    prev.wins += entry.wins;
    prev.losses += entry.losses;
    prev.points_for += entry.points_for;
    prev.points_against += entry.points_against;
    prev.point_diff = prev.points_for - prev.points_against;
    prev.win_pct =
      prev.games_played > 0 ? Math.round((prev.wins / prev.games_played) * 1000) / 10 : 0;
  }
  return [...byPlayer.values()];
}

// ── VIP Map Builder ───────────────────────────────────────────
// Fetches vip_tag + vip_theme from profiles for a list of player IDs.
// Returns a Map<player_id, { vip_tag, vip_theme }>.
//
// Deliberately stays on the CALLER's client even though its only caller now
// reads the board itself with the service client. It does not need the
// escalation (profiles_select is `TO authenticated USING (true)` and the column
// grants cover id/vip_tag/vip_theme), escalating would ADD data for logged-out
// callers — the exact opposite of PR2's goal — and when profiles_select is
// narrowed to shared-club visibility, a caller-client read narrows with it
// while a service-role read would silently keep bypassing the new policy.
// CLAUDE.md restricts the service role to bypassing RLS; there is none to
// bypass here.
async function buildVipMap(
  supabase: Awaited<
    ReturnType<typeof import("@/utils/supabase/server").createServerSupabaseClient>
  >,
  playerIds: string[]
): Promise<Map<string, { vip_tag: string | null; vip_theme: string | null }>> {
  if (playerIds.length === 0) return new Map();
  const { data } = await supabase
    .from("profiles")
    .select("id, vip_tag, vip_theme")
    .in("id", playerIds);
  return new Map(
    (data ?? []).map((p) => [p.id, { vip_tag: p.vip_tag ?? null, vip_theme: p.vip_theme ?? null }])
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
    // Service client, deliberately: 20260722010001 revoked anon/authenticated
    // EXECUTE on both RPCs below to close the unscoped PostgREST dump. This
    // action stays a fully public surface — it is what /leaderboard/[sessionId]
    // renders, and it must keep working logged out — but it is now reachable
    // only with a session UUID the caller already has, instead of by
    // enumerating with the bundled anon key. Nothing else about the action
    // changed.
    const db = createServiceClient();

    // Fetch session stats and streaks in parallel
    const [statsResult, streaksResult] = await Promise.all([
      db
        .rpc("get_session_leaderboard_public", { p_session_id: sessionId })
        .gte("games_played", MIN_SESSION_GP),
      db.rpc("get_player_streaks", { p_session_id: sessionId }),
    ]);

    if (statsResult.error) {
      console.error("[getSessionLeaderboard] stats error:", statsResult.error);
      return { success: false, error: statsResult.error.message };
    }

    // Streak failure is non-fatal — degrade gracefully with empty streak map
    if (streaksResult.error) {
      console.warn(
        "[getSessionLeaderboard] streaks unavailable (non-fatal):",
        streaksResult.error.message
      );
    }

    const rawStats = (statsResult.data ?? []) as SessionLeaderboardEntry[];
    const streakMap = buildStreakMap(
      streaksResult.error ? [] : ((streaksResult.data ?? []) as PlayerStreak[])
    );

    // Sort, assign ranks, merge streaks
    const sorted = sortLeaderboard(rawStats, SESSION_CONFIDENCE_K);
    const ranked = assignRanks(sorted, SESSION_CONFIDENCE_K);

    // VIP fields are folded into get_session_leaderboard_public (2026-07 DB
    // audit) — no separate buildVipMap round trip per board fetch.
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
      vip_tag: entry.vip_tag ?? null,
      vip_theme: entry.vip_theme ?? null,
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
export async function getAllTimeLeaderboard(
  clubSlug?: string | null // when set, scope to that club; omitted = every club the caller belongs to
): Promise<GetAllTimeLeaderboardResult> {
  try {
    const supabase = await createServerSupabaseClient();

    // ── Authorization ────────────────────────────────────────
    // v_alltime_leaderboard_mat is a MATERIALIZED view, so it can never carry
    // RLS: its GRANT *was* the access control until 20260722010001 revoked the
    // browser roles. These checks are what replaces it, and every one of them
    // fails CLOSED — an empty board is the right answer for a caller who is
    // logged out, belongs to no club, or names a club that is not theirs.
    // Previously an unknown clubSlug fell through to the all-clubs board, so a
    // typo returned strictly more data than a correct slug.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { success: true, rows: [] };

    const myClubIds = await getMyActiveClubIds(user.id);
    if (myClubIds.length === 0) return { success: true, rows: [] };

    let scopeClubIds: string[];
    if (clubSlug) {
      const club = await getClubBySlug(clubSlug);
      if (!club || !myClubIds.includes(club.id)) return { success: true, rows: [] };
      scopeClubIds = [club.id];
    } else {
      scopeClubIds = myClubIds;
    }

    const db = createServiceClient();

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RANK_MOVEMENT_DAYS);
    const cutoffISO = cutoff.toISOString();

    // Current: from materialized view (fast, pre-aggregated), scoped to the
    // caller's clubs.
    //
    // MIN_ALLTIME_GP is applied AFTER mergeAllTimeEntries, not as a .gte() here.
    // The matview is keyed (player_id, club_id), so a player in two scoped clubs
    // arrives as two rows; filtering per row would drop someone with 6 + 6 games
    // who qualifies on 12, while the snapshot below — which filters post-merge —
    // would still rank them. That mismatch is not merely a missing row: it
    // shifts previousRankMap out from under everyone beneath them and paints a
    // spurious ▲1 down the rest of the board.
    const currentQuery = db
      .from("v_alltime_leaderboard_mat")
      .select("*")
      .in("club_id", scopeClubIds);

    // Snapshot and streaks are fetched ONCE PER CLUB, never once with
    // p_club_id = null. Both RPCs aggregate across whatever they are given and
    // null means every club in the database, which would fold foreign-club
    // matches into the snapshot that rank_movement is diffed against and into
    // each player's lifetime streak. One club in scope = one call, i.e. exactly
    // what ran before.
    const [currentResult, previousResults, streakResults] = await Promise.all([
      currentQuery,

      // Previous: raw aggregation on v_match_history filtered by date (+ club).
      // We re-aggregate here rather than using the matview because the
      // matview always reflects all history — we need a point-in-time slice.
      Promise.all(
        scopeClubIds.map((id) =>
          db.rpc("get_alltime_snapshot_before", { p_cutoff: cutoffISO, p_club_id: id })
        )
      ),

      // Cross-session streaks (no session filter = lifetime streak)
      Promise.all(
        scopeClubIds.map((id) =>
          db.rpc("get_player_streaks", { p_session_id: null, p_club_id: id })
        )
      ),
    ]);

    if (currentResult.error) {
      console.error("[getAllTimeLeaderboard] current error:", currentResult.error);
      return { success: false, error: currentResult.error.message };
    }

    const streaksError = streakResults.find((r) => r.error)?.error;
    if (streaksError) {
      console.error("[getAllTimeLeaderboard] streaks error:", streaksError);
      return { success: false, error: streaksError.message };
    }

    const currentStats = mergeAllTimeEntries(
      (currentResult.data ?? []) as AllTimeLeaderboardEntry[]
    ).filter((r) => r.games_played >= MIN_ALLTIME_GP);

    // A player in 2+ scoped clubs has one streak row per club; the flame shows
    // their best active streak.
    const streakMap = new Map<string, number>();
    for (const streak of streakResults.flatMap((r) => (r.data ?? []) as PlayerStreak[])) {
      streakMap.set(
        streak.player_id,
        Math.max(streakMap.get(streak.player_id) ?? 0, streak.win_streak)
      );
    }

    // Sort + rank current stats
    const sortedCurrent = sortLeaderboard(currentStats, ALLTIME_CONFIDENCE_K);
    const rankedCurrent = assignRanks(sortedCurrent, ALLTIME_CONFIDENCE_K);

    // Build previous rank map (player_id → rank).
    //
    // The snapshot is advisory — it only drives the Δ column, so unlike the
    // board itself a failure here degrades rather than aborts. It is ALL-OR-
    // NOTHING ACROSS CLUBS on purpose: ranking a partial union would silently
    // compare today's full board against a subset of history and invent
    // movement for every player in the clubs that did answer. An empty map
    // renders ✦ NEW everywhere, which is visibly "no history" rather than
    // plausible-looking wrong arrows.
    const previousRankMap = new Map<string, number>();
    const previousError = previousResults.find((r) => r.error)?.error;
    if (previousError) {
      console.warn(
        "[getAllTimeLeaderboard] snapshot unavailable — rank movement suppressed:",
        previousError.message
      );
    } else {
      const prevStats = mergeAllTimeEntries(
        previousResults.flatMap((r) => (r.data ?? []) as AllTimeLeaderboardEntry[])
      );
      const filteredPrev = prevStats.filter((r) => r.games_played >= MIN_ALLTIME_GP);
      const sortedPrev = sortLeaderboard(filteredPrev, ALLTIME_CONFIDENCE_K);
      const rankedPrev = assignRanks(sortedPrev, ALLTIME_CONFIDENCE_K);
      rankedPrev.forEach((r) => previousRankMap.set(r.player_id, r.rank));
    }

    // Batch-fetch VIP fields for all qualified players
    const vipMap = await buildVipMap(
      supabase,
      rankedCurrent.map((r) => r.player_id)
    );

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
        vip_tag: vipMap.get(entry.player_id)?.vip_tag ?? null,
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
// getMonthlyLeaderboard
// ============================================================
// Live aggregation of one Manila-month slice (via get_monthly_leaderboard RPC),
// reusing the shared confidence-sort + rank + VIP helpers. No streak (O-2:
// the streak RPC isn't month-scoped) and no rank movement (monthly omits Δ).
// Anti-ghost: players with < MIN_MONTH_GP are excluded.
// ============================================================
export async function getMonthlyLeaderboard(
  year: number,
  month: number,
  clubSlug?: string | null
): Promise<GetMonthlyLeaderboardResult> {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return { success: false, error: "Invalid year or month." };
  }
  try {
    const supabase = await createServerSupabaseClient();
    const clubId = clubSlug ? ((await getClubBySlug(clubSlug))?.id ?? null) : null;

    const { data, error } = await supabase.rpc("get_monthly_leaderboard", {
      p_year: year,
      p_month: month,
      p_club_id: clubId,
    });

    if (error) {
      console.error("[getMonthlyLeaderboard] error:", error);
      return { success: false, error: error.message };
    }

    const rawStats = ((data ?? []) as MonthlyLeaderboardEntry[]).filter(
      (r) => r.games_played >= MIN_MONTH_GP
    );

    const sorted = sortLeaderboard(rawStats, MONTH_CONFIDENCE_K);
    const ranked = assignRanks(sorted, MONTH_CONFIDENCE_K);

    // VIP fields folded into get_monthly_leaderboard (2026-07 DB audit).
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
      win_streak: 0, // O-2: monthly omits win-streak
      rank_movement: null, // monthly omits Δ
      vip_tag: entry.vip_tag ?? null,
      vip_theme: entry.vip_theme ?? null,
    }));

    return { success: true, rows };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[getMonthlyLeaderboard] unexpected error:", message);
    return { success: false, error: message };
  }
}

// ============================================================
// getLeaderboardMonths
// ============================================================
// Months selectable in the monthly picker: distinct Manila-months with
// completed matches, plus the current month (always present), newest first.
// ============================================================
export async function getLeaderboardMonths(
  clubSlug?: string | null
): Promise<GetLeaderboardMonthsResult> {
  try {
    const supabase = await createServerSupabaseClient();
    const clubId = clubSlug ? ((await getClubBySlug(clubSlug))?.id ?? null) : null;
    const { data, error } = await supabase.rpc("get_leaderboard_months", { p_club_id: clubId });
    if (error) {
      console.error("[getLeaderboardMonths] error:", error);
      return { success: false, error: error.message };
    }
    const months: LeaderboardMonth[] = ((data ?? []) as { year: number; month: number }[]).map(
      (m) => ({ year: m.year, month: m.month, label: formatMonthLabel(m.year, m.month) })
    );
    return { success: true, months };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[getLeaderboardMonths] unexpected error:", message);
    return { success: false, error: message };
  }
}

// ============================================================
// getPlayerMonthlyStats
// ============================================================
// A single player's monthly stats (incl. below-threshold) for the hero card.
// Additive — does NOT change getPlayerStats's signature. Reuses the monthly RPC
// and finds the player; the month slice is small so this is cheap.
// ============================================================
export async function getPlayerMonthlyStats(
  playerId: string,
  year: number,
  month: number,
  clubSlug?: string | null
): Promise<GetPlayerStatsResult> {
  if (!isValidUUID(playerId)) return { success: false, error: "Invalid player ID." };
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return { success: false, error: "Invalid year or month." };
  }
  try {
    const supabase = await createServerSupabaseClient();
    const clubId = clubSlug ? ((await getClubBySlug(clubSlug))?.id ?? null) : null;
    const { data, error } = await supabase.rpc("get_monthly_leaderboard", {
      p_year: year,
      p_month: month,
      p_club_id: clubId,
    });
    if (error) {
      console.error("[getPlayerMonthlyStats] error:", error);
      return { success: false, error: error.message };
    }
    const entry = ((data ?? []) as MonthlyLeaderboardEntry[]).find((r) => r.player_id === playerId);
    if (!entry) return { success: true, row: null }; // zero games this month

    const row: LeaderboardRow = {
      ...entry,
      rank: 0, // not on ranked board
      win_streak: 0, // not shown in below-threshold state
      rank_movement: null,
      vip_tag: null,
      vip_theme: null,
    };
    return { success: true, row };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[getPlayerMonthlyStats] unexpected error:", message);
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
  sessionId: string | null, // null = all-time scope
  clubSlug?: string | null // scopes the all-time branch; session branch is club-implicit
): Promise<GetPlayerStatsResult> {
  if (!isValidUUID(playerId)) return { success: false, error: "Invalid player ID." };
  if (sessionId !== null && !isValidUUID(sessionId)) {
    return { success: false, error: "Invalid session ID." };
  }
  try {
    // Both branches read objects that 20260722010001 locked to the service
    // role. The session branch keeps the same public contract as
    // getSessionLeaderboard; the all-time branch re-authorizes below, exactly
    // like getAllTimeLeaderboard, because the matview cannot carry RLS.
    const db = createServiceClient();

    if (sessionId) {
      // ── Session scope ────────────────────────────────────────
      const { data, error } = await db
        .rpc("get_session_leaderboard_public", { p_session_id: sessionId })
        .eq("player_id", playerId)
        .maybeSingle();

      if (error) {
        console.error("[getPlayerStats] session error:", error);
        return { success: false, error: error.message };
      }

      if (!data) return { success: true, row: null }; // zero games this session

      const entry = data as SessionLeaderboardEntry;
      const row: LeaderboardRow = {
        player_id: entry.player_id,
        display_name: entry.display_name,
        games_played: entry.games_played,
        wins: entry.wins,
        losses: entry.losses,
        points_for: entry.points_for,
        points_against: entry.points_against,
        point_diff: entry.point_diff,
        win_pct: entry.win_pct,
        rank: 0, // not on ranked board
        win_streak: 0, // not shown in below-threshold state
        rank_movement: null,
        vip_tag: null, // not shown in below-threshold state
        vip_theme: null,
      };

      return { success: true, row };
    } else {
      // ── All-time scope ───────────────────────────────────────
      // Same authorization as getAllTimeLeaderboard, for the same reason: this
      // reads the matview, RLS can never apply to it, and the read now runs as
      // service_role. Every denial returns `row: null`, which the hero card
      // already renders as its zero-games state.
      const supabase = await createServerSupabaseClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return { success: true, row: null };

      const myClubIds = await getMyActiveClubIds(user.id);
      if (myClubIds.length === 0) return { success: true, row: null };

      let scopeClubIds: string[];
      if (clubSlug) {
        const club = await getClubBySlug(clubSlug);
        if (!club || !myClubIds.includes(club.id)) return { success: true, row: null };
        scopeClubIds = [club.id];
      } else {
        scopeClubIds = myClubIds;
      }

      // The matview is keyed (club_id, player_id), so a player active in 2+ of
      // the caller's clubs has one row per club. mergeAllTimeEntries folds them
      // into the single combined row the hero card expects, over the same club
      // scope and with the same summing the board uses.
      //
      // No MIN_ALLTIME_GP filter here, deliberately: the hero card's job is to
      // show a player their own totals whether or not they have qualified, and
      // its below-threshold state (handled by the caller) is what communicates
      // the gap. So a player under the threshold sees a card and no board row —
      // intended — but the NUMBERS on the two always match, because both sides
      // now merge before they compare against MIN_ALLTIME_GP.
      const { data, error } = await db
        .from("v_alltime_leaderboard_mat")
        .select("*")
        .eq("player_id", playerId)
        .in("club_id", scopeClubIds);

      if (error) {
        console.error("[getPlayerStats] alltime error:", error);
        return { success: false, error: error.message };
      }

      const merged = mergeAllTimeEntries((data ?? []) as AllTimeLeaderboardEntry[]);
      if (merged.length === 0) return { success: true, row: null }; // zero all-time games

      const entry = merged[0];
      const row: LeaderboardRow = {
        player_id: entry.player_id,
        display_name: entry.display_name,
        games_played: entry.games_played,
        wins: entry.wins,
        losses: entry.losses,
        points_for: entry.points_for,
        points_against: entry.points_against,
        point_diff: entry.point_diff,
        win_pct: entry.win_pct,
        rank: 0, // not on ranked board
        win_streak: 0, // not shown in below-threshold state
        rank_movement: null,
        vip_tag: null, // not shown in below-threshold state
        vip_theme: null,
      };

      return { success: true, row };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[getPlayerStats] unexpected error:", message);
    return { success: false, error: message };
  }
}
