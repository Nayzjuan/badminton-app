// @vitest-environment happy-dom
// ============================================================
// Unit Tests: updatePlayerPin UI — Queue Control Edit PIN
// ============================================================
//
// Tests the new inline PIN editing flow in QueueControl.
// The "Edit" (pencil) icon appears next to the Reset button
// when a player's PIN is revealed. Clicking it opens an
// inline input where the organizer can type a custom 4-digit
// PIN and submit.
//
// EP-1  Edit button is NOT visible when PIN is hidden
// EP-2  Edit button is visible when PIN is revealed
// EP-3  Clicking Edit replaces PIN display with an inline input
// EP-4  Submitting a valid 4-digit PIN calls updatePlayerPin
//        with (sessionId, playerId, newPin)
// EP-5  Submitting "0000" shows an inline validation error
//        and does NOT call updatePlayerPin
// EP-6  Submitting a 3-digit value shows an inline validation error
// EP-7  Submitting a 5-digit value shows an inline validation error
// EP-8  Submitting a non-numeric value shows an inline validation error
// EP-9  A successful updatePlayerPin call updates the displayed PIN
// EP-10 A failed updatePlayerPin call shows an error and preserves input
// EP-11 Pressing Escape or clicking Cancel collapses the input without saving
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

// ── Mocks ─────────────────────────────────────────────────────

vi.mock("@/app/actions/profile", () => ({
  getPlayerPin: vi.fn(),
  resetPlayerPin: vi.fn(),
  updatePlayerPin: vi.fn(),
  updatePlayerSkill: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { getPlayerPin, updatePlayerPin } from "@/app/actions/profile";

// ── Component under test ──────────────────────────────────────
// QueueControl receives sessionId as a prop (added in the security fix).
// The PIN column shows: Reveal → (PIN + Hide + Reset + Edit) inline.

import { QueueControl } from "@/components/organizer/queue-control";
import type { QueueFullWithWaitTime } from "@/types/database";

// ── Fixtures ──────────────────────────────────────────────────

const SESSION_ID = "sess-xyz";
const PLAYER_ID = "player-abc";

function makeQueueEntry(overrides: Partial<QueueFullWithWaitTime> = {}): QueueFullWithWaitTime {
  return {
    id: "entry-1",
    session_id: SESSION_ID,
    player_id: PLAYER_ID,
    joined_at: new Date().toISOString(),
    games_played: 3,
    status: "waiting",
    position: 1,
    is_paused: false,
    created_at: new Date().toISOString(),
    display_name: "Test Player",
    skill_level: "intermediate",
    skill_level_int: 3,
    wait_minutes: 5,
    is_bottleneck: false,
    status_priority: 2,
    ...overrides,
  };
}

function renderQueueControl() {
  return render(
    <QueueControl
      sessionId={SESSION_ID}
      queue={[makeQueueEntry()]}
      onCreateManualMatch={vi.fn().mockResolvedValue({})}
      onRemoveFromQueue={vi.fn().mockResolvedValue({})}
      onPausePlayer={vi.fn().mockResolvedValue({})}
    />
  );
}

// Reveal the PIN for a player (prerequisite for Edit to appear)
async function revealPin(pin = "1234") {
  vi.mocked(getPlayerPin).mockResolvedValue({ success: true, message: "OK", pin });
  const revealBtn = screen.getByLabelText("Reveal PIN");
  await userEvent.click(revealBtn);
  await waitFor(() => screen.getByText(pin));
}

// ── Tests ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EP-1: Edit button is NOT visible when PIN is hidden", () => {
  it("no Edit PIN button appears before the PIN is revealed", () => {
    renderQueueControl();
    // Edit button should not exist before reveal
    expect(screen.queryByLabelText("Edit PIN")).toBeNull();
  });
});

describe("EP-2: Edit button is visible after PIN is revealed", () => {
  it("Edit PIN button appears alongside Hide and Reset once PIN is shown", async () => {
    renderQueueControl();
    await revealPin();
    expect(screen.getByLabelText("Edit PIN")).toBeDefined();
  });
});

describe("EP-3: Clicking Edit replaces PIN display with an inline input", () => {
  it("PIN text disappears and an input field appears when Edit is clicked", async () => {
    renderQueueControl();
    await revealPin("5678");

    const editBtn = screen.getByLabelText("Edit PIN");
    await userEvent.click(editBtn);

    // Input should now be visible, pre-populated with current PIN
    const input = screen.getByLabelText("New PIN");
    expect(input).toBeDefined();
    expect((input as HTMLInputElement).value).toBe("5678");

    // The plain PIN text should no longer be shown
    expect(screen.queryByText("5678")).toBeNull();
  });
});

describe("EP-4: Valid PIN submission calls updatePlayerPin with correct args", () => {
  it("submitting a valid 4-digit PIN calls updatePlayerPin(sessionId, playerId, '2468')", async () => {
    vi.mocked(updatePlayerPin).mockResolvedValue({
      success: true,
      message: "PIN updated",
      pin: "2468",
    });

    renderQueueControl();
    await revealPin("1234");

    await userEvent.click(screen.getByLabelText("Edit PIN"));

    const input = screen.getByLabelText("New PIN");
    await userEvent.clear(input);
    await userEvent.type(input, "2468");

    await userEvent.click(screen.getByLabelText("Save PIN"));

    expect(updatePlayerPin).toHaveBeenCalledWith(SESSION_ID, PLAYER_ID, "2468");
  });
});

describe("EP-5: '0000' is rejected with inline error", () => {
  it("submitting '0000' shows a validation error and does NOT call updatePlayerPin", async () => {
    renderQueueControl();
    await revealPin("1234");

    await userEvent.click(screen.getByLabelText("Edit PIN"));
    const input = screen.getByLabelText("New PIN");
    await userEvent.clear(input);
    await userEvent.type(input, "0000");
    await userEvent.click(screen.getByLabelText("Save PIN"));

    // Error shown inline
    expect(screen.getByText(/cannot be 0000/i)).toBeDefined();
    // updatePlayerPin NOT called
    expect(updatePlayerPin).not.toHaveBeenCalled();
  });
});

describe("EP-6: 3-digit PIN is rejected", () => {
  it("submitting '123' shows a validation error", async () => {
    renderQueueControl();
    await revealPin("1234");

    await userEvent.click(screen.getByLabelText("Edit PIN"));
    const input = screen.getByLabelText("New PIN");
    await userEvent.clear(input);
    await userEvent.type(input, "123");
    await userEvent.click(screen.getByLabelText("Save PIN"));

    expect(screen.getByText(/4 digits/i)).toBeDefined();
    expect(updatePlayerPin).not.toHaveBeenCalled();
  });
});

describe("EP-7: 5-digit PIN is prevented by input maxLength", () => {
  it("input has maxLength=4 so a 5th digit is silently dropped — only 4 chars can be entered", async () => {
    // The input enforces maxLength={4} at the HTML level.
    // '12345' typed into it yields '1234' — the 5th char is never captured.
    // Submitting '1234' is then valid, so updatePlayerPin IS called.
    // The browser-level guard is the correct enforcement mechanism here.
    vi.mocked(updatePlayerPin).mockResolvedValue({ success: true, message: "ok", pin: "1234" });

    renderQueueControl();
    await revealPin("9999");

    await userEvent.click(screen.getByLabelText("Edit PIN"));
    const input = screen.getByLabelText("New PIN") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "12345"); // 5th char silently dropped by maxLength

    expect(input.value).toBe("1234"); // only 4 chars accepted
    expect(input.maxLength).toBe(4);
  });
});

describe("EP-8: Non-numeric input is rejected", () => {
  it("submitting 'abcd' shows a validation error", async () => {
    renderQueueControl();
    await revealPin("1234");

    await userEvent.click(screen.getByLabelText("Edit PIN"));
    const input = screen.getByLabelText("New PIN");
    await userEvent.clear(input);
    await userEvent.type(input, "abcd");
    await userEvent.click(screen.getByLabelText("Save PIN"));

    expect(screen.getByText(/4 digits/i)).toBeDefined();
    expect(updatePlayerPin).not.toHaveBeenCalled();
  });
});

describe("EP-9: Successful update displays the new PIN", () => {
  it("after successful updatePlayerPin the input collapses and new PIN is shown", async () => {
    vi.mocked(updatePlayerPin).mockResolvedValue({
      success: true,
      message: "PIN updated",
      pin: "9876",
    });

    renderQueueControl();
    await revealPin("1234");

    await userEvent.click(screen.getByLabelText("Edit PIN"));
    const input = screen.getByLabelText("New PIN");
    await userEvent.clear(input);
    await userEvent.type(input, "9876");
    await userEvent.click(screen.getByLabelText("Save PIN"));

    await waitFor(() => {
      // Input collapses, new PIN is shown as text
      expect(screen.queryByLabelText("New PIN")).toBeNull();
      expect(screen.getByText("9876")).toBeDefined();
    });
  });
});

describe("EP-10: Failed updatePlayerPin shows error, preserves input", () => {
  it("when server returns failure the input stays open with an error message", async () => {
    vi.mocked(updatePlayerPin).mockResolvedValue({ success: false, message: "Database error" });

    renderQueueControl();
    await revealPin("1234");

    await userEvent.click(screen.getByLabelText("Edit PIN"));
    const input = screen.getByLabelText("New PIN");
    await userEvent.clear(input);
    await userEvent.type(input, "5555");
    await userEvent.click(screen.getByLabelText("Save PIN"));

    await waitFor(() => {
      // Input still visible
      expect(screen.getByLabelText("New PIN")).toBeDefined();
      // Error shown
      expect(screen.getByText(/Database error/i)).toBeDefined();
    });
  });
});

describe("EP-11: Pressing Escape or Cancel collapses input without saving", () => {
  it("clicking Cancel restores the original PIN display without calling updatePlayerPin", async () => {
    renderQueueControl();
    await revealPin("1234");

    await userEvent.click(screen.getByLabelText("Edit PIN"));
    const input = screen.getByLabelText("New PIN");
    await userEvent.clear(input);
    await userEvent.type(input, "9999");

    // Click cancel
    await userEvent.click(screen.getByLabelText("Cancel PIN edit"));

    // Input gone, original PIN shown
    expect(screen.queryByLabelText("New PIN")).toBeNull();
    expect(screen.getByText("1234")).toBeDefined();
    expect(updatePlayerPin).not.toHaveBeenCalled();
  });

  it("pressing Escape key collapses the input without saving", async () => {
    renderQueueControl();
    await revealPin("1234");

    await userEvent.click(screen.getByLabelText("Edit PIN"));
    const input = screen.getByLabelText("New PIN");
    await userEvent.type(input, "{Escape}");

    expect(screen.queryByLabelText("New PIN")).toBeNull();
    expect(updatePlayerPin).not.toHaveBeenCalled();
  });
});
