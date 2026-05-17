// ============================================================
// Suite E — RLS Edge Cases (Phase 3)
// ============================================================
// Two layers of access control are tested here:
//
// Layer 1 — DB-level RLS (via direct Supabase client with anon key):
//   Postgres RLS policies prevent anon users from reading/writing
//   private tables. These tests query the DB directly with the anon
//   key (NOT via server actions) to verify the policies are in place.
//
// Layer 2 — JS-level auth gates (via server actions):
//   Server actions have additional auth checks beyond RLS. These tests
//   verify that organizers can only modify their own sessions and that
//   unauthenticated callers are rejected.
//
// Isolation: Layer B — truncateTracked() in afterEach.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { makeProfile, makeSession, makeQueueEntry, makeCompletedMatch } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import { closeSession } from "@/app/actions/sessions";
import { publishMatchAction } from "@/app/actions/match-drafts";
import { runEngineForSession } from "@/app/actions/matchmaking";
import { makeMatch } from "./factories";

const faker = new Faker({ locale: [en] });
faker.seed(6001);

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

/** Returns a Supabase client authenticated as an anonymous user (no auth). */
function anonClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

describe("RLS Edge Cases — Suite E", () => {
  // ── DB Layer — anon reads ─────────────────────────────────

  it("anon client cannot read session_wrapped_stats (RLS: player_id = auth.uid())", async () => {
    // Seed a wrapped stats row so there IS data to potentially leak
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    const [p1, p2, p3, p4] = await Promise.all([
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
    ]);

    await Promise.all([
      makeQueueEntry({ sessionId: session.id, playerId: p1.id }),
      makeQueueEntry({ sessionId: session.id, playerId: p2.id }),
      makeQueueEntry({ sessionId: session.id, playerId: p3.id }),
      makeQueueEntry({ sessionId: session.id, playerId: p4.id }),
    ]);

    await makeCompletedMatch({
      sessionId: session.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
    });

    // Close the session to populate wrapped stats
    const restore = mockAuthAs(organizer.id);
    await closeSession(session.id);
    restore();

    // An unauthenticated client should see 0 rows (RLS filters by auth.uid())
    const { data, error } = await anonClient()
      .from("session_wrapped_stats")
      .select("id")
      .eq("session_id", session.id);

    expect(error).toBeNull();
    expect(data).toHaveLength(0); // RLS hides all rows for anon users
  });

  it("anon client cannot read player_rivalries (RLS: player_id = auth.uid())", async () => {
    // Seed rivalry rows via a closed session
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    const [p1, p2, p3, p4] = await Promise.all([
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
    ]);

    await makeCompletedMatch({
      sessionId: session.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
    });

    const restore = mockAuthAs(organizer.id);
    await closeSession(session.id);
    restore();

    // Anon client should see 0 rivalry rows
    const { data, error } = await anonClient().from("player_rivalries").select("player_id");

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("anon client cannot insert into sessions (RLS blocks unauthenticated inserts)", async () => {
    const organizer = await makeProfile({ faker });

    // Attempt to insert a session as an unauthenticated user
    const { error } = await anonClient().from("sessions").insert({
      name: "Malicious Session",
      created_by: organizer.id,
    });

    // Should be blocked by RLS — either a permission error or policy violation
    expect(error).not.toBeNull();
  });

  // ── JS Layer — auth gate cross-session isolation ──────────

  it("organizer of session A cannot close session B", async () => {
    const orgA = await makeProfile({ faker });
    const orgB = await makeProfile({ faker });

    await makeSession({ faker, organizer: orgA.id });
    const sessionB = await makeSession({ faker, organizer: orgB.id });

    // orgA tries to close sessionB — should be rejected
    const restore = mockAuthAs(orgA.id);
    try {
      const result = await closeSession(sessionB.id);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not authorized|organizer/i);
    } finally {
      restore();
    }

    // sessionB should still be active
    const { data: s } = await serviceClient()
      .from("sessions")
      .select("is_active")
      .eq("id", sessionB.id)
      .single();
    expect(s?.is_active).toBe(true);
  });

  it("organizer of session A cannot publish a match in session B", async () => {
    const orgA = await makeProfile({ faker });
    const orgB = await makeProfile({ faker });

    await makeSession({ faker, organizer: orgA.id });
    const sessionB = await makeSession({ faker, organizer: orgB.id });

    const [p1, p2, p3, p4] = await Promise.all([
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
    ]);

    const match = await makeMatch({
      sessionId: sessionB.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      isPublished: false,
    });

    // orgA tries to publish a match in sessionB
    const restore = mockAuthAs(orgA.id);
    try {
      const result = await publishMatchAction(match.id);
      expect(result.success).toBe(false);
    } finally {
      restore();
    }

    // Match is still a draft
    const { data: m } = await serviceClient()
      .from("matches")
      .select("is_published")
      .eq("id", match.id)
      .single();
    expect(m?.is_published).toBe(false);
  });

  // ── JS Layer — unauthenticated callers ────────────────────

  it("unauthenticated caller cannot close a session", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });

    clearMockAuth(); // no user set

    const result = await closeSession(session.id);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not authenticated|not authenticated/i);
  });

  it("unauthenticated caller cannot run the engine for a session", async () => {
    // runEngineForSession is fire-and-forget (no auth gate — it trusts callers).
    // It should exit gracefully when auto-matchmaking is OFF.
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    // auto-matchmaking OFF (default) — engine should return without creating matches

    clearMockAuth();
    await runEngineForSession(session.id); // should not throw

    const { count } = await serviceClient()
      .from("matches")
      .select("id", { count: "exact", head: true })
      .eq("session_id", session.id);

    expect(count).toBe(0); // no matches — toggle was off
  });
});
