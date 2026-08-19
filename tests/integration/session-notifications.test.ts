// ============================================================
// Suite SN — session_notifications: table, RPC, grants, RLS (Real DB)
// ============================================================
// 20260818_session_notifications shipped a table, two partial-unique indexes,
// an RLS policy, a REVOKE/GRANT block and a SECURITY DEFINER RPC, and five
// server actions were built on top of it. No test named any of them. This
// suite is that coverage.
//
// Two things here are load-bearing and invisible to a mock:
//
//   1. `session_notifications_pending_correction_idx` is a PARTIAL unique
//      index (`WHERE status IN ('unread','read')`). "One pending correction
//      per match, but a new one is allowed once the last is resolved" is
//      enforced entirely by that predicate. A mocked insert cannot fail it,
//      so the duplicate branch in requestScoreCorrection is unreachable
//      outside a real database.
//
//   2. The migration's own comment states the defence: "Do not GRANT INSERT
//      to authenticated — a bare insert policy would let any signed-in user
//      park a pending row on any match_id and block the real requester."
//      That defence is an ABSENT grant. Nothing in the schema declares it,
//      so nothing but a test that tries the insert can notice it coming back.
//
//   SN-1   list: organizer sees the session's notices; a non-organizer and an
//          anonymous caller are refused
//   SN-2   a seated player's correction request lands a real row
//   SN-3   the partial unique holds one pending per match — and RELEASES once
//          the pending row is resolved
//   SN-4   a player who was never in the match cannot request a correction
//   SN-5   resolve rewrites the match score and stamps the notice resolved
//   SN-6   resolving twice reports alreadyResolved and does NOT rewrite again
//   SN-7   a foreign organizer cannot resolve another session's notice
//   SN-8   RLS: a player reads only their OWN correction rows
//   SN-9   `authenticated` holds no INSERT — the park-a-pending-row DoS the
//          migration comment describes is refused by the grant, not by app code
//   SN-10  resolve refuses when the match is no longer completed
//   SN-11  the pause bucket unique collapses repeat reminders per bucket
//   SN-12  resolve_score_correction is SECURITY DEFINER and EXECUTE-able by
//          the service role alone — anon and authenticated are revoked
//
// What this does NOT cover: the realtime broadcast side of emitOrganizerNotice
// (Suite RB owns broadcast authorization), the organizer UI, and Web Push.
//
// ── DISCRIMINATOR EVIDENCE ──────────────────────────────────
// Every case below was watched failing before it was trusted. Each mutant was
// applied to the local database or to notifications.ts, the suite was run, and
// the original restored; the baseline was re-run green after each.
//
//   M1  DROP session_notifications_pending_correction_idx        → kills SN-3
//   M2  same index rebuilt WITHOUT the status predicate          → kills SN-3
//       (the half a plain unique breaks: a player could appeal once, ever)
//   M3  GRANT INSERT + permissive insert policy to authenticated → kills SN-9
//   M4  RLS policy widened to USING (true)                       → kills SN-8
//   M5  RPC UPDATE loses `AND status = 'completed'`              → kills SN-10
//   M6  requestScoreCorrection loses the match-seat check        → kills SN-4
//   M7  resolveScoreCorrection loses the isSessionOrganizer gate → kills SN-7
//   M8  DROP session_notifications_pause_bucket_idx              → kills SN-11
//
// SN-1, SN-2, SN-5 and SN-6 are happy-path and ordering cases and were not
// mutation-proved; they are here to pin behaviour a reader would otherwise
// have to infer from the RPC body.
//
// Isolation: Layer B — truncateTracked() in afterEach.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import { makeProfile, makeSession, makeCompletedMatch, makeCourt } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { withTx } from "./helpers/withTx";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import {
  listSessionNotifications,
  requestScoreCorrection,
  resolveScoreCorrection,
  listMyScoreCorrections,
  markNotificationRead,
} from "@/app/actions/notifications";

const faker = new Faker({ locale: [en] });
faker.seed(8801);

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

// ── Shared setup ───────────────────────────────────────────────

/**
 * Organizer + active session + one completed 2v2 match, with p1..p4 seated.
 * `outsider` is a real profile who never played in it.
 */
async function correctionSetup() {
  const organizer = await makeProfile({ faker });
  const session = await makeSession({ faker, organizer: organizer.id });
  const court = await makeCourt({ sessionId: session.id, name: "Court 1" });

  const [p1, p2, p3, p4, outsider] = await Promise.all([
    makeProfile({ faker }),
    makeProfile({ faker }),
    makeProfile({ faker }),
    makeProfile({ faker }),
    makeProfile({ faker }),
  ]);

  const match = await makeCompletedMatch({
    sessionId: session.id,
    teamA: [p1.id, p2.id],
    teamB: [p3.id, p4.id],
    scoreA: 21,
    scoreB: 15,
    courtId: court.id,
  });

  return { organizer, session, match, p1, p2, p3, p4, outsider };
}

async function noticeRows(sessionId: string) {
  const { data, error } = await serviceClient()
    .from("session_notifications")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`[noticeRows] ${error.message}`);
  return data ?? [];
}

async function matchScore(matchId: string) {
  const { data } = await serviceClient()
    .from("matches")
    .select("team_a_score, team_b_score, status")
    .eq("id", matchId)
    .single();
  return data!;
}

describe("session_notifications — Suite SN", () => {
  it("SN-1: only an organizer of THAT session can list its notices", async () => {
    const { organizer, session, match, p1, outsider } = await correctionSetup();

    mockAuthAs(p1.id);
    await requestScoreCorrection(match.id, 21, 19);

    mockAuthAs(organizer.id);
    const asOrganizer = await listSessionNotifications(session.id);
    expect(asOrganizer.success).toBe(true);
    expect(asOrganizer.notifications).toHaveLength(1);
    expect(asOrganizer.notifications[0].kind).toBe("score_correction");

    mockAuthAs(outsider.id);
    const asPlayer = await listSessionNotifications(session.id);
    expect(asPlayer).toMatchObject({ success: false, error: "Not authorized." });
    expect(asPlayer.notifications).toEqual([]);

    clearMockAuth();
    const asAnon = await listSessionNotifications(session.id);
    expect(asAnon).toMatchObject({ success: false, error: "Not authenticated." });
  });

  it("SN-2: a seated player's request lands a real row with the proposed score", async () => {
    const { session, match, p3 } = await correctionSetup();

    mockAuthAs(p3.id);
    const res = await requestScoreCorrection(match.id, 19, 21);
    expect(res).toMatchObject({ success: true, message: "Correction requested." });

    const rows = await noticeRows(session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "score_correction",
      status: "unread",
      subject_player_id: p3.id,
      match_id: match.id,
      resolved_by: null,
      resolved_at: null,
    });
    // The proposal is carried in the payload, not applied to the match yet.
    expect(rows[0].payload).toMatchObject({ proposedScoreA: 19, proposedScoreB: 21 });
    expect(await matchScore(match.id)).toMatchObject({ team_a_score: 21, team_b_score: 15 });

    // The requester can see their own row back through the player-facing list.
    const mine = await listMyScoreCorrections(session.id);
    expect(mine.success).toBe(true);
    expect(mine.notifications.map((n) => n.id)).toEqual([rows[0].id]);
  });

  it("SN-3: one pending correction per match — and the slot frees once resolved", async () => {
    const { organizer, session, match, p1, p2 } = await correctionSetup();

    mockAuthAs(p1.id);
    expect(await requestScoreCorrection(match.id, 21, 19)).toMatchObject({ success: true });

    // Second request while the first is still pending — refused by the partial
    // unique index (23505), surfaced as the duplicate branch. A different
    // player is used deliberately: the constraint is per MATCH, not per player.
    mockAuthAs(p2.id);
    const dupe = await requestScoreCorrection(match.id, 15, 21);
    expect(dupe).toMatchObject({
      success: false,
      error: "A correction is already pending for this match.",
    });
    expect(await noticeRows(session.id)).toHaveLength(1);

    // Resolve it, which moves status out of ('unread','read') and therefore
    // out of the index predicate.
    const pending = (await noticeRows(session.id))[0];
    mockAuthAs(organizer.id);
    expect(await resolveScoreCorrection(pending.id, 21, 19)).toMatchObject({ success: true });

    // Now a fresh request is allowed again. This is the half a full (non-partial)
    // unique index would silently break — the player could never appeal twice.
    mockAuthAs(p2.id);
    expect(await requestScoreCorrection(match.id, 21, 18)).toMatchObject({ success: true });
    expect(await noticeRows(session.id)).toHaveLength(2);
  });

  it("SN-4: a player who was not in the match cannot request a correction on it", async () => {
    const { session, match, outsider } = await correctionSetup();

    mockAuthAs(outsider.id);
    const res = await requestScoreCorrection(match.id, 21, 5);
    expect(res).toMatchObject({ success: false, error: "You were not in this match." });
    expect(await noticeRows(session.id)).toHaveLength(0);
  });

  it("SN-5: resolving rewrites the match score and stamps the notice", async () => {
    const { organizer, session, match, p1 } = await correctionSetup();

    mockAuthAs(p1.id);
    await requestScoreCorrection(match.id, 21, 19);
    const pending = (await noticeRows(session.id))[0];

    mockAuthAs(organizer.id);
    const res = await resolveScoreCorrection(pending.id, 21, 19);
    expect(res.success).toBe(true);

    expect(await matchScore(match.id)).toMatchObject({
      team_a_score: 21,
      team_b_score: 19,
      status: "completed",
    });

    const after = (await noticeRows(session.id))[0];
    expect(after.status).toBe("resolved");
    expect(after.resolved_by).toBe(organizer.id);
    expect(after.resolved_at).not.toBeNull();
  });

  it("SN-6: resolving twice reports alreadyResolved and does not rewrite the score", async () => {
    const { organizer, session, match, p1 } = await correctionSetup();

    mockAuthAs(p1.id);
    await requestScoreCorrection(match.id, 21, 19);
    const pending = (await noticeRows(session.id))[0];

    mockAuthAs(organizer.id);
    await resolveScoreCorrection(pending.id, 21, 19);

    // Second organizer click on a stale card — a different score, to prove the
    // match is not silently rewritten by the losing caller.
    const second = await resolveScoreCorrection(pending.id, 5, 21);
    expect(second.success).toBe(false);
    expect(second.alreadyResolved).toBe(true);
    expect(second.actorName).toBeTruthy();
    // The UI shows the score that actually stands.
    expect(second.currentScoreA).toBe(21);
    expect(second.currentScoreB).toBe(19);

    expect(await matchScore(match.id)).toMatchObject({ team_a_score: 21, team_b_score: 19 });
  });

  it("SN-7: an organizer of a DIFFERENT session cannot resolve or read this notice", async () => {
    const { session, match, p1 } = await correctionSetup();
    const foreign = await makeProfile({ faker });
    await makeSession({ faker, organizer: foreign.id });

    mockAuthAs(p1.id);
    await requestScoreCorrection(match.id, 21, 19);
    const pending = (await noticeRows(session.id))[0];

    mockAuthAs(foreign.id);
    expect(await resolveScoreCorrection(pending.id, 5, 21)).toMatchObject({
      success: false,
      error: "Not authorized.",
    });
    expect(await markNotificationRead(pending.id)).toMatchObject({
      success: false,
      error: "Not authorized.",
    });

    // Untouched: still pending, original score.
    expect((await noticeRows(session.id))[0].status).toBe("unread");
    expect(await matchScore(match.id)).toMatchObject({ team_a_score: 21, team_b_score: 15 });

    // A notice id that does not exist answers "not found" rather than
    // "not authorized". The ids are opaque v4 UUIDs and are never listed to a
    // non-organizer, so the distinction leaks only existence of a random UUID
    // — the same disposition the tenancy audit recorded for #9. Pinned here so
    // the choice stays deliberate instead of drifting silently.
    const absent = await resolveScoreCorrection("00000000-0000-4000-8000-0000000000ff", 21, 5);
    expect(absent).toMatchObject({ success: false, error: "Notification not found." });
  });

  it("SN-8: RLS lets a player read only their own correction rows", async () => {
    const { session, match, p1, p3 } = await correctionSetup();

    mockAuthAs(p1.id);
    await requestScoreCorrection(match.id, 21, 19);
    const row = (await noticeRows(session.id))[0];

    await withTx(async (db) => {
      const asPlayer = async (sub: string | null) => {
        await db.query("savepoint sn_actor");
        try {
          await db.query(`set local role ${sub === null ? "anon" : "authenticated"}`);
          await db.query(`select set_config('request.jwt.claim.sub', '', true)`);
          await db.query(`select set_config('request.jwt.claims', $1, true)`, [
            sub === null ? "" : JSON.stringify({ sub, role: "authenticated" }),
          ]);
          const res = await db.query("select id from public.session_notifications where id = $1", [
            row.id,
          ]);
          return res.rowCount ?? 0;
        } finally {
          await db.query("rollback to savepoint sn_actor");
          await db.query("release savepoint sn_actor");
        }
      };

      // The subject of the correction sees their row.
      expect(await asPlayer(p1.id)).toBe(1);
      // Another player in the same match does not.
      expect(await asPlayer(p3.id)).toBe(0);
      // Anonymous sees nothing — anon holds no grant at all.
      await expect(asPlayer(null)).rejects.toThrow(/permission denied/i);
    });
  });

  it("SN-9: `authenticated` cannot INSERT — the park-a-pending-row DoS is refused by the grant", async () => {
    const { session, match, outsider } = await correctionSetup();

    await withTx(async (db) => {
      await db.query("set local role authenticated");
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: outsider.id, role: "authenticated" }),
      ]);

      // A signed-in stranger tries to occupy the one pending slot on a match
      // they never played in. If INSERT is ever granted to `authenticated`,
      // this succeeds and the real players can never file a correction.
      await expect(
        db.query(
          `insert into public.session_notifications
             (session_id, kind, subject_player_id, match_id, payload)
           values ($1, 'score_correction', $2, $3, '{}'::jsonb)`,
          [session.id, outsider.id, match.id]
        )
      ).rejects.toThrow(/permission denied/i);
    });

    expect(await noticeRows(session.id)).toHaveLength(0);
  });

  it("SN-10: resolve refuses once the match is no longer completed", async () => {
    const { organizer, session, match, p1 } = await correctionSetup();

    mockAuthAs(p1.id);
    await requestScoreCorrection(match.id, 21, 19);
    const pending = (await noticeRows(session.id))[0];

    // The organizer reverted the match to live play while the card sat on screen.
    await serviceClient().from("matches").update({ status: "in_progress" }).eq("id", match.id);

    mockAuthAs(organizer.id);
    const res = await resolveScoreCorrection(pending.id, 21, 19);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no longer completed/i);

    // The notice is left pending so the organizer can act on it after the
    // match completes again — not burned by the failed attempt.
    expect((await noticeRows(session.id))[0].status).toBe("unread");
  });

  it("SN-11: the pause-bucket unique collapses repeat reminders in the same bucket", async () => {
    const { session, p1 } = await correctionSetup();
    const svc = serviceClient();

    const insert = (bucket: number) =>
      svc.from("session_notifications").insert({
        session_id: session.id,
        kind: "player_paused_long" as const,
        subject_player_id: p1.id,
        payload: { playerName: "Paused Player", bucket },
      });

    expect((await insert(15)).error).toBeNull();
    // Same session + player + bucket → refused, so the organizer is nagged once.
    expect((await insert(15)).error?.code).toBe("23505");
    // A later bucket is a genuinely new escalation and is allowed through.
    expect((await insert(30)).error).toBeNull();

    expect(await noticeRows(session.id)).toHaveLength(2);
  });

  it("SN-12: resolve_score_correction is callable only by the service role", async () => {
    // SN-7 proves resolveScoreCorrection refuses a foreign organizer. That
    // guard lives in TypeScript, and the RPC underneath it rewrites a match
    // score with SECURITY DEFINER authority — so the guard is only worth
    // anything if a signed-in player cannot reach the RPC directly and skip
    // it. What stops them is the migration's REVOKE, not any code: a function
    // whose EXECUTE was left at the PUBLIC default is callable by every
    // authenticated session over PostgREST.
    //
    // This is the shape the repo has been bitten by repeatedly — the check
    // and the privileged write sitting on opposite sides of a boundary
    // nothing asserts.
    const fn = await withTx(async (db) => {
      const res = await db.query(
        `select p.prosecdef,
                has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
                has_function_privilege('service_role', p.oid, 'EXECUTE') as sr_exec
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'resolve_score_correction'`
      );
      return res.rows;
    });
    expect(fn).toHaveLength(1);
    expect(fn[0]).toEqual({
      prosecdef: true,
      anon_exec: false,
      auth_exec: false,
      sr_exec: true,
    });
  });
});
