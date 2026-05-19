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

// ── Mock next/navigation ──────────────────────────────────────
const mockRouter = { push: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
}));

// ── Mock sonner ───────────────────────────────────────────────
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// ── Mock session actions ──────────────────────────────────────
vi.mock("@/app/actions/sessions", () => ({
  closeSession: vi.fn(),
  toggleAutoMatchmaking: vi.fn(),
}));

// ── Mock queue actions ────────────────────────────────────────
vi.mock("@/app/actions/queue", () => ({
  joinQueueAction: vi.fn(),
}));

import { toast } from "sonner";
import { closeSession, toggleAutoMatchmaking } from "@/app/actions/sessions";
import { joinQueueAction } from "@/app/actions/queue";

// ── Fixtures ──────────────────────────────────────────────────

const SESSION_ID = "sess-abc";

function makeParams(
  overrides: Partial<{
    sessionIsActive: boolean;
    liveAutoMatchmaking: boolean;
    bottleneckCount: number;
    draftCount: number;
    handleCancelSwap: () => void;
  }> = {}
) {
  return {
    sessionId: SESSION_ID,
    sessionIsActive: true,
    liveAutoMatchmaking: false,
    bottleneckCount: 0,
    draftCount: 0,
    handleCancelSwap: vi.fn(),
    ...overrides,
  };
}

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

      // happy-dom does not define window.alert — stub it globally
      const alertFn = vi.fn();
      vi.stubGlobal("alert", alertFn);

      const { result } = renderHook(() => useOrganizerDashboard(makeParams()));

      await act(async () => {
        await result.current.handleCloseSession();
      });

      expect(result.current.closing).toBe(false);
      expect(mockRouter.push).not.toHaveBeenCalled();
      expect(alertFn).toHaveBeenCalledWith("Cannot close: active matches");

      vi.unstubAllGlobals();
    });
  });

  describe("joinQueue", () => {
    it("calls joinQueueAction with sessionId", async () => {
      vi.mocked(joinQueueAction).mockResolvedValue({});

      const { result } = renderHook(() => useOrganizerDashboard(makeParams()));

      await act(async () => {
        await result.current.joinQueue();
      });

      expect(joinQueueAction).toHaveBeenCalledWith(SESSION_ID);
    });

    it("calls toast.error when joinQueueAction returns an error", async () => {
      vi.mocked(joinQueueAction).mockResolvedValue({ error: "Queue is full" });

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
