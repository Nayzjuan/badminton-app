// @vitest-environment happy-dom
// ============================================================
// JoinFinalizer — retry on failure, replace on success/rename
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
}));

vi.mock("@/app/actions/registration", () => ({
  completeRegistrationJoinAction: vi.fn(),
}));

vi.mock("@/lib/registration-analytics", () => ({
  trackRegistration: vi.fn(),
}));

import { JoinFinalizer } from "@/components/join/join-finalizer";
import { completeRegistrationJoinAction } from "@/app/actions/registration";
import { trackRegistration } from "@/lib/registration-analytics";

const SID = "00000000-0000-4000-8000-000000000001";

describe("JoinFinalizer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("JF-1: success replace()s the derived destination and emits transitions only", async () => {
    vi.mocked(completeRegistrationJoinAction).mockResolvedValue({
      success: true,
      destination: `/c/chillax/play/${SID}`,
      membershipAction: "created",
      queueAction: "inserted",
      joined: true,
    });
    render(
      <StrictMode>
        <JoinFinalizer clubSlug="chillax" sessionId={SID} />
      </StrictMode>
    );
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith(`/c/chillax/play/${SID}?joined=1`);
    });
    expect(trackRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ step: "membership_transition" })
    );
    expect(trackRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ step: "queue_transition" })
    );
  });

  it("JF-2: unchanged no-ops do not emit transition events", async () => {
    vi.mocked(completeRegistrationJoinAction).mockResolvedValue({
      success: true,
      destination: `/c/chillax/play/${SID}`,
      membershipAction: "unchanged",
      queueAction: "unchanged",
      joined: false,
    });
    render(<JoinFinalizer clubSlug="chillax" sessionId={SID} />);
    await vi.waitFor(() => expect(replace).toHaveBeenCalled());
    expect(trackRegistration).not.toHaveBeenCalledWith(
      expect.objectContaining({ step: "membership_transition" })
    );
    expect(trackRegistration).not.toHaveBeenCalledWith(
      expect.objectContaining({ step: "queue_transition" })
    );
  });

  it("JF-3: failure shows Retry and a second click re-invokes the action", async () => {
    const user = userEvent.setup();
    vi.mocked(completeRegistrationJoinAction)
      .mockResolvedValueOnce({
        success: false,
        error: "This session has ended.",
        code: "session_closed",
      })
      .mockResolvedValueOnce({
        success: true,
        destination: `/c/chillax/play/${SID}`,
        membershipAction: "unchanged",
        queueAction: "unchanged",
        joined: false,
      });
    render(<JoinFinalizer clubSlug="chillax" sessionId={SID} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/session has ended/i);
    const before = vi.mocked(completeRegistrationJoinAction).mock.calls.length;
    await user.click(screen.getByRole("button", { name: /retry/i }));
    await vi.waitFor(() =>
      expect(vi.mocked(completeRegistrationJoinAction).mock.calls.length).toBeGreaterThan(before)
    );
  });

  it("JF-4: rename result replace()s /rename with the canonical next", async () => {
    vi.mocked(completeRegistrationJoinAction).mockResolvedValue({
      success: false,
      requiresRename: true,
      next: `/j/${SID}`,
    });
    render(<JoinFinalizer clubSlug="chillax" sessionId={SID} />);
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledWith(`/rename?next=${encodeURIComponent(`/j/${SID}`)}`);
    });
  });
});
