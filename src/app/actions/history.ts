"use server";

// ============================================================
// History Server Actions
// ============================================================
// Data-fetching server actions for player match history views.
// Using server actions instead of direct browser client queries:
//   - Auth is verified server-side (no RLS exposure in client)
//   - Responses can be cached by Next.js
//   - No Supabase URL or anon key required in client bundle
// ============================================================

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import type { MatchHistory } from "@/types/database";

// ── Session metadata subset used in AllSessionsHistory ────────

export type SessionMeta = {
  id: string;
  name: string | null;
  created_at: string;
  ended_at: string | null;
  club_id: string | null;
  /** Null when the club row can't be resolved (defensive — clubs has no RLS
   *  policies, so this is always looked up via the service-role client). */
  club_name: string | null;
};

export type MatchHistoryResult = {
  success: true;
  matches: MatchHistory[];
};

export type MatchHistoryError = {
  success: false;
  error: string;
};

// ── getMatchHistory ───────────────────────────────────────────

/**
 * Fetch completed match history for a player.
 *
 * Scoped to a specific session when `sessionId` is provided;
 * returns all-time history when omitted. Results are ordered
 * newest-first. Caller must be authenticated.
 */
export async function getMatchHistory(
  playerId: string,
  sessionId?: string,
  limit?: number
): Promise<MatchHistoryResult | MatchHistoryError> {
  const supabase = await createServerSupabaseClient();

  // Auth gate — history is not public data.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated." };

  // Ownership gate — club-scoped RLS on matches/match_players (see
  // 20260701000008_club_scoped_rls.sql) only restricts by club membership,
  // not by specific player identity, so a fellow club member could otherwise
  // pass someone else's id and read their history. This is the check that
  // stops that.
  if (playerId !== user.id) return { success: false, error: "Not authorized." };

  // v_match_history has no direct anon/authenticated grant (hardened in
  // 20260702000003_harden_security_definer_views.sql to close a cross-club
  // unfiltered-dump vector) — service role is required here. Safe because
  // the ownership gate above already restricts results to the caller's own id.
  const db = createServiceClient();
  let query = db
    .from("v_match_history")
    .select("*")
    .eq("player_id", playerId)
    .order("completed_at", { ascending: false });

  if (sessionId) query = query.eq("session_id", sessionId);
  if (limit) query = query.limit(limit);

  const { data, error } = await query;

  if (error) return { success: false, error: "Failed to load match history." };
  return { success: true, matches: data ?? [] };
}

// ── getAllSessionsHistory ─────────────────────────────────────

export type AllSessionsHistoryResult = {
  success: true;
  matches: MatchHistory[];
  sessions: SessionMeta[];
};

/**
 * Fetch all completed matches for a player across every session,
 * plus the session metadata needed to group and label them.
 * Two queries total: v_match_history then sessions.
 */
export async function getAllSessionsHistory(
  playerId: string
): Promise<AllSessionsHistoryResult | MatchHistoryError> {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated." };

  // Ownership gate — see getMatchHistory above: club-scoped RLS on
  // matches/match_players restricts by club membership, not by specific
  // player identity, so without this check a fellow club member could pass
  // another player's id and read their full cross-club history.
  if (playerId !== user.id) return { success: false, error: "Not authorized." };

  // v_match_history has no direct anon/authenticated grant (hardened in
  // 20260702000003_harden_security_definer_views.sql to close a cross-club
  // unfiltered-dump vector) — service role is required here. Safe because
  // the ownership gate above already restricts results to the caller's own id.
  const db = createServiceClient();
  const { data: matches, error: matchError } = await db
    .from("v_match_history")
    .select("*")
    .eq("player_id", playerId)
    .order("completed_at", { ascending: false });

  if (matchError) return { success: false, error: "Failed to load match history." };
  if (!matches || matches.length === 0) return { success: true, matches: [], sessions: [] };

  // Collect unique session IDs in newest-first order.
  const sessionIds: string[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    if (!seen.has(m.session_id)) {
      seen.add(m.session_id);
      sessionIds.push(m.session_id);
    }
  }

  const { data: sessions } = await supabase
    .from("sessions")
    .select("id, name, created_at, ended_at, club_id")
    .in("id", sessionIds);

  // Club names — sessions RLS lets a member read their own club's sessions,
  // but `clubs` itself has no RLS policies (deny-all to anon/authenticated;
  // see src/lib/clubs.ts), so this lookup goes through the service role.
  // Session ownership was already established above via the sessions query.
  const clubIds = Array.from(new Set((sessions ?? []).map((s) => s.club_id).filter(Boolean)));
  let clubNameById = new Map<string, string>();
  if (clubIds.length > 0) {
    const { data: clubs } = await db.from("clubs").select("id, name").in("id", clubIds);
    clubNameById = new Map((clubs ?? []).map((c) => [c.id, c.name]));
  }

  const sessionMetas: SessionMeta[] = (sessions ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    created_at: s.created_at,
    ended_at: s.ended_at,
    club_id: s.club_id,
    club_name: s.club_id ? (clubNameById.get(s.club_id) ?? null) : null,
  }));

  return {
    success: true,
    matches,
    sessions: sessionMetas,
  };
}
