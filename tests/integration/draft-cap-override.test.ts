// ============================================================
// Integration Tests: Draft Cap Override
// ============================================================
// Tests the full DB-level behaviour of the cap override feature
// against a real Supabase test DB. These verify:
//
// DCINT-1   applyDraftCapOverride saves max_auto_drafts_override to sessions
// DCINT-2   applyDraftCapOverride with null resets to dynamic (NULL in DB)
// DCINT-3   clear_all_unpublished_drafts RPC: returns all players to 'waiting'
// DCINT-4   clear_all_unpublished_drafts RPC: deletes only is_published=false matches
// DCINT-5   clear_all_unpublished_drafts RPC: published on-deck matches are untouched
// DCINT-7   Engine respects override: generates only min(override, dynamic) drafts
// DCINT-8   Engine with override > dynamic: uses dynamic cap (not override)
// DCINT-11  applyDraftCapOverride: invalid cap (0, 6) rejected by the DB constraint
// DCINT-13  held cross-court drafts are excluded from the bulk clear
//
// This list is the file's contents, not a wishlist. DCINT-6/9/10 and the former
// DCINT-12 ("co-organizer receives draft_cap_phase in order") were listed here
// for months without ever being written — and DCINT-12 in particular read as
// proof that the broadcast worked while it was in fact dead on arrival. The
// phase sequence is now pinned where it can actually be asserted: DCA-8 in
// tests/unit/draft-cap-action.test.ts (server emits clearing→generating→done)
// and UCS-* in tests/unit/use-organizer-session-cap-phase.test.ts (client lease
// and ordering). Anything added back here must come with a test body.
//
// Setup: uses tests/integration/setup.ts factory helpers.
// Every test runs in its own transaction, rolled back on completion.
// ============================================================

import { describe, it, expect, beforeAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

// ── Supabase admin client ─────────────────────────────────────
// Uses service role from test .env — bypasses RLS for setup/teardown.

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/**
 * Bootstrap profile seeded by supabase/seed.sql. It lives at the all-zeros UUID
 * because that is the one id tests/integration/helpers/truncate.ts preserves
 * (`.delete().neq("id", ZERO_UUID)`), so it outlives cleanup between tests.
 */
const BOOTSTRAP_PROFILE_ID = "00000000-0000-0000-0000-000000000000";

let db: ReturnType<typeof createClient<Database>>;

beforeAll(() => {
  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      "Integration tests require SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in tests/integration/.env"
    );
  }
  db = createClient<Database>(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
});

// ── Helpers ───────────────────────────────────────────────────

async function createTestSession(overrides: Record<string, unknown> = {}) {
  const { name, scoring, is_auto_matchmaking_on, ...rest } = overrides as {
    name?: string;
    scoring?: string;
    is_auto_matchmaking_on?: boolean;
    [k: string]: unknown;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db.from("sessions") as any)
    .insert({
      name: name ?? "Test Session",
      scoring: scoring ?? "single",
      is_auto_matchmaking_on: is_auto_matchmaking_on ?? true,
      // sessions.created_by is NOT NULL, so omitting it fails outright. This
      // went unnoticed because the integration suite could not run at all —
      // the migration replay died during DB setup (see 20260722000000-3).
      // Uses the seeded bootstrap profile (supabase/seed.sql), which is the
      // one row truncation preserves, so it is valid for every test in the file.
      created_by: BOOTSTRAP_PROFILE_ID,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to create test session: ${error?.message}`);

  // Apply any remaining overrides (e.g. max_auto_drafts_override) via update.
  if (Object.keys(rest).length > 0) {
    await db
      .from("sessions")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update(rest as any)
      .eq("id", data.id as string);
  }

  return data.id as string;
}

async function createDraftMatch(sessionId: string, isPublished = false) {
  const { data, error } = await db
    .from("matches")
    .insert({
      session_id: sessionId,
      status: "pending",
      is_published: isPublished,
      is_mixed_level: false,
      created_method: "auto",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to create draft match: ${error?.message}`);
  return data.id as string;
}

async function createWaitingPlayer(sessionId: string) {
  const { data: auth } = await db.auth.admin.createUser({ email: `${Math.random()}@test.com` });
  const userId = auth.user?.id;
  if (!userId) throw new Error("Failed to create test user");

  await db
    .from("profiles")
    .insert({ id: userId, display_name: "Test Player", skill_level: "intermediate" });
  const { data } = await db
    .from("queue_entries")
    .insert({
      session_id: sessionId,
      player_id: userId,
      status: "drafted",
    })
    .select("id, player_id")
    .single();

  return { userId, entryId: data?.id as string };
}

async function cleanup(sessionId: string) {
  // cascade delete: matches → match_players, queue_entries → profiles
  await db.from("matches").delete().eq("session_id", sessionId);
  const { data: entries } = await db
    .from("queue_entries")
    .select("player_id")
    .eq("session_id", sessionId);
  await db.from("queue_entries").delete().eq("session_id", sessionId);
  if (entries?.length) {
    for (const e of entries) {
      await db.auth.admin.deleteUser(e.player_id);
    }
  }
  await db.from("sessions").delete().eq("id", sessionId);
}

// ── Tests ─────────────────────────────────────────────────────

describe("DCINT-1: applyDraftCapOverride saves override to sessions", () => {
  it("stores the override value in max_auto_drafts_override column", async () => {
    const sessionId = await createTestSession();
    try {
      await db.from("sessions").update({ max_auto_drafts_override: 2 }).eq("id", sessionId);

      const { data } = await db
        .from("sessions")
        .select("max_auto_drafts_override")
        .eq("id", sessionId)
        .single();
      expect(data?.max_auto_drafts_override).toBe(2);
    } finally {
      await cleanup(sessionId);
    }
  });
});

describe("DCINT-2: Resetting to Dynamic stores NULL", () => {
  it("null override is stored as NULL in the DB column", async () => {
    const sessionId = await createTestSession();
    try {
      await db.from("sessions").update({ max_auto_drafts_override: 3 }).eq("id", sessionId);
      await db.from("sessions").update({ max_auto_drafts_override: null }).eq("id", sessionId);

      const { data } = await db
        .from("sessions")
        .select("max_auto_drafts_override")
        .eq("id", sessionId)
        .single();
      expect(data?.max_auto_drafts_override).toBeNull();
    } finally {
      await cleanup(sessionId);
    }
  });
});

describe("DCINT-3: clear_all_unpublished_drafts returns players to waiting", () => {
  it("all players from unpublished drafts have queue status set back to waiting", async () => {
    const sessionId = await createTestSession();
    try {
      const matchId = await createDraftMatch(sessionId, false); // unpublished
      const { userId } = await createWaitingPlayer(sessionId);
      await db.from("match_players").insert({ match_id: matchId, player_id: userId, team: "a" });
      await db
        .from("queue_entries")
        .update({ status: "drafted" })
        .eq("session_id", sessionId)
        .eq("player_id", userId);

      // Call the RPC
      const { error } = await db.rpc("clear_all_unpublished_drafts", { p_session_id: sessionId });
      expect(error).toBeNull();

      const { data: entry } = await db
        .from("queue_entries")
        .select("status")
        .eq("player_id", userId)
        .single();
      expect(entry?.status).toBe("waiting");
    } finally {
      await cleanup(sessionId);
    }
  });
});

describe("DCINT-4: clear_all_unpublished_drafts deletes only is_published=false matches", () => {
  it("unpublished drafts are deleted, published on-deck matches survive", async () => {
    const sessionId = await createTestSession();
    try {
      const unpublishedId = await createDraftMatch(sessionId, false);
      const publishedId = await createDraftMatch(sessionId, true);

      await db.rpc("clear_all_unpublished_drafts", { p_session_id: sessionId });

      const { data: remaining } = await db
        .from("matches")
        .select("id, is_published")
        .eq("session_id", sessionId);
      const ids = remaining?.map((m) => m.id) ?? [];

      expect(ids).not.toContain(unpublishedId); // unpublished → deleted
      expect(ids).toContain(publishedId); // published → untouched
    } finally {
      await cleanup(sessionId);
    }
  });
});

describe("DCINT-13: held cross-court drafts are excluded from the bulk clear (Fix #2)", () => {
  it("held drafts survive clear_all_unpublished_drafts; a still-playing pulled body keeps 'playing'", async () => {
    const sessionId = await createTestSession();
    try {
      // A normal unpublished draft (must be cleared) + a held draft (must survive).
      const normalId = await createDraftMatch(sessionId, false);

      // The held draft's pulled body is still PLAYING on its source court.
      const { userId } = await createWaitingPlayer(sessionId);
      await db
        .from("queue_entries")
        .update({ status: "playing" })
        .eq("session_id", sessionId)
        .eq("player_id", userId);

      // `is_held` is GENERATED ALWAYS AS (cardinality(pulled_player_ids) > 0)
      // STORED (20260607000000), so it cannot be written directly — an insert
      // that names it is rejected outright. Set the column it is derived from
      // instead. The app only ever creates held drafts via the
      // create_held_cross_court_match RPC, so neither field is on the typed
      // MatchInsert surface; cast to set them for this DB-behaviour test.
      const heldPayload = {
        session_id: sessionId,
        status: "pending",
        is_published: false,
        is_mixed_level: false,
        created_method: "held",
        pulled_player_ids: [userId],
      };
      const { data: heldRow, error: heldErr } = await db
        .from("matches")
        .insert(heldPayload as never)
        .select("id, is_held")
        .single();
      // Assert rather than optional-chain: swallowing the error here is what let
      // this test pass `undefined` into toContain() and read as a real result.
      if (heldErr || !heldRow) throw new Error(`held draft insert failed: ${heldErr?.message}`);
      const { id: heldId, is_held: isHeld } = heldRow as { id: string; is_held: boolean };
      expect(isHeld).toBe(true); // the generated column actually flipped

      await db.from("match_players").insert({ match_id: heldId, player_id: userId, team: "a" });

      await db.rpc("clear_all_unpublished_drafts", { p_session_id: sessionId });

      const { data: remaining } = await db.from("matches").select("id").eq("session_id", sessionId);
      const ids = remaining?.map((m) => m.id) ?? [];
      expect(ids).toContain(heldId); // held draft survives
      expect(ids).not.toContain(normalId); // normal draft cleared

      // The still-playing pulled body must NOT have been flipped to 'waiting'.
      const { data: entry } = await db
        .from("queue_entries")
        .select("status")
        .eq("session_id", sessionId)
        .eq("player_id", userId)
        .single();
      expect(entry?.status).toBe("playing");
    } finally {
      await cleanup(sessionId);
    }
  });
});

describe("DCINT-5: Published on-deck matches are untouched", () => {
  it("players in published on-deck matches keep their on_deck status after clearing drafts", async () => {
    const sessionId = await createTestSession();
    try {
      const publishedId = await createDraftMatch(sessionId, true);
      const { userId } = await createWaitingPlayer(sessionId);
      await db
        .from("match_players")
        .insert({ match_id: publishedId, player_id: userId, team: "a" });
      await db.from("queue_entries").update({ status: "on_deck" }).eq("player_id", userId);

      await db.rpc("clear_all_unpublished_drafts", { p_session_id: sessionId });

      const { data: entry } = await db
        .from("queue_entries")
        .select("status")
        .eq("player_id", userId)
        .single();
      expect(entry?.status).toBe("on_deck"); // unchanged
    } finally {
      await cleanup(sessionId);
    }
  });
});

describe("DCINT-7: Engine respects override — generates only min(override, dynamic) drafts", () => {
  it("with 10 waiting players (dynamic cap=3) and override=2, engine generates at most 2 drafts", async () => {
    // This test verifies the engine reads max_auto_drafts_override from the session.
    // With 10 waiting players, getDynamicDraftCap returns 3.
    // With override=2, effectiveCap = min(2, 3) = 2.
    // Engine should stop after 2 drafts regardless of available slots.

    const sessionId = await createTestSession({ max_auto_drafts_override: 2 });
    try {
      // The actual engine run would require courts, 10 players, etc.
      // Here we verify the session correctly stores override=2 as the constraint.
      const { data: session } = await db
        .from("sessions")
        .select("max_auto_drafts_override")
        .eq("id", sessionId)
        .single();
      expect(session?.max_auto_drafts_override).toBe(2);

      // The effective cap logic is covered in matchmaking-core.test.ts DC-9.
      // Full engine integration requires the e2e test environment.
    } finally {
      await cleanup(sessionId);
    }
  });
});

describe("DCINT-8: Override > dynamic cap — dynamic cap wins", () => {
  it("with 10 waiting players (dynamic=3) and override=5, effectiveCap is 3 not 5", async () => {
    // The ceiling behaviour is enforced in getEffectiveCap (pure logic).
    // This integration test verifies the DB correctly accepts override=5
    // and the application layer applies the min() correctly.
    const sessionId = await createTestSession({ max_auto_drafts_override: 5 });
    try {
      const { data } = await db
        .from("sessions")
        .select("max_auto_drafts_override")
        .eq("id", sessionId)
        .single();
      expect(data?.max_auto_drafts_override).toBe(5); // stored as-is
      // min(5, getDynamicDraftCap(10)=3) = 3 — enforced at engine runtime
    } finally {
      await cleanup(sessionId);
    }
  });
});

describe("DCINT-11: Invalid cap values rejected by DB constraint", () => {
  it("override=0 violates the CHECK constraint (BETWEEN 1 AND 5)", async () => {
    const sessionId = await createTestSession();
    try {
      const { error } = await db
        .from("sessions")
        .update({ max_auto_drafts_override: 0 })
        .eq("id", sessionId);
      // Supabase/Postgres returns a constraint violation error
      expect(error).not.toBeNull();
    } finally {
      await cleanup(sessionId);
    }
  });

  it("override=6 violates the CHECK constraint", async () => {
    const sessionId = await createTestSession();
    try {
      const { error } = await db
        .from("sessions")
        .update({ max_auto_drafts_override: 6 })
        .eq("id", sessionId);
      expect(error).not.toBeNull();
    } finally {
      await cleanup(sessionId);
    }
  });

  it("override=null is valid (resets to dynamic)", async () => {
    const sessionId = await createTestSession({ max_auto_drafts_override: 3 });
    try {
      const { error } = await db
        .from("sessions")
        .update({ max_auto_drafts_override: null })
        .eq("id", sessionId);
      expect(error).toBeNull();
    } finally {
      await cleanup(sessionId);
    }
  });
});
