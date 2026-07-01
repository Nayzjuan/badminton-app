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
import type { MatchHistory } from "@/types/database";

// ── Session metadata subset used in AllSessionsHistory ────────

export type SessionMeta = {
  id: string;
  name: string | null;
  created_at: string;
  ended_at: string | null;
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

  let query = supabase
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

  const { data: matches, error: matchError } = await supabase
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
    .select("id, name, created_at, ended_at")
    .in("id", sessionIds);

  return {
    success: true,
    matches,
    sessions: (sessions ?? []) as SessionMeta[],
  };
}
