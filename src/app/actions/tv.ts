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
import { isValidUUID } from "@/lib/validate";
import type { SkillLevel } from "@/types/database";

/** Slim session info for the TV header */
export interface TvSession {
  id: string;
  name: string;
  is_active: boolean;
  club_id: string | null; // owning club — used by the club-namespaced TV route's cross-check
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
  if (!isValidUUID(sessionId)) return { session: null, matches: [] };
  const supabase = createServiceClient();

  // Was 5 sequential round trips (session → matches → courts → match_players →
  // profiles). Now 2 parallel: session + one embedded matches query. Draft-mode
  // firewall filter is preserved verbatim on the top-level matches select.
  type TvMatchRow = {
    id: string;
    status: string;
    court_id: string | null;
    is_mixed_level: boolean;
    created_at: string;
    started_at: string | null;
    courts: { name: string } | null;
    match_players: {
      player_id: string;
      team: string;
      profiles: {
        display_name: string;
        skill_level: string;
        vip_tag: string | null;
        vip_theme: string | null;
      } | null;
    }[];
  };

  const [sessionRes, matchesRes] = await Promise.all([
    supabase.from("sessions").select("id, name, is_active, club_id").eq("id", sessionId).single(),
    supabase
      .from("matches")
      .select(
        "id, status, court_id, is_mixed_level, created_at, started_at, courts(name), match_players(player_id, team, profiles(display_name, skill_level, vip_tag, vip_theme))"
      )
      .eq("session_id", sessionId)
      .or("status.eq.in_progress,and(status.eq.pending,is_published.eq.true)"),
  ]);

  const session = sessionRes.data;
  if (!session) return { session: null, matches: [] };

  const rows = (matchesRes.data ?? []) as unknown as TvMatchRow[];

  const enriched: TvMatch[] = rows.map((match) => ({
    id: match.id,
    status: match.status as "in_progress" | "pending",
    court_id: match.court_id,
    court_name: match.courts?.name ?? null,
    is_mixed_level: match.is_mixed_level,
    created_at: match.created_at,
    started_at: match.started_at ?? null,
    players: (match.match_players ?? []).map((mp) => ({
      player_id: mp.player_id,
      display_name: mp.profiles?.display_name ?? "Unknown",
      skill_level: (mp.profiles?.skill_level ?? "beginner") as SkillLevel,
      vip_tag: mp.profiles?.vip_tag ?? null,
      vip_theme: mp.profiles?.vip_theme ?? null,
      team: mp.team as "a" | "b",
    })),
  }));

  return { session, matches: enriched };
}
