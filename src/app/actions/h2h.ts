"use server";

// ============================================================
// Head-to-Head — server action
// ============================================================
// Calls the get_h2h_record Postgres RPC for an exact 2v2 pairing.
//
// Array ordering: the caller (useH2H) is responsible for sorting
// both arrays before calling this action. This function passes
// them through unchanged — no double-sort.
// ============================================================

import { createServerSupabaseClient } from "@/utils/supabase/server";
import type { H2HRecord } from "@/types/database";

export async function getH2HRecord(
  teamAIds: string[],
  teamBIds: string[],
  sessionId: string
): Promise<H2HRecord | null> {
  const supabase = await createServerSupabaseClient();

  // Auth gate — match history is not public data
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

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
