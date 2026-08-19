// ============================================================
// Suite QSA — queue visibility: who can be seen, and who changed it (Real DB)
// ============================================================
// Two database objects exist to answer one recurring incident question,
// "why can't I see <player> in Match Control?", from opposite ends:
//
//   * `v_queue_full_with_wait_time` decides who is visible RIGHT NOW. Its
//     WHERE clause is the whole contract — a status silently dropped from it
//     makes a player vanish from the organizer's queue while they are still
//     very much in the session.
//   * `queue_status_events` + `log_queue_status_change()` say who changed it
//     AFTERWARDS. 20260815_queue_status_audit exists because queue_entries has
//     no history and status is mutated from a dozen code paths.
//
// Neither was named by any test before this file.
//
// The audit trigger is the more dangerous of the two to leave uncovered,
// because it is deliberately best-effort:
//
//     EXCEPTION WHEN OTHERS THEN
//       -- Audit logging must NEVER break a queue status update.
//       NULL;
//
// That swallow is correct — and it means a permanently broken audit trail is
// indistinguishable, from the application's side, from a quiet one. Nothing
// goes red. The organizer notices months later, during the next incident,
// that the table they were told to consult is empty. The only way to know the
// trigger still fires is to make a real status transition and look.
//
//   QSA-1   a real server action's transition (checkoutPlayer: waiting→left)
//           lands one audit row with the right session, player and statuses
//   QSA-2   a direct service-client write logs too — the migration's claim is
//           "EVERY status transition regardless of which code path made it"
//   QSA-3   a same-value status write and a non-status write log NOTHING
//           (the WHEN clause and `UPDATE OF status`)
//   QSA-4   THE BEST-EFFORT PROMISE: with the audit insert forced to fail, the
//           queue status update still commits and the action still succeeds
//   QSA-5   actor_uid is the JWT `sub` when there is one, NULL for the
//           service-role callers every server action actually uses
//   QSA-6   a multi-step life (waiting→drafted→on_deck→playing→waiting→left)
//           leaves an
//           ordered, contiguous trail — the thing an incident is read from
//   QSA-7   the trail is not readable by anon or authenticated, and is doubly
//           defended: no SELECT grant AND RLS with no policy
//   QSA-8   the display view shows waiting/drafted/on_deck and hides
//           playing/left, ordered on_deck → drafted → waiting
//   QSA-9   the view is security_invoker, so `anon` — which does hold an
//           explicit SELECT grant on it (20260722000003) — still reads
//           nothing through it
//   QSA-10  the service role can read and prune the trail but cannot forge a
//           row — the privileges 20260815 never stated, declared by
//           20260818120000
//   QSA-11  the trigger function is SECURITY DEFINER with a pinned
//           search_path — why the trail filled while nothing could read it
//
// ── DISCRIMINATOR EVIDENCE ──────────────────────────────────
// Each mutant was applied to the local database, the suite run, the original
// restored, and the baseline re-run green.
//
//   M12  DROP TRIGGER trg_log_queue_status_change      → kills QSA-1,2,3,5,6,7,10
//   M13  trigger recreated without the WHEN clause     → kills QSA-3 only
//   M14  the EXCEPTION handler removed (error escapes) → kills QSA-4 only
//   M15  actor read from ->>'user_id' instead of 'sub' → kills QSA-5 only
//   M16  view WHERE loses 'drafted'                    → kills QSA-8 only
//   M17  view set (security_invoker = false)           → kills QSA-9 only
//   M18  log_queue_status_change → SECURITY INVOKER    → kills QSA-1,2,3,5,6,7,10,11
//   M19  REVOKE omits service_role (inherits Dxtm)     → kills QSA-10 only
//
// M12 is the blunt one — a dead trigger takes down every case that needs a
// row to exist, including QSA-3's sanity check and the preconditions of QSA-7
// and QSA-10. That breadth is the point: if the audit ever stops firing, this
// file does not go quietly amber, it goes hard red in seven places. The five
// narrow mutants are what show the cases are not merely all asserting "some
// row appeared" — each pins a distinct property and dies alone.
//
// M18 is M12's blast radius plus QSA-11, and the overlap is the whole reason
// QSA-11 is here. Demoting the trigger function to SECURITY INVOKER makes it
// run as the caller, the insert is refused for want of a grant, and the
// refusal vanishes into the swallowed EXCEPTION — so the *symptom* is an empty
// trail, identical in every observable way to the trigger having been dropped.
// M19 is the mutant that found a real bug in the first draft of
// 20260818120000: its REVOKE named PUBLIC, anon and authenticated but not
// service_role, and a REVOKE only touches the roles it names. The subsequent
// GRANT SELECT, DELETE is a no-op against a role that already holds more, so
// on production — where the default ACL is arwdDxtm — the "withheld"
// INSERT/UPDATE would still have been held. Locally the default is only Dxtm,
// which is why QSA-10's ins/upd booleans stayed green throughout and the
// TRUNCATE assertion is the one that catches it. A test that agrees with the
// environment's default instead of with the migration is not pinning anything.
//
// Only QSA-11 names the cause. Both blast radii were measured, not predicted:
// M12 and M18 were each applied, the suite run, the original restored and the
// baseline re-run green. The first draft of this table guessed narrower for
// both, which is the same mistake in miniature as trusting the migration's
// comment about who could read the table.
//
// QSA-9's second half is proved without a mutant: it grants SELECT to
// `authenticated` inside the rolled-back transaction and shows RLS still
// returns zero rows — the second defence demonstrated rather than assumed.
//
// Isolation: Layer B — truncateTracked() in afterEach. queue_status_events is
// wiped there too; it has no FK to anything, so nothing else cascades it and
// before this suite it accumulated silently across whole runs.
// ============================================================

import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { Faker, en } from "@faker-js/faker";
import { makeProfile, makeSession, makeQueueEntry } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { withTx, queryCommitted } from "./helpers/withTx";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import { checkoutPlayer } from "@/app/actions/queue";
import type { QueueStatus } from "@/types/database";

const faker = new Faker({ locale: [en] });
faker.seed(8815);

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

// QSA-4 adds a constraint that makes EVERY audit insert fail, and drops it in
// a `finally`. A `finally` does not run if the worker is killed between the
// two, and the leftover constraint would then break the audit trail on this
// database permanently — failing into the swallowed EXCEPTION, which is the
// exact silent failure this suite exists to detect. Clearing it up front costs
// one statement and makes the damage un-sticky.
beforeAll(async () => {
  await queryCommitted(
    `alter table public.queue_status_events drop constraint if exists qsa_forced_failure`
  );
});

// ── Shared setup ───────────────────────────────────────────────

/** An organizer, an active session, and one waiting player in it. */
async function seedWaitingPlayer() {
  const organizer = await makeProfile({ faker });
  const player = await makeProfile({ faker });
  const session = await makeSession({ faker, organizer: organizer.id });
  const entry = await makeQueueEntry({ sessionId: session.id, playerId: player.id });
  return { organizer, player, session, entry };
}

/** Every audit row for one player, oldest first. */
async function auditTrail(playerId: string) {
  const { data, error } = await serviceClient()
    .from("queue_status_events")
    .select("session_id, player_id, old_status, new_status, actor_uid, changed_at")
    .eq("player_id", playerId)
    .order("changed_at", { ascending: true });
  if (error) throw new Error(`[auditTrail] ${error.message}`);
  return data ?? [];
}

/** Moves a queue row's status the way the engine does: service client, no JWT. */
async function setStatus(entryId: string, status: QueueStatus) {
  const { error } = await serviceClient()
    .from("queue_entries")
    .update({ status })
    .eq("id", entryId);
  if (error) throw new Error(`[setStatus] ${error.message}`);
}

// ── The audit trail ────────────────────────────────────────────

describe("Suite QSA — queue_status_events audit trail", () => {
  it("QSA-1: a checkoutPlayer transition lands one audit row", async () => {
    const { player, session, entry } = await seedWaitingPlayer();

    mockAuthAs(player.id);
    const result = await checkoutPlayer(session.id);
    expect(result.success).toBe(true);

    const trail = await auditTrail(player.id);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      session_id: session.id,
      player_id: player.id,
      old_status: "waiting",
      new_status: "left",
    });

    // The row must describe the entry that actually moved.
    const { data: after } = await serviceClient()
      .from("queue_entries")
      .select("status")
      .eq("id", entry.id)
      .single();
    expect(after?.status).toBe("left");
  });

  it("QSA-2: a direct service-client write is logged the same way", async () => {
    const { player, entry } = await seedWaitingPlayer();

    // No server action, no JWT — the shape every engine write has.
    await setStatus(entry.id, "on_deck");

    const trail = await auditTrail(player.id);
    expect(trail).toHaveLength(1);
    expect(trail[0].old_status).toBe("waiting");
    expect(trail[0].new_status).toBe("on_deck");
  });

  it("QSA-3: a same-value status write and a non-status write log nothing", async () => {
    const { player, entry } = await seedWaitingPlayer();

    // Same value: the trigger's WHEN (OLD.status IS DISTINCT FROM NEW.status).
    await setStatus(entry.id, "waiting");
    expect(await auditTrail(player.id)).toHaveLength(0);

    // A different column entirely: the trigger is UPDATE OF status.
    const { error } = await serviceClient()
      .from("queue_entries")
      .update({ games_played: 3 })
      .eq("id", entry.id);
    expect(error).toBeNull();
    expect(await auditTrail(player.id)).toHaveLength(0);

    // Sanity: the same helper DOES log when the status really changes, so the
    // two empty results above are the WHEN clause and not a dead trigger.
    await setStatus(entry.id, "drafted");
    expect(await auditTrail(player.id)).toHaveLength(1);
  });

  it("QSA-4: a failing audit insert does not block the queue update", async () => {
    const { player, session, entry } = await seedWaitingPlayer();

    // Force every audit insert to fail. This is the only way to exercise the
    // EXCEPTION handler the migration's whole design rests on: in normal
    // operation it is unreachable, and if it were ever removed the app would
    // look fine until the day the audit table broke and took queue checkout
    // down with it.
    await queryCommitted(
      `alter table public.queue_status_events
         add constraint qsa_forced_failure check (new_status <> new_status) not valid`
    );

    try {
      mockAuthAs(player.id);
      const result = await checkoutPlayer(session.id);

      // The user-visible operation is unaffected...
      expect(result.success).toBe(true);
      const { data: after } = await serviceClient()
        .from("queue_entries")
        .select("status")
        .eq("id", entry.id)
        .single();
      expect(after?.status).toBe("left");

      // ...and the audit simply has nothing to show for it.
      expect(await auditTrail(player.id)).toHaveLength(0);
    } finally {
      await queryCommitted(
        `alter table public.queue_status_events drop constraint if exists qsa_forced_failure`
      );
    }
  });

  it("QSA-5: actor_uid is the JWT sub when present, NULL for service-role writes", async () => {
    const { player, entry } = await seedWaitingPlayer();

    // Service-role write — no request.jwt.claims is ever set on that
    // connection, so the migration documents actor_uid as a hint, not proof.
    await setStatus(entry.id, "drafted");

    // A write made while a JWT IS in scope. queue_entries carries no
    // anon/authenticated UPDATE grant (revoked so an organizer could not
    // repoint player_id), so the claims are set on a privileged connection
    // rather than by switching role — what is under test is the trigger's
    // claim extraction, not who is allowed to write.
    //
    // All of it inside ONE withTx, and `set_config(..., true)` is transaction-
    // scoped, for two reasons that are easy to get wrong. A `false` here is
    // *session*-scoped: it survives on whichever pooled connection served it,
    // so a later unrelated test that happens to draw that connection inherits
    // a stranded JWT claim and records the wrong actor. And the update and the
    // read must share a connection to be sure they share that setting — three
    // separate queryCommitted calls only do so by the pool's LIFO accident.
    // The rollback discards the on_deck row; the assertions have already run,
    // and the 'drafted' row above was committed before we got here.
    const trail = await withTx(async (db) => {
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: player.id, role: "authenticated" }),
      ]);
      await db.query(`update public.queue_entries set status = 'on_deck' where id = $1`, [
        entry.id,
      ]);
      const res = await db.query<{ new_status: string; actor_uid: string | null }>(
        `select new_status, actor_uid
           from public.queue_status_events
          where player_id = $1
          order by changed_at asc, id asc`,
        [player.id]
      );
      return res.rows;
    });

    expect(trail).toHaveLength(2);
    expect(trail[0].new_status).toBe("drafted");
    expect(trail[0].actor_uid).toBeNull();
    expect(trail[1].new_status).toBe("on_deck");
    expect(trail[1].actor_uid).toBe(player.id);
  });

  it("QSA-6: a full queue life leaves an ordered, contiguous trail", async () => {
    const { player, entry } = await seedWaitingPlayer();

    const life: QueueStatus[] = ["drafted", "on_deck", "playing", "waiting", "left"];
    for (const status of life) await setStatus(entry.id, status);

    const trail = await auditTrail(player.id);
    expect(trail.map((r) => r.new_status)).toEqual(life);

    // Contiguity is what makes the trail readable during an incident: each
    // row's old_status must be the previous row's new_status, with no gap.
    expect(trail.map((r) => r.old_status)).toEqual(["waiting", ...life.slice(0, -1)]);

    const times = trail.map((r) => new Date(r.changed_at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("QSA-7: neither anon nor authenticated can read the trail", async () => {
    const { player, entry } = await seedWaitingPlayer();
    await setStatus(entry.id, "left");
    expect(await auditTrail(player.id)).toHaveLength(1);

    // First defence: no SELECT privilege at all.
    const grants = await queryCommitted(
      `select has_table_privilege('anon','public.queue_status_events','SELECT') as anon,
              has_table_privilege('authenticated','public.queue_status_events','SELECT') as auth`
    );
    expect(grants.rows[0]).toEqual({ anon: false, auth: false });

    // Second defence, shown rather than assumed: hand `authenticated` the
    // grant inside a transaction that is rolled back, and RLS-with-no-policy
    // still returns nothing. Without this the suite would pass on a table
    // whose RLS had been disabled, purely because of the missing grant.
    const visible = await withTx(async (db) => {
      await db.query(`grant select on public.queue_status_events to authenticated`);
      await db.query(`set local role authenticated`);
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: player.id, role: "authenticated" }),
      ]);
      const res = await db.query(`select id from public.queue_status_events`);
      return res.rowCount ?? 0;
    });
    expect(visible).toBe(0);
  });

  it("QSA-10: service_role can read and prune the trail, but never write it", async () => {
    // 20260815 said "only the service role (which bypasses RLS) can read it"
    // and then granted nobody anything, so what the table actually got was
    // whatever ALTER DEFAULT PRIVILEGES was in force — and the environments
    // disagree. Here (and on any from-scratch replay) that is `Dxtm`: no
    // SELECT, so every PostgREST read came back `permission denied` before
    // RLS was ever consulted. On production it is `arwdDxtm`, which handed
    // anon full DML on an audit trail with RLS as the only thing in the way.
    // 20260818120000 states the privileges instead of inheriting them; this
    // case is what keeps them stated.
    //
    // WHICH OF THESE ASSERTIONS ACTUALLY DISCRIMINATE, AND WHERE:
    // `ins`/`upd` do NOT discriminate on a local database — the local default
    // ACL already withholds them, so they read false with or without this
    // migration. They pin the intended production end-state, nothing more.
    // `trunc` is the one that catches a REVOKE which forgot to name
    // service_role: the inherited default is `Dxtm`, so TRUNCATE arrives for
    // free in BOTH environments and only an explicit REVOKE takes it away.
    // The anon/authenticated arm is the same trick from the other side.
    const privs = await queryCommitted(
      `select has_table_privilege('service_role','public.queue_status_events','SELECT')   as sel,
              has_table_privilege('service_role','public.queue_status_events','DELETE')   as del,
              has_table_privilege('service_role','public.queue_status_events','INSERT')   as ins,
              has_table_privilege('service_role','public.queue_status_events','UPDATE')   as upd,
              has_table_privilege('service_role','public.queue_status_events','TRUNCATE') as trunc`
    );
    expect(privs.rows[0]).toEqual({
      sel: true,
      del: true,
      ins: false,
      upd: false,
      trunc: false,
    });

    // anon and authenticated hold NOTHING — not even the TRIGGER/REFERENCES/
    // TRUNCATE crumbs the default ACL hands out. Asserted as an empty list of
    // held privileges rather than a fixed set of booleans so the failure
    // message names which privilege survived, on which role, instead of
    // reporting `false !== true` with no subject. The privilege list is
    // complete for PostgreSQL 17; a future privilege type would have to be
    // added here, so this is not self-extending.
    const others = await queryCommitted(
      `select r.rolname as grantee,
              string_agg(p.priv, ',' order by p.priv) as held
         from unnest(array['anon','authenticated']) as r(rolname)
         cross join unnest(array['SELECT','INSERT','UPDATE','DELETE',
                                 'TRUNCATE','REFERENCES','TRIGGER',
                                 'MAINTAIN']) as p(priv)
        where has_table_privilege(r.rolname, 'public.queue_status_events', p.priv)
        group by r.rolname`
    );
    expect(others.rows).toEqual([]);

    // And the read actually works through the client the app would use — the
    // grant assertion above is about the ACL, this is about the API.
    const { player, session, entry } = await seedWaitingPlayer();
    await setStatus(entry.id, "left");
    const { data, error } = await serviceClient()
      .from("queue_status_events")
      .select("new_status")
      .eq("player_id", player.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);

    // Forging a transition through the API stays refused by the grant.
    const forged = await serviceClient().from("queue_status_events").insert({
      session_id: session.id,
      player_id: player.id,
      old_status: "waiting",
      new_status: "playing",
      actor_uid: null,
    });
    // 42501 specifically. `not.toBeNull()` would also pass on a typo'd column
    // or a constraint violation, which would make this case look like it was
    // testing the grant while testing something else entirely.
    expect(forged.error?.code).toBe("42501");
  });

  it("QSA-11: log_queue_status_change is SECURITY DEFINER with a pinned search_path", async () => {
    // This is why the trail kept filling on a database where service_role held
    // no privileges on the table at all: the writer is not the caller. The
    // trigger function runs as its owner, so the missing grant was invisible
    // from the write side and only ever showed up on the read side — which
    // nothing read. Pinning it here means the two halves cannot drift apart
    // again: if this function stopped being SECURITY DEFINER, every insert
    // would start failing into the swallowed EXCEPTION and the trail would go
    // silently empty, which is precisely the failure QSA-1 alone would catch
    // but could not explain.
    const fn = await queryCommitted(
      `select p.prosecdef, p.proconfig::text as config
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'log_queue_status_change'`
    );
    expect(fn.rows).toHaveLength(1);
    expect(fn.rows[0].prosecdef).toBe(true);
    // A SECURITY DEFINER function without a pinned search_path is a
    // privilege-escalation vector — a caller-controlled schema can shadow
    // `queue_status_events` and capture the insert.
    expect(fn.rows[0].config).toContain("search_path=");
    expect(fn.rows[0].config).toContain("public");
  });
});

// ── The display view ───────────────────────────────────────────

describe("Suite QSA — v_queue_full_with_wait_time", () => {
  it("QSA-8: shows waiting/drafted/on_deck, hides playing/left, in tier order", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });

    const seed = async (status: QueueStatus) => {
      const p = await makeProfile({ faker, displayName: `${status} player` });
      await makeQueueEntry({ sessionId: session.id, playerId: p.id, status });
      return p.id;
    };
    const waiting = await seed("waiting");
    const drafted = await seed("drafted");
    const onDeck = await seed("on_deck");
    const playing = await seed("playing");
    const left = await seed("left");

    const { data, error } = await serviceClient()
      .from("v_queue_full_with_wait_time")
      .select("player_id, status, status_priority, wait_minutes, is_bottleneck")
      .eq("session_id", session.id)
      .order("status_priority", { ascending: true });
    expect(error).toBeNull();

    const ids = (data ?? []).map((r) => r.player_id);
    expect(ids).toEqual([onDeck, drafted, waiting]);
    expect(ids).not.toContain(playing);
    expect(ids).not.toContain(left);
    expect((data ?? []).map((r) => r.status_priority)).toEqual([0, 1, 2]);

    // Freshly joined rows: the wait clock has started but nobody is stuck yet.
    for (const row of data ?? []) {
      expect(row.wait_minutes).toBeGreaterThanOrEqual(0);
      expect(row.wait_minutes).toBeLessThan(1);
      expect(row.is_bottleneck).toBe(false);
    }
  });

  it("QSA-9: security_invoker keeps the view shut to anon despite its SELECT grant", async () => {
    const organizer = await makeProfile({ faker });
    const player = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    await makeQueueEntry({ sessionId: session.id, playerId: player.id });

    // anon really can SELECT this view: 20260722000003 grants it explicitly,
    // restating production's platform baseline (the view's own migration,
    // 20260520000000, granted only authenticated and service_role — the
    // broader grant came later and from elsewhere). The GRANT is therefore
    // NOT what protects it —
    // security_invoker is, by making the underlying tables' RLS apply as the
    // caller. If the view ever reverted to a definer view, this leaks the
    // whole queue to logged-out callers.
    const granted = await queryCommitted(
      `select has_table_privilege('anon','public.v_queue_full_with_wait_time','SELECT') as anon,
              (select array_to_string(reloptions, ',') from pg_class
                where relname = 'v_queue_full_with_wait_time') as opts`
    );
    expect(granted.rows[0].anon).toBe(true);
    expect(granted.rows[0].opts).toContain("security_invoker=true");

    const visible = await withTx(async (db) => {
      await db.query(`set local role anon`);
      const res = await db.query(
        `select player_id from public.v_queue_full_with_wait_time where session_id = $1`,
        [session.id]
      );
      return res.rowCount ?? 0;
    });
    expect(visible).toBe(0);
  });
});
