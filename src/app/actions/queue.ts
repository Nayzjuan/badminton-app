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
import { createServiceClient } from "@/utils/supabase/service";
import { runEngineForSession } from "@/app/actions/matchmaking";
import { isValidUUID } from "@/lib/validate";

// ── Checkout ──────────────────────────────────────────────────
// Marks the calling player's queue_entries row as "left" for a
// given session, removing them from matchmaking.
// Calling this while on_deck or playing is allowed — the match
// already in progress is unaffected; they're only removed from
// the future queue so they don't get scheduled again.

export interface CheckoutResult {
  success: boolean;
  error?: string;
}

// ── Soft Pause ────────────────────────────────────────────────
// Toggles `is_paused` on the player's queue_entries row.
// The player remains visible in the organizer dashboard but is
// strictly excluded from the matchmaking engine while paused.
// IMPORTANT: `joined_at` and `games_played` are never touched —
// pausing does NOT forfeit queue position or game stats.

export interface TogglePlayerPauseResult {
  success: boolean;
  error?: string;
}

export async function togglePlayerPause(
  sessionId: string,
  playerId: string,
  isPaused: boolean
): Promise<TogglePlayerPauseResult> {
  if (!isValidUUID(sessionId) || !isValidUUID(playerId)) {
    return { success: false, error: "Invalid session or player ID." };
  }
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, error: "Not authenticated." };
  }

  // Update is_paused ONLY — never touch joined_at or games_played.
  const { error } = await supabase
    .from("queue_entries")
    .update({ is_paused: isPaused })
    .eq("session_id", sessionId)
    .eq("player_id", playerId);

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true };
}

export async function checkoutPlayer(sessionId: string): Promise<CheckoutResult> {
  if (!isValidUUID(sessionId)) return { success: false, error: "Invalid session ID." };
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, error: "Not authenticated." };
  }

  const { error } = await supabase
    .from("queue_entries")
    .update({ status: "left" as const })
    .eq("session_id", sessionId)
    .eq("player_id", user.id);

  if (error) {
    return { success: false, error: error.message };
  }

  // Clean up any unpublished draft matches this player is assigned to.
  // Without this, a draft containing a 'left' player is stuck: it can't
  // be published (publishMatchAction blocks on 'left' players) and shows
  // a stale roster to the organizer. We remove the player and auto-cancel
  // the draft if it falls below 4 players, freeing the slot.
  const svc = createServiceClient();
  const { data: draftMatches } = await svc
    .from("matches")
    .select("id")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .eq("is_published", false);

  if (draftMatches && draftMatches.length > 0) {
    const draftMatchIds = draftMatches.map((m) => m.id);
    const { data: draftEntries } = await svc
      .from("match_players")
      .select("match_id")
      .eq("player_id", user.id)
      .in("match_id", draftMatchIds);

    for (const entry of draftEntries ?? []) {
      await svc
        .from("match_players")
        .delete()
        .eq("match_id", entry.match_id)
        .eq("player_id", user.id);

      const { count } = await svc
        .from("match_players")
        .select("*", { count: "exact", head: true })
        .eq("match_id", entry.match_id);

      if ((count ?? 0) < 4) {
        await svc
          .from("matches")
          .update({ status: "cancelled" as const })
          .eq("id", entry.match_id)
          .eq("status", "pending");
      }
    }
  }

  return { success: true };
}

export interface JoinQueueResult {
  error?: string;
}

export async function joinQueueAction(sessionId: string): Promise<JoinQueueResult> {
  if (!isValidUUID(sessionId)) return { error: "Invalid session ID." };
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
  // STEP 1b — Active-match guard (early return before any DB write)
  //
  // If the player is currently on_deck or playing, refuse the join.
  // Re-queuing them would reset their queue entry to "waiting",
  // evicting them from their assigned match slot and potentially
  // creating a duplicate-in-queue appearance when the match ends.
  //
  // This most commonly surfaces when a player reconnects on a new
  // device mid-match — the reconnect flow migrates their DB row,
  // the page loads, and the UI may prompt "Join Queue" before the
  // match state has propagated.  Block it cleanly here.
  // ----------------------------------------------------------
  if (existing && (existing.status === "on_deck" || existing.status === "playing")) {
    console.log(
      `[joinQueueAction] BLOCKED — player=${playerId} is currently ` +
      `status=${existing.status} and cannot re-join until their match ends.`
    );
    return {
      error: "You're currently in a match — wait for it to finish before rejoining the queue.",
    };
  }

  // Draft-mode guard: a player's queue_entries.status stays 'waiting' while
  // in an unpublished draft, so the status check above doesn't catch them.
  // Query match_players to block a re-join that would corrupt the draft roster.
  if (existing) {
    const svcJoin = createServiceClient();
    const { data: pendingMatchIds } = await svcJoin
      .from("matches")
      .select("id")
      .eq("session_id", sessionId)
      .in("status", ["pending", "in_progress"]);

    if (pendingMatchIds && pendingMatchIds.length > 0) {
      const { data: matchEntry } = await svcJoin
        .from("match_players")
        .select("match_id")
        .eq("player_id", playerId)
        .in("match_id", pendingMatchIds.map((m) => m.id))
        .limit(1)
        .maybeSingle();

      if (matchEntry) {
        console.log(
          `[joinQueueAction] BLOCKED — player=${playerId} is already ` +
          `in match_players for match=${matchEntry.match_id}`
        );
        return {
          error: "You're already assigned to a match — wait for it to complete before rejoining the queue.",
        };
      }
    }
  }

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
  // STEP 3a — RETURNING PLAYER: row exists (waiting or left status)
  //
  // Note: on_deck / playing are caught by the early guard in Step 1b.
  // By the time we reach here, existing (if set) is always waiting/left.
  //
  // BUG FIX (games_played): previously we kept existing.games_played
  // unchanged.  If that value is BELOW the session floor (e.g., player
  // has 0 games played but everyone else has 3), they would jump to #1.
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

    await runEngineForSession(sessionId);
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

  await runEngineForSession(sessionId);
  return {};
}
