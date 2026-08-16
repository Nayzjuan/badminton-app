// @vitest-environment happy-dom
// ============================================================
// Unit Tests: losing the score-submission race
// ============================================================
//
// When a game ends, the organizer and the four players can all reach for the
// score at once. The server settles that with a compare-and-swap, so exactly
// one write lands — but the losers used to be left on a live form showing a
// red error for a match that no longer exists, with a retry button that could
// only ever fail again.
//
// SR-1 already_scored renders as a neutral resolution, not an error, and the
//      form is gone (nothing left to retry).
// SR-2 match_cancelled does the same.
// SR-3 An ordinary failure still renders red and leaves the form armed.
// SR-4 A plain success is unaffected.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

vi.mock("@/app/actions/match-lifecycle", () => ({
  submitMatchScore: vi.fn(),
}));

import { submitMatchScore } from "@/app/actions/match-lifecycle";
import { ScoreInputCard } from "@/components/player/score-input-card";

const mockSubmit = vi.mocked(submitMatchScore);
const MATCH_ID = "44444444-4444-4444-8444-444444444444";

async function submitScores(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/your team score/i), "21");
  await user.type(screen.getByLabelText(/opponents score/i), "18");
  await user.click(screen.getByRole("button", { name: /submit final score/i }));
}

describe("ScoreInputCard — losing the submission race", () => {
  beforeEach(() => vi.clearAllMocks());

  it("SR-1: already_scored resolves the card instead of erroring", async () => {
    const user = userEvent.setup();
    mockSubmit.mockResolvedValue({
      success: false,
      message: "Match is already completed.",
      code: "already_scored",
    });
    render(<ScoreInputCard matchId={MATCH_ID} myTeam="a" />);

    await submitScores(user);

    await waitFor(() =>
      expect(screen.getByText(/already submitted this score/i)).toBeInTheDocument()
    );
    // The form is gone — no dead retry button, no red text.
    expect(screen.queryByRole("button", { name: /submit final score/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Match is already completed.")).not.toBeInTheDocument();
  });

  it("SR-2: match_cancelled resolves the card too", async () => {
    const user = userEvent.setup();
    mockSubmit.mockResolvedValue({
      success: false,
      message: "Match is already cancelled.",
      code: "match_cancelled",
    });
    render(<ScoreInputCard matchId={MATCH_ID} myTeam="b" />);

    await submitScores(user);

    await waitFor(() =>
      expect(screen.getByText(/cancelled by the organizer/i)).toBeInTheDocument()
    );
    expect(screen.queryByRole("button", { name: /submit final score/i })).not.toBeInTheDocument();
  });

  it("SR-3: an ordinary failure still shows an error and keeps the form armed", async () => {
    const user = userEvent.setup();
    mockSubmit.mockResolvedValue({
      success: false,
      message: "You are not a player in this match.",
    });
    render(<ScoreInputCard matchId={MATCH_ID} myTeam="a" />);

    await submitScores(user);

    await waitFor(() =>
      expect(screen.getByText("You are not a player in this match.")).toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: /submit final score/i })).toBeInTheDocument();
  });

  it("SR-4: a success still shows the submitted confirmation", async () => {
    const user = userEvent.setup();
    mockSubmit.mockResolvedValue({ success: true, message: "Match completed." });
    render(<ScoreInputCard matchId={MATCH_ID} myTeam="a" />);

    await submitScores(user);

    await waitFor(() => expect(screen.getByText(/score submitted/i)).toBeInTheDocument());
  });
});
