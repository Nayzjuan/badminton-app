"use server";

// ============================================================
// Queue Server Actions
// ============================================================
// joinQueueAction applies Inherited Games logic so late-joining
// players cannot jump to position #1 in the queue.
//
// ── Inherited Games ────────────────────────────────────────
// The queue sorts by (games_played ASC, joined_at ASC).
// A player who joins with games_played=0 while everyone else
// has played 3+ games lands at #1 — completely unfair.
//
// Fix: before inserting OR re-activating a row, query the
// session floor (MIN games_played across active players).
// The player's games_played is set to MAX(their_current, floor).
//
// ── Both branches must apply the floor ─────────────────────
// BUG that was causing line-jumping:
//   The floor query was ONLY run for first-time joiners.
//   Returning players (row exists with status="left") went
//   through a fast-path that kept their old games_played — often 0.
//   A player who joined at the start, never played, left, and
//   re-joined hours later would land at #1.
//
// Fix: compute the floor in BOTH branches, then take the max.
//
// ── Edge cases ──────────────────────────────────────────────
// • Empty session → floor = 0, player starts at 0 ✓
// • Everyone at 0 → floor = 0, correct ✓
// • Floor query fails → log + fall back to 0 (non-blocking) ✓
// • Player already on_deck/playing → allowed by DB; UI prevents
// ============================================================

import { createClient } from "@/utils/supabase/server";
import { generateOnDeckMatchesAction } from "@/app/actions/matchmaking";

export interface JoinQueueResult {
  error?: string;
}

export async function joinQueueAction(sessionId: string): Promise<JoinQueueResult> {
  const supabase = await createClient();

  // Resolve caller identity server-side — client cannot spoof player_id.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: "Not authenticated. Please refresh and try again." };
  }

  const playerId = user.id;

  console.log(`[joinQueueAction] player=${playerId} session=${sessionId}`);

  // ----------------------------------------------------------
  // STEP 1 — Check for an existing queue_entries row
  // ----------------------------------------------------------
  const { data: existing, error: fetchError } = await supabase
    .from("queue_entries")
    .select("id, games_played, status")
    .eq("session_id", sessionId)
    .eq("player_id", playerId)
    .maybeSingle();

  if (fetchError) {
    console.error("[joinQueueAction] fetch existing error:", fetchError.message);
    return { error: fetchError.message };
  }

  console.log(
    `[joinQueueAction] existing row:`,
    existing
      ? `id=${existing.id} games_played=${existing.games_played} status=${existing.status}`
      : "none (first-time joiner)"
  );

  // ----------------------------------------------------------
  // STEP 2 — Query the session floor (MIN games_played)
  //          Run this for BOTH first-time and returning players.
  //          This is the key fix for the line-jumping bug.
  // ----------------------------------------------------------
  const { data: floorRow, error: floorError } = await supabase
    .from("queue_entries")
    .select("games_played")
    .eq("session_id", sessionId)
    .in("status", ["waiting", "on_deck", "playing"])
    .order("games_played", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (floorError) {
    // Non-fatal — fall back to 0 so joining is never blocked.
    console.error("[joinQueueAction] floor query failed:", floorError.message);
  }

  const sessionFloor: number = floorRow?.games_played ?? 0;

  console.log(
    `[joinQueueAction] session floor=${sessionFloor}` +
    (floorRow ? ` (from active players)` : ` (session empty, defaulting to 0)`)
  );

  // ----------------------------------------------------------
  // STEP 3a — RETURNING PLAYER: row exists (any prior status)
  //
  // BUG FIX: previously we kept existing.games_played unchanged.
  // If that value is BELOW the session floor (e.g., player has 0
  // games played but everyone else has 3), they would jump to #1.
  //
  // Fix: use MAX(existing.games_played, sessionFloor).
  // This preserves hard-earned games (never reduce), but prevents
  // a stale 0 from granting an unfair front-of-queue position.
  // ----------------------------------------------------------
  if (existing) {
    const inheritedGames = Math.max(existing.games_played, sessionFloor);

    console.log(
      `[joinQueueAction] RETURNING PLAYER ` +
      `existing.games_played=${existing.games_played} ` +
      `sessionFloor=${sessionFloor} ` +
      `→ will write games_played=${inheritedGames}`
    );

    const { error: updateError } = await supabase
      .from("queue_entries")
      .update({
        status: "waiting" as const,
        games_played: inheritedGames,
        joined_at: new Date().toISOString(),
      })
      .eq("id", existing.id);

    if (updateError) {
      console.error("[joinQueueAction] update error:", updateError.message);
      return { error: updateError.message };
    }

    console.log(`[joinQueueAction] RETURNING PLAYER re-queued at games_played=${inheritedGames}`);

    await generateOnDeckMatchesAction(sessionId);
    return {};
  }

  // ----------------------------------------------------------
  // STEP 3b — FIRST-TIME JOINER: no row yet
  //
  // Insert with the session floor so they don't land at #1.
  // Their joined_at is brand-new, so within the same games_played
  // tier they go to the back of the line — fair.
  // ----------------------------------------------------------
  const inheritedGames = sessionFloor; // Floor already computed above.

  console.log(
    `[joinQueueAction] FIRST-TIME JOINER ` +
    `sessionFloor=${sessionFloor} ` +
    `→ inserting with games_played=${inheritedGames}`
  );

  const { error: insertError } = await supabase.from("queue_entries").insert({
    session_id: sessionId,
    player_id: playerId,
    status: "waiting" as const,
    games_played: inheritedGames,
    joined_at: new Date().toISOString(),
  });

  if (insertError) {
    console.error("[joinQueueAction] insert error:", insertError.message);
    return { error: insertError.message };
  }

  console.log(`[joinQueueAction] FIRST-TIME JOINER inserted at games_played=${inheritedGames}`);

  await generateOnDeckMatchesAction(sessionId);
  return {};
}
