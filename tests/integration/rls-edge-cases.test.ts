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
import { withTx } from "./helpers/withTx";
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

  // ── DB Layer — leaderboard read surface (TENANCY_AUDIT_2026-07-21 #6) ──
  // These reproduce the audit finding through the same door an attacker used:
  // a plain `createClient(url, ANON_KEY)`, no login, no session id, no club.
  // Before 20260722010001 each of them returned the whole platform's data.

  it("anon client cannot read the leaderboard views or matview", async () => {
    // Seeded so the two VIEWS have something to leak. The matview is NOT
    // refreshed here, so its seed is inert — but the assertion that carries all
    // three cases is `error !== null`, which is purely grant-dependent: these
    // are owner-rights relations, so losing the revoke is a row dump, not an
    // empty set. The length check is a belt-and-braces trivial pass.
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

    const anon = anonClient();
    // v_match_history and v_session_leaderboard are owner-rights views and
    // v_alltime_leaderboard_mat is a matview (which cannot carry RLS at all),
    // so for all three the GRANT is the only access control there is. Losing it
    // is a hard permission error, not an empty result set.
    for (const relation of [
      "v_match_history",
      "v_session_leaderboard",
      "v_alltime_leaderboard_mat",
    ] as const) {
      const { data, error } = await anon.from(relation).select("player_id").limit(1);
      expect(error, `${relation} answered anon`).not.toBeNull();
      expect(data ?? []).toHaveLength(0);
    }
  });

  it("anon client cannot call the leaderboard RPCs", async () => {
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

    const anon = anonClient();

    // get_player_streaks has BOTH parameters defaulted, so `{}` is a legal call
    // that used to return every player in every club. Same for
    // get_alltime_snapshot_before. This is the exact request the audit made.
    const streaks = await anon.rpc("get_player_streaks", {});
    expect(streaks.error, "get_player_streaks answered anon").not.toBeNull();
    expect(streaks.data ?? []).toHaveLength(0);

    const snapshot = await anon.rpc("get_alltime_snapshot_before", {
      p_cutoff: new Date().toISOString(),
    });
    expect(snapshot.error, "get_alltime_snapshot_before answered anon").not.toBeNull();
    expect(snapshot.data ?? []).toHaveLength(0);

    // Scoped, but still a full board for any session id — and session ids are
    // published in share URLs. The share page reads it server-side now.
    const board = await anon.rpc("get_session_leaderboard_public", {
      p_session_id: session.id,
    });
    expect(board.error, "get_session_leaderboard_public answered anon").not.toBeNull();
    expect(board.data ?? []).toHaveLength(0);

    // The browser-callable replacement is authenticated-only: anon must not
    // reach it either, even though it would gate itself if it did.
    const scoped = await anon.rpc("get_session_player_streaks", {
      p_session_id: session.id,
    });
    expect(scoped.error, "get_session_player_streaks answered anon").not.toBeNull();
    expect(scoped.data ?? []).toHaveLength(0);
  });

  it("get_session_player_streaks gates on session_access_level, not just on the grant", async () => {
    // The grant keeps anon out; this is the other half — an ordinary logged-in
    // user of some OTHER club must get zero rows rather than this session's
    // board. Asserted at the SQL layer because the integration harness mocks
    // createServerSupabaseClient to a service-role client, so nothing driven
    // through a server action can observe RLS or auth.uid() at all.
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    const [p1, p2, p3, p4] = await Promise.all([
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
    ]);
    // 21–15: team A wins, so p1 and p2 each carry a 1-match win streak.
    await makeCompletedMatch({
      sessionId: session.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
    });
    const outsider = await makeProfile({ faker });

    /** Calls the RPC as `authenticated` with auth.uid() = userId. */
    async function streaksAs(userId: string): Promise<{ player_id: string }[]> {
      return withTx(async (db) => {
        await db.query("SET LOCAL ROLE authenticated");
        await db.query("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: userId, role: "authenticated" }),
        ]);
        const { rows } = await db.query<{ player_id: string }>(
          "SELECT player_id FROM public.get_session_player_streaks($1)",
          [session.id]
        );
        return rows;
      });
    }

    // The organizer matches session_access_level's created_by branch.
    const organizerRows = await streaksAs(organizer.id);
    expect(organizerRows.map((r) => r.player_id).sort()).toEqual([p1.id, p2.id].sort());

    // The outsider is neither an organizer nor an active member of the
    // session's club, so session_access_level() is NULL and the WHERE clause
    // matches nothing. Zero rows, not an error — the flames just don't light.
    const outsiderRows = await streaksAs(outsider.id);
    expect(outsiderRows).toEqual([]);

    // Granting club membership flips the same caller to 'member' and the rows
    // come back — proving the empty result above was the gate, not an empty
    // seed or a broken join.
    const { data: sessionRow } = await serviceClient()
      .from("sessions")
      .select("club_id")
      .eq("id", session.id)
      .single();
    await serviceClient()
      .from("club_members")
      .upsert(
        {
          club_id: sessionRow!.club_id,
          player_id: outsider.id,
          role: "member" as const,
          is_active: true,
        },
        { onConflict: "club_id,player_id" }
      );

    const memberRows = await streaksAs(outsider.id);
    expect(memberRows.map((r) => r.player_id).sort()).toEqual([p1.id, p2.id].sort());
  });
});
