// ============================================================
// Suite RB — realtime.messages RLS actually scopes the broadcast topic
// ============================================================
// Tenancy audit 2026-07-21 finding #7 closed `session-events:{sessionId}` by
// flipping the channel to `private: true` and adding ONE policy —
// `session_events_broadcast_read` on realtime.messages (20260723100000).
//
// Everything that existed before this file tested the CLIENT side of that fix.
// tests/unit/realtime-private-broadcast.test.ts (RPB-1..7) mocks supabase-js and
// asserts the app *declares* `private: true` and builds the right topic string;
// [R-1] in the e2e suite proves a second organizer *receives* the event. Both
// are positive paths. Nothing anywhere asserted the half the finding was
// actually about: that a signed-in stranger is REFUSED. A policy that had been
// dropped, or narrowed to `using (extension = 'broadcast')`, would have left
// every one of those tests green.
//
// ── WHY THIS IS TESTABLE IN SQL ─────────────────────────────
// Realtime Authorization is not a bespoke check. To decide a channel join,
// Realtime opens a transaction, sets the caller's role and JWT claims, sets
// `realtime.topic` to the topic being joined, and asks Postgres whether the
// caller can SELECT from realtime.messages (and, for write, whether an INSERT
// survives). That is precisely what asMember()/asAnon() reproduce below, so
// these assertions run the real policy, the real realtime_topic_session_id()
// and the real session_access_level() against real rows.
//
// What it does NOT cover, stated so it is not mistaken for full coverage:
//   • the WebSocket layer — that Realtime consults this policy at all, and
//     defers the join until setAuth() lands, is [R-1]'s job (see also
//     MEMORY.md "realtime-jwt-before-join");
//   • the project-wide "Allow public access" toggle, which is what stops a
//     hand-rolled client from opening this topic as a PUBLIC channel and
//     skipping authorization entirely. That is a dashboard setting with no SQL
//     surface; 20260723100000's header tracks it as the remaining gap.
//
// ── DISCRIMINATOR EVIDENCE ──────────────────────────────────
// Measured 2026-08-12 on the local stack: four mutated policy sets installed in
// turn, the suite run against each, results below transcribed from the runs.
// Every test is killed by at least one. The DDL is given verbatim because the
// result depends on it exactly — see the ⚠️ under the table.
//
//   mutant (applied to realtime.messages)              | fails
//   ---------------------------------------------------+----------------------
//   M1 REPLACE the policy with                         | RB-3 RB-4 RB-5 RB-7
//      `for select to authenticated                    |
//       using (realtime.messages.extension =           |
//             'broadcast')` — private but unscoped,    |
//       the exact shape the audit feared               |
//   M2 ADD `create policy rb_mutant_all ... for all    | RB-3 RB-4 RB-5 RB-7
//      to authenticated using (true) with check        | RB-8
//      (true)` — the forgery hole. pg_policies          |
//      reports cmd='ALL', not 'INSERT'                 |
//   M3 DROP the policy entirely — fail-closed          | RB-1 RB-2 RB-4 RB-5
//   M4 ADD `create policy rb_mutant_anon ... for       | RB-6
//      select to anon using (realtime.messages.        |
//      extension = 'broadcast')` — an anon read arm    |
//
// M2 also kills the four reads because a permissive ALL policy is OR'd into
// SELECT as well; M3 kills RB-4 and RB-5 through their positive halves (RB-4's
// own-club control, RB-5's before-deactivation read), not their negative ones.
//
// ⚠️ RB-6 is a pin, not a discriminator against M1-M3: anon is refused under all
// three, so only M4 can kill it. It earns its place anyway — 20260723100000's
// header warns that adding an anon arm silently requires giving anon EXECUTE on
// realtime_topic_session_id() back, which that same migration deliberately
// revokes. And the qualifier matters: M2 is written `to authenticated` on
// purpose. Drop that clause and the policy applies to PUBLIC, which includes
// anon — RB-6 would then fail too, and the table above would be wrong. Re-derive
// this table if you change a mutant; do not paraphrase it.
//
// Isolation: Layer B — truncateTracked() in afterEach for the factory rows,
// plus Layer A — every realtime.messages write happens inside withTx and is
// rolled back, so no test ever leaves a message behind for Realtime to deliver.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import type { PoolClient } from "pg";
import { makeProfile, makeSession } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { withTx, queryCommitted } from "./helpers/withTx";

const faker = new Faker({ locale: [en] });
faker.seed(7301);

afterEach(async () => {
  await truncateTracked();
});

/** The legacy club — sessions.club_id defaults to it. */
const LEGACY_CLUB_ID = "00000000-0000-0000-0000-000000000001";

const topicFor = (sessionId: string) => `session-events:${sessionId}`;

// ── Helpers ────────────────────────────────────────────────────

/**
 * realtime.messages is partitioned by day and the partitions are created by a
 * scheduled job, so a local stack that has been idle can be missing today's.
 * This makes it, named the way Realtime names them so the real job stays
 * idempotent against it. The DDL runs inside withTx's transaction and rolls
 * back with everything else.
 *
 * Tuple routing happens in ExecInsert BEFORE the RLS `WITH CHECK` is evaluated,
 * so a missing partition raises 23514 and pre-empts the very SQLSTATE RB-8
 * asserts. That is why this is a named helper called by both writers, and not
 * folded into seedBroadcast(): RB-8 does not seed, and it is the one test that
 * most needs the right error.
 *
 * The `when others` swallow is deliberate but NOT harmless-by-definition — it
 * would equally hide a privilege error on schema realtime or a lock timeout.
 * What makes it safe is the ordering: every caller issues a realtime.messages
 * write immediately afterwards, so any cause that actually mattered resurfaces
 * there as a loud failure (23514 for a genuinely absent partition). The only
 * cause it is meant to absorb is a partition already covering today, created
 * concurrently or by a differently-named bound.
 *
 * The date comes from `now()::timestamp`, not from JS — inserted_at is
 * `timestamp without time zone` and the bounds are naive, so the partition has
 * to be chosen in the same frame the row will be routed in.
 */
async function ensureTodayPartition(db: PoolClient): Promise<void> {
  await db.query(
    `do $$
     declare d date := (now()::timestamp)::date;
     begin
       execute format(
         'create table if not exists realtime.%I partition of realtime.messages for values from (%L) to (%L)',
         'messages_' || to_char(d, 'YYYY_MM_DD'), d, d + 1);
     exception when others then
       null;
     end $$;`
  );
}

/**
 * Seed one private broadcast row on `topic`, as the connection's own superuser
 * role — which bypasses RLS, exactly as the service-role REST emit in
 * src/lib/broadcast.ts does.
 *
 * Without a row present, "denied" and "allowed but nothing to see" are the same
 * observation, and every negative assertion below would pass vacuously.
 *
 */
async function seedBroadcast(db: PoolClient, topic: string): Promise<void> {
  await ensureTodayPartition(db);
  await db.query(
    `insert into realtime.messages (topic, extension, event, private, payload, inserted_at, updated_at)
     values ($1, 'broadcast', 'auto_matchmaking_toggled', true, '{"isOn": true}'::jsonb, now(), now())`,
    [topic]
  );
}

/**
 * Run `fn` under the role/claims/topic Realtime would install for a channel
 * join, then unwind. The savepoint is what restores the connection: `SET LOCAL`
 * and `set_config(..., true)` are both transactional, so rolling back to it
 * returns the session to the superuser role for the next case.
 *
 * `sub === null` models a caller with no JWT at all — role `anon`.
 */
async function asRealtimeCaller<T>(
  db: PoolClient,
  sub: string | null,
  topic: string,
  fn: () => Promise<T>
): Promise<T> {
  await db.query("savepoint rb_actor");
  try {
    await db.query(`set local role ${sub === null ? "anon" : "authenticated"}`);
    // Cleared explicitly rather than left to the savepoint: auth.uid() reads
    // this key FIRST and falls back to the JSON claims only when it is empty,
    // so a stale value here would silently outrank `sub`.
    await db.query(`select set_config('request.jwt.claim.sub', '', true)`);
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      sub === null ? "" : JSON.stringify({ sub, role: "authenticated" }),
    ]);
    await db.query(`select set_config('realtime.topic', $1, true)`, [topic]);
    return await fn();
  } finally {
    // Rollback alone does not pop the savepoint, and the name is re-declared on
    // every call — RB-7 would otherwise leave four nested ones on the
    // connection. Release keeps the stack flat.
    await db.query("rollback to savepoint rb_actor");
    await db.query("release savepoint rb_actor");
  }
}

/** The read half of Realtime's authorization check: how many rows survive RLS. */
async function visibleMessages(
  db: PoolClient,
  sub: string | null,
  joinTopic: string,
  readTopic = joinTopic
): Promise<number> {
  return asRealtimeCaller(db, sub, joinTopic, async () => {
    const { rows } = await db.query<{ n: string }>(
      `select count(*) n from realtime.messages where topic = $1`,
      [readTopic]
    );
    return Number(rows[0].n);
  });
}

/**
 * The write half: can this caller forge a broadcast? Returns the SQLSTATE and
 * the message, because 42501 alone does not say WHICH privilege check failed —
 * see RB-8.
 */
async function attemptForgery(
  db: PoolClient,
  sub: string | null,
  topic: string
): Promise<{ inserted: boolean; code?: string; message?: string }> {
  return asRealtimeCaller(db, sub, topic, async () => {
    try {
      await db.query(
        `insert into realtime.messages (topic, extension, event, private, payload, inserted_at, updated_at)
         values ($1, 'broadcast', 'session_closed', true, '{}'::jsonb, now(), now())`,
        [topic]
      );
      return { inserted: true };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { inserted: false, code: e.code, message: e.message };
    }
  });
}

async function addClubMember(clubId: string, playerId: string, isActive = true) {
  const { error } = await serviceClient()
    .from("club_members")
    .upsert(
      { club_id: clubId, player_id: playerId, role: "member" as const, is_active: isActive },
      { onConflict: "club_id,player_id" }
    );
  if (error) throw new Error(`[addClubMember] ${error.message}`);
}

// ── The suite ──────────────────────────────────────────────────

describe("Realtime broadcast RLS — Suite RB", () => {
  // ── Who may LISTEN ──────────────────────────────────────────

  it("RB-1: a plain club member may read the session's broadcast topic", async () => {
    // The regression 20260723100000's header calls out by name: the policy is
    // deliberately NOT `= 'organizer'`, because player-dashboard.tsx subscribes
    // ordinary players to this same topic for their "match cancelled" toast.
    // Tightening it would break every player-side toast, silently.
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    const player = await makeProfile({ faker });
    await addClubMember(LEGACY_CLUB_ID, player.id);

    await withTx(async (db) => {
      await seedBroadcast(db, topicFor(session.id));
      expect(await visibleMessages(db, player.id, topicFor(session.id))).toBe(1);
    });
  });

  it("RB-2: the session's organizer may read it", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });

    await withTx(async (db) => {
      await seedBroadcast(db, topicFor(session.id));
      expect(await visibleMessages(db, organizer.id, topicFor(session.id))).toBe(1);
    });
  });

  it("RB-3: a signed-in user who shares no club or session is refused", async () => {
    // ⭐ The finding itself. Before 20260723100000 the topic was public, so this
    // stranger received every organizer event for a club they do not belong to
    // — including organizer_intervention.actorName, a real member's display name.
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    const stranger = await makeProfile({ faker }); // deliberately in no club

    await withTx(async (db) => {
      await seedBroadcast(db, topicFor(session.id));
      expect(await visibleMessages(db, stranger.id, topicFor(session.id))).toBe(0);
    });
  });

  it("RB-4: belonging to one club does not open another club's topic", async () => {
    // Sharper than RB-3: this caller IS an active member of a club and CAN read
    // its topics. Only the topic→session→club chain denies them here, so this is
    // what proves realtime_topic_session_id() is consulted per join rather than
    // the policy collapsing to "any authenticated member of anything".
    const insider = await makeProfile({ faker });
    await addClubMember(LEGACY_CLUB_ID, insider.id);

    const otherOrganizer = await makeProfile({ faker });
    const otherSession = await makeSession({ faker, organizer: otherOrganizer.id });

    const { data: otherClub, error: clubErr } = await serviceClient()
      .from("clubs")
      .insert({
        name: "RB Other Club",
        slug: `rb-other-${faker.string.numeric(6)}`,
        created_by: otherOrganizer.id,
        is_active: true,
      })
      .select("id")
      .single();
    if (clubErr || !otherClub) throw new Error(`[RB-4] club insert: ${clubErr?.message}`);

    // Raw SQL, not the typed client: `club_id` is absent from SessionUpdate on
    // purpose — nothing in the app re-tenants a session, and this test is not a
    // reason to widen that type. queryCommitted() is withTx's documented escape
    // hatch for exactly this. The write commits, and truncateTracked() clears
    // sessions and the club in afterEach.
    const moved = await queryCommitted(`update public.sessions set club_id = $1 where id = $2`, [
      otherClub.id,
      otherSession.id,
    ]);
    if (moved.rowCount !== 1) throw new Error(`[RB-4] club_id update moved ${moved.rowCount} rows`);

    // Control: a session that stayed in the insider's own club. Its 1 below is
    // what makes the 0 the club boundary rather than a broken fixture.
    const ownOrganizer = await makeProfile({ faker });
    const ownSession = await makeSession({ faker, organizer: ownOrganizer.id });

    await withTx(async (db) => {
      await seedBroadcast(db, topicFor(otherSession.id));
      await seedBroadcast(db, topicFor(ownSession.id));

      expect(await visibleMessages(db, insider.id, topicFor(ownSession.id))).toBe(1);
      expect(await visibleMessages(db, insider.id, topicFor(otherSession.id))).toBe(0);
    });
  });

  it("RB-5: a deactivated club member goes dark", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    const player = await makeProfile({ faker });
    await addClubMember(LEGACY_CLUB_ID, player.id);

    await withTx(async (db) => {
      await seedBroadcast(db, topicFor(session.id));
      expect(await visibleMessages(db, player.id, topicFor(session.id))).toBe(1);
    });

    await addClubMember(LEGACY_CLUB_ID, player.id, false);

    await withTx(async (db) => {
      await seedBroadcast(db, topicFor(session.id));
      expect(await visibleMessages(db, player.id, topicFor(session.id))).toBe(0);
    });
  });

  it("RB-6: an unauthenticated caller is refused — there is no anon arm at all", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });

    await withTx(async (db) => {
      await seedBroadcast(db, topicFor(session.id));
      expect(await visibleMessages(db, null, topicFor(session.id))).toBe(0);
    });
  });

  it("RB-7: a malformed topic denies even the organizer, and does not raise", async () => {
    // realtime_topic_session_id() returns NULL rather than letting `::uuid`
    // raise 22P02 inside a policy — Postgres does not guarantee AND
    // short-circuits, so a bare cast behind a LIKE guard can still be
    // evaluated. NULL feeds session_access_level(), which denies. A raise here
    // would surface to the user as an opaque failed channel join.
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });

    await withTx(async (db) => {
      await seedBroadcast(db, topicFor(session.id));
      const malformed = [
        "session-events:not-a-uuid",
        "session-events:",
        "",
        `courts:${session.id}`,
      ];
      for (const joinTopic of malformed) {
        // Read the real topic's rows while JOINED to the malformed one: the
        // policy consults realtime.topic(), not the WHERE clause, so a 0 here
        // is the policy denying and not the filter missing.
        expect(await visibleMessages(db, organizer.id, joinTopic, topicFor(session.id))).toBe(0);
      }
    });
  });

  // ── Who may SEND ────────────────────────────────────────────

  it("RB-8: nobody may INSERT — not a stranger, not even the organizer", async () => {
    // ⭐ The forgery half, which was not in the original finding and is the worse
    // one: on a public topic, `channel.send({event:'session_closed'})` from any
    // browser console redirects every player in that session to their Wrapped
    // page. 20260723100000 ships NO insert policy, so every legitimate emit has
    // to come from the server's service-role key, which bypasses RLS.
    //
    // ⚠️ 42501 alone does NOT prove RLS did the refusing. It is
    // ERRCODE_INSUFFICIENT_PRIVILEGE, raised identically for "permission denied
    // for table messages" (missing GRANT, checked in the executor) and for "new
    // row violates row-level security policy" (empty policy set). Those are
    // different closures with different blast radii — a migration that revoked
    // the GRANT instead would keep a code-only assertion green while the claim
    // in APP_MANIFEST §3.35 quietly stopped being true. So this asserts all
    // three: the GRANT is present, the insert failed, and the failure names RLS.
    //
    // If a future migration ever adds a `for all` policy — pg_policies reports
    // cmd='ALL', which confers INSERT just the same — this test fails.
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    const stranger = await makeProfile({ faker });
    const topic = topicFor(session.id);

    await withTx(async (db) => {
      // Without today's partition, tuple routing raises 23514 in ExecInsert
      // before the WITH CHECK is ever reached, and this test would assert the
      // wrong error. RB-8 does not seed, so it has to ask for it itself.
      await ensureTodayPartition(db);

      const { rows: grants } = await db.query<{ role: string; has: boolean }>(
        `select r role, has_table_privilege(r, 'realtime.messages', 'insert') has
         from unnest(array['anon', 'authenticated']) r`
      );
      for (const g of grants) {
        expect(`${g.role}=${g.has}`).toBe(`${g.role}=true`);
      }

      for (const sub of [organizer.id, stranger.id, null]) {
        const result = await attemptForgery(db, sub, topic);
        expect(result.inserted).toBe(false);
        expect(result.code).toBe("42501");
        expect(result.message).toMatch(/row-level security/i);
      }
    });
  });
});
