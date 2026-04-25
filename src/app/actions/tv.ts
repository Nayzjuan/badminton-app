"use server";

// ============================================================
// TV Scoreboard — Server-side data fetcher
// ============================================================
// Uses the service-role client so this works with no user
// session at all — the TV board is fully public/read-only.
// Called from the TV page (server component initial fetch)
// and from the TvBoard client component on real-time events.
// ============================================================

import { createServiceClient } from "@/utils/supabase/service";
import type { SkillLevel } from "@/types/database";

/** Slim session info for the TV header */
export interface TvSession {
  id: string;
  name: string;
  is_active: boolean;
}

/** Flat, enriched match record ready for TV rendering */
export interface TvMatch {
  id: string;
  status: "in_progress" | "pending";
  court_id: string | null;
  court_name: string | null;
  is_mixed_level: boolean;
  created_at: string;
  started_at: string | null;
  players: {
    player_id: string;
    display_name: string;
    skill_level: SkillLevel;
    vip_tag: string | null;
    vip_theme: string | null;
    team: "a" | "b";
  }[];
}

export async function getTvData(sessionId: string): Promise<{
  session: TvSession | null;
  matches: TvMatch[];
}> {
  const supabase = createServiceClient();

  // Fetch session info
  const { data: session } = await supabase
    .from("sessions")
    .select("id, name, is_active")
    .eq("id", sessionId)
    .single();

  if (!session) return { session: null, matches: [] };

  // Fetch active matches (in_progress = on a court, pending = on deck)
  const { data: matches } = await supabase
    .from("matches")
    .select("id, status, court_id, is_mixed_level, created_at, started_at")
    .eq("session_id", sessionId)
    .in("status", ["in_progress", "pending"]);

  if (!matches?.length) return { session, matches: [] };

  const matchIds = matches.map((m) => m.id);

  // Court names
  const courtIds = [
    ...new Set(matches.map((m) => m.court_id).filter(Boolean)),
  ] as string[];
  let courtMap = new Map<string, string>();
  if (courtIds.length) {
    const { data: courts } = await supabase
      .from("courts")
      .select("id, name")
      .in("id", courtIds);
    courtMap = new Map((courts ?? []).map((c) => [c.id, c.name]));
  }

  // Match players
  const { data: matchPlayers } = await supabase
    .from("match_players")
    .select("match_id, player_id, team")
    .in("match_id", matchIds);

  // Player profiles
  const playerIds = [
    ...new Set((matchPlayers ?? []).map((mp) => mp.player_id)),
  ];
  let profileMap = new Map<
    string,
    { display_name: string; skill_level: SkillLevel; vip_tag: string | null; vip_theme: string | null }
  >();
  if (playerIds.length) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, display_name, skill_level, vip_tag, vip_theme")
      .in("id", playerIds);
    profileMap = new Map(
      (profiles ?? []).map((p) => [
        p.id,
        {
          display_name: p.display_name,
          skill_level: p.skill_level as SkillLevel,
          vip_tag: p.vip_tag ?? null,
          vip_theme: p.vip_theme ?? null,
        },
      ])
    );
  }

  const enriched: TvMatch[] = matches.map((match) => ({
    id: match.id,
    status: match.status as "in_progress" | "pending",
    court_id: match.court_id,
    court_name: match.court_id ? (courtMap.get(match.court_id) ?? null) : null,
    is_mixed_level: match.is_mixed_level,
    created_at: match.created_at,
    started_at: match.started_at ?? null,
    players: (matchPlayers ?? [])
      .filter((mp) => mp.match_id === match.id)
      .map((mp) => ({
        player_id: mp.player_id,
        display_name:
          profileMap.get(mp.player_id)?.display_name ?? "Unknown",
        skill_level:
          profileMap.get(mp.player_id)?.skill_level ?? "beginner",
        vip_tag: profileMap.get(mp.player_id)?.vip_tag ?? null,
        vip_theme: profileMap.get(mp.player_id)?.vip_theme ?? null,
        team: mp.team as "a" | "b",
      })),
  }));

  return { session, matches: enriched };
}
