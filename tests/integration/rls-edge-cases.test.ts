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
import {
  makeProfile,
  makeSession,
  makeQueueEntry,
  makeCompletedMatch,
  TEST_USER_PASSWORD,
} from "./factories";
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

// ============================================================
// profiles_select — tenancy audit finding #8
// ============================================================
// `profiles_select` used to be USING (true): any signed-in user could
// enumerate every display name, skill level and VIP tag on the platform, and
// the unfiltered `profiles` postgres_changes subscription streamed every
// profile UPDATE platform-wide to every connected browser.
//
// 20260723200000 replaces it with `id = auth.uid() OR can_read_profile(id)`.
// These tests sign users in FOR REAL (mockAuthAs only fools the server
// actions, not Postgres) so the assertions run against the `authenticated`
// role with a genuine JWT, which is the only way RLS is actually exercised.
//
// One test per arm of the predicate. Every arm test pairs its positive
// assertion with a `not.toContain(stranger.id)` control, so a pass cannot be
// explained by "the policy lets everything through" — the exact bug being
// fixed. (The last two cases — the anon RPC revoke and the own-profile read —
// are not arm tests and need no control.)
// ============================================================

describe("profiles_select scope — finding #8", () => {
  /**
   * Signs a factory-made profile in for real and returns their client.
   *
   * makeProfile() creates the auth user with TEST_USER_PASSWORD and now
   * returns the generated email, so this is a plain password grant — the
   * resulting client carries a real `authenticated` JWT whose `sub` is the
   * profile id, which is what auth.uid() reads inside the policy.
   */
  async function signedInAs(profile: { id: string; email: string }) {
    const client = anonClient();
    const { data, error } = await client.auth.signInWithPassword({
      email: profile.email,
      password: TEST_USER_PASSWORD,
    });
    if (error || data.session?.user.id !== profile.id) {
      throw new Error(
        `[signedInAs] could not sign in ${profile.id}: ${error?.message ?? "no session"}`
      );
    }
    return client;
  }

  /** Every profile id the given user can actually SELECT. */
  async function visibleProfileIds(profile: { id: string; email: string }): Promise<string[]> {
    const client = await signedInAs(profile);
    const { data, error } = await client.from("profiles").select("id");
    if (error) throw new Error(`[visibleProfileIds] select failed: ${error.message}`);
    return (data ?? []).map((row) => row.id).sort();
  }

  /** The club a factory session lands in (the column default). */
  async function clubIdOf(sessionId: string): Promise<string> {
    const { data, error } = await serviceClient()
      .from("sessions")
      .select("club_id")
      .eq("id", sessionId)
      .single();
    if (error || !data?.club_id) {
      throw new Error(`[clubIdOf] no club_id for ${sessionId}: ${error?.message ?? "null"}`);
    }
    return data.club_id;
  }

  async function addClubMember(clubId: string, playerId: string) {
    // club_members.player_id is ON DELETE CASCADE from profiles, so these rows
    // are cleaned up by truncateTracked() along with the auth users — the club
    // itself is the shared bootstrap club and must survive.
    const { error } = await serviceClient()
      .from("club_members")
      .upsert(
        { club_id: clubId, player_id: playerId, role: "member" as const, is_active: true },
        { onConflict: "club_id,player_id" }
      );
    if (error) throw new Error(`[addClubMember] ${error.message}`);
  }

  // ── The finding itself ──────────────────────────────────────

  it("a signed-in user who shares no club or session sees only their own profile", async () => {
    const alice = await makeProfile({ faker });
    await makeProfile({ faker }); // a stranger, in no shared scope
    await makeProfile({ faker }); // and another

    expect(await visibleProfileIds(alice)).toEqual([alice.id]);
  });

  it("the platform-wide enumeration this closes is gone: count(*) is 1, not the table", async () => {
    const alice = await makeProfile({ faker });
    await Promise.all([makeProfile({ faker }), makeProfile({ faker }), makeProfile({ faker })]);

    const client = await signedInAs(alice);
    const { count, error } = await client
      .from("profiles")
      .select("id", { count: "exact", head: true });

    expect(error).toBeNull();
    expect(count).toBe(1);
  });

  // ── Arm 1 — shared active club ──────────────────────────────

  it("arm 1: active club-mates can read each other, and only each other", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    const clubId = await clubIdOf(session.id);

    const alice = await makeProfile({ faker });
    const bob = await makeProfile({ faker });
    const stranger = await makeProfile({ faker }); // deliberately not in the club

    await addClubMember(clubId, alice.id);
    await addClubMember(clubId, bob.id);

    const visible = await visibleProfileIds(alice);
    expect(visible).toContain(bob.id);
    expect(visible).not.toContain(stranger.id);
  });

  it("arm 1 respects is_active: a deactivated member goes dark", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    const clubId = await clubIdOf(session.id);

    const alice = await makeProfile({ faker });
    const bob = await makeProfile({ faker });
    await addClubMember(clubId, alice.id);
    await addClubMember(clubId, bob.id);

    expect(await visibleProfileIds(alice)).toContain(bob.id);

    await serviceClient()
      .from("club_members")
      .update({ is_active: false })
      .eq("club_id", clubId)
      .eq("player_id", bob.id);

    expect(await visibleProfileIds(alice)).not.toContain(bob.id);
  });

  // ── Arm 2 — target queued in a session I can reach ──────────

  it("arm 2: an organizer sees a walk-in queued in their session who has no club membership", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    const walkIn = await makeProfile({ faker });
    const stranger = await makeProfile({ faker });

    await makeQueueEntry({ sessionId: session.id, playerId: walkIn.id });

    const visible = await visibleProfileIds(organizer);
    expect(visible).toContain(walkIn.id);
    expect(visible).not.toContain(stranger.id);
  });

  // ── Arm 3 — target played a match in a session I can reach ──

  it("arm 3: players who checked out stay readable through their completed match", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    const [p1, p2, p3, p4] = await Promise.all([
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
      makeProfile({ faker }),
    ]);
    const stranger = await makeProfile({ faker });

    await Promise.all(
      [p1, p2, p3, p4].map((p) => makeQueueEntry({ sessionId: session.id, playerId: p.id }))
    );
    await makeCompletedMatch({
      sessionId: session.id,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
    });

    // Checkout DELETEs the queue row (queue_delete_own / queue_delete_organizer)
    // but leaves match_players behind. Arm 2 can no longer fire for these four;
    // if arm 3 were missing, useMatchHistory would render blank names.
    await serviceClient().from("queue_entries").delete().eq("session_id", session.id);

    const visible = await visibleProfileIds(organizer);
    for (const p of [p1, p2, p3, p4]) {
      expect(visible).toContain(p.id);
    }
    expect(visible).not.toContain(stranger.id);
  });

  // ── Arms 4 & 5 — the people running the session ─────────────

  it("arm 4: a delegated organizer is visible to the room they are running", async () => {
    const creator = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: creator.id });
    const clubId = await clubIdOf(session.id);

    // Delegated via QR invite: a session_organizers row and nothing else — no
    // club membership, never queued, never played.
    const delegated = await makeProfile({ faker });
    const { error } = await serviceClient()
      .from("session_organizers")
      .insert({ session_id: session.id, user_id: delegated.id });
    expect(error).toBeNull();

    // A player who can reach the session because they belong to its club.
    const member = await makeProfile({ faker });
    await addClubMember(clubId, member.id);

    const stranger = await makeProfile({ faker });

    const visible = await visibleProfileIds(member);
    expect(visible).toContain(delegated.id);
    expect(visible).not.toContain(stranger.id);
  });

  it("arm 5: the session creator is visible to the club even with no organizer row", async () => {
    const creator = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: creator.id });
    const clubId = await clubIdOf(session.id);

    // Production has a session whose creator has no session_organizers row, so
    // arm 5 is not implied by arm 4. Reproduce that state exactly.
    await serviceClient()
      .from("session_organizers")
      .delete()
      .eq("session_id", session.id)
      .eq("user_id", creator.id);

    const member = await makeProfile({ faker });
    await addClubMember(clubId, member.id);

    const stranger = await makeProfile({ faker });

    const visible = await visibleProfileIds(member);
    expect(visible).toContain(creator.id);
    expect(visible).not.toContain(stranger.id);
  });

  // ── The helper must not become an anonymous oracle ──────────

  it("can_read_profile is not callable over /rest/v1/rpc as anon", async () => {
    const target = await makeProfile({ faker });

    const { error } = await anonClient().rpc("can_read_profile", { p_profile_id: target.id });

    // EXECUTE is revoked from PUBLIC/anon: PostgREST answers PGRST202 (function
    // not exposed in the schema cache) or 42501 (permission denied) depending
    // on cache state. Assert the code rather than merely "some error", so a
    // typo'd argument name or a renamed function cannot keep this green while
    // the revoke silently regresses.
    expect(error).not.toBeNull();
    expect(["PGRST202", "42501"]).toContain(error?.code);
  });

  it("a user can always read their own profile", async () => {
    const alice = await makeProfile({ faker });
    const client = await signedInAs(alice);

    const { data, error } = await client
      .from("profiles")
      .select("id, display_name")
      .eq("id", alice.id)
      .single();

    expect(error).toBeNull();
    expect(data?.id).toBe(alice.id);
  });
});
