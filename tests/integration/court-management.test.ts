// ============================================================
// Suite CX — court actions against real rows
// ============================================================
// courts.ts had NO test of any kind. Its three actions all follow this
// repo's highest-risk shape: authorize with isSessionOrganizer(user, sessionId),
// then write through createServiceClient(), which bypasses RLS entirely. When
// the service client is the writer there is no second line of defence — the
// .eq() bindings on the statement ARE the security boundary.
//
// The property this file exists to protect is the session-scope binding on
// updateCourtStatusAction and removeCourtAction:
//
//     .eq("id", courtId).eq("session_id", sessionId)
//
// Delete that second .eq and an organizer of Session A can mutate or destroy
// any court in Session B by passing their own sessionId alongside a foreign
// courtId. That is "authorize on A, operate on B" — the defect class this repo
// has now hit four separate times (tenancy audit #1, #4, #10b, #12). A unit
// test with a mocked client can assert the .eq() was recorded; only this file
// proves the real statement actually fails to reach the foreign row.
//
//   CX-1  Happy:    organizer adds a court
//   CX-2  Negative:  unauthenticated caller cannot add        (+ no row written)
//   CX-3  Negative:  a session player who is not the organizer cannot add
//   CX-4  Happy:    organizer updates their own court's status
//   CX-5  Negative:  organizer of A cannot update a court in B  ← cross-session
//   CX-6  Happy:    organizer removes their own court
//   CX-7  Negative:  organizer of A cannot remove a court in B  ← cross-session
//   CX-8  Edge:     a courtId that does not exist is a silent no-op
//
// CX-5 and CX-7 each carry a POSITIVE CONTROL in the same test: the same
// organizer performing the same call against their OWN court must succeed.
// Without it, both tests are equally satisfied by an action that is simply
// broken for everyone — which is precisely how a guard-order regression hides.
//
// Isolation: Layer B — truncateTracked() in afterEach.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import { makeProfile, makeSession, makeCourt, makeQueueEntry } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import { addCourtAction, updateCourtStatusAction, removeCourtAction } from "@/app/actions/courts";

const faker = new Faker({ locale: [en] });
faker.seed(20260821);

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

// ── Helpers ───────────────────────────────────────────────────

async function readCourt(courtId: string) {
  const { data } = await serviceClient()
    .from("courts")
    .select("id, name, status, session_id")
    .eq("id", courtId)
    .maybeSingle();
  return data;
}

async function countCourts(sessionId: string): Promise<number> {
  const { count } = await serviceClient()
    .from("courts")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId);
  return count ?? 0;
}

/** Two fully independent sessions with their own organizers and courts. */
async function seedTwoSessions() {
  const orgA = await makeProfile({ faker });
  const orgB = await makeProfile({ faker });
  const sessionA = await makeSession({ faker, organizer: orgA.id });
  const sessionB = await makeSession({ faker, organizer: orgB.id });
  const courtA = await makeCourt({ sessionId: sessionA.id, name: "A-1" });
  const courtB = await makeCourt({ sessionId: sessionB.id, name: "B-1" });
  return { orgA, orgB, sessionA, sessionB, courtA, courtB };
}

// ─────────────────────────────────────────────────────────────

describe("Suite CX — court actions", () => {
  it("CX-1: the session organizer can add a court", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    mockAuthAs(organizer.id);

    const res = await addCourtAction(session.id, "Court 7");

    expect(res.success, res.message).toBe(true);
    const { data } = await serviceClient()
      .from("courts")
      .select("name, status")
      .eq("session_id", session.id);
    expect(data).toHaveLength(1);
    expect(data?.[0].name).toBe("Court 7");
  });

  it("CX-2 (negative): an unauthenticated caller cannot add a court, and writes nothing", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    clearMockAuth();

    const res = await addCourtAction(session.id, "Ghost Court");

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/not authenticated/i);
    expect(
      await countCourts(session.id),
      "a court was created despite the auth gate rejecting the caller"
    ).toBe(0);
  });

  it("CX-3 (negative): a session player who is not the organizer cannot add a court", async () => {
    const organizer = await makeProfile({ faker });
    const player = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    // Being IN the session is not being the organizer of it — this is the
    // distinction the gate has to draw, so put the player in the queue.
    await makeQueueEntry({ sessionId: session.id, playerId: player.id });
    mockAuthAs(player.id);

    const res = await addCourtAction(session.id, "Player Court");

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/not authorized/i);
    expect(await countCourts(session.id), "a non-organizer's insert reached the table").toBe(0);
  });

  it("CX-4: the organizer can update their own court's status", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    const court = await makeCourt({ sessionId: session.id, name: "C-1" });
    mockAuthAs(organizer.id);

    const res = await updateCourtStatusAction(session.id, court.id, "closed");

    expect(res.success, res.message).toBe(true);
    expect((await readCourt(court.id))?.status).toBe("closed");
  });

  it("CX-5 (negative): an organizer of session A cannot update a court in session B", async () => {
    const { orgA, sessionA, courtA, courtB } = await seedTwoSessions();
    mockAuthAs(orgA.id);

    // Confirm the pre-state, so a court that was ALREADY closed cannot make
    // the assertion below pass for the wrong reason.
    expect((await readCourt(courtB.id))?.status).toBe("available");

    // The attack: authorize against my own session, operate on a foreign court.
    await updateCourtStatusAction(sessionA.id, courtB.id, "closed");

    expect(
      (await readCourt(courtB.id))?.status,
      "session A's organizer mutated a court belonging to session B — the " +
        '.eq("session_id", sessionId) binding on the update is missing or broken'
    ).toBe("available");

    // ── Positive control ──────────────────────────────────────
    // Same caller, same call shape, own court. Without this half, CX-5 passes
    // just as happily against an updateCourtStatusAction that updates nothing
    // at all — including one broken by a guard-order regression.
    const own = await updateCourtStatusAction(sessionA.id, courtA.id, "closed");
    expect(own.success, own.message).toBe(true);
    expect(
      (await readCourt(courtA.id))?.status,
      "the action failed to update the caller's OWN court, so the cross-session " +
        "assertion above proves nothing"
    ).toBe("closed");
  });

  it("CX-6: the organizer can remove their own court", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    const court = await makeCourt({ sessionId: session.id, name: "D-1" });
    mockAuthAs(organizer.id);

    const res = await removeCourtAction(session.id, court.id);

    expect(res.success, res.message).toBe(true);
    expect(await readCourt(court.id)).toBeNull();
  });

  it("CX-7 (negative): an organizer of session A cannot remove a court in session B", async () => {
    const { orgA, sessionA, sessionB, courtA, courtB } = await seedTwoSessions();
    mockAuthAs(orgA.id);

    await removeCourtAction(sessionA.id, courtB.id);

    expect(
      await readCourt(courtB.id),
      "session A's organizer DELETED a court belonging to session B — the " +
        '.eq("session_id", sessionId) binding on the delete is missing or broken'
    ).not.toBeNull();
    expect((await readCourt(courtB.id))?.session_id).toBe(sessionB.id);

    // ── Positive control — same caller, own court, must really delete.
    const own = await removeCourtAction(sessionA.id, courtA.id);
    expect(own.success, own.message).toBe(true);
    expect(
      await readCourt(courtA.id),
      "the action failed to delete the caller's OWN court, so the cross-session " +
        "assertion above proves nothing"
    ).toBeNull();
  });

  it("CX-8 (edge): a courtId that matches nothing is a silent no-op that still reports success", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    mockAuthAs(organizer.id);

    // This is the ACTUAL contract, asserted so a future change to it is a
    // deliberate decision rather than an accident: PostgREST does not treat
    // "matched zero rows" as an error, so both actions return success:true
    // having changed nothing. That is also what the CX-5/CX-7 attacker sees —
    // the cross-session write is refused by the binding, but the caller is
    // told "Court status updated.". Data is safe; the message is a lie.
    const nonExistent = "00000000-0000-0000-0000-0000000000ff";
    const upd = await updateCourtStatusAction(session.id, nonExistent, "closed");
    const del = await removeCourtAction(session.id, nonExistent);

    expect(upd.success).toBe(true);
    expect(del.success).toBe(true);
    expect(await countCourts(session.id)).toBe(0);
  });
});
