// ============================================================
// Unit tests: applyDraftCapOverride server action (orchestration)
// ============================================================
// This action is the ONLY caller of broadcastDraftCapPhase. It replaced
// setCapAndClearDrafts plus a client-side three-phase emit that never worked:
// src/lib/broadcast.ts had no server-only guard, so use-organizer-dashboard.ts
// ("use client") pulled it into the browser bundle where
// SUPABASE_SERVICE_ROLE_KEY is undefined — every phase was dropped at the
// missing-key guard and the co-organizer lockout overlay never engaged.
// These cases pin the server-owned control flow so that emit path cannot
// silently rot again.
//
//   DCA-1   invalid sessionId → rejected before any auth/DB/emit work
//   DCA-2   out-of-range cap (0 / 6 / 1.5) → rejected, emit-free
//   DCA-3   invalid opId → rejected, emit-free (correlation id is load-bearing)
//   DCA-4   unauthenticated → rejected, emit-free
//   DCA-5   authenticated non-organizer → ZERO emits (security invariant)
//   DCA-6   sessions UPDATE fails → error, still emit-free (nothing was locked)
//   DCA-6b  pre-flight THROWS (client construction) → resolves, emit-free,
//           and the raw cause is logged rather than returned
//   DCA-6c  the organizer gate itself throws → same contract
//   DCA-7   auto-matchmaking OFF → exactly one terminal "done", no clear/engine
//   DCA-8   auto ON happy path → "clearing" → "generating" → "done", in step
//           with the clear→engine work it brackets
//   DCA-9   clear fails → "clearing" then "done", never "generating"
//   DCA-9b  clear THROWS → still resolves (never rejects), same phase pair
//   DCA-10  engine throws → "done" still emitted from the finally; resolves
//   DCA-11  a rejecting broadcast is non-fatal to the action's result
//   DCA-12  every emit carries the same opId, the resolved actor, ttlMs 45000,
//           and the sessionId + cap the action was called with
//   DCA-12b a null cap (Dynamic) is valid and is echoed as null on every phase
//   DCA-12c the actor name is resolved for the caller, and a null name still emits
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

// A vi.mock factory REPLACES the whole module, so every export sessions.ts
// imports must be listed — an omitted one is `undefined` at import time.
vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/app/actions/matchmaking", () => ({ runEngineForSession: vi.fn() }));
vi.mock("@/app/actions/match-drafts", () => ({ clearAllUnpublishedDrafts: vi.fn() }));
// Both _shared helpers are needed here: applyDraftCapOverride resolves the
// actor for the broadcast payload in the same Promise.all as the gate.
vi.mock("@/app/actions/_shared", () => ({
  isSessionOrganizer: vi.fn(),
  getActorContext: vi.fn(),
}));
vi.mock("@/lib/broadcast", () => ({
  broadcastSessionClosed: vi.fn().mockResolvedValue(undefined),
  broadcastAutoMatchmakingToggled: vi.fn().mockResolvedValue(undefined),
  broadcastAutoPublishToggled: vi.fn().mockResolvedValue(undefined),
  broadcastDraftCapPhase: vi.fn().mockResolvedValue(undefined),
}));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { runEngineForSession } from "@/app/actions/matchmaking";
import { clearAllUnpublishedDrafts } from "@/app/actions/match-drafts";
import { isSessionOrganizer, getActorContext } from "@/app/actions/_shared";
import { broadcastDraftCapPhase } from "@/lib/broadcast";
import type { DraftCapPhase } from "@/lib/broadcast";
import { applyDraftCapOverride } from "@/app/actions/sessions";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const OP_ID = "11111111-2222-4333-8444-555555555555";
const ACTOR_ID = "99999999-0000-4000-8000-00000000000a";
const ACTOR_NAME = "Jake L";
/** Mirrors CAP_PHASE_LOCK_TTL_MS in sessions.ts — the lease the receiver honours. */
const EXPECTED_TTL_MS = 45_000;

// The action deliberately logs (and swallows) engine + broadcast failures;
// silence them so a passing run has a clean transcript. Kept as handles so
// DCA-10/DCA-11 can assert the failure was actually observed, not lost.
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

// ── Mock builders ──────────────────────────────────────────────

type MockResponse = { data?: unknown; error?: { message: string } | null };

function makeBuilder(response: MockResponse) {
  const b: Record<string, unknown> = {};
  b["single"] = () => Promise.resolve(response);
  b["then"] = (res: (v: MockResponse) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(response).then(res, rej);
  for (const m of ["select", "eq", "update", "in", "neq", "order", "limit"]) {
    b[m] = (..._args: unknown[]) => b;
  }
  return b;
}

/** Service client whose sessions UPDATE…RETURNING resolves to `sessionRow`. */
function makeServiceClient(sessionRow: MockResponse) {
  return {
    from: vi.fn(() => makeBuilder(sessionRow)),
  };
}

function makeServerClient(userId: string | null) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId } : null },
        error: null,
      }),
    },
  };
}

/** The sessions row the UPDATE…RETURNING yields, keyed on auto-matchmaking. */
function stubSessionUpdate(autoIsOn: boolean) {
  const client = makeServiceClient({ data: { is_auto_matchmaking_on: autoIsOn }, error: null });
  vi.mocked(createServiceClient).mockReturnValue(client as never);
  return client;
}

/** The phase string of every draft_cap_phase emit, in emission order. */
function emittedPhases(): DraftCapPhase[] {
  return vi.mocked(broadcastDraftCapPhase).mock.calls.map((c) => c[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createServerSupabaseClient).mockResolvedValue(makeServerClient(ACTOR_ID) as never);
  vi.mocked(isSessionOrganizer).mockResolvedValue(true);
  vi.mocked(getActorContext).mockResolvedValue({ id: ACTOR_ID, name: ACTOR_NAME });
  vi.mocked(broadcastDraftCapPhase).mockResolvedValue(undefined);
  vi.mocked(runEngineForSession).mockResolvedValue(undefined as never);
  vi.mocked(clearAllUnpublishedDrafts).mockResolvedValue({
    success: true,
    message: "Cleared 3 drafts.",
    clearedCount: 3,
    affectedPlayerIds: [],
  });
});

describe("applyDraftCapOverride — gates run before anything emits", () => {
  it("DCA-1: invalid sessionId → rejected with no auth, no DB write, no emit", async () => {
    const result = await applyDraftCapOverride("not-a-uuid", 3, OP_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid session/i);
    // Bailing before the client is even constructed is what makes this cheap
    // AND emit-free; asserting only on the broadcast would miss a regression
    // that moved the uuid check below the write.
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(broadcastDraftCapPhase).not.toHaveBeenCalled();
  });

  it("DCA-2: cap outside null|1–5 → rejected, nothing written or emitted", async () => {
    // 0 and 6 are the off-by-one neighbours of the real bounds; 1.5 catches a
    // range check written without an integer check (a fractional cap would be
    // persisted and then silently floor/round somewhere downstream).
    for (const badCap of [0, 6, 1.5]) {
      vi.clearAllMocks();

      const result = await applyDraftCapOverride(SESSION_ID, badCap, OP_ID);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/cap/i);
      expect(createServiceClient).not.toHaveBeenCalled();
      expect(broadcastDraftCapPhase).not.toHaveBeenCalled();
    }
  });

  it("DCA-3: invalid opId → rejected, no emit", async () => {
    // An emit without a well-formed opId is worse than no emit: receivers
    // correlate lock/unlock by opId, so an unmatched 'clearing' would leave
    // co-organizers locked until the TTL lease expires.
    const result = await applyDraftCapOverride(SESSION_ID, 3, "op-1");

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/operation id/i);
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
    expect(broadcastDraftCapPhase).not.toHaveBeenCalled();
  });

  it("DCA-4: unauthenticated caller → rejected before the organizer check, no emit", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeServerClient(null) as never);

    const result = await applyDraftCapOverride(SESSION_ID, 3, OP_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not authenticated/i);
    expect(isSessionOrganizer).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(broadcastDraftCapPhase).not.toHaveBeenCalled();
  });

  it("DCA-5: authenticated non-organizer → ZERO broadcastDraftCapPhase calls", async () => {
    // THE security invariant of this action. If any code above the authorization
    // check could emit, any logged-in user could POST a session UUID and lock
    // every organizer's dashboard behind an overlay with no dismiss control.
    vi.mocked(isSessionOrganizer).mockResolvedValue(false);

    const result = await applyDraftCapOverride(SESSION_ID, 2, OP_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/organizer/i);
    expect(broadcastDraftCapPhase).toHaveBeenCalledTimes(0);
    // No service client → the cap was never persisted either.
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(clearAllUnpublishedDrafts).not.toHaveBeenCalled();
    expect(runEngineForSession).not.toHaveBeenCalled();
  });

  it("DCA-6: sessions UPDATE fails → error returned and still no emit", async () => {
    // The emit block sits below the write. A failed write locked nobody, so
    // emitting here would strand co-organizers on a change that never happened.
    vi.mocked(createServiceClient).mockReturnValue(
      makeServiceClient({ data: null, error: { message: "column does not exist" } }) as never
    );

    const result = await applyDraftCapOverride(SESSION_ID, 4, OP_ID);

    expect(result.success).toBe(false);
    expect(result.error).toContain("column does not exist");
    expect(broadcastDraftCapPhase).not.toHaveBeenCalled();
    expect(clearAllUnpublishedDrafts).not.toHaveBeenCalled();
    expect(runEngineForSession).not.toHaveBeenCalled();
  });

  it("DCA-6b: pre-flight THROWS → resolves with a clean error, still emit-free", async () => {
    // Client construction and PostgREST transport can both throw. CLAUDE.md
    // forbids throwing out of a server action, so the whole emit-free span
    // (auth → organizer gate → cap write) is wrapped. The raw error must not
    // reach the organizer — it is logged instead.
    // …Once, not a persistent implementation: beforeEach uses clearAllMocks,
    // which clears calls but NOT implementations, so a sticky thrower would
    // leak into every later test that doesn't re-stub this mock.
    vi.mocked(createServiceClient).mockImplementationOnce(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
    });

    const result = await applyDraftCapOverride(SESSION_ID, 4, OP_ID);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Couldn't save the draft cap. Please try again.");
    expect(result.error).not.toContain("SERVICE_ROLE");
    // Also pins "exactly once, and only after the organizer gate" — and proves
    // the once-impl above was actually consumed, so it cannot leak forward.
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(broadcastDraftCapPhase).not.toHaveBeenCalled();
    expect(clearAllUnpublishedDrafts).not.toHaveBeenCalled();
    expect(runEngineForSession).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("DCA-6c: the organizer gate THROWS → same contract (resolves, emit-free)", async () => {
    vi.mocked(isSessionOrganizer).mockRejectedValue(new Error("PostgREST unreachable"));

    const result = await applyDraftCapOverride(SESSION_ID, 4, OP_ID);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Couldn't save the draft cap. Please try again.");
    expect(broadcastDraftCapPhase).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("applyDraftCapOverride — phase emission", () => {
  it("DCA-7: auto-matchmaking OFF → exactly one emit, and it is a terminal 'done'", async () => {
    stubSessionUpdate(false);

    const result = await applyDraftCapOverride(SESSION_ID, 3, OP_ID);

    expect(result.success).toBe(true);
    expect(result.autoIsOn).toBe(false);
    expect(result.clearedCount).toBe(0);
    // A lone 'done' is deliberate: it unlocks any client that armed a lease
    // from a previous op and makes every cap chip converge. Emitting nothing
    // would be a silent divergence; emitting 'clearing' here would lock
    // co-organizers for work that never runs.
    expect(emittedPhases()).toEqual(["done"]);
    expect(clearAllUnpublishedDrafts).not.toHaveBeenCalled();
    expect(runEngineForSession).not.toHaveBeenCalled();
  });

  it("DCA-8: auto ON → 'clearing' → 'generating' → 'done', bracketing clear then engine", async () => {
    stubSessionUpdate(true);

    const result = await applyDraftCapOverride(SESSION_ID, 2, OP_ID);

    expect(result.success).toBe(true);
    expect(result.autoIsOn).toBe(true);
    expect(result.clearedCount).toBe(3);
    expect(emittedPhases()).toEqual(["clearing", "generating", "done"]);

    // Order is the whole point of doing this server-side: 'clearing' must be on
    // the wire BEFORE drafts vanish, or co-organizers watch matches disappear
    // with no overlay, and 'done' must land after the engine or they unlock onto
    // a half-regenerated board.
    const [clearing, generating, done] = vi.mocked(broadcastDraftCapPhase).mock.invocationCallOrder;
    const clearOrder = vi.mocked(clearAllUnpublishedDrafts).mock.invocationCallOrder[0];
    const engineOrder = vi.mocked(runEngineForSession).mock.invocationCallOrder[0];

    expect(clearing).toBeLessThan(clearOrder);
    expect(clearOrder).toBeLessThan(generating);
    expect(generating).toBeLessThan(engineOrder);
    expect(engineOrder).toBeLessThan(done);

    expect(clearAllUnpublishedDrafts).toHaveBeenCalledWith(SESSION_ID);
    expect(runEngineForSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it("DCA-9: clear fails → 'clearing' then 'done', never 'generating'", async () => {
    stubSessionUpdate(true);
    vi.mocked(clearAllUnpublishedDrafts).mockResolvedValue({
      success: false,
      message: "Failed to clear drafts.",
      clearedCount: 0,
      affectedPlayerIds: [],
    });

    const result = await applyDraftCapOverride(SESSION_ID, 5, OP_ID);

    expect(result.success).toBe(false);
    expect(result.autoIsOn).toBe(true);
    expect(result.error).toBe("Failed to clear drafts.");
    // The early return still passes through the finally — a failure path that
    // skipped 'done' would leave every co-organizer locked until the TTL lease
    // expired, which is the exact bricking the lease exists to bound.
    expect(emittedPhases()).toEqual(["clearing", "done"]);
    expect(runEngineForSession).not.toHaveBeenCalled();
  });

  it("DCA-9b: clear THROWS → action resolves (never rejects) and still emits 'done'", async () => {
    stubSessionUpdate(true);
    vi.mocked(clearAllUnpublishedDrafts).mockRejectedValue(new Error("PostgREST unreachable"));

    // A rejection here would escape the action entirely: the caller sees a
    // transport-shaped error instead of a result, which CLAUDE.md forbids.
    const result = await applyDraftCapOverride(SESSION_ID, 3, OP_ID);

    expect(result.success).toBe(false);
    expect(result.autoIsOn).toBe(true);
    expect(result.error).toBe("Failed to clear drafts.");
    expect(emittedPhases()).toEqual(["clearing", "done"]);
    expect(runEngineForSession).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("DCA-10: engine throws → 'done' still emitted and the action resolves", async () => {
    stubSessionUpdate(true);
    vi.mocked(runEngineForSession).mockRejectedValue(new Error("engine exploded"));

    // Must not reject: CLAUDE.md forbids throwing out of a server action, and a
    // rejection here would skip the client's own unlock handling too.
    const result = await applyDraftCapOverride(SESSION_ID, 3, OP_ID);

    expect(result.success).toBe(true);
    expect(result.autoIsOn).toBe(true);
    expect(emittedPhases()).toEqual(["clearing", "generating", "done"]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("DCA-11: a rejecting broadcast is non-fatal — the action still succeeds", async () => {
    stubSessionUpdate(true);
    vi.mocked(broadcastDraftCapPhase).mockRejectedValue(new Error("realtime 503"));

    const result = await applyDraftCapOverride(SESSION_ID, 1, OP_ID);

    // The DB work already committed; a dead broadcast must not turn a completed
    // cap change into a red toast (and the receiver's TTL lease covers the lost
    // 'done' anyway).
    expect(result.success).toBe(true);
    expect(result.clearedCount).toBe(3);
    expect(broadcastDraftCapPhase).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("DCA-12: every emit carries the same opId, actor, ttl, session and cap", async () => {
    stubSessionUpdate(true);

    await applyDraftCapOverride(SESSION_ID, 4, OP_ID);

    const calls = vi.mocked(broadcastDraftCapPhase).mock.calls;
    expect(calls).toHaveLength(3);

    for (const [sessionId, , override, meta] of calls) {
      expect(sessionId).toBe(SESSION_ID);
      // The cap must ride along on EVERY phase: a receiver that only learns the
      // new cap on 'done' shows a stale chip for the whole locked window.
      expect(override).toBe(4);
      // opId identical across phases is what lets the initiating tab ignore its
      // own echo (the REST broadcast has no sending socket) and stops one
      // organizer's 'done' from releasing another's in-flight reset.
      expect(meta).toEqual({
        opId: OP_ID,
        actorId: ACTOR_ID,
        actorName: ACTOR_NAME,
        ttlMs: EXPECTED_TTL_MS,
      });
    }
  });

  it("DCA-12b: a null cap (Dynamic) is a valid override and is echoed as null", async () => {
    // Guards a bounds check rewritten as a truthiness test — `!cap` would
    // reject Dynamic outright and there'd be no way back off a fixed cap.
    stubSessionUpdate(true);

    const result = await applyDraftCapOverride(SESSION_ID, null, OP_ID);

    expect(result.success).toBe(true);
    expect(vi.mocked(broadcastDraftCapPhase).mock.calls.map((c) => c[2])).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("DCA-12c: the actor name is resolved for the caller, not hardcoded null", async () => {
    // The overlay reads "{name} is changing the draft cap"; a null name from a
    // missing profile must still emit (with null) rather than break the phase.
    stubSessionUpdate(false);
    vi.mocked(getActorContext).mockResolvedValue({ id: ACTOR_ID, name: null });

    await applyDraftCapOverride(SESSION_ID, 3, OP_ID);

    expect(getActorContext).toHaveBeenCalledWith(ACTOR_ID);
    expect(vi.mocked(broadcastDraftCapPhase).mock.calls[0][3]).toEqual({
      opId: OP_ID,
      actorId: ACTOR_ID,
      actorName: null,
      ttlMs: EXPECTED_TTL_MS,
    });
  });
});
