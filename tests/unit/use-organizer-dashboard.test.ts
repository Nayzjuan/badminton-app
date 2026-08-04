// @vitest-environment happy-dom
// ============================================================
// Unit Tests — useOrganizerDashboard Hook
// ============================================================
// Pins the UI-controller logic that breaks silently on refactor:
//
//   OD-1   Active session → activeTab="courts", isClosed=false
//   OD-2   Closed session → activeTab="history", isClosed=true
//   OD-3   Tabs config — active has 5 tabs, closed has 2
//   OD-4   Draft badge present when activeTab !== "courts" AND draftCount > 0
//   OD-4b  Draft badge absent when activeTab IS "courts"
//   OD-5   Monitor badge shows bottleneckCount > 0; absent when 0
//   OD-6   handleToggleAuto — optimistic then confirms on success
//   OD-7   pendingAuto yields back when liveAutoMatchmaking matches it
//   OD-8   Esc keydown calls handleCancelSwap
//   OD-9   handleCloseSession calls closeSession and router.push on success
//   OD-10  handleCloseSession reverts closing=false and does NOT navigate on failure
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useOrganizerDashboard } from "@/hooks/use-organizer-dashboard";
import type { CapPhaseSignal } from "@/hooks/use-organizer-session";

// ── Mock next/navigation ──────────────────────────────────────
const mockRouter = { push: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  usePathname: () => "/organizer",
}));

// ── Mock sonner ───────────────────────────────────────────────
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// ── Mock session actions ──────────────────────────────────────
// toggleAutoPublish is mocked even though no test drives it: a vi.mock factory
// REPLACES the module, so an omitted export is `undefined` at import time and
// the hook would throw the moment that path is exercised.
vi.mock("@/app/actions/sessions", () => ({
  closeSession: vi.fn(),
  toggleAutoMatchmaking: vi.fn(),
  toggleAutoPublish: vi.fn(),
  applyDraftCapOverride: vi.fn(),
}));

// ── Mock queue actions ────────────────────────────────────────
vi.mock("@/app/actions/queue", () => ({
  joinQueueAction: vi.fn(),
}));

import { toast } from "sonner";
import { closeSession, toggleAutoMatchmaking, applyDraftCapOverride } from "@/app/actions/sessions";
import type { ApplyDraftCapResult } from "@/app/actions/sessions";
import { joinQueueAction } from "@/app/actions/queue";

// ── Fixtures ──────────────────────────────────────────────────

const SESSION_ID = "sess-abc";

function makeParams(
  overrides: Partial<{
    sessionIsActive: boolean;
    liveAutoMatchmaking: boolean;
    liveAutoPublish: boolean;
    bottleneckCount: number;
    draftCount: number;
    handleCancelSwap: () => void;
    capSignal: CapPhaseSignal;
  }> = {}
) {
  return {
    sessionId: SESSION_ID,
    sessionIsActive: true,
    liveAutoMatchmaking: false,
    liveAutoPublish: false,
    bottleneckCount: 0,
    draftCount: 0,
    handleCancelSwap: vi.fn(),
    ...overrides,
  };
}

/** Matches the crypto.randomUUID() opId the hook mints per operation. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Tests ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useOrganizerDashboard", () => {
  describe("OD-1: Active session initial state", () => {
    it("activeTab is 'courts' and isClosed is false when sessionIsActive=true", () => {
      const { result } = renderHook(() =>
        useOrganizerDashboard(makeParams({ sessionIsActive: true }))
      );

      expect(result.current.activeTab).toBe("courts");
      expect(result.current.isClosed).toBe(false);
    });
  });

  describe("OD-2: Closed session initial state", () => {
    it("activeTab is 'history' and isClosed is true when sessionIsActive=false", () => {
      const { result } = renderHook(() =>
        useOrganizerDashboard(makeParams({ sessionIsActive: false }))
      );

      expect(result.current.activeTab).toBe("history");
      expect(result.current.isClosed).toBe(true);
    });
  });

  describe("OD-3: Tabs config", () => {
    it("active session returns 5 tabs (courts, queue, monitor, history, leaderboard)", () => {
      const { result } = renderHook(() =>
        useOrganizerDashboard(makeParams({ sessionIsActive: true }))
      );

      expect(result.current.tabs).toHaveLength(5);
      const keys = result.current.tabs.map((t) => t.key);
      expect(keys).toEqual(["courts", "queue", "monitor", "history", "leaderboard"]);
    });

    it("closed session returns 2 tabs (history + leaderboard)", () => {
      const { result } = renderHook(() =>
        useOrganizerDashboard(makeParams({ sessionIsActive: false }))
      );

      expect(result.current.tabs).toHaveLength(2);
      const keys = result.current.tabs.map((t) => t.key);
      expect(keys).toEqual(["history", "leaderboard"]);
    });
  });

  describe("OD-4: Draft badge on 'courts' tab", () => {
    it("shows draftCount badge on courts tab when activeTab is NOT 'courts' and draftCount > 0", () => {
      const { result } = renderHook(() =>
        useOrganizerDashboard(makeParams({ sessionIsActive: true, draftCount: 3 }))
      );

      // Switch away from courts so badge should appear
      act(() => result.current.setActiveTab("queue"));

      const courtsTab = result.current.tabs.find((t) => t.key === "courts");
      expect(courtsTab?.badge).toBe(3);
    });

    it("draft badge is absent when draftCount is 0 even when activeTab !== 'courts'", () => {
      const { result } = renderHook(() =>
        useOrganizerDashboard(makeParams({ sessionIsActive: true, draftCount: 0 }))
      );

      act(() => result.current.setActiveTab("queue"));

      const courtsTab = result.current.tabs.find((t) => t.key === "courts");
      expect(courtsTab?.badge).toBeUndefined();
    });
  });

  describe("OD-4b: Draft badge absent when activeTab IS 'courts'", () => {
    it("courts tab badge is undefined when activeTab='courts' even with draftCount > 0", () => {
      const { result } = renderHook(() =>
        useOrganizerDashboard(makeParams({ sessionIsActive: true, draftCount: 5 }))
      );

      // activeTab starts as "courts"
      expect(result.current.activeTab).toBe("courts");

      const courtsTab = result.current.tabs.find((t) => t.key === "courts");
      expect(courtsTab?.badge).toBeUndefined();
    });
  });

  describe("OD-5: Monitor badge", () => {
    it("shows bottleneckCount on monitor tab when bottleneckCount > 0", () => {
      const { result } = renderHook(() =>
        useOrganizerDashboard(makeParams({ sessionIsActive: true, bottleneckCount: 4 }))
      );

      const monitorTab = result.current.tabs.find((t) => t.key === "monitor");
      expect(monitorTab?.badge).toBe(4);
    });

    it("monitor badge is absent when bottleneckCount is 0", () => {
      const { result } = renderHook(() =>
        useOrganizerDashboard(makeParams({ sessionIsActive: true, bottleneckCount: 0 }))
      );

      const monitorTab = result.current.tabs.find((t) => t.key === "monitor");
      expect(monitorTab?.badge).toBeUndefined();
    });
  });

  describe("OD-6: handleToggleAuto — optimistic toggle", () => {
    it("optimistically flips autoMatchmaking immediately before server responds, then confirms on success", async () => {
      vi.mocked(toggleAutoMatchmaking).mockResolvedValue({
        success: true,
        isOn: true,
        message: "",
      });

      const { result } = renderHook(() =>
        useOrganizerDashboard(makeParams({ liveAutoMatchmaking: false }))
      );

      // Initially false from liveAutoMatchmaking
      expect(result.current.autoMatchmaking).toBe(false);

      // Fire toggle without awaiting — check optimistic state in the same tick
      act(() => {
        result.current.handleToggleAuto();
      });

      // Optimistic flip should be visible immediately
      expect(result.current.autoMatchmaking).toBe(true);

      // Wait for the server round-trip to complete
      await waitFor(() => expect(result.current.togglingAuto).toBe(false));

      expect(toggleAutoMatchmaking).toHaveBeenCalledWith(SESSION_ID);
      // After server confirms isOn=true, pendingAuto should reflect that
      expect(result.current.autoMatchmaking).toBe(true);
    });

    it("reverts autoMatchmaking to liveAutoMatchmaking on toggle failure", async () => {
      vi.mocked(toggleAutoMatchmaking).mockResolvedValue({
        success: false,
        isOn: false,
        message: "Toggle failed",
      });

      const { result } = renderHook(() =>
        useOrganizerDashboard(makeParams({ liveAutoMatchmaking: false }))
      );

      await act(async () => {
        await result.current.handleToggleAuto();
      });

      // On failure pendingAuto is cleared, falls back to liveAutoMatchmaking=false
      expect(result.current.autoMatchmaking).toBe(false);
      expect(toast.error).toHaveBeenCalledWith("Toggle failed");
    });
  });

  describe("OD-7: pendingAuto yields back when liveAutoMatchmaking matches", () => {
    it("clears pendingAuto when liveAutoMatchmaking prop changes to agree with pendingAuto", async () => {
      vi.mocked(toggleAutoMatchmaking).mockResolvedValue({
        success: true,
        isOn: true,
        message: "",
      });

      let liveAuto = false;
      const { result, rerender } = renderHook(
        ({ live }) => useOrganizerDashboard(makeParams({ liveAutoMatchmaking: live })),
        { initialProps: { live: liveAuto } }
      );

      // Trigger toggle — sets pendingAuto=true
      await act(async () => {
        await result.current.handleToggleAuto();
      });

      // pendingAuto=true is currently overriding; autoMatchmaking should be true
      expect(result.current.autoMatchmaking).toBe(true);

      // Now simulate the realtime broadcast arriving: liveAutoMatchmaking → true
      liveAuto = true;
      rerender({ live: liveAuto });

      // Once liveAutoMatchmaking matches pendingAuto, pendingAuto should yield back
      // autoMatchmaking should still read true (now from liveAutoMatchmaking)
      await waitFor(() => expect(result.current.autoMatchmaking).toBe(true));
    });
  });

  describe("OD-8: Esc key calls handleCancelSwap", () => {
    it("fires handleCancelSwap when the Escape key is pressed", () => {
      const handleCancelSwap = vi.fn();
      renderHook(() => useOrganizerDashboard(makeParams({ handleCancelSwap })));

      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });

      expect(handleCancelSwap).toHaveBeenCalledTimes(1);
    });

    it("does NOT call handleCancelSwap for non-Escape keys", () => {
      const handleCancelSwap = vi.fn();
      renderHook(() => useOrganizerDashboard(makeParams({ handleCancelSwap })));

      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });

      expect(handleCancelSwap).not.toHaveBeenCalled();
    });
  });

  describe("OD-9: handleCloseSession — success path", () => {
    it("calls closeSession with sessionId and navigates to /organizer on success", async () => {
      vi.mocked(closeSession).mockResolvedValue({ success: true, message: "" });

      const { result } = renderHook(() => useOrganizerDashboard(makeParams()));

      await act(async () => {
        await result.current.handleCloseSession();
      });

      expect(closeSession).toHaveBeenCalledWith(SESSION_ID);
      expect(mockRouter.push).toHaveBeenCalledWith("/organizer");
    });

    it("sets closing=true while the request is in-flight", async () => {
      let resolveClose!: (v: { success: boolean; message: string }) => void;
      vi.mocked(closeSession).mockImplementation(
        () =>
          new Promise((res) => {
            resolveClose = res;
          })
      );

      const { result } = renderHook(() => useOrganizerDashboard(makeParams()));

      act(() => {
        result.current.handleCloseSession();
      });

      expect(result.current.closing).toBe(true);

      await act(async () => {
        resolveClose({ success: true, message: "" });
      });
    });
  });

  describe("OD-10: handleCloseSession — failure path", () => {
    it("reverts closing=false and does NOT navigate when closeSession fails", async () => {
      vi.mocked(closeSession).mockResolvedValue({
        success: false,
        message: "Cannot close: active matches",
      });

      const { result } = renderHook(() => useOrganizerDashboard(makeParams()));

      await act(async () => {
        await result.current.handleCloseSession();
      });

      expect(result.current.closing).toBe(false);
      expect(mockRouter.push).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith("Cannot close: active matches");
    });
  });

  describe("joinQueue", () => {
    it("calls joinQueueAction with sessionId", async () => {
      vi.mocked(joinQueueAction).mockResolvedValue({ success: true });

      const { result } = renderHook(() => useOrganizerDashboard(makeParams()));

      await act(async () => {
        await result.current.joinQueue();
      });

      expect(joinQueueAction).toHaveBeenCalledWith(SESSION_ID);
    });

    it("calls toast.error when joinQueueAction returns an error", async () => {
      vi.mocked(joinQueueAction).mockResolvedValue({ success: false, error: "Queue is full" });

      const { result } = renderHook(() => useOrganizerDashboard(makeParams()));

      await act(async () => {
        await result.current.joinQueue();
      });

      expect(toast.error).toHaveBeenCalledWith("Queue is full");
    });
  });

  // ── OD-new-1 / OD-new-2: more-menu click-outside handler (lines 147–155) ──
  //
  // The `moreMenuRef` is exposed in the hook's return value.  We attach a DOM
  // element to it so the `contains()` check in the effect has something real to
  // test against.

  describe("OD-new: more-menu click-outside effect", () => {
    it("OD-new-1: mousedown outside the more-menu element closes the menu", () => {
      const { result } = renderHook(() => useOrganizerDashboard(makeParams()));

      // Attach a detached DOM element to the ref so contains() works correctly.
      const menuEl = document.createElement("div");
      result.current.moreMenuRef.current = menuEl;

      // Open the more-menu — this triggers the effect to register the listener.
      act(() => result.current.setMoreMenuOpen(true));
      expect(result.current.moreMenuOpen).toBe(true);

      // Dispatch a mousedown on document itself (target = document, not inside menuEl).
      act(() => {
        document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });

      // menuEl.contains(document) = false → setMoreMenuOpen(false) called.
      expect(result.current.moreMenuOpen).toBe(false);
    });

    it("OD-new-2: mousedown inside the more-menu element does NOT close the menu", () => {
      const { result } = renderHook(() => useOrganizerDashboard(makeParams()));

      // Set up: menuEl contains a child; click will originate from the child.
      const menuEl = document.createElement("div");
      const childEl = document.createElement("button");
      menuEl.appendChild(childEl);
      result.current.moreMenuRef.current = menuEl;

      act(() => result.current.setMoreMenuOpen(true));
      expect(result.current.moreMenuOpen).toBe(true);

      // Dispatch from the child (inside menuEl) — bubbles up to document.
      // event.target = childEl; menuEl.contains(childEl) = true → menu stays open.
      act(() => {
        childEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });

      expect(result.current.moreMenuOpen).toBe(true);
    });
  });
});

// ============================================================
// Draft Cap Override — OD-11 through OD-21
// ============================================================
//
// The whole clear → regenerate sequence now lives in ONE server action
// (applyDraftCapOverride). This hook no longer orchestrates phases and no
// longer imports @/lib/broadcast — it could not publish anything from the
// browser anyway, because the service-role key is server-only. See §3.28.
//
// OD-11  handleCapChange (Auto ON) — one action call, dashboard ends unlocked
// OD-12  handleCapChange (Auto OFF) — identical call shape; auto-state is the
//          server's business, not the hook's
// OD-13  action returns success:false — error toast, dashboard unlocked
// OD-14  isDashboardLocked is true while the action is in flight
// OD-15  capPhase is null → 'clearing' → null across one operation
// OD-16  applyDraftCapOverride receives (sessionId, cap, opId)
// OD-17  resetting to Dynamic passes cap = null
// OD-18  our OWN echo never re-locks us (opId self-correlation)
// OD-19  a CO-ORGANIZER's signal locks us and surfaces their name
// OD-20  a transport-level throw still unlocks and toasts
// OD-21  the watchdog force-unlocks a lock the action never released
// ============================================================

describe("OD-11 through OD-21: handleCapChange — draft cap override", () => {
  describe("OD-11: Auto ON — single server action drives the whole sequence", () => {
    it("calls applyDraftCapOverride once and ends unlocked", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(applyDraftCapOverride).mockResolvedValue({
        success: true,
        autoIsOn: true,
        clearedCount: 2,
      });

      const { result } = renderHook(() =>
        useOrganizerDashboard(makeParams({ liveAutoMatchmaking: true }))
      );

      await act(async () => {
        await result.current.handleCapChange(2);
      });

      expect(applyDraftCapOverride).toHaveBeenCalledTimes(1);
      expect(result.current.capPhase).toBeNull();
      expect(result.current.isDashboardLocked).toBe(false);
      expect(toast.error).not.toHaveBeenCalled();

      // Historical tripwire: before 2026-08-04 this hook called
      // broadcastDraftCapPhase directly, and every call logged
      // "[broadcast] Missing SUPABASE_URL or service role key — skipping
      // broadcast." from the browser. A green run used to emit 19 of them.
      //
      // Kept as documentation, NOT as coverage: post-fix the hook no longer
      // references broadcast.ts at all, so this assertion can never fail and
      // proves nothing on its own. (Note it is NOT `import "server-only"` doing
      // the work under this runner — vitest.config.ts aliases that to a no-op
      // stub; the guard only bites in `next build`.) What actually carries the
      // weight is CB-1 in client-bundle-boundaries, which statically pins the
      // whole class across src/.
      const broadcastWarnings = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes("[broadcast] Missing SUPABASE_URL")
      );
      expect(broadcastWarnings).toEqual([]);
      warnSpy.mockRestore();
    });
  });

  describe("OD-12: Auto OFF — same call shape, decided server-side", () => {
    it("still issues exactly one applyDraftCapOverride call", async () => {
      vi.mocked(applyDraftCapOverride).mockResolvedValue({
        success: true,
        autoIsOn: false, // <-- server reports Auto was OFF
        clearedCount: 0,
      });

      const { result } = renderHook(() =>
        useOrganizerDashboard(makeParams({ liveAutoMatchmaking: false }))
      );

      await act(async () => {
        await result.current.handleCapChange(3);
      });

      expect(applyDraftCapOverride).toHaveBeenCalledTimes(1);
      expect(applyDraftCapOverride).toHaveBeenCalledWith(SESSION_ID, 3, expect.any(String));
      expect(result.current.capPhase).toBeNull();
    });
  });

  describe("OD-13: action failure — reverts cleanly and reports", () => {
    it("shows an error toast and unlocks when the action returns success:false", async () => {
      vi.mocked(applyDraftCapOverride).mockResolvedValue({
        success: false,
        error: "Database error",
      });

      const { result } = renderHook(() =>
        useOrganizerDashboard(makeParams({ liveAutoMatchmaking: true }))
      );

      await act(async () => {
        await result.current.handleCapChange(2);
      });

      expect(result.current.capPhase).toBeNull();
      expect(result.current.isDashboardLocked).toBe(false);
      expect(toast.error).toHaveBeenCalledWith("Database error");
    });
  });

  describe("OD-14: isDashboardLocked reflects capPhase", () => {
    it("isDashboardLocked is false initially (no operation in progress)", () => {
      const { result } = renderHook(() => useOrganizerDashboard(makeParams()));
      expect(result.current.isDashboardLocked).toBe(false);
    });

    it("isDashboardLocked is true while the action is in flight", async () => {
      let resolveAction!: (v: ApplyDraftCapResult) => void;
      vi.mocked(applyDraftCapOverride).mockReturnValue(
        new Promise((res) => {
          resolveAction = res;
        })
      );

      const { result } = renderHook(() =>
        useOrganizerDashboard(makeParams({ liveAutoMatchmaking: true }))
      );

      // Kick off but don't await — capture mid-flight state
      act(() => {
        void result.current.handleCapChange(1);
      });

      await waitFor(() => expect(result.current.isDashboardLocked).toBe(true));

      // Clean up
      await act(async () => {
        resolveAction({ success: true, autoIsOn: true, clearedCount: 0 });
      });
    });
  });

  describe("OD-15: capPhase transitions", () => {
    it("goes null → 'clearing' → null across one operation", async () => {
      let resolveAction!: (v: ApplyDraftCapResult) => void;
      vi.mocked(applyDraftCapOverride).mockReturnValue(
        new Promise((res) => {
          resolveAction = res;
        })
      );

      const { result } = renderHook(() =>
        useOrganizerDashboard(makeParams({ liveAutoMatchmaking: true }))
      );

      expect(result.current.capPhase).toBeNull(); // starts null

      act(() => {
        void result.current.handleCapChange(2);
      });
      await waitFor(() => expect(result.current.capPhase).toBe("clearing"));

      await act(async () => {
        resolveAction({ success: true, autoIsOn: true, clearedCount: 1 });
      });

      expect(result.current.capPhase).toBeNull();
      expect(result.current.isDashboardLocked).toBe(false);
    });
  });

  describe("OD-16: applyDraftCapOverride called with correct arguments", () => {
    it("passes sessionId, cap and a UUID opId", async () => {
      vi.mocked(applyDraftCapOverride).mockResolvedValue({
        success: true,
        autoIsOn: false,
        clearedCount: 0,
      });

      const { result } = renderHook(() => useOrganizerDashboard(makeParams()));

      await act(async () => {
        await result.current.handleCapChange(2);
      });

      expect(applyDraftCapOverride).toHaveBeenCalledWith(
        SESSION_ID,
        2,
        expect.stringMatching(UUID_RE)
      );
    });

    it("mints a FRESH opId per operation", async () => {
      vi.mocked(applyDraftCapOverride).mockResolvedValue({
        success: true,
        autoIsOn: false,
        clearedCount: 0,
      });

      const { result } = renderHook(() => useOrganizerDashboard(makeParams()));

      await act(async () => {
        await result.current.handleCapChange(4);
      });
      await act(async () => {
        await result.current.handleCapChange(5);
      });

      const calls = vi.mocked(applyDraftCapOverride).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][1]).toBe(4);
      expect(calls[1][1]).toBe(5);
      expect(calls[0][2]).not.toBe(calls[1][2]);
    });

    it("OD-16b: still mints a valid UUID when crypto.randomUUID is unavailable", async () => {
      // randomUUID is secure-context-only. Over plain http — a phone hitting a
      // dev box at http://192.168.x.x:3000 — it is undefined, and calling it
      // threw on the FIRST line of handleCapChange, before any setState, with
      // the popover's `void onChange(cap)` swallowing the rejection: the chip
      // did nothing at all. Exactly the silent no-op class this change set
      // exists to delete, so the fallback is pinned here. The server validates
      // the id with isValidUUID, hence UUID_RE and not "some random string".
      // Shadow with an own property rather than `delete crypto.randomUUID`:
      // randomUUID lives on Crypto.prototype, so deleting it off the instance
      // silently succeeds and changes nothing — the test would pass vacuously.
      Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
      try {
        // Inside the try: a failed shadow must still be unwound, or every later
        // test in this file mints ids against an undefined randomUUID.
        expect(crypto.randomUUID).toBeUndefined(); // the shadow actually took

        vi.mocked(applyDraftCapOverride).mockResolvedValue({
          success: true,
          autoIsOn: false,
          clearedCount: 0,
        });

        const { result } = renderHook(() => useOrganizerDashboard(makeParams()));

        await act(async () => {
          await result.current.handleCapChange(3);
        });

        expect(applyDraftCapOverride).toHaveBeenCalledWith(
          SESSION_ID,
          3,
          expect.stringMatching(UUID_RE)
        );
        expect(toast.error).not.toHaveBeenCalled();
      } finally {
        // Drop the shadow so the prototype's real implementation is visible
        // again — every later test in this file mints ids through it.
        delete (crypto as { randomUUID?: unknown }).randomUUID;
      }
      expect(typeof crypto.randomUUID).toBe("function"); // restored
    });
  });

  describe("OD-17: resetting to Dynamic (null) passes cap = null", () => {
    it("passes null when the organizer resets to Dynamic", async () => {
      vi.mocked(applyDraftCapOverride).mockResolvedValue({
        success: true,
        autoIsOn: false,
        clearedCount: 0,
      });

      const { result } = renderHook(() => useOrganizerDashboard(makeParams()));

      await act(async () => {
        await result.current.handleCapChange(null);
      });

      expect(applyDraftCapOverride).toHaveBeenCalledWith(
        SESSION_ID,
        null,
        expect.stringMatching(UUID_RE)
      );
    });
  });

  describe("OD-18: our own echo never re-locks us", () => {
    it("stays unlocked when a signal carrying OUR opId arrives after completion", async () => {
      vi.mocked(applyDraftCapOverride).mockResolvedValue({
        success: true,
        autoIsOn: true,
        clearedCount: 1,
      });

      let capSignal: CapPhaseSignal = {
        phase: null,
        opId: null,
        actorName: null,
      };
      const { result, rerender } = renderHook(() =>
        useOrganizerDashboard(makeParams({ liveAutoMatchmaking: true, capSignal }))
      );

      await act(async () => {
        await result.current.handleCapChange(2);
      });
      expect(result.current.isDashboardLocked).toBe(false);

      // A REST broadcast has no sending socket, so the initiator receives its
      // own "clearing" too — often AFTER the action already resolved.
      const myOpId = vi.mocked(applyDraftCapOverride).mock.calls[0][2];
      capSignal = { phase: "clearing", opId: myOpId, actorName: "Me" };
      rerender();

      expect(result.current.capPhase).toBeNull();
      expect(result.current.isDashboardLocked).toBe(false);
      expect(result.current.capPhaseActorName).toBeNull();
    });
  });

  describe("OD-19: a co-organizer's signal locks this dashboard", () => {
    it("locks on a foreign opId and exposes the actor name", () => {
      const capSignal: CapPhaseSignal = {
        phase: "generating",
        opId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        actorName: "Jake L",
      };

      const { result } = renderHook(() =>
        useOrganizerDashboard(makeParams({ liveAutoMatchmaking: true, capSignal }))
      );

      expect(result.current.capPhase).toBe("generating");
      expect(result.current.isDashboardLocked).toBe(true);
      expect(result.current.capPhaseActorName).toBe("Jake L");
    });

    it("attributes nothing while WE hold the optimistic lock", async () => {
      let resolveAction!: (v: ApplyDraftCapResult) => void;
      vi.mocked(applyDraftCapOverride).mockReturnValue(
        new Promise((res) => {
          resolveAction = res;
        })
      );

      const capSignal: CapPhaseSignal = {
        phase: "clearing",
        opId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        actorName: "Jake L",
      };

      const { result } = renderHook(() =>
        useOrganizerDashboard(makeParams({ liveAutoMatchmaking: true, capSignal }))
      );

      act(() => {
        void result.current.handleCapChange(2);
      });
      await waitFor(() => expect(result.current.capPhase).toBe("clearing"));

      // Local lock wins: no "Started by …" line on the initiator's overlay.
      expect(result.current.capPhaseActorName).toBeNull();

      await act(async () => {
        resolveAction({ success: true, autoIsOn: true, clearedCount: 0 });
      });
    });
  });

  describe("OD-20: transport failure", () => {
    it("unlocks and toasts when the action itself throws", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(applyDraftCapOverride).mockRejectedValue(new Error("network down"));

      const { result } = renderHook(() =>
        useOrganizerDashboard(makeParams({ liveAutoMatchmaking: true }))
      );

      await act(async () => {
        await result.current.handleCapChange(2);
      });

      expect(result.current.isDashboardLocked).toBe(false);
      expect(toast.error).toHaveBeenCalledWith("Couldn't reach the server. Please try again.");
      errSpy.mockRestore();
    });
  });

  describe("OD-21: watchdog", () => {
    it("force-unlocks when the action never settles", async () => {
      vi.useFakeTimers();
      try {
        // A promise that never resolves — offline tab, sleeping device.
        vi.mocked(applyDraftCapOverride).mockReturnValue(new Promise(() => {}));

        const { result } = renderHook(() =>
          useOrganizerDashboard(makeParams({ liveAutoMatchmaking: true }))
        );

        act(() => {
          void result.current.handleCapChange(2);
        });
        expect(result.current.isDashboardLocked).toBe(true);

        // CAP_LOCK_WATCHDOG_MS = 60s.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });

        expect(result.current.isDashboardLocked).toBe(false);
        expect(toast.error).toHaveBeenCalledWith(
          "Draft cap change timed out. Refresh to confirm the result."
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
