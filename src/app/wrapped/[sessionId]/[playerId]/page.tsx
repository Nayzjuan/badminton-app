// ============================================================
// Wrapped Page — server component
// ============================================================
// Route: /wrapped/[sessionId]/[playerId]
//
// Fetches the pre-computed stats row for this player from
// session_wrapped_stats, then hands off to the WrappedShell
// client component which orchestrates the intro + award feed.
//
// If no row exists (session not yet closed, or player had 0
// completed matches), shows a graceful loading/empty state.
// ============================================================

import { notFound } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { WrappedShell, type WrappedStats } from "@/components/wrapped/wrapped-shell";

interface WrappedPageProps {
  params: Promise<{ sessionId: string; playerId: string }>;
}

export default async function WrappedPage({ params }: WrappedPageProps) {
  const { sessionId, playerId } = await params;

  const supabase = await createClient();

  // ── Fetch wrapped stats row ─────────────────────────────────
  const { data: statsRow, error: statsError } = await supabase
    .from("session_wrapped_stats")
    .select("*")
    .eq("session_id", sessionId)
    .eq("player_id", playerId)
    .single();

  // ── Fetch player profile (for display name) ─────────────────
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, skill_level")
    .eq("id", playerId)
    .single();

  // If neither exists, the URL is genuinely invalid.
  if (!profile) return notFound();

  // ── Handle no stats row (session not yet computed or 0 games) ─
  // Show a "no stats yet" shell rather than 404.
  if (statsError || !statsRow) {
    const emptyStats: WrappedStats = {
      playerName:    profile.display_name,
      games:         0,
      wins:          0,
      losses:        0,
      pointsFor:     0,
      pointsAgainst: 0,
      pointDiff:     0,
      winPct:        0,
      sessionRank:   null,
      earnedAwards:  [],
      awardData:     {},
    };
    return <WrappedShell stats={emptyStats} sessionId={sessionId} />;
  }

  // ── Build the typed stats object ────────────────────────────
  const stats: WrappedStats = {
    playerName:    profile.display_name,
    games:         statsRow.games_played,
    wins:          statsRow.wins,
    losses:        statsRow.losses,
    pointsFor:     statsRow.points_for,
    pointsAgainst: statsRow.points_against,
    pointDiff:     statsRow.point_diff ?? (statsRow.points_for - statsRow.points_against),
    winPct:        Number(statsRow.win_pct),
    sessionRank:   statsRow.session_rank,
    earnedAwards:  statsRow.earned_awards ?? [],
    awardData:     (statsRow.award_data as Record<string, Record<string, unknown>>) ?? {},
  };

  return <WrappedShell stats={stats} sessionId={sessionId} />;
}
