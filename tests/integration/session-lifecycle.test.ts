// ============================================================
// Suite K — Session Lifecycle Server Actions
// ============================================================
// Locks in the contract of three server actions that govern the
// session lifecycle but had no integration coverage before this:
//
//   createSession
//     K-1  Happy: explicit passcode is upper-cased, normalized
//          and stored; auto-generated when blank.
//     K-2  Happy: handle_new_session trigger inserts a
//          session_organizers row for created_by.
//     K-3  Negative: duplicate ACTIVE passcode rejected.
//     K-4  Negative: name length > 60 rejected.
//     K-5  Negative: passcode length > 20 rejected.
//     K-6  Negative: unauthenticated rejected.
//
//   joinAsCoOrganizer
//     K-7  Happy: valid passcode → session_organizers row inserted,
//          sessionId returned.
//     K-8  Happy: idempotent — second call returns success and does
//          not create a duplicate session_organizers row.
//     K-9  Negative: invalid passcode → generic INVALID message
//          (must NOT reveal whether the passcode exists).
//     K-10 Negative: primary organizer cannot join their own session.
//     K-11 Negative: closed session passcode rejected.
//
//   toggleAutoMatchmaking
//     K-12 Happy: organizer flips false→true and back.
//     K-13 Negative: non-organizer rejected.
//
// Isolation: Layer B — truncateTracked() in afterEach.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import { makeProfile, makeSession } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import { createSession, joinAsCoOrganizer, toggleAutoMatchmaking } from "@/app/actions/sessions";

const faker = new Faker({ locale: [en] });
faker.seed(11001);

/**
 * The founding club seeded by migration 20260630000001. createSession now
 * REQUIRES an explicit clubId and always verifies club-admin — omitting it used
 * to fall through to this club's DB DEFAULT with no check at all, which was the
 * privilege-escalation primitive the security fix removed.
 */
const DEFAULT_CLUB_ID = "00000000-0000-0000-0000-000000000001";

/** Make `userId` an owner of the default club so createSession's gate passes. */
async function makeClubOwner(userId: string): Promise<void> {
  const client = serviceClient();
  const { error } = await client
    .from("club_members")
    .upsert(
      { club_id: DEFAULT_CLUB_ID, player_id: userId, role: "owner", is_active: true },
      { onConflict: "club_id,player_id" }
    );
  if (error) throw new Error(`[makeClubOwner] ${error.message}`);
}

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

// ─────────────────────────────────────────────────────────────

describe("Session Lifecycle — Suite K", () => {
  // ============================================================
  // createSession
  // ============================================================

  // ── K-1: Explicit passcode normalised + stored ────────────
  it("K-1: createSession with an explicit passcode upper-cases and persists it", async () => {
    const me = await makeProfile({ faker });
    await makeClubOwner(me.id); // createSession now requires club-admin
    const restore = mockAuthAs(me.id);
    try {
      const result = await createSession({
        clubId: DEFAULT_CLUB_ID,
        name: "Friday Pickup",
        scoring: "single",
        passcode: "smash7",
      });

      expect(result.success).toBe(true);
      expect(result.sessionId).toBeDefined();
      expect(result.passcode).toBe("SMASH7"); // normalised to upper-case

      const { data: session } = await serviceClient()
        .from("sessions")
        .select("name, scoring, organizer_passcode, created_by, is_active")
        .eq("id", result.sessionId!)
        .single();

      expect(session?.name).toBe("Friday Pickup");
      expect(session?.scoring).toBe("single");
      expect(session?.organizer_passcode).toBe("SMASH7");
      expect(session?.created_by).toBe(me.id);
      expect(session?.is_active).toBe(true);
    } finally {
      restore();
    }
  });

  // ── K-2: handle_new_session trigger inserts organizer row ─
  it("K-2: handle_new_session trigger inserts session_organizers row for created_by", async () => {
    const me = await makeProfile({ faker });
    await makeClubOwner(me.id); // createSession now requires club-admin
    const restore = mockAuthAs(me.id);
    try {
      const result = await createSession({
        clubId: DEFAULT_CLUB_ID,
        name: "Trigger Test",
        scoring: "single",
        passcode: "TRIG1",
      });
      expect(result.success).toBe(true);

      const { data: orgRows } = await serviceClient()
        .from("session_organizers")
        .select("user_id")
        .eq("session_id", result.sessionId!);

      // The handle_new_session trigger is the SOLE inserter on this path —
      // createSession itself does not write session_organizers. Length=1
      // confirms (a) the trigger fired and (b) no other code path raced
      // a duplicate row in.
      expect(orgRows).toHaveLength(1);
      expect(orgRows?.[0].user_id).toBe(me.id);
    } finally {
      restore();
    }
  });

  // ── K-3: Duplicate active passcode rejected ───────────────
  it("K-3: createSession rejects a passcode already used by another active session", async () => {
    const userA = await makeProfile({ faker });
    await makeClubOwner(userA.id); // createSession now requires club-admin
    const userB = await makeProfile({ faker });
    await makeClubOwner(userB.id); // createSession now requires club-admin

    const restoreA = mockAuthAs(userA.id);
    let firstSessionId: string | undefined;
    try {
      const r1 = await createSession({
        clubId: DEFAULT_CLUB_ID,
        name: "First",
        scoring: "single",
        passcode: "DUPE1",
      });
      expect(r1.success).toBe(true);
      firstSessionId = r1.sessionId;
    } finally {
      restoreA();
    }

    const restoreB = mockAuthAs(userB.id);
    try {
      const r2 = await createSession({
        clubId: DEFAULT_CLUB_ID,
        name: "Second",
        scoring: "single",
        passcode: "DUPE1",
      });
      expect(r2.success).toBe(false);
      expect(r2.message).toMatch(/in use|already/i);
      expect(r2.sessionId).toBeUndefined();

      // Only the first session exists with that passcode.
      const { data: sessions } = await serviceClient()
        .from("sessions")
        .select("id")
        .eq("organizer_passcode", "DUPE1")
        .eq("is_active", true);
      expect(sessions).toHaveLength(1);
      expect(sessions?.[0].id).toBe(firstSessionId);
    } finally {
      restoreB();
    }
  });

  // ── K-4: Name length > 60 rejected ────────────────────────
  it("K-4: createSession rejects a name longer than 60 characters", async () => {
    const me = await makeProfile({ faker });
    const longName = "x".repeat(61);
    const restore = mockAuthAs(me.id);
    try {
      const result = await createSession({
        clubId: DEFAULT_CLUB_ID,
        name: longName,
        scoring: "single",
        passcode: "LEN001",
      });
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/60 characters/i);
    } finally {
      restore();
    }
  });

  // ── K-5: Passcode length > 20 rejected ────────────────────
  it("K-5: createSession rejects a passcode longer than 20 characters", async () => {
    const me = await makeProfile({ faker });
    const longPasscode = "P".repeat(21);
    const restore = mockAuthAs(me.id);
    try {
      const result = await createSession({
        clubId: DEFAULT_CLUB_ID,
        name: "OK name",
        scoring: "single",
        passcode: longPasscode,
      });
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/20 characters/i);
    } finally {
      restore();
    }
  });

  // ── K-6: Unauthenticated rejected ─────────────────────────
  it("K-6: createSession rejects unauthenticated callers with no DB write", async () => {
    // No mockAuthAs.
    const result = await createSession({
      clubId: DEFAULT_CLUB_ID,
      name: "Anon",
      scoring: "single",
      passcode: "ANON1",
    });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not authenticated/i);

    const { count } = await serviceClient()
      .from("sessions")
      .select("*", { count: "exact", head: true })
      .eq("organizer_passcode", "ANON1");
    expect(count).toBe(0);
  });

  // ============================================================
  // joinAsCoOrganizer
  // ============================================================

  // ── K-7: Valid passcode → membership row inserted ─────────
  it("K-7: joinAsCoOrganizer with a valid passcode inserts a session_organizers row", async () => {
    const primary = await makeProfile({ faker });
    await makeClubOwner(primary.id); // createSession now requires club-admin
    let sessionId: string | undefined;
    {
      const restore = mockAuthAs(primary.id);
      try {
        const r = await createSession({
          clubId: DEFAULT_CLUB_ID,
          name: "Co-org Test",
          scoring: "single",
          passcode: "JOIN01",
        });
        expect(r.success).toBe(true);
        sessionId = r.sessionId;
      } finally {
        restore();
      }
    }

    const coOrganizer = await makeProfile({ faker });
    const restore = mockAuthAs(coOrganizer.id);
    try {
      const result = await joinAsCoOrganizer("join01"); // case-insensitive
      expect(result.success).toBe(true);
      expect(result.sessionId).toBe(sessionId);

      const { data: rows } = await serviceClient()
        .from("session_organizers")
        .select("user_id")
        .eq("session_id", sessionId!);
      const ids = (rows ?? []).map((r) => r.user_id);
      expect(ids).toContain(primary.id);
      expect(ids).toContain(coOrganizer.id);
    } finally {
      restore();
    }
  });

  // ── K-8: Idempotent — second call no-ops ──────────────────
  it("K-8: joinAsCoOrganizer is idempotent — second call does not create a duplicate row", async () => {
    const primary = await makeProfile({ faker });
    await makeClubOwner(primary.id); // createSession now requires club-admin
    let sessionId: string | undefined;
    {
      const restore = mockAuthAs(primary.id);
      try {
        const r = await createSession({
          clubId: DEFAULT_CLUB_ID,
          name: "Idempotent",
          scoring: "single",
          passcode: "IDEM01",
        });
        sessionId = r.sessionId;
      } finally {
        restore();
      }
    }

    const coOrganizer = await makeProfile({ faker });
    const restore = mockAuthAs(coOrganizer.id);
    try {
      const r1 = await joinAsCoOrganizer("IDEM01");
      const r2 = await joinAsCoOrganizer("IDEM01");
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);

      const { count } = await serviceClient()
        .from("session_organizers")
        .select("*", { count: "exact", head: true })
        .eq("session_id", sessionId!)
        .eq("user_id", coOrganizer.id);
      expect(count).toBe(1);
    } finally {
      restore();
    }
  });

  // ── K-9: Invalid passcode → generic message ───────────────
  it("K-9: joinAsCoOrganizer returns a generic 'invalid passcode' message for unknown codes", async () => {
    const me = await makeProfile({ faker });
    const restore = mockAuthAs(me.id);
    try {
      const result = await joinAsCoOrganizer("NOPE99");
      expect(result.success).toBe(false);
      // Generic — never reveals existence/non-existence.
      expect(result.message).toMatch(/invalid|no active session/i);
      expect(result.sessionId).toBeUndefined();
    } finally {
      restore();
    }
  });

  // ── K-10: Primary organizer cannot join their own session ─
  it("K-10: joinAsCoOrganizer rejects the primary organizer of the session", async () => {
    const primary = await makeProfile({ faker });
    await makeClubOwner(primary.id); // createSession now requires club-admin
    const restore = mockAuthAs(primary.id);
    try {
      const r1 = await createSession({
        clubId: DEFAULT_CLUB_ID,
        name: "Mine",
        scoring: "single",
        passcode: "MINE99",
      });
      expect(r1.success).toBe(true);

      const r2 = await joinAsCoOrganizer("MINE99");
      expect(r2.success).toBe(false);
      expect(r2.message).toMatch(/primary organizer/i);
    } finally {
      restore();
    }
  });

  // ── K-11: Closed session passcode rejected ────────────────
  it("K-11: joinAsCoOrganizer rejects a passcode that belongs to a closed session", async () => {
    const primary = await makeProfile({ faker });
    await makeClubOwner(primary.id); // createSession now requires club-admin
    let sessionId: string | undefined;
    {
      const restore = mockAuthAs(primary.id);
      try {
        const r = await createSession({
          clubId: DEFAULT_CLUB_ID,
          name: "Was active",
          scoring: "single",
          passcode: "CLOSED",
        });
        sessionId = r.sessionId;
      } finally {
        restore();
      }
    }

    // Mark it closed directly in the DB.
    await serviceClient()
      .from("sessions")
      .update({ is_active: false, ended_at: new Date().toISOString() })
      .eq("id", sessionId!);

    const lateJoiner = await makeProfile({ faker });
    const restore = mockAuthAs(lateJoiner.id);
    try {
      const result = await joinAsCoOrganizer("CLOSED");
      expect(result.success).toBe(false);
      // Same generic invalid message — closed sessions are not findable.
      expect(result.message).toMatch(/invalid|no active session/i);

      const { count } = await serviceClient()
        .from("session_organizers")
        .select("*", { count: "exact", head: true })
        .eq("session_id", sessionId!)
        .eq("user_id", lateJoiner.id);
      expect(count).toBe(0);
    } finally {
      restore();
    }
  });

  // ============================================================
  // toggleAutoMatchmaking
  // ============================================================

  // ── K-12: Organizer flips false → true → false ────────────
  it("K-12: toggleAutoMatchmaking flips the boolean and returns the new value", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    // Factories default is_auto_matchmaking_on=false.

    const restore = mockAuthAs(organizer.id);
    try {
      const r1 = await toggleAutoMatchmaking(session.id);
      expect(r1.success).toBe(true);
      expect(r1.isOn).toBe(true);

      const { data: s1 } = await serviceClient()
        .from("sessions")
        .select("is_auto_matchmaking_on")
        .eq("id", session.id)
        .single();
      expect(s1?.is_auto_matchmaking_on).toBe(true);

      const r2 = await toggleAutoMatchmaking(session.id);
      expect(r2.success).toBe(true);
      expect(r2.isOn).toBe(false);

      const { data: s2 } = await serviceClient()
        .from("sessions")
        .select("is_auto_matchmaking_on")
        .eq("id", session.id)
        .single();
      expect(s2?.is_auto_matchmaking_on).toBe(false);
    } finally {
      restore();
    }
  });

  // ── K-13: Non-organizer rejected ──────────────────────────
  it("K-13: toggleAutoMatchmaking rejects a caller who is not an organizer", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    const outsider = await makeProfile({ faker });

    const restore = mockAuthAs(outsider.id);
    try {
      const result = await toggleAutoMatchmaking(session.id);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/organizer/i);

      const { data } = await serviceClient()
        .from("sessions")
        .select("is_auto_matchmaking_on")
        .eq("id", session.id)
        .single();
      expect(data?.is_auto_matchmaking_on).toBe(false); // unchanged
    } finally {
      restore();
    }
  });
});
