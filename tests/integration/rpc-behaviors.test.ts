// ============================================================
// Suite H + I + J — RPC Behavioral Tests
// ============================================================
// Verifies the two RPCs added by migration 20260511000002_missing_rpcs:
//
//   • elevate_to_organizer(p_session_id, p_passcode) → boolean
//     Security-sensitive: passcode-based privilege escalation.
//     Called by browser clients (SECURITY DEFINER).
//
//   • rejoin_queue(p_session_id) → void
//     User-facing re-entry after leaving a session.
//     Called by browser clients (SECURITY DEFINER).
//
// …plus Suite J for clear_on_deck_match_atomic (service_role only),
// which is the ONLY level at which the held-draft cancel can be
// tested: the unit tests (CC-HOLD-1..6) cover the pure predicate
// heldDraftExpired, but the defect this suite pins lives entirely in
// the RPC's UPDATE statement.
//
// How auth context is injected:
//   Both RPCs use auth.uid() internally. In production, PostgREST
//   sets request.jwt.claim.sub from the caller's JWT. Here we
//   use withTx to call the function via a pg.PoolClient and issue
//   SET LOCAL "request.jwt.claim.sub" = userId before the RPC call.
//   This mirrors exactly what PostgREST does, without requiring a
//   real HTTP auth flow.
//
// Isolation: Layer A (withTx) for the RPC call + in-transaction
//   assertions. Layer B (truncateTracked) in afterEach for the
//   setup data created by makeProfile / makeSession.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import { makeProfile, makeSession, makeQueueEntry } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { withTx } from "./helpers/withTx";
import pg from "pg";

const faker = new Faker({ locale: [en] });
faker.seed(8001);

afterEach(async () => {
  await truncateTracked();
});

// ── Shared helpers ────────────────────────────────────────────

/**
 * Sets a session's organizer_passcode via the service client
 * (SessionUpdate allows organizer_passcode as an optional field).
 */
async function setSessionPasscode(sessionId: string, passcode: string): Promise<void> {
  const { error } = await serviceClient()
    .from("sessions")
    .update({ organizer_passcode: passcode })
    .eq("id", sessionId);
  if (error) throw new Error(`[setSessionPasscode] ${error.message}`);
}

/**
 * Calls a SECURITY DEFINER RPC that uses auth.uid() internally.
 *
 * Wraps the call in a withTx savepoint so that any writes made by
 * the RPC (e.g., inserting session_organizers, updating queue_entries)
 * are visible to assertions inside `fn` and then rolled back when the
 * callback returns — leaving the DB in the pre-call state.
 *
 * @param userId - The UUID to inject as request.jwt.claim.sub (auth.uid()).
 * @param sql    - A single SELECT statement that invokes the RPC.
 * @param params - Positional parameters for the SQL statement.
 * @param fn     - Callback receiving the query result + the live pg client
 *                 for additional in-transaction assertions.
 */
async function callRpcAs<T>(
  userId: string,
  sql: string,
  params: unknown[],
  fn: (result: pg.QueryResult, db: pg.PoolClient) => Promise<T>
): Promise<T> {
  return withTx(async (db) => {
    // Inject auth context — mirrors what PostgREST does before each request.
    // set_config(name, value, is_local=true) is the parameterized equivalent of
    // SET LOCAL "request.jwt.claim.sub" = '…'; SET LOCAL does not accept $1.
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    const result = await db.query(sql, params);
    return fn(result, db);
  });
}

// ─────────────────────────────────────────────────────────────
// Suite H — elevate_to_organizer
// ─────────────────────────────────────────────────────────────

describe("elevate_to_organizer — Suite H", () => {
  // ── H-1: Correct passcode → true, row inserted ────────────

  it("H-1 returns true and inserts session_organizers row on correct passcode", async () => {
    const primaryOrg = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: primaryOrg.id });
    await setSessionPasscode(session.id, "TESTCODE");

    const joiner = await makeProfile({ faker });

    await callRpcAs(
      joiner.id,
      "SELECT public.elevate_to_organizer($1, $2) AS result",
      [session.id, "TESTCODE"],
      async (result, db) => {
        // RPC must return true
        expect(result.rows[0].result).toBe(true);

        // Row must be visible in the same transaction
        const { rows } = await db.query(
          `SELECT id FROM session_organizers
            WHERE session_id = $1 AND user_id = $2`,
          [session.id, joiner.id]
        );
        expect(rows).toHaveLength(1);
      }
    );
  });

  // ── H-2: Wrong passcode → false, no row ──────────────────

  it("H-2 returns false and inserts no row on wrong passcode", async () => {
    const primaryOrg = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: primaryOrg.id });
    await setSessionPasscode(session.id, "CORRECT");

    const joiner = await makeProfile({ faker });

    await callRpcAs(
      joiner.id,
      "SELECT public.elevate_to_organizer($1, $2) AS result",
      [session.id, "WRONGCODE"],
      async (result, db) => {
        // RPC must return false
        expect(result.rows[0].result).toBe(false);

        // No row should have been inserted
        const { rows } = await db.query(
          `SELECT id FROM session_organizers
            WHERE session_id = $1 AND user_id = $2`,
          [session.id, joiner.id]
        );
        expect(rows).toHaveLength(0);
      }
    );
  });

  // ── H-3: Session has no passcode → false ─────────────────

  it("H-3 returns false when session has no organizer_passcode set", async () => {
    const primaryOrg = await makeProfile({ faker });
    // makeSession leaves organizer_passcode null by default
    const session = await makeSession({ faker, organizer: primaryOrg.id });

    const joiner = await makeProfile({ faker });

    await callRpcAs(
      joiner.id,
      "SELECT public.elevate_to_organizer($1, $2) AS result",
      [session.id, "ANYCODE"],
      async (result, db) => {
        expect(result.rows[0].result).toBe(false);

        const { rows } = await db.query(
          `SELECT id FROM session_organizers
            WHERE session_id = $1 AND user_id = $2`,
          [session.id, joiner.id]
        );
        expect(rows).toHaveLength(0);
      }
    );
  });

  // ── H-4: Inactive session → false ────────────────────────

  it("H-4 returns false for an inactive (closed) session", async () => {
    const primaryOrg = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: primaryOrg.id });
    await setSessionPasscode(session.id, "ACTIVECODE");

    // Close the session directly
    const { error } = await serviceClient()
      .from("sessions")
      .update({ is_active: false })
      .eq("id", session.id);
    expect(error).toBeNull();

    const joiner = await makeProfile({ faker });

    await callRpcAs(
      joiner.id,
      "SELECT public.elevate_to_organizer($1, $2) AS result",
      [session.id, "ACTIVECODE"],
      async (result, db) => {
        expect(result.rows[0].result).toBe(false);

        const { rows } = await db.query(
          `SELECT id FROM session_organizers
            WHERE session_id = $1 AND user_id = $2`,
          [session.id, joiner.id]
        );
        expect(rows).toHaveLength(0);
      }
    );
  });

  // ── H-5: Already an organizer → idempotent via ON CONFLICT ─
  //
  // Uses a COMMITTED pre-existing session_organizers row so that
  // the RPC actually hits the ON CONFLICT DO NOTHING path.
  // (H-6 covers the same for the primary organizer via the trigger row;
  //  this test covers a secondary joiner whose row was committed earlier.)

  it("H-5 is idempotent — returns true and no duplicate row when joiner's row is already committed", async () => {
    const primaryOrg = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: primaryOrg.id });
    await setSessionPasscode(session.id, "IDEMPOTENT");

    const joiner = await makeProfile({ faker });

    // Commit a session_organizers row for the joiner directly (simulates
    // a prior successful elevation that was not rolled back).
    const { error: insertErr } = await serviceClient()
      .from("session_organizers")
      .insert({ session_id: session.id, user_id: joiner.id });
    expect(insertErr).toBeNull();

    // Call elevate_to_organizer with the row already committed — this is the
    // genuine ON CONFLICT DO NOTHING path inside the RPC.
    await callRpcAs(
      joiner.id,
      "SELECT public.elevate_to_organizer($1, $2) AS result",
      [session.id, "IDEMPOTENT"],
      async (result, db) => {
        // Must still return true
        expect(result.rows[0].result).toBe(true);

        // Exactly one row — ON CONFLICT DO NOTHING prevented a duplicate
        const { rows } = await db.query(
          `SELECT id FROM session_organizers
            WHERE session_id = $1 AND user_id = $2`,
          [session.id, joiner.id]
        );
        expect(rows).toHaveLength(1);
      }
    );
  });

  // ── H-6: Primary organizer calls it with own passcode ────

  it("H-6 is idempotent for the primary organizer (already has a session_organizers row)", async () => {
    // The on_session_created trigger inserts a row for created_by.
    // elevate_to_organizer should succeed (ON CONFLICT DO NOTHING) and return true.
    const primaryOrg = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: primaryOrg.id });
    await setSessionPasscode(session.id, "PRIMARYCODE");

    await callRpcAs(
      primaryOrg.id,
      "SELECT public.elevate_to_organizer($1, $2) AS result",
      [session.id, "PRIMARYCODE"],
      async (result, db) => {
        // Must return true — the primary organizer's row already exists
        expect(result.rows[0].result).toBe(true);

        // Exactly one row — no duplicate created
        const { rows } = await db.query(
          `SELECT id FROM session_organizers
            WHERE session_id = $1 AND user_id = $2`,
          [session.id, primaryOrg.id]
        );
        expect(rows).toHaveLength(1);
      }
    );
  });

  // ── H-7: Non-existent session UUID → false ────────────────

  it("H-7 returns false for a session UUID that does not exist", async () => {
    const player = await makeProfile({ faker });
    const nonExistentId = "00000000-0000-0000-0000-000000000001";

    await callRpcAs(
      player.id,
      "SELECT public.elevate_to_organizer($1, $2) AS result",
      [nonExistentId, "ANYCODE"],
      async (result, _db) => {
        expect(result.rows[0].result).toBe(false);
      }
    );
  });
});

// ─────────────────────────────────────────────────────────────
// Suite I — rejoin_queue
// ─────────────────────────────────────────────────────────────

describe("rejoin_queue — Suite I", () => {
  // ── I-1: left → waiting with fresh joined_at ─────────────

  it("I-1 resets a 'left' player to 'waiting' and refreshes joined_at", async () => {
    const player = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: player.id });
    await makeQueueEntry({ sessionId: session.id, playerId: player.id });

    // Record the original joined_at before marking as left
    const { data: original } = await serviceClient()
      .from("queue_entries")
      .select("joined_at")
      .eq("session_id", session.id)
      .eq("player_id", player.id)
      .single();

    // Mark as left (simulates player leaving the session)
    await serviceClient()
      .from("queue_entries")
      .update({ status: "left" })
      .eq("session_id", session.id)
      .eq("player_id", player.id);

    // Small delay so joined_at comparison is meaningful
    await new Promise((r) => setTimeout(r, 10));
    const callTime = new Date();

    await callRpcAs(
      player.id,
      "SELECT public.rejoin_queue($1)",
      [session.id],
      async (_result, db) => {
        const { rows } = await db.query(
          `SELECT status, joined_at FROM queue_entries
            WHERE session_id = $1 AND player_id = $2`,
          [session.id, player.id]
        );

        expect(rows).toHaveLength(1);
        // Status should be waiting
        expect(rows[0].status).toBe("waiting");
        // joined_at should have been refreshed to now (≥ original)
        const newJoinedAt = new Date(rows[0].joined_at);
        expect(newJoinedAt.getTime()).toBeGreaterThanOrEqual(callTime.getTime() - 1000);
        expect(newJoinedAt.getTime()).toBeGreaterThan(new Date(original!.joined_at).getTime());
      }
    );
  });

  // ── I-2: waiting player → no-op ──────────────────────────

  it("I-2 is a no-op for a player already 'waiting' (only 'left' entries are affected)", async () => {
    const player = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: player.id });
    await makeQueueEntry({ sessionId: session.id, playerId: player.id, status: "waiting" });

    const { data: before } = await serviceClient()
      .from("queue_entries")
      .select("status, joined_at")
      .eq("session_id", session.id)
      .eq("player_id", player.id)
      .single();

    await callRpcAs(
      player.id,
      "SELECT public.rejoin_queue($1)",
      [session.id],
      async (_result, db) => {
        const { rows } = await db.query(
          `SELECT status, joined_at FROM queue_entries
            WHERE session_id = $1 AND player_id = $2`,
          [session.id, player.id]
        );
        expect(rows[0].status).toBe("waiting");
        // joined_at should be unchanged
        expect(rows[0].joined_at.toISOString()).toBe(new Date(before!.joined_at).toISOString());
      }
    );
  });

  // ── I-3: on_deck player → no-op ──────────────────────────

  it("I-3 is a no-op for a player in 'on_deck' status", async () => {
    const player = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: player.id });
    await makeQueueEntry({ sessionId: session.id, playerId: player.id, status: "on_deck" });

    await callRpcAs(
      player.id,
      "SELECT public.rejoin_queue($1)",
      [session.id],
      async (_result, db) => {
        const { rows } = await db.query(
          `SELECT status FROM queue_entries
            WHERE session_id = $1 AND player_id = $2`,
          [session.id, player.id]
        );
        // Status must be unchanged
        expect(rows[0].status).toBe("on_deck");
      }
    );
  });

  // ── I-4: drafted player → no-op ──────────────────────────

  it("I-4 is a no-op for a player in 'drafted' status (cannot escape a draft via rejoin)", async () => {
    const player = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: player.id });
    await makeQueueEntry({ sessionId: session.id, playerId: player.id, status: "drafted" });

    await callRpcAs(
      player.id,
      "SELECT public.rejoin_queue($1)",
      [session.id],
      async (_result, db) => {
        const { rows } = await db.query(
          `SELECT status FROM queue_entries
            WHERE session_id = $1 AND player_id = $2`,
          [session.id, player.id]
        );
        // Drafted players cannot use rejoin_queue to escape a draft
        expect(rows[0].status).toBe("drafted");
      }
    );
  });

  // ── I-5: no queue entry → no-op, no error ─────────────────

  it("I-5 is a no-op when the player has no queue entry in the session (no error thrown)", async () => {
    const player = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: player.id });
    // Intentionally do NOT call makeQueueEntry

    await callRpcAs(
      player.id,
      "SELECT public.rejoin_queue($1)",
      [session.id],
      async (_result, db) => {
        const { rows } = await db.query(
          `SELECT id FROM queue_entries
            WHERE session_id = $1 AND player_id = $2`,
          [session.id, player.id]
        );
        // No row should have been created
        expect(rows).toHaveLength(0);
      }
    );
  });

  // ── I-6: player can only rejoin their own entry ───────────

  it("I-6 only affects the calling player's entry — other players' entries are untouched", async () => {
    const organizer = await makeProfile({ faker });
    const otherPlayer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });

    // Both players have 'left' entries
    await makeQueueEntry({ sessionId: session.id, playerId: organizer.id, status: "left" });
    await makeQueueEntry({ sessionId: session.id, playerId: otherPlayer.id, status: "left" });

    // organizer calls rejoin_queue — should only affect organizer's entry
    await callRpcAs(
      organizer.id,
      "SELECT public.rejoin_queue($1)",
      [session.id],
      async (_result, db) => {
        const { rows } = await db.query(
          `SELECT player_id, status FROM queue_entries
            WHERE session_id = $1 ORDER BY player_id`,
          [session.id]
        );

        const orgEntry = rows.find((r) => r.player_id === organizer.id);
        const otherEntry = rows.find((r) => r.player_id === otherPlayer.id);

        // Only the calling player's entry should change
        expect(orgEntry?.status).toBe("waiting");
        // Other player's entry must remain unchanged
        expect(otherEntry?.status).toBe("left");
      }
    );
  });

  // ── I-7: games_played is preserved on rejoin ──────────────

  it("I-7 preserves games_played when resetting a 'left' player to 'waiting'", async () => {
    const player = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: player.id });
    await makeQueueEntry({ sessionId: session.id, playerId: player.id });

    // Simulate some games played, then player left
    await serviceClient()
      .from("queue_entries")
      .update({ status: "left", games_played: 5 })
      .eq("session_id", session.id)
      .eq("player_id", player.id);

    await callRpcAs(
      player.id,
      "SELECT public.rejoin_queue($1)",
      [session.id],
      async (_result, db) => {
        const { rows } = await db.query(
          `SELECT status, games_played FROM queue_entries
            WHERE session_id = $1 AND player_id = $2`,
          [session.id, player.id]
        );
        expect(rows[0].status).toBe("waiting");
        // games_played should be preserved — the player paid for their history
        expect(rows[0].games_played).toBe(5);
      }
    );
  });

  // ── I-8: playing player → no-op ──────────────────────────

  it("I-8 is a no-op for a player in 'playing' status", async () => {
    const player = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: player.id });
    await makeQueueEntry({ sessionId: session.id, playerId: player.id, status: "playing" });

    await callRpcAs(
      player.id,
      "SELECT public.rejoin_queue($1)",
      [session.id],
      async (_result, db) => {
        const { rows } = await db.query(
          `SELECT status FROM queue_entries
            WHERE session_id = $1 AND player_id = $2`,
          [session.id, player.id]
        );
        // Only 'left' entries are affected; 'playing' must be unchanged
        expect(rows[0].status).toBe("playing");
      }
    );
  });
});

// ─────────────────────────────────────────────────────────────
// Suite J — clear_on_deck_match_atomic never unseats a live body
// ─────────────────────────────────────────────────────────────
//
// Regression cover for migration
// 20260812000000_clear_on_deck_never_unseats_a_playing_body.
//
// A HELD cross-court draft is (3 waiting + 1 still-playing body).
// The cross-court hold-age cancel (CROSS_COURT_MAX_HOLD_MINUTES) is
// the first routine caller of this RPC that fires while the body is
// genuinely mid-game, so step 5's old `status != 'left'` guard would
// have flipped a player on court to 'waiting' — the same hazard
// 20260624000000 fixed for the BULK clear.
//
// ⚠️ These are not unit-testable. heldDraftExpired is a pure
// predicate and returns the same boolean either way; the whole defect
// is in what the SQL then writes.

describe("clear_on_deck_match_atomic — Suite J", () => {
  /**
   * Builds a held cross-court draft in-transaction: an in_progress
   * source match holding `body`, plus a pending draft whose roster is
   * the 3 waiting players AND `body`.
   *
   * Written as raw SQL on the withTx client (not the service client)
   * so every row rolls back with the savepoint — matches/match_players
   * have no factory, and Layer B only truncates factory-made setup.
   */
  async function seedHeldDraft(
    db: pg.PoolClient,
    sessionId: string,
    waiting: string[],
    body: string,
    sourceStatus: "in_progress" | "completed" = "in_progress"
  ): Promise<{ heldId: string }> {
    const { rows: srcRows } = await db.query(
      // `completed` is passed as its own boolean param rather than reusing $2:
      // $2 lands in a match_status column, so a second `$2 = 'completed'` makes
      // Postgres deduce text AND match_status for one parameter and fail with
      // 42P08 ("inconsistent types deduced").
      `INSERT INTO matches (session_id, status, started_at, completed_at)
       VALUES ($1, $2, now(), CASE WHEN $3 THEN now() ELSE NULL END)
       RETURNING id`,
      [sessionId, sourceStatus, sourceStatus === "completed"]
    );
    const sourceId = srcRows[0].id;
    // ⚠️ team is lowercase 'a'/'b' — that is what create_match_with_players and
    // create_held_cross_court_match actually write. `team char(1)` has no CHECK,
    // so uppercase would insert fine and the assertions would still hold; the
    // fixture just would not be a faithful stand-in for a real roster.
    await db.query(`INSERT INTO match_players (match_id, player_id, team) VALUES ($1, $2, 'a')`, [
      sourceId,
      body,
    ]);

    // created_method 'held' mirrors what create_held_cross_court_match stamps,
    // so the row is self-documenting as a held draft rather than relying on the
    // 'auto' default. ('auto' | 'manual' | 'held' are the only values the
    // CHECK in 20260617000000 permits.) clear_on_deck_match_atomic never reads it.
    const { rows: heldRows } = await db.query(
      `INSERT INTO matches (session_id, status, pulled_player_ids, pulled_from_match_id, created_method)
       VALUES ($1, 'pending', ARRAY[$2::uuid], $3, 'held') RETURNING id`,
      [sessionId, body, sourceId]
    );
    const heldId = heldRows[0].id;
    for (const [i, pid] of [...waiting, body].entries()) {
      await db.query(`INSERT INTO match_players (match_id, player_id, team) VALUES ($1, $2, $3)`, [
        heldId,
        pid,
        i < 2 ? "a" : "b",
      ]);
    }
    return { heldId };
  }

  // ── J-1: the body stays on court; the 3 parked players are freed ──

  it("J-1 leaves a still-playing pulled body alone while restoring the 3 parked waiters", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });

    const waiting: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await makeProfile({ faker });
      await makeQueueEntry({ sessionId: session.id, playerId: p.id, status: "drafted" });
      waiting.push(p.id);
    }
    const body = await makeProfile({ faker });
    await makeQueueEntry({ sessionId: session.id, playerId: body.id, status: "playing" });

    await withTx(async (db) => {
      const { heldId } = await seedHeldDraft(db, session.id, waiting, body.id);

      await db.query(`SELECT public.clear_on_deck_match_atomic($1, $2)`, [heldId, session.id]);

      const { rows } = await db.query(
        `SELECT player_id, status FROM queue_entries
          WHERE session_id = $1 AND player_id = ANY($2)`,
        [session.id, [...waiting, body.id]]
      );
      const byId = new Map(rows.map((r) => [r.player_id, r.status]));

      // The three parked players re-enter the pool — that is the whole
      // point of the hold-age cancel.
      for (const pid of waiting) expect(byId.get(pid)).toBe("waiting");

      // ⚠️ THE decisive assertion. Before the migration this read
      // "waiting": the body would appear in the queue and on a court at
      // the same time, and every later engine tick would stall on
      // create_match_with_players' Guard 2.
      expect(byId.get(body.id)).toBe("playing");

      // The draft itself is gone either way.
      const { rows: gone } = await db.query(`SELECT id FROM matches WHERE id = $1`, [heldId]);
      expect(gone).toHaveLength(0);
    });
  });

  // ── J-1b: same held shape, but the body's game already ended ─

  it("J-1b restores ALL FOUR when the pulled body's source match has completed", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });

    const waiting: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await makeProfile({ faker });
      await makeQueueEntry({ sessionId: session.id, playerId: p.id, status: "drafted" });
      waiting.push(p.id);
    }
    // The body has come off court, so its queue row is 'drafted' like the
    // others — this is the shape a held draft takes once isHeldMatchReady
    // has resolved and before it is promoted.
    const body = await makeProfile({ faker });
    await makeQueueEntry({ sessionId: session.id, playerId: body.id, status: "drafted" });

    await withTx(async (db) => {
      const { heldId } = await seedHeldDraft(db, session.id, waiting, body.id, "completed");

      await db.query(`SELECT public.clear_on_deck_match_atomic($1, $2)`, [heldId, session.id]);

      const { rows } = await db.query(
        `SELECT player_id, status FROM queue_entries
          WHERE session_id = $1 AND player_id = ANY($2)`,
        [session.id, [...waiting, body.id]]
      );
      const byId = new Map(rows.map((r) => [r.player_id, r.status]));

      // The NOT EXISTS guard tests PHYSICAL truth — "is this player in an
      // in_progress match right now" — not "is this a held draft". So once
      // the source game is over the body is an ordinary member of the four
      // and must come back with the rest. A guard keyed on is_held or on
      // pulled_player_ids would have stranded them here.
      for (const pid of [...waiting, body.id]) expect(byId.get(pid)).toBe("waiting");

      const { rows: gone } = await db.query(`SELECT id FROM matches WHERE id = $1`, [heldId]);
      expect(gone).toHaveLength(0);
    });
  });

  // ── J-2: an ordinary draft is completely unaffected ──────────

  it("J-2 still restores every member of an ordinary (non-held) draft", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });

    const players: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await makeProfile({ faker });
      await makeQueueEntry({ sessionId: session.id, playerId: p.id, status: "drafted" });
      players.push(p.id);
    }

    await withTx(async (db) => {
      const { rows: mRows } = await db.query(
        `INSERT INTO matches (session_id, status) VALUES ($1, 'pending') RETURNING id`,
        [session.id]
      );
      const matchId = mRows[0].id;
      for (const [i, pid] of players.entries()) {
        await db.query(
          `INSERT INTO match_players (match_id, player_id, team) VALUES ($1, $2, $3)`,
          [matchId, pid, i < 2 ? "a" : "b"]
        );
      }

      await db.query(`SELECT public.clear_on_deck_match_atomic($1, $2)`, [matchId, session.id]);

      const { rows } = await db.query(
        `SELECT status FROM queue_entries WHERE session_id = $1 AND player_id = ANY($2)`,
        [session.id, players]
      );
      // Nobody here holds an in_progress match, so the new NOT EXISTS
      // clause must be a no-op. If this fails, the fix over-reached.
      expect(rows).toHaveLength(4);
      for (const r of rows) expect(r.status).toBe("waiting");
    });
  });

  // ── J-3: a checked-out player is still never pulled back ─────

  it("J-3 preserves the pre-existing 'left' guard", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });

    const stayer = await makeProfile({ faker });
    await makeQueueEntry({ sessionId: session.id, playerId: stayer.id, status: "drafted" });
    const leaver = await makeProfile({ faker });
    await makeQueueEntry({ sessionId: session.id, playerId: leaver.id, status: "left" });

    await withTx(async (db) => {
      const { rows: mRows } = await db.query(
        `INSERT INTO matches (session_id, status) VALUES ($1, 'pending') RETURNING id`,
        [session.id]
      );
      const matchId = mRows[0].id;
      for (const [i, pid] of [stayer.id, leaver.id].entries()) {
        await db.query(
          `INSERT INTO match_players (match_id, player_id, team) VALUES ($1, $2, $3)`,
          [matchId, pid, i === 0 ? "a" : "b"]
        );
      }

      await db.query(`SELECT public.clear_on_deck_match_atomic($1, $2)`, [matchId, session.id]);

      const { rows } = await db.query(
        `SELECT player_id, status FROM queue_entries
          WHERE session_id = $1 AND player_id = ANY($2)`,
        [session.id, [stayer.id, leaver.id]]
      );
      const byId = new Map(rows.map((r) => [r.player_id, r.status]));
      expect(byId.get(stayer.id)).toBe("waiting");
      expect(byId.get(leaver.id)).toBe("left");
    });
  });
});
