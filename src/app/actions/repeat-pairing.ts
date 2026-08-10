"use server";

// ============================================================
// Repeat-pairing — server actions for the manual-match warning
// ============================================================
// Auth model: ORGANIZER-ONLY. Stricter than getH2HRecord (which allows any
// session member) because the payload keys ARE player UUIDs — the full
// co-play graph for the session. Only organizers build manual matches, so
// there is no reason to expose it more widely.
//
// Reads go through the service client: fetchPartnershipCounts is typed for a
// service-role DbClient and runs with RLS bypassed. It is now this action's
// helper alone — the engine derives its own counts from the per-slot match
// snapshot — and it fails SOFT (empty maps + a warn) so a transient DB error
// blanks the badge rather than erroring the organizer's screen. The JS-level
// organizer gate above is the boundary.
//
// Both actions honour the CLAUDE.md contract: return { success, ... }, never throw.
//
// CRITICAL — status parity: getPairMatches filters on the SAME
// COMMITTED_MATCH_STATUSES set that produced the counts (completed +
// in_progress + pending). Reusing the match-history fetch instead would show
// completed+cancelled, so the expanded list would contradict the count that
// opened it ("partnered 3x" then listing 1 match).
// ============================================================

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { isSessionOrganizer } from "@/app/actions/_shared";
import { fetchPartnershipCounts } from "@/lib/matchmaking-db";
import { COMMITTED_MATCH_STATUSES } from "@/lib/constants";
import { isValidUUID } from "@/lib/validate";

export type PairCountsPayload = {
  /** [pairKey, count] tuples — rehydrated into Maps on the client. */
  partnerships: [string, number][];
  opponents: [string, number][];
};

export type GetSessionPairCountsResult =
  | { success: true; data: PairCountsPayload }
  | { success: false; error: string };

/** Session-scoped same-team and cross-net pair counts for the repeat warning. */
export async function getSessionPairCounts(sessionId: string): Promise<GetSessionPairCountsResult> {
  if (!isValidUUID(sessionId)) return { success: false, error: "Invalid session ID." };

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated." };

  if (!(await isSessionOrganizer(user.id, sessionId))) {
    return { success: false, error: "Not authorized." };
  }

  try {
    const db = createServiceClient();
    const { partnershipCounts, opponentCounts } = await fetchPartnershipCounts(db, sessionId);
    return {
      success: true,
      data: {
        partnerships: Array.from(partnershipCounts.entries()),
        opponents: Array.from(opponentCounts.entries()),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[getSessionPairCounts]", message);
    return { success: false, error: message };
  }
}

export type PairMatchPlayer = { playerId: string; displayName: string; team: string };

export type PairMatch = {
  matchId: string;
  /** 'completed' | 'in_progress' | 'pending' — drives the row's state label. */
  status: string;
  /** completed_at when finished, else created_at, so rows can always be ordered. */
  at: string | null;
  courtName: string | null;
  /** true when the two probed players were on the SAME side in this match. */
  sameTeam: boolean;
  teamAScore: number | null;
  teamBScore: number | null;
  players: PairMatchPlayer[];
};

export type GetPairMatchesResult =
  | { success: true; data: PairMatch[] }
  | { success: false; error: string };

/**
 * The actual matches behind a repeat-pair count — powers the disclosure.
 * Same session + same status set as the counts, so the list length always
 * reconciles with the number the organizer tapped.
 */
export async function getPairMatches(
  sessionId: string,
  playerA: string,
  playerB: string
): Promise<GetPairMatchesResult> {
  if (!isValidUUID(sessionId) || !isValidUUID(playerA) || !isValidUUID(playerB)) {
    return { success: false, error: "Invalid ID." };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not authenticated." };

  if (!(await isSessionOrganizer(user.id, sessionId))) {
    return { success: false, error: "Not authorized." };
  }

  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("matches")
      .select(
        "id, status, completed_at, created_at, team_a_score, team_b_score, " +
          "courts(name), match_players(player_id, team, profiles(display_name))"
      )
      .eq("session_id", sessionId)
      .in("status", COMMITTED_MATCH_STATUSES);

    if (error) return { success: false, error: error.message };

    type Row = {
      id: string;
      status: string;
      completed_at: string | null;
      created_at: string;
      team_a_score: number | null;
      team_b_score: number | null;
      courts: { name: string } | null;
      match_players: {
        player_id: string;
        team: string;
        profiles: { display_name: string } | null;
      }[];
    };

    const rows = (data ?? []) as unknown as Row[];

    const out: PairMatch[] = [];
    for (const m of rows) {
      const roster = m.match_players ?? [];
      const a = roster.find((p) => p.player_id === playerA);
      const b = roster.find((p) => p.player_id === playerB);
      if (!a || !b) continue; // this match didn't contain both players

      out.push({
        matchId: m.id,
        status: m.status,
        at: m.completed_at ?? m.created_at ?? null,
        courtName: m.courts?.name ?? null,
        sameTeam: a.team === b.team,
        teamAScore: m.team_a_score,
        teamBScore: m.team_b_score,
        players: roster.map((p) => ({
          playerId: p.player_id,
          displayName: p.profiles?.display_name ?? "Unknown",
          team: p.team,
        })),
      });
    }

    // Newest first; nulls last.
    out.sort((x, y) => (y.at ?? "").localeCompare(x.at ?? ""));
    return { success: true, data: out };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[getPairMatches]", message);
    return { success: false, error: message };
  }
}
