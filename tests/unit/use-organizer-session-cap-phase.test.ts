// @vitest-environment happy-dom
// ============================================================
// Unit Tests — useOrganizerSession draft-cap lockout LEASE
// ============================================================
// `onDraftCapPhaseChanged` drives a `fixed inset-0 z-[200]` overlay that has no
// dismiss control, no Esc handler and no polling fallback. Every failure mode
// below is therefore silent-but-fatal: the board either never locks (the
// co-organizer edits drafts that are being deleted underneath them) or never
// unlocks (dashboard bricked until a manual reload). None of it surfaces an
// error, so only these assertions can catch a regression.
//
//   UCS-1   Unknown wire phase ("Done", "clearing ", 42, undefined) is ignored
//           with a console.warn and leaves the signal idle. The pre-fix code was
//           `phase === "done" ? null : phase`, so ANY other string locked the
//           board forever and rendered as "Generating new drafts…".
//   UCS-2   "clearing" adopts phase + opId + actorName.
//   UCS-3   A LATE "clearing" after "generating" for the same op cannot walk the
//           lock backwards (CAP_PHASE_RANK guard).
//   UCS-4   "done" for the active op releases the lock AND refetches the session
//           (the refetch is how max_auto_drafts_override converges).
//   UCS-5   "done" carrying a DIFFERENT opId must NOT release this client's lock
//           — organizer A finishing would otherwise unlock organizer B's
//           still-running reset mid-flight.
//   UCS-6   A "clearing" that arrives AFTER its own op's "done" is discarded
//           (finished-op ring), instead of re-locking for a whole fresh lease.
//   UCS-7   No "done" ever arrives → the lease self-unlocks at ttlMs, warns, and
//           toasts only when the tab is visible. This is the sole recovery path
//           for a dropped 'done' (Realtime 5xx, socket drop, serverless timeout).
//   UCS-8   ttlMs is clamped to [5_000, 120_000] with a 30_000 default, so a
//           garbled or hostile server value can neither cut a live reset short
//           nor pin the overlay open for hours.
//   UCS-9   Rolling-deploy compatibility: a payload with no opId still adopts the
//           phase, and a legacy "done" still clears it — including the SECOND
//           such op, which the finished-op ring used to swallow forever because
//           every legacy payload shares one sentinel id.
//   UCS-10  Unmounting with a lease armed must not fire the unlock afterwards
//           (setState on an unmounted hook + a stray toast on another screen).
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Session } from "@/types/database";
import type { OrganizerBroadcastHandlers } from "@/lib/realtime";
import type { DraftCapPhasePayload } from "@/lib/broadcast";

// ── Fixtures ──────────────────────────────────────────────────

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const CURRENT_USER_ID = "user-viewing-organizer";

const SESSION: Session = {
  id: SESSION_ID,
  name: "Tuesday Social",
  created_by: CURRENT_USER_ID,
  club_id: "club-chillax",
  organizer_passcode: null,
  scoring: "single",
  is_active: true,
  is_auto_matchmaking_on: false,
  court_time_limit_minutes: null,
  max_auto_drafts_override: null,
  auto_publish: false,
  is_hidden: false,
  created_at: "2026-08-04T00:00:00.000Z",
  ended_at: null,
};

/** The idle value the hook exposes when no cap reset is in flight. */
const IDLE = { phase: null, opId: null, actorName: null };

// ── Mocks ─────────────────────────────────────────────────────
// Each factory below only *closes over* the module-level spies; it never reads
// them while the factory itself runs, which is what keeps them out of the TDZ
// (vi.mock factories are evaluated before this file's own module body).

let capturedHandlers: OrganizerBroadcastHandlers | null = null;
const unsubscribeSpy = vi.fn();

vi.mock("@/lib/realtime", () => ({
  subscribeToOrganizerBroadcast: (
    _client: unknown,
    _sessionId: string,
    handlers: OrganizerBroadcastHandlers
  ) => {
    capturedHandlers = handlers;
    return unsubscribeSpy;
  },
}));

// The real helper gates the channel join on the Realtime JWT; resolved-now keeps
// the fake client's channel stubs on the same microtask as the mount.
vi.mock("@/utils/supabase/client", () => ({
  whenRealtimeAuthReady: () => Promise.resolve(),
}));

const getSessionForOrganizerMock = vi.fn((_sessionId: string) =>
  Promise.resolve({ success: true, session: SESSION })
);

vi.mock("@/app/actions/sessions", () => ({
  getSessionForOrganizer: (sessionId: string) => getSessionForOrganizerMock(sessionId),
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { toast } from "sonner";
import { useOrganizerSession } from "@/hooks/use-organizer-session";

// ── Harness ───────────────────────────────────────────────────

type FakeChannel = { on: () => FakeChannel; subscribe: () => FakeChannel };

/**
 * Minimal SupabaseClient stand-in. The hook only ever calls
 * `.channel(name).on(...).subscribe()` and `.removeChannel(ch)` on it — the
 * broadcast path under test is fully intercepted by the @/lib/realtime mock.
 */
function makeSupabase(): SupabaseClient<Database> {
  const channel: FakeChannel = {
    on: () => channel,
    subscribe: () => channel,
  };
  const client = {
    channel: () => channel,
    removeChannel: () => {},
  };
  return client as unknown as SupabaseClient<Database>;
}

/**
 * The client instance is created ONCE per render harness, not per render: it is
 * a dependency of the subscription effect, so a fresh object each render would
 * re-run the effect and silently clear the armed lease between assertions.
 */
function renderSession() {
  const supabase = makeSupabase();
  return renderHook(() => useOrganizerSession(SESSION_ID, SESSION, supabase, CURRENT_USER_ID));
}

/**
 * Deliver a draft_cap_phase payload exactly the way subscribeToOrganizerBroadcast
 * would. Takes `unknown` on purpose — several cases send values the compile-time
 * type forbids, which is precisely the wire traffic the guard exists for.
 */
function emitPhase(payload: unknown): void {
  const handler = capturedHandlers?.onDraftCapPhaseChanged;
  if (!handler) throw new Error("onDraftCapPhaseChanged was never registered");
  act(() => {
    handler(payload as DraftCapPhasePayload);
  });
}

/** Same as emitPhase but flushes the async session refetch the handler kicks off. */
async function emitPhaseAsync(payload: unknown): Promise<void> {
  const handler = capturedHandlers?.onDraftCapPhaseChanged;
  if (!handler) throw new Error("onDraftCapPhaseChanged was never registered");
  await act(async () => {
    handler(payload as DraftCapPhasePayload);
  });
}

/** Advance fake timers inside act, flushing the refetch the lease expiry fires. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

const EXPIRY_WARNING =
  "[useOrganizerSession] draft-cap lock expired without 'done' — self-unlocking";

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandlers = null;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  warnSpy.mockRestore();
});

// ── Tests ─────────────────────────────────────────────────────

describe("useOrganizerSession — draft-cap lease", () => {
  describe("UCS-1: unknown phase values are rejected, not adopted", () => {
    // Each of these is a plausible wire value: a server that title-cases, a
    // payload that picked up whitespace, a numeric enum from a future schema, a
    // dropped field. Pre-fix, every one of them locked the board permanently
    // because only the literal "done" mapped to null.
    const REJECTED: Array<[string, unknown]> = [
      ["title-cased 'Done'", { phase: "Done", override: null, opId: "op-bad-1" }],
      ["trailing-space 'clearing '", { phase: "clearing ", override: null, opId: "op-bad-2" }],
      ["numeric 42", { phase: 42, override: null, opId: "op-bad-3" }],
      ["missing phase", { override: null, opId: "op-bad-4" }],
    ];

    it.each(REJECTED)("%s leaves capSignal idle and warns", (_label, payload) => {
      const { result } = renderSession();

      emitPhase(payload);

      expect(result.current.capSignal).toEqual(IDLE);
      expect(warnSpy).toHaveBeenCalledWith(
        "[useOrganizerSession] ignoring unknown draft_cap_phase:",
        (payload as { phase?: unknown }).phase
      );
      // An unknown value must not be treated as a terminal phase either — no
      // refetch, and nothing entered the finished-op ring.
      expect(getSessionForOrganizerMock).not.toHaveBeenCalled();
    });

    it("a rejected phase does not consume the op, so a later real phase still locks", () => {
      const { result } = renderSession();

      emitPhase({ phase: "Done", override: null, opId: "op-a" });
      emitPhase({ phase: "clearing", override: 3, opId: "op-a", actorName: "Jake" });

      expect(result.current.capSignal.phase).toBe("clearing");
    });
  });

  describe("UCS-2: 'clearing' adopts the lock", () => {
    it("exposes phase, opId and actorName so the overlay can name the actor", () => {
      const { result } = renderSession();

      emitPhase({
        phase: "clearing",
        override: 3,
        opId: "op-a",
        actorId: "user-other-organizer",
        actorName: "Jake L",
        ttlMs: 30_000,
      });

      expect(result.current.capSignal).toEqual({
        phase: "clearing",
        opId: "op-a",
        actorName: "Jake L",
      });
    });
  });

  describe("UCS-3: rank guard blocks a backwards phase", () => {
    it("a late 'clearing' after 'generating' for the same op is ignored", () => {
      const { result } = renderSession();

      emitPhase({
        phase: "generating",
        override: 3,
        opId: "op-a",
        actorName: "Jake L",
        ttlMs: 30_000,
      });
      expect(result.current.capSignal.phase).toBe("generating");

      // Realtime does not guarantee ordering. Re-adopting "clearing" would show
      // the wrong copy AND re-arm a full lease from the older message.
      emitPhase({
        phase: "clearing",
        override: 3,
        opId: "op-a",
        actorName: "Stale Copy",
        ttlMs: 30_000,
      });

      expect(result.current.capSignal).toEqual({
        phase: "generating",
        opId: "op-a",
        actorName: "Jake L",
      });
    });

    it("a duplicate 'generating' for the same op is also a no-op", () => {
      const { result } = renderSession();

      emitPhase({ phase: "generating", override: null, opId: "op-a", actorName: "Jake L" });
      emitPhase({ phase: "generating", override: null, opId: "op-a", actorName: "Duplicate" });

      expect(result.current.capSignal.actorName).toBe("Jake L");
    });
  });

  describe("UCS-4: 'done' for the active op releases and refetches", () => {
    it("returns capSignal to idle and refetches the session", async () => {
      const { result } = renderSession();

      emitPhase({ phase: "clearing", override: 3, opId: "op-a", actorName: "Jake L" });
      expect(result.current.capSignal.phase).toBe("clearing");

      await emitPhaseAsync({ phase: "done", override: 3, opId: "op-a", actorName: "Jake L" });

      expect(result.current.capSignal).toEqual(IDLE);
      // Without the refetch the released board still shows the OLD cap: nothing
      // else pushes max_auto_drafts_override to a co-organizer inside 15s.
      expect(getSessionForOrganizerMock).toHaveBeenCalledTimes(1);
      expect(getSessionForOrganizerMock).toHaveBeenCalledWith(SESSION_ID);
    });
  });

  describe("UCS-5: a foreign 'done' cannot release this client's lock", () => {
    it("keeps the lock held by the active op when 'done' carries another opId", async () => {
      const { result } = renderSession();

      emitPhase({ phase: "clearing", override: 3, opId: "op-a", actorName: "Jake L" });

      // Organizer B's reset finishing must not unlock a board that organizer A's
      // reset is still actively mutating.
      await emitPhaseAsync({ phase: "done", override: 5, opId: "op-b", actorName: "Stelle" });

      expect(result.current.capSignal).toEqual({
        phase: "clearing",
        opId: "op-a",
        actorName: "Jake L",
      });
      // The refetch is deliberately unconditional — cheap convergence.
      expect(getSessionForOrganizerMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("UCS-6: finished-op ring discards a post-'done' 'clearing'", () => {
    it("stays idle when 'clearing' arrives after its own op's 'done'", async () => {
      const { result } = renderSession();

      await emitPhaseAsync({ phase: "done", override: 3, opId: "op-a", actorName: "Jake L" });
      expect(result.current.capSignal).toEqual(IDLE);

      // Re-adopting here would lock a board whose operation is already over —
      // and only the lease, not another 'done', would ever release it.
      emitPhase({ phase: "clearing", override: 3, opId: "op-a", actorName: "Jake L" });

      expect(result.current.capSignal).toEqual(IDLE);
    });

    it("only the finished op is blocked — a fresh opId still locks", async () => {
      const { result } = renderSession();

      await emitPhaseAsync({ phase: "done", override: 3, opId: "op-a" });
      emitPhase({ phase: "clearing", override: 4, opId: "op-b", actorName: "Stelle" });

      expect(result.current.capSignal).toEqual({
        phase: "clearing",
        opId: "op-b",
        actorName: "Stelle",
      });
    });
  });

  describe("UCS-7: the lease self-unlocks when 'done' never arrives", () => {
    it("unlocks at ttlMs, warns, refetches, and toasts while the tab is visible", async () => {
      vi.useFakeTimers();
      const { result } = renderSession();

      emitPhase({
        phase: "clearing",
        override: 3,
        opId: "op-a",
        actorName: "Jake L",
        ttlMs: 8_000,
      });

      await advance(7_999);
      expect(result.current.capSignal.phase).toBe("clearing");

      await advance(2);

      expect(result.current.capSignal).toEqual(IDLE);
      expect(warnSpy).toHaveBeenCalledWith(EXPIRY_WARNING);
      expect(getSessionForOrganizerMock).toHaveBeenCalledWith(SESSION_ID);
      expect(toast.info).toHaveBeenCalledTimes(1);
    });

    it("suppresses the toast on a hidden tab but still unlocks", async () => {
      const originalDescriptor = Object.getOwnPropertyDescriptor(
        Document.prototype,
        "visibilityState"
      );
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      try {
        vi.useFakeTimers();
        const { result } = renderSession();

        emitPhase({ phase: "clearing", override: 3, opId: "op-a", ttlMs: 8_000 });
        await advance(8_001);

        // Unlocking is unconditional; only the user-facing notice is gated, so a
        // backgrounded tab is never left holding the overlay.
        expect(result.current.capSignal).toEqual(IDLE);
        expect(warnSpy).toHaveBeenCalledWith(EXPIRY_WARNING);
        expect(toast.info).not.toHaveBeenCalled();
      } finally {
        delete (document as unknown as Record<string, unknown>).visibilityState;
        if (originalDescriptor) {
          Object.defineProperty(Document.prototype, "visibilityState", originalDescriptor);
        }
      }
    });

    it("an advancing phase re-arms the lease instead of inheriting the old deadline", async () => {
      vi.useFakeTimers();
      const { result } = renderSession();

      emitPhase({ phase: "clearing", override: 3, opId: "op-a", ttlMs: 10_000 });
      await advance(9_000);

      // 'generating' at t=9s must restart the 10s clock; otherwise a long but
      // healthy reset gets cut short 1s later and the UI unlocks mid-operation.
      emitPhase({ phase: "generating", override: 3, opId: "op-a", ttlMs: 10_000 });
      await advance(2_000);
      expect(result.current.capSignal.phase).toBe("generating");

      await advance(8_001);
      expect(result.current.capSignal).toEqual(IDLE);
    });
  });

  describe("UCS-8: ttlMs is clamped", () => {
    it("a below-floor ttlMs (1000) is raised to the 5000 minimum", async () => {
      vi.useFakeTimers();
      const { result } = renderSession();

      emitPhase({ phase: "clearing", override: 3, opId: "op-a", ttlMs: 1_000 });

      // Honouring 1000 would unlock while the server is still deleting drafts.
      await advance(4_999);
      expect(result.current.capSignal.phase).toBe("clearing");

      await advance(2);
      expect(result.current.capSignal).toEqual(IDLE);
    });

    it("an above-ceiling ttlMs (999999) is capped at the 120000 maximum", async () => {
      vi.useFakeTimers();
      const { result } = renderSession();

      emitPhase({ phase: "clearing", override: 3, opId: "op-a", ttlMs: 999_999 });

      await advance(119_999);
      expect(result.current.capSignal.phase).toBe("clearing");

      // Uncapped, a garbled value would hold a dismiss-less overlay for ~17min.
      await advance(2);
      expect(result.current.capSignal).toEqual(IDLE);
    });

    it("a missing ttlMs falls back to the 30000 default", async () => {
      vi.useFakeTimers();
      const { result } = renderSession();

      emitPhase({ phase: "clearing", override: 3, opId: "op-a" });

      await advance(29_999);
      expect(result.current.capSignal.phase).toBe("clearing");

      await advance(2);
      expect(result.current.capSignal).toEqual(IDLE);
    });
  });

  describe("UCS-9: legacy payloads without an opId still work", () => {
    it("adopts the phase with a null opId and is cleared by a legacy 'done'", async () => {
      const { result } = renderSession();

      // An older server mid-rolling-deploy sends no opId. Ignoring it would leave
      // co-organizers with no lockout at all for the length of the deploy.
      emitPhase({ phase: "clearing", override: 3, actorName: "Legacy Server" });

      expect(result.current.capSignal).toEqual({
        phase: "clearing",
        opId: null,
        actorName: "Legacy Server",
      });

      await emitPhaseAsync({ phase: "done", override: 3 });

      expect(result.current.capSignal).toEqual(IDLE);
      expect(getSessionForOrganizerMock).toHaveBeenCalledTimes(1);
    });

    it("a SECOND legacy op still locks the board", async () => {
      const { result } = renderSession();

      // Regression guard. Every opId-less payload collapses onto one sentinel,
      // so remembering it in the finished-op ring made the first legacy 'done'
      // permanently discard the 'clearing' of every legacy op after it. During
      // a rolling deploy — where legacy IS the only traffic — that meant exactly
      // one cap reset ever showed the overlay, and the rest silently deleted
      // drafts underneath a co-organizer who was never locked out.
      emitPhase({ phase: "clearing", override: 3, actorName: "Legacy Server" });
      await emitPhaseAsync({ phase: "done", override: 3 });
      expect(result.current.capSignal).toEqual(IDLE);

      emitPhase({ phase: "clearing", override: 4, actorName: "Legacy Server" });

      expect(result.current.capSignal).toEqual({
        phase: "clearing",
        opId: null,
        actorName: "Legacy Server",
      });
    });

    it("a legacy 'done' also releases a lock that a real opId is holding", async () => {
      const { result } = renderSession();

      emitPhase({ phase: "generating", override: 3, opId: "op-a", actorName: "Jake L" });

      // The escape hatch: an old server can only ever send the sentinel, so it
      // must be allowed to release, or a mixed-version deploy strands the board.
      await emitPhaseAsync({ phase: "done", override: 3 });

      expect(result.current.capSignal).toEqual(IDLE);
    });
  });

  describe("UCS-10: unmount disarms the lease", () => {
    it("does not fire the unlock, warning, refetch or toast after unmount", async () => {
      vi.useFakeTimers();
      const { unmount } = renderSession();

      emitPhase({ phase: "clearing", override: 3, opId: "op-a", ttlMs: 6_000 });

      unmount();
      expect(unsubscribeSpy).toHaveBeenCalledTimes(1);

      await advance(20_000);

      expect(warnSpy).not.toHaveBeenCalledWith(EXPIRY_WARNING);
      expect(getSessionForOrganizerMock).not.toHaveBeenCalled();
      expect(toast.info).not.toHaveBeenCalled();
    });
  });
});
