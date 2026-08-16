// ============================================================
// Unit tests: the held-draft publish guard in the JS RPC fallbacks
// ============================================================
// Migration 20260816000000 teaches publish_match / publish_all_drafts to refuse
// an UNREADY held draft (is_held AND held_ready_at IS NULL). Every environment
// that has not had that migration hand-applied yet runs the JS fallbacks in
// src/app/actions/match-drafts.ts instead — and migrations here are applied by
// hand, so "not applied yet" is a real state, not a hypothetical one. These
// cases pin the fallbacks to the same rule the SQL enforces.
//
// Why the rule exists at all (the bug this suite exists to prevent regressing):
//   HOLDING — the draft's fourth player is still on court, so the publish
//     conflict probe matches 100% of the time and the organizer was told to
//     "clear this draft and let the engine regenerate" about a draft that was
//     merely waiting. In the 08/15 live session 10 of 12 held drafts were
//     manually cleared — plausibly on that advice, but prod logs no publish
//     attempt, so the link is read off the copy rather than traced.
//   RESTING — the source match ended but the engine has not stamped
//     held_ready_at yet. This one PUBLISHES, fires a premature ON_DECK_WARNING
//     push, and then sits on deck un-promotable. Refusing it is the fix.
//
// The predicate itself is pinned in tests/unit/derive-held-state.test.ts
// (CC-DHS-06..08); the engine-side cap/heartbeat behaviour in
// tests/unit/matchmaking-engine.test.ts (CAP-HELD-*, ENG-HEARTBEAT-*).
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
// after() (fire-and-forget push) runs synchronously in tests.
vi.mock("next/server", () => ({ after: (cb: () => unknown) => cb() }));
vi.mock("@/lib/notifications/push-server", () => ({
  pushToPlayers: vi.fn().mockResolvedValue({ sent: 0, errors: 0 }),
}));
vi.mock("@/app/actions/matchmaking", () => ({ runEngineForSession: vi.fn() }));
vi.mock("@/app/actions/_shared", () => ({
  getAuthenticatedUser: vi.fn(),
  isSessionOrganizer: vi.fn(),
}));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { runEngineForSession } from "@/app/actions/matchmaking";
import { getAuthenticatedUser, isSessionOrganizer } from "@/app/actions/_shared";
import { pushToPlayers } from "@/lib/notifications/push-server";
import { publishMatchAction, publishAllDraftMatchesAction } from "@/app/actions/match-drafts";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const MATCH_ID = "00000000-0000-4000-8000-000000000002";
const STAMP = "2026-08-16T00:00:00.000Z";

// The organizer-facing copy is deliberately NOT phrased as a failure and
// deliberately does NOT end in "clear and regenerate" — that instruction is what
// destroyed 10 perfectly good drafts in the live session. Matched by shape, not
// by string equality, so a copy tweak doesn't fail the behavioural assertion.
const WAITS_FOR_COURT = /still on court/i;
const UNLOCKS_ITSELF = /unlocks by itself/i;
const CLEAR_AND_REGENERATE = /regenerate/i;

// ── Recording mock client ──────────────────────────────────────
// Same chainable-builder shape as tests/unit/publish-engine-trigger.test.ts,
// plus a call log: several of these cases are about WHICH ids reach a filter
// (the candidate set vs the conflict-probe exclusion set), which the returned
// data can't show.

type MockResponse = { data?: unknown; error?: { message: string; code?: string } | null };
type Call = { table: string; method: string; args: unknown[] };

function makeBuilder(table: string, response: MockResponse, log: Call[]) {
  const b: Record<string, unknown> = {};
  b["then"] = (res: (v: MockResponse) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(response).then(res, rej);
  b["catch"] = (rej: (e: unknown) => unknown) => Promise.resolve(response).catch(rej);
  b["maybeSingle"] = () => Promise.resolve(response);
  b["single"] = () => Promise.resolve(response);
  for (const m of [
    "select",
    "eq",
    "neq",
    "in",
    "not",
    "or",
    "order",
    "limit",
    "update",
    "insert",
    "upsert",
    "delete",
  ]) {
    b[m] = (...args: unknown[]) => {
      log.push({ table, method: m, args });
      return b;
    };
  }
  return b;
}

function makeSvc(rpcResponse: MockResponse, fromResponses: MockResponse[] = []) {
  const calls: Call[] = [];
  const tables: string[] = [];
  let idx = 0;
  return {
    calls,
    tables,
    rpc: vi.fn().mockResolvedValue(rpcResponse),
    from: vi.fn((table: string) => {
      tables.push(table);
      return makeBuilder(table, fromResponses[idx++] ?? { data: null, error: null }, calls);
    }),
  };
}

function makeServerClient(fromResponses: MockResponse[]) {
  const calls: Call[] = [];
  let idx = 0;
  return {
    from: vi.fn((table: string) =>
      makeBuilder(table, fromResponses[idx++] ?? { data: null, error: null }, calls)
    ),
  };
}

/** First `method` call recorded against `table`, or undefined. */
const findCall = (calls: Call[], table: string, method: string) =>
  calls.find((c) => c.table === table && c.method === method);

/** PGRST202 = "function does not exist" → every action falls back to JS. */
const RPC_MISSING = { message: "Could not find the function", code: "PGRST202" };

/** Draft-list row shape read by both publish-all paths. */
const draft = (id: string, isHeld = false, readyAt: string | null = null) => ({
  id,
  is_held: isHeld,
  held_ready_at: readyAt,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runEngineForSession).mockResolvedValue(undefined);
  vi.mocked(getAuthenticatedUser).mockResolvedValue({
    id: "user-1",
    email: "org@test.com",
  } as never);
  vi.mocked(isSessionOrganizer).mockResolvedValue(true);
});

// ─────────────────────────────────────────────────────────────
// publishMatchAction — single publish
// ─────────────────────────────────────────────────────────────

describe("publishMatchAction — held guard", () => {
  it("PUB-HELD-1: HELD_NOT_READY explains the wait and does NOT tell the organizer to clear", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeServerClient([{ data: { session_id: SESSION_ID }, error: null }]) as never
    );
    const svc = makeSvc({ data: "HELD_NOT_READY", error: null });
    vi.mocked(createServiceClient).mockReturnValue(svc as never);

    const result = await publishMatchAction(MATCH_ID);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(WAITS_FOR_COURT);
    expect(result.message).toMatch(UNLOCKS_ITSELF);
    // The whole point: this is the code CONFLICT used to be mislabelled as, and
    // CONFLICT's copy ends in "Clear this draft and let the engine regenerate."
    expect(result.message).not.toMatch(CLEAR_AND_REGENERATE);
    // Nothing moved, so nothing to refill — and no premature on-deck push.
    expect(runEngineForSession).not.toHaveBeenCalled();
    expect(pushToPlayers).not.toHaveBeenCalled();
  });

  it("PUB-HELD-2: the fallback refuses an unready hold before it can read a roster", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeServerClient([{ data: { session_id: SESSION_ID }, error: null }]) as never
    );
    const svc = makeSvc({ data: null, error: RPC_MISSING }, [
      {
        data: {
          session_id: SESSION_ID,
          status: "pending",
          is_published: false,
          is_held: true,
          held_ready_at: null,
        },
        error: null,
      },
    ]);
    vi.mocked(createServiceClient).mockReturnValue(svc as never);

    const result = await publishMatchAction(MATCH_ID);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(WAITS_FOR_COURT);
    expect(result.message).not.toMatch(CLEAR_AND_REGENERATE);
    // Ordering, not just outcome: the guard sits AHEAD of the left/conflict
    // probes. If it slipped below them the conflict query would fire, match the
    // on-court player, and answer with the wrong message — which is the original
    // bug reproduced inside the fallback.
    expect(svc.from).toHaveBeenCalledTimes(1);
    expect(svc.tables).toEqual(["matches"]);
    expect(findCall(svc.calls, "matches", "update")).toBeUndefined();
    expect(runEngineForSession).not.toHaveBeenCalled();
  });

  it("PUB-HELD-3: a READY hold publishes through the fallback like any other draft", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeServerClient([{ data: { session_id: SESSION_ID }, error: null }]) as never
    );
    const svc = makeSvc({ data: null, error: RPC_MISSING }, [
      // 1. matches — held, but stamped ⇒ READY
      {
        data: {
          session_id: SESSION_ID,
          status: "pending",
          is_published: false,
          is_held: true,
          held_ready_at: STAMP,
        },
        error: null,
      },
      // 2. match_players — empty roster skips the left/conflict probes
      { data: [], error: null },
      // 3. matches update
      { data: null, error: null },
    ]);
    vi.mocked(createServiceClient).mockReturnValue(svc as never);

    const result = await publishMatchAction(MATCH_ID);

    // Guarding a READY hold would be the same bug with the sign flipped: the
    // stamp is exactly what makes a hold publishable, so a stamped hold that
    // still can't publish is permanently stuck.
    expect(result.success).toBe(true);
    expect(result.message).toBe("Match published.");
    expect(findCall(svc.calls, "matches", "update")).toBeDefined();
    expect(runEngineForSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it("PUB-HELD-4: the fallback's match read carries the two held columns", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeServerClient([{ data: { session_id: SESSION_ID }, error: null }]) as never
    );
    const svc = makeSvc({ data: null, error: RPC_MISSING }, [
      {
        data: {
          session_id: SESSION_ID,
          status: "pending",
          is_published: false,
          is_held: true,
          held_ready_at: null,
        },
        error: null,
      },
    ]);
    vi.mocked(createServiceClient).mockReturnValue(svc as never);

    await publishMatchAction(MATCH_ID);

    // Without both columns in the projection the guard reads undefined on every
    // row and silently never fires — a select-list regression that no
    // outcome-only assertion above would notice, because PostgREST returns the
    // row either way.
    const select = findCall(svc.calls, "matches", "select");
    expect(select?.args[0]).toContain("is_held");
    expect(select?.args[0]).toContain("held_ready_at");
  });

  it("PUB-HELD-5: an already-published unready hold is not stranded — it still answers 'Already published.'", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeServerClient([{ data: { session_id: SESSION_ID }, error: null }]) as never
    );
    const svc = makeSvc({ data: null, error: RPC_MISSING }, [
      {
        data: {
          session_id: SESSION_ID,
          status: "pending",
          is_published: true,
          is_held: true,
          held_ready_at: null,
        },
        error: null,
      },
    ]);
    vi.mocked(createServiceClient).mockReturnValue(svc as never);

    const result = await publishMatchAction(MATCH_ID);

    // Holds published before this guard existed are still sitting on deck in
    // live sessions. The is_published check deliberately precedes the held
    // guard so re-publishing one is a no-op success rather than a new error the
    // organizer can do nothing about; callNextMatch is what resolves them.
    expect(result).toEqual({ success: true, message: "Already published." });
  });
});

// ─────────────────────────────────────────────────────────────
// publishAllDraftMatchesAction — "Publish All"
// ─────────────────────────────────────────────────────────────

describe("publishAllDraftMatchesAction — held guard", () => {
  it("PUB-HELD-6: the on-deck ping re-read skips the unready hold the RPC never touched", async () => {
    const svc = makeSvc(
      { data: { success: true, published_count: 1, skipped_count: 0 }, error: null },
      [
        // 1. draft snapshot: one plain draft + one unready hold
        { data: [draft("d1"), draft("h1", true)], error: null },
        // 2. re-read of the ones that actually flipped
        { data: [{ id: "d1" }], error: null },
        // 3. rosters of the published set
        { data: [{ player_id: "p1" }], error: null },
      ]
    );
    vi.mocked(createServiceClient).mockReturnValue(svc as never);

    const result = await publishAllDraftMatchesAction(SESSION_ID);

    expect(result.success).toBe(true);
    // publish_all_drafts excludes unready holds from its candidate set, so h1
    // cannot have flipped. Widening the re-read onto it would be harmless today
    // but would silently start pushing ON_DECK_WARNING at a player still on
    // court the moment the two filters drift apart.
    expect(findCall(svc.calls, "matches", "in")?.args).toEqual(["id", ["d1"]]);
    expect(pushToPlayers).toHaveBeenCalledWith(["p1"], "ON_DECK_WARNING", SESSION_ID);
  });

  it("PUB-HELD-7: the skip message no longer blames departed players for every skip", async () => {
    const svc = makeSvc(
      { data: { success: true, published_count: 1, skipped_count: 2 }, error: null },
      [
        { data: [draft("d1"), draft("d2"), draft("d3")], error: null },
        { data: [{ id: "d1" }], error: null },
        { data: [{ player_id: "p1" }], error: null },
      ]
    );
    vi.mocked(createServiceClient).mockReturnValue(svc as never);

    const result = await publishAllDraftMatchesAction(SESSION_ID);

    expect(result.skippedCount).toBe(2);
    // The RPC returns counts, not reasons, so the copy has to cover both real
    // causes honestly. It used to read "(left players)" unconditionally, which
    // was false for every held draft skipped as a CONFLICT.
    expect(result.message).toMatch(/2 drafts skipped/);
    expect(result.message).toMatch(/left or is already in another match/i);
    expect(result.message).not.toMatch(/\(left players\)/);
  });

  it("PUB-HELD-8: the fallback drops the unready hold from candidates but KEEPS it in the conflict-probe exclusion set", async () => {
    const drafts = { data: [draft("d1"), draft("h1", true)], error: null };
    const svc = makeSvc({ data: null, error: RPC_MISSING }, [
      // 1. outer snapshot (runs before the RPC, so before the fallback)
      drafts,
      // 2. fallback's own draft list
      drafts,
      // 3. match_players for the candidates
      { data: [{ match_id: "d1", player_id: "p1" }], error: null },
      // 4. queue_entries — nobody left
      { data: [], error: null },
      // 5. other active matches
      { data: [], error: null },
      // 6. matches update ... .select("id")
      { data: [{ id: "d1" }], error: null },
      // 7. queue_entries update → on_deck
      { data: null, error: null },
    ]);
    vi.mocked(createServiceClient).mockReturnValue(svc as never);

    const result = await publishAllDraftMatchesAction(SESSION_ID);

    expect(result.publishedCount).toBe(1);
    // The two lists are deliberately different. Candidates exclude the hold...
    expect(findCall(svc.calls, "match_players", "in")?.args).toEqual(["match_id", ["d1"]]);
    // ...but the exclusion set must NOT, or the hold reads back as an "other
    // active match" containing its own pulled body and taints d1 into a skip.
    expect(findCall(svc.calls, "matches", "not")?.args).toEqual(["id", "in", "(d1,h1)"]);
    expect(runEngineForSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it("PUB-HELD-9: a fallback with nothing but unready holds publishes nothing and reports no failure", async () => {
    const drafts = { data: [draft("h1", true), draft("h2", true)], error: null };
    const svc = makeSvc({ data: null, error: RPC_MISSING }, [drafts, drafts]);
    vi.mocked(createServiceClient).mockReturnValue(svc as never);

    const result = await publishAllDraftMatchesAction(SESSION_ID);

    // success:true, not an error. Nothing is broken — the drafts are simply not
    // due yet, and the "All N drafts have a player who left..." branch below
    // would be a lie that pushes the organizer to clear them.
    expect(result.success).toBe(true);
    expect(result.message).toBe("No drafts to publish.");
    expect(result.publishedCount).toBe(0);
    expect(findCall(svc.calls, "matches", "update")).toBeUndefined();
    expect(runEngineForSession).not.toHaveBeenCalled();
  });

  it("PUB-HELD-10: a READY hold is a fallback candidate and publishes", async () => {
    const drafts = { data: [draft("h1", true, STAMP)], error: null };
    const svc = makeSvc({ data: null, error: RPC_MISSING }, [
      drafts,
      drafts,
      { data: [{ match_id: "h1", player_id: "p1" }], error: null },
      { data: [], error: null },
      { data: [], error: null },
      { data: [{ id: "h1" }], error: null },
      { data: null, error: null },
    ]);
    vi.mocked(createServiceClient).mockReturnValue(svc as never);

    const result = await publishAllDraftMatchesAction(SESSION_ID);

    expect(result.publishedCount).toBe(1);
    expect(findCall(svc.calls, "match_players", "in")?.args).toEqual(["match_id", ["h1"]]);
  });
});
