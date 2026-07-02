"use server";

// ============================================================
// Wrapped — Server Actions
// ============================================================
// dismissWrappedIntro  — marks the intro overlay as seen for
//                        this (session, player) pair by setting
//                        intro_dismissed_at = now().
//
// This is called when the player clicks the "Done" button on
// the awards page.  Once set, the play-page redirect and the
// wrapped page server component both skip the intro on
// subsequent page loads — across all devices.
//
// getWrappedData — shared data-fetcher for both the root
//                  (/wrapped/[sessionId]/[playerId]) and the
//                  club-namespaced (/c/[clubSlug]/wrapped/...)
//                  pages. Mirrors getTvData (actions/tv.ts):
//                  always uses the service-role client, since
//                  Wrapped is a public, shareable recap — the
//                  viewer may not be authenticated as this
//                  player at all.
// ============================================================

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { isValidUUID } from "@/lib/validate";
import type { MatchHistory } from "@/types/database";
import type { WrappedStats } from "@/components/wrapped/wrapped-shell";

// ── dismissWrappedIntro ───────────────────────────────────────

export interface DismissWrappedIntroResult {
  success: boolean;
  error?: string;
}

/**
 * Stamps intro_dismissed_at = now() on the session_wrapped_stats
 * row for the given (sessionId, playerId).
 *
 * Idempotent — safe to call multiple times.  If no stats row
 * exists yet (rare race on session close), does nothing and
 * returns success so the UI still navigates away cleanly.
 */
export async function dismissWrappedIntro(
  sessionId: string,
  playerId: string
): Promise<DismissWrappedIntroResult> {
  if (!isValidUUID(sessionId) || !isValidUUID(playerId)) {
    return { success: false, error: "Invalid session or player ID." };
  }
  const supabase = await createServerSupabaseClient();

  const { error } = await supabase
    .from("session_wrapped_stats")
    .update({ intro_dismissed_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .eq("player_id", playerId)
    .is("intro_dismissed_at", null); // no-op if already dismissed

  if (error) {
    console.error("[dismissWrappedIntro] Supabase error:", error.message);
    return { success: false, error: error.message };
  }

  return { success: true };
}

// ── getWrappedData ────────────────────────────────────────────

export interface WrappedData {
  /** Owning club of the session — null when the session row can't be
   *  resolved. Used by the club-namespaced page's session↔club cross-check
   *  (mirrors the TV board's `session.club_id !== club.id` 404 guard). */
  sessionClubId: string | null;
  profile: { display_name: string } | null;
  stats: WrappedStats;
  matchHistory: MatchHistory[];
  introDismissed: boolean;
}

const EMPTY_STATS: WrappedStats = {
  playerName: "",
  games: 0,
  wins: 0,
  losses: 0,
  pointsFor: 0,
  pointsAgainst: 0,
  pointDiff: 0,
  winPct: 0,
  sessionRank: null,
  earnedAwards: [],
  awardData: {},
};

/**
 * Fetches everything the Wrapped page needs to render: the session's owning
 * club (for the club-scoped page's cross-check), the player's stats row (or
 * a graceful "no stats yet" fallback when the session hasn't been computed
 * or the player had 0 completed matches), their display name, and their
 * match history for this session.
 */
export async function getWrappedData(sessionId: string, playerId: string): Promise<WrappedData> {
  if (!isValidUUID(sessionId) || !isValidUUID(playerId)) {
    return {
      sessionClubId: null,
      profile: null,
      stats: EMPTY_STATS,
      matchHistory: [],
      introDismissed: false,
    };
  }

  const service = createServiceClient();

  const [{ data: session }, { data: statsRow }, { data: profile }, { data: matchHistory }] =
    await Promise.all([
      service.from("sessions").select("club_id").eq("id", sessionId).maybeSingle(),
      service
        .from("session_wrapped_stats")
        .select("*")
        .eq("session_id", sessionId)
        .eq("player_id", playerId)
        .maybeSingle(),
      service.from("profiles").select("display_name, skill_level").eq("id", playerId).maybeSingle(),
      service
        .from("v_match_history")
        .select("*")
        .eq("session_id", sessionId)
        .eq("player_id", playerId)
        .order("completed_at", { ascending: false }),
    ]);

  const sessionClubId = session?.club_id ?? null;

  if (!profile) {
    return {
      sessionClubId,
      profile: null,
      stats: EMPTY_STATS,
      matchHistory: [],
      introDismissed: false,
    };
  }

  const stats: WrappedStats = statsRow
    ? {
        playerName: profile.display_name,
        games: statsRow.games_played,
        wins: statsRow.wins,
        losses: statsRow.losses,
        pointsFor: statsRow.points_for,
        pointsAgainst: statsRow.points_against,
        pointDiff: statsRow.point_diff ?? statsRow.points_for - statsRow.points_against,
        winPct: Number(statsRow.win_pct),
        sessionRank: statsRow.session_rank,
        earnedAwards: statsRow.earned_awards ?? [],
        awardData: (statsRow.award_data as Record<string, Record<string, unknown>>) ?? {},
      }
    : { ...EMPTY_STATS, playerName: profile.display_name };

  return {
    sessionClubId,
    profile: { display_name: profile.display_name },
    stats,
    matchHistory: matchHistory ?? [],
    introDismissed: !!statsRow?.intro_dismissed_at,
  };
}
