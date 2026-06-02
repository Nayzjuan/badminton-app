"use server";

// ============================================================
// Head-to-Head — server action
// ============================================================
// Calls the get_h2h_record Postgres RPC for an exact 2v2 pairing.
//
// Auth model:
//   Caller must be authenticated AND a member of the session —
//   either as an organizer or as a player with a queue_entries
//   row for that session. This prevents any authenticated user
//   from probing H2H statistics for arbitrary sessions.
//
// Array ordering: the caller (useH2H) is responsible for sorting
// both arrays before calling this action. This function passes
// them through unchanged — no double-sort.
// ============================================================

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { isSessionOrganizer } from "@/app/actions/_shared";
import type { H2HRecord } from "@/types/database";

export async function getH2HRecord(
  teamAIds: string[],
  teamBIds: string[],
  sessionId: string
): Promise<H2HRecord | null> {
  const supabase = await createServerSupabaseClient();

  // Auth gate — must be logged in.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // Membership gate — must be an organizer OR a player in this session.
  // Using service client for cross-user reads (consistent with other actions
  // that probe session membership via the service role).
  const db = createServiceClient();

  const isOrg = await isSessionOrganizer(user.id, sessionId);
  if (!isOrg) {
    // Fall back: check if the user has any queue entry for this session.
    const { data: queueRow } = await db
      .from("queue_entries")
      .select("id")
      .eq("session_id", sessionId)
      .eq("player_id", user.id)
      .maybeSingle();

    if (!queueRow) return null; // not a member of this session
  }

  const { data, error } = await supabase.rpc("get_h2h_record", {
    p_team_a: teamAIds,
    p_team_b: teamBIds,
    p_session_id: sessionId,
  });

  if (error || !data) return null;

  // The function always returns exactly one row (zeros when no history).
  // totalAllTime === 0 is handled by the component (H2HStrip returns null).
  return data[0] ?? null;
}
