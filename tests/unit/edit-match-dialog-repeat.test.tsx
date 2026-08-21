// @vitest-environment happy-dom
// ============================================================
// Unit Tests: EditMatchDialog — repeat score edits
// ============================================================
//
// Regression cover for the organizer report "when one match is
// edited, it couldn't be edited or fixed again".
//
// EM-1 A first save calls updateMatchDetails once and the dialog
//      STAYS OPEN — a score correction is a repeatable action, so
//      it no longer auto-closes on success.
// EM-2 A second save from the same open dialog reaches the server.
// EM-3 Closing and re-opening after a save also allows a further
//      edit (the close/reopen cycle leaves nothing latched).
// EM-4 Re-opening seeds the inputs from the CURRENT persisted
//      scores (the refreshed props), not the mount-time ones.
// EM-5 A failed save leaves the dialog open and re-armed — the
//      organizer can retry without closing/reopening.
// EM-6 A stale error does not bleed into the next open (isError
//      used to survive the close and paint the next message red).
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

vi.mock("@/app/actions/match-lifecycle", () => ({
  updateMatchDetails: vi.fn(),
}));

import { updateMatchDetails } from "@/app/actions/match-lifecycle";
import { EditMatchDialog } from "@/components/organizer/edit-match-dialog";

const mockUpdate = vi.mocked(updateMatchDetails);
const MATCH_ID = "11111111-1111-4111-8111-111111111111";

type User = ReturnType<typeof userEvent.setup>;

async function openDialog(user: User) {
  await user.click(screen.getByRole("button", { name: /edit match scores/i }));
  await waitFor(() => expect(screen.getByText("Edit Match Score")).toBeInTheDocument());
}

async function closeDialog(user: User) {
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByText("Edit Match Score")).not.toBeInTheDocument());
}

async function typeScores(user: User, a: string, b: string) {
  // The inputs carry disabled={isPending} (edit-match-dialog.tsx), and the
  // "Scores updated." confirmation can render in a commit where isPending is
  // still true. Typing at that instant throws "clear() is only supported on
  // editable elements" — a userEvent error, not a failed assertion, so it
  // reports nothing about the behaviour the test names. Wait for the property
  // that actually has to hold before typing is meaningful.
  await waitFor(() => {
    for (const input of screen.getAllByRole("spinbutton")) {
      expect(input).not.toBeDisabled();
    }
  });
  const inputs = screen.getAllByRole("spinbutton");
  await user.clear(inputs[0]);
  await user.type(inputs[0], a);
  await user.clear(inputs[1]);
  await user.type(inputs[1], b);
}

async function save(user: User) {
  // findBy, not getBy. This button's label is pending-driven — it reads
  // "Saving…" while isPending, then "Save Score"/"Save Again" (see
  // edit-match-dialog.tsx). A synchronous query run while the previous save
  // is still settling throws "Unable to find ... /^save (score|again)$/i",
  // which is a query error rather than a failed assertion and so says nothing
  // about the behaviour under test.
  await user.click(await screen.findByRole("button", { name: /^save (score|again)$/i }));
}

describe("EditMatchDialog — repeat edits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({ success: true, message: "Scores updated." });
  });

  it("EM-1/EM-2: the dialog stays open after a save and a second save reaches the server", async () => {
    const user = userEvent.setup();
    render(<EditMatchDialog matchId={MATCH_ID} initialScoreA={21} initialScoreB={15} />);

    await openDialog(user);
    await typeScores(user, "19", "21");
    await save(user);

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenNthCalledWith(1, MATCH_ID, 19, 21, false);

    // EM-1: still open, showing the confirmation, re-seeded with what was saved.
    await waitFor(() => expect(screen.getByText("Scores updated.")).toBeInTheDocument());
    expect(screen.getByText("Edit Match Score")).toBeInTheDocument();
    let inputs = screen.getAllByRole("spinbutton");
    expect(inputs[0]).toHaveValue(19);
    expect(inputs[1]).toHaveValue(21);

    // EM-2: correct it again without closing.
    await typeScores(user, "21", "18");
    await save(user);
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(2));
    expect(mockUpdate).toHaveBeenNthCalledWith(2, MATCH_ID, 21, 18, false);

    inputs = screen.getAllByRole("spinbutton");
    expect(inputs[0]).toHaveValue(21);
    expect(inputs[1]).toHaveValue(18);
  });

  it("EM-3: closing and re-opening after a save still allows another edit", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <EditMatchDialog matchId={MATCH_ID} initialScoreA={21} initialScoreB={15} />
    );

    await openDialog(user);
    await typeScores(user, "19", "21");
    await save(user);
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));

    // Organizer dismisses; realtime then pushes the new persisted scores down.
    //
    // findBy, not getBy: the waitFor above proves updateMatchDetails was
    // CALLED, which is not the same as React having re-rendered the dialog's
    // Save button into a Done button. A synchronous query here passes only
    // when the render happens to land inside the same tick, and throws
    // "Unable to find ... /^done$/i" whenever the machine is busy.
    await user.click(await screen.findByRole("button", { name: /^done$/i }));
    await waitFor(() => expect(screen.queryByText("Edit Match Score")).not.toBeInTheDocument());
    rerender(<EditMatchDialog matchId={MATCH_ID} initialScoreA={19} initialScoreB={21} />);

    await openDialog(user);
    await typeScores(user, "21", "18");
    await save(user);
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(2));
    expect(mockUpdate).toHaveBeenNthCalledWith(2, MATCH_ID, 21, 18, false);
  });

  it("EM-4: reopening seeds the inputs from the refreshed scores", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <EditMatchDialog matchId={MATCH_ID} initialScoreA={21} initialScoreB={15} />
    );

    await openDialog(user);
    let inputs = screen.getAllByRole("spinbutton");
    expect(inputs[0]).toHaveValue(21);
    expect(inputs[1]).toHaveValue(15);

    await closeDialog(user);
    rerender(<EditMatchDialog matchId={MATCH_ID} initialScoreA={30} initialScoreB={28} />);

    await openDialog(user);
    inputs = screen.getAllByRole("spinbutton");
    expect(inputs[0]).toHaveValue(30);
    expect(inputs[1]).toHaveValue(28);
  });

  it("EM-5: a failed save keeps the dialog open and allows an immediate retry", async () => {
    const user = userEvent.setup();
    mockUpdate.mockResolvedValueOnce({ success: false, message: "Failed to update scores." });
    render(<EditMatchDialog matchId={MATCH_ID} initialScoreA={21} initialScoreB={15} />);

    await openDialog(user);
    await typeScores(user, "19", "21");
    await save(user);

    await waitFor(() => expect(screen.getByText("Failed to update scores.")).toBeInTheDocument());
    expect(screen.getByText("Edit Match Score")).toBeInTheDocument();

    mockUpdate.mockResolvedValueOnce({ success: true, message: "Scores updated." });
    await save(user);
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("Scores updated.")).toBeInTheDocument());
  });

  it("EM-6: an error from a previous open does not colour the next one", async () => {
    const user = userEvent.setup();
    mockUpdate.mockResolvedValueOnce({ success: false, message: "Failed to update scores." });
    render(<EditMatchDialog matchId={MATCH_ID} initialScoreA={21} initialScoreB={15} />);

    await openDialog(user);
    await typeScores(user, "19", "21");
    await save(user);
    await waitFor(() => expect(screen.getByText("Failed to update scores.")).toBeInTheDocument());

    await closeDialog(user);
    await openDialog(user);

    // No message carried over, and the next success renders green, not red.
    expect(screen.queryByText("Failed to update scores.")).not.toBeInTheDocument();
    await typeScores(user, "21", "18");
    await save(user);
    await waitFor(() => {
      const msg = screen.getByText("Scores updated.");
      expect(msg).toHaveClass("text-emerald-600");
    });
  });
});
