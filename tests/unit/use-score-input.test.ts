// @vitest-environment happy-dom
// ============================================================
// useScoreInput — the SETTLED mapping the player's score card depends on (SI)
// ============================================================
// src/hooks/use-score-input.ts is fifteen lines that decide, for every player
// who loses the score-submission race, whether the app tells them "done" or
// hands them a red retry button that can only ever fail again.
//
// Every game that ends is a race: four players and the organizer can all reach
// for the score at once, and the server's compare-and-swap lets exactly one
// write land. The losers get `already_scored` (the match was completed by
// someone else) or `match_cancelled` (the organizer voided it). Neither is the
// submitter's fault and neither leaves anything for them to do — the match is
// gone. Mapped to `{ error }` like any other failure, the card stays armed
// over a match that no longer exists, and the documented consequence is people
// recording the game a second way. So the hook maps exactly those two codes to
// `{ settled: true }`, which useScoreForm treats as terminal (same shape as a
// success), and EVERY other failure to `{ error }`, which keeps the form armed.
//
// The whole file is that fork, and it has three ways to rot silently:
//   1. one of the two codes drifts out of the condition — the half that drops
//      out goes back to being a red dead end;
//   2. the two settled branches collapse to one message — a player whose match
//      was CANCELLED is told a score was already submitted, so nobody re-runs
//      the game (the organizer-side twin of this is pinned by SMT-3 in
//      settled-match-toast.test.ts);
//   3. a genuine failure (bad input, auth, network) starts reporting `settled`
//      — the card congratulates the player on a score that was never written.
// None of the three is visible to tsc: every branch returns a valid
// ScoreSubmitOutcome, and every one of them renders without throwing.
//
// The tests drive the REAL useScoreForm and observe the state it lands in
// (`settled` / `error` / `submitted`), because that state is what the card
// renders — asserting the returned object in isolation would not prove the
// hook is wired into the form at all. submitMatchScore is the only mock.
//
//   SI-1   success → submitted, no error, no settled (positive control)
//   SI-2   already_scored → settled, with its own copy, and NOT an error
//   SI-3   match_cancelled → settled, with its own copy, and NOT an error
//   SI-4   the two settled messages are distinct, and neither is the
//          useScoreForm fallback (collapse-to-one-branch regression)
//   SI-5   (negative) a non-settled code → error carrying the server's own
//          message, form still armed, NOT settled
//   SI-6   (negative) a failure with no code at all → error, NOT settled
//   SI-7   (edge) a failure whose message is missing → the fallback string
//   SI-8   the matchId the hook was CONSTRUCTED with, and the scores in
//          (teamA, teamB) order, are what reach submitMatchScore
//   SI-9   (edge) after a re-render with a different matchId, the submit goes
//          to the NEW id — the id is not captured once
//   SI-10  (negative) an invalid pair never reaches submitMatchScore at all
//          (+ positive control in the same test)
//
// WHAT THIS FILE DOES NOT PROVE
//   - The validation rules themselves (range, draws, the double-submit latch,
//     the terminal-state machine). That is useScoreForm's contract and is
//     covered in tests/unit/use-score-form.test.ts (SF-*).
//   - That the card RENDERS the settled copy as a neutral resolution rather
//     than a red error — tests/unit/score-race-transition.test.tsx (SR-*).
//   - That the server actually returns these codes in the racing cases —
//     tests/unit/end-match-cas-code.test.ts covers the CAS that emits them.
//   - The organizer's parallel mapping — tests/unit/settled-match-toast.test.ts.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { MatchActionResult } from "@/app/actions/_shared";

vi.mock("@/app/actions/match-lifecycle", () => ({
  submitMatchScore: vi.fn(),
}));

import { submitMatchScore } from "@/app/actions/match-lifecycle";
import { useScoreInput } from "@/hooks/use-score-input";

const mockSubmit = vi.mocked(submitMatchScore);

const MATCH_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_MATCH_ID = "55555555-5555-4555-8555-555555555555";

// useScoreForm's own copy when a handler reports `settled` without supplying a
// message. Duplicated here deliberately: SI-4 asserts the hook's two strings
// are its OWN and not this one, which cannot be expressed by importing it.
const FORM_DEFAULT_SETTLED = "This match was already scored.";

// ── Helpers ───────────────────────────────────────────────────

function setup(matchId = MATCH_ID) {
  return renderHook(({ id }: { id: string }) => useScoreInput(id), {
    initialProps: { id: matchId },
  });
}

type Hook = ReturnType<typeof setup>["result"];

/** Fill a valid, non-drawn pair and submit, flushing the transition. */
async function submitValid(result: Hook, a = "21", b = "18") {
  act(() => {
    result.current.setTeamAScore(a);
    result.current.setTeamBScore(b);
  });
  await act(async () => result.current.handleSubmit());
}

// ── Tests ─────────────────────────────────────────────────────

describe("useScoreInput — Unit Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSubmit.mockResolvedValue({ success: true, message: "Score submitted." });
  });

  // ── SI-1 ───────────────────────────────────────────────────
  it("SI-1: a successful submit is terminal, with no error and no settled copy", async () => {
    const { result } = setup();
    await submitValid(result);

    expect(
      result.current.submitted,
      "a successful score submission did not reach the submitted state — the player is left on a live form for a match that IS scored, and will submit it again"
    ).toBe(true);
    expect(
      result.current.error,
      "a successful submission painted an error — the score landed, and telling the player it did not is what produces the duplicate entries"
    ).toBeNull();
    expect(
      result.current.settled,
      "a plain success was reported as settled-by-someone-else — it was this player who scored it, and the card would say somebody else did"
    ).toBeNull();
  });

  // ── SI-2 ───────────────────────────────────────────────────
  it("SI-2: already_scored is settled, not an error", async () => {
    mockSubmit.mockResolvedValue({
      success: false,
      message: "Match is already completed.",
      code: "already_scored",
    });

    const { result } = setup();
    await submitValid(result);

    expect(
      result.current.settled,
      "losing the race to another submitter did not resolve the card — this is THE bug this hook exists to prevent: the loser is left staring at a retry button for a match that no longer exists"
    ).not.toBeNull();
    expect(
      result.current.error,
      "the lost race was painted red — nothing about it is the submitter's fault and there is nothing to retry, so an error here only invites recording the game a second way"
    ).toBeNull();
    expect(
      result.current.settled,
      "the already_scored copy no longer tells the player their score was superseded by someone else's"
    ).toMatch(/already submitted this score/i);
    expect(
      result.current.settled,
      "the already_scored copy no longer tells the player they are done and heading back"
    ).toMatch(/queue/i);
  });

  // ── SI-3 ───────────────────────────────────────────────────
  it("SI-3: match_cancelled is settled, not an error", async () => {
    mockSubmit.mockResolvedValue({
      success: false,
      message: "Match was cancelled.",
      code: "match_cancelled",
    });

    const { result } = setup();
    await submitValid(result);

    expect(
      result.current.settled,
      "a match the organizer cancelled mid-game left the player on a live form — the match is gone, so every retry from here fails identically"
    ).not.toBeNull();
    expect(
      result.current.error,
      "an organizer cancellation was reported to the player as their own failure"
    ).toBeNull();
    expect(
      result.current.settled,
      "the cancelled copy no longer says the organizer cancelled the match — the player needs to know why the form vanished, or they will assume the app ate their score"
    ).toMatch(/cancelled by the organizer/i);
  });

  // ── SI-4 ───────────────────────────────────────────────────
  it("SI-4: the two settled outcomes carry distinct copy, neither the form's default", async () => {
    mockSubmit.mockResolvedValue({
      success: false,
      message: "Match is already completed.",
      code: "already_scored",
    });
    const scored = setup();
    await submitValid(scored.result);
    const scoredCopy = scored.result.current.settled;

    mockSubmit.mockResolvedValue({
      success: false,
      message: "Match was cancelled.",
      code: "match_cancelled",
    });
    const cancelled = setup();
    await submitValid(cancelled.result);
    const cancelledCopy = cancelled.result.current.settled;

    expect(
      scoredCopy,
      "the two settled reasons collapsed into one message — they mean opposite things: after already_scored the game IS recorded, after match_cancelled no score exists and the game has to be re-run"
    ).not.toBe(cancelledCopy);

    // Both must be the hook's OWN copy. A branch that returns `settled: true`
    // without a settledMessage still lands in the settled state — it just
    // renders useScoreForm's generic default, which says a score was already
    // submitted even when the match was cancelled.
    expect(
      scoredCopy,
      "the already_scored branch stopped supplying its own copy and fell through to useScoreForm's generic default"
    ).not.toBe(FORM_DEFAULT_SETTLED);
    expect(
      cancelledCopy,
      "the cancelled branch fell through to useScoreForm's default, which claims the match was already SCORED — a player told that will not report the game as un-played"
    ).not.toBe(FORM_DEFAULT_SETTLED);

    expect(
      cancelledCopy,
      "the cancelled copy claims someone else submitted a score — no score was recorded for a cancelled match"
    ).not.toMatch(/already submitted/i);
  });

  // ── SI-5 ───────────────────────────────────────────────────
  it("SI-5: (negative) a non-settled failure code stays an error, with the server's own message", async () => {
    mockSubmit.mockResolvedValue({
      success: false,
      message: "Match is not completed yet.",
      code: "not_completed",
    });

    const { result } = setup();
    await submitValid(result);

    expect(
      result.current.error,
      "a real, actionable failure was swallowed — the settled branch must be exactly two codes wide, and anything wider tells the player a score landed when it did not"
    ).toBe("Match is not completed yet.");
    expect(
      result.current.settled,
      "a failure the player CAN act on was reported as settled — the card would close over a match with no score on it"
    ).toBeNull();
    expect(
      result.current.submitted,
      "a failed submit reached the terminal submitted state, so the form is gone and the score was never written"
    ).toBe(false);
  });

  // ── SI-6 ───────────────────────────────────────────────────
  it("SI-6: (negative) a failure with no code at all is an ordinary error", async () => {
    mockSubmit.mockResolvedValue({
      success: false,
      message: "Not authenticated.",
    });

    const { result } = setup();
    await submitValid(result);

    expect(
      result.current.error,
      "an uncoded failure (auth, validation, a network fault) did not surface — every failure without one of the two settled codes has to stay actionable and on-screen"
    ).toBe("Not authenticated.");
    expect(
      result.current.settled,
      "an undefined code matched the settled branch — `undefined === 'already_scored'` must be false, and a mapping that treats a missing code as settled hides every uncoded failure the action can return"
    ).toBeNull();
  });

  // ── SI-7 ───────────────────────────────────────────────────
  it("SI-7: (edge) a failure with no message falls back to a usable string", async () => {
    // MatchActionResult declares `message` as required, so this shape cannot be
    // built without the cast. The `??` in the hook is the defence for exactly
    // that: an action that returns early, or a serialization that drops the
    // field, must not render an empty red box the player cannot interpret.
    mockSubmit.mockResolvedValue({ success: false } as unknown as MatchActionResult);

    const { result } = setup();
    await submitValid(result);

    expect(
      result.current.error,
      "a failure with no message produced no error text — the card would show an empty error box, or nothing at all, on a submit that did not land"
    ).toBe("Failed to submit score.");
    expect(result.current.settled, "a message-less failure was treated as settled").toBeNull();
  });

  // ── SI-8 ───────────────────────────────────────────────────
  it("SI-8: the constructed matchId and the scores in (teamA, teamB) order reach the action", async () => {
    const { result } = setup(MATCH_ID);
    await submitValid(result, "21", "18");

    expect(
      mockSubmit,
      "the score submission never reached the server action at all"
    ).toHaveBeenCalledTimes(1);
    // Argument-by-argument, not just the array: a swapped (b, a) call makes the
    // same number of calls with the same values and records the loser as the
    // winner — every leaderboard and Wrapped stat downstream reads the result
    // from these two numbers.
    expect(
      mockSubmit.mock.calls[0][0],
      "the submit was not bound to the matchId the hook was constructed with — a score written against another match is unrecoverable without a manual fix-record"
    ).toBe(MATCH_ID);
    expect(
      mockSubmit.mock.calls[0][1],
      "teamA's score was not passed in the first score position — swapping the two hands the win to the losing team"
    ).toBe(21);
    expect(
      mockSubmit.mock.calls[0][2],
      "teamB's score was not passed in the second score position — swapping the two hands the win to the losing team"
    ).toBe(18);
  });

  // ── SI-9 ───────────────────────────────────────────────────
  it("SI-9: (edge) after a re-render with a new matchId, the submit goes to the NEW id", async () => {
    const { result, rerender } = setup(MATCH_ID);

    // Same mounted card, different match — the player's dashboard swaps the
    // matchId prop when the next match starts rather than remounting the tree.
    rerender({ id: OTHER_MATCH_ID });
    await submitValid(result, "21", "15");

    expect(
      mockSubmit.mock.calls[0][0],
      "the hook submitted to the matchId it was FIRST constructed with — the id was captured once instead of read per submit, so the score for the current match is written onto the previous one"
    ).toBe(OTHER_MATCH_ID);
    expect(
      mockSubmit.mock.calls[0][0],
      "the stale matchId was used — this is the id the card was mounted with, not the one it is showing"
    ).not.toBe(MATCH_ID);
  });

  // ── SI-10 ──────────────────────────────────────────────────
  it("SI-10: (negative) an invalid pair never reaches submitMatchScore", async () => {
    const { result } = setup();

    // A draw. useScoreForm rejects it before calling the handler, which is the
    // property under test HERE: that useScoreInput's submitter is wired in as
    // useScoreForm's onSubmit and therefore sits BEHIND that validation, rather
    // than calling the server action directly from the card.
    act(() => {
      result.current.setTeamAScore("21");
      result.current.setTeamBScore("21");
    });
    await act(async () => result.current.handleSubmit());

    expect(
      mockSubmit,
      "an unscoreable draw was sent to the server action — the submitter is no longer gated by useScoreForm's validation, so every malformed pair becomes a server round-trip and a red error the player has to decode"
    ).not.toHaveBeenCalled();
    expect(
      result.current.error,
      "the draw was neither submitted nor reported — the player is left with a dead button and no reason"
    ).toMatch(/equal|winning team/i);

    // Positive control: the same mounted hook DOES submit once the pair is
    // valid, so the assertion above is about the draw and not about a submitter
    // that never fires.
    await submitValid(result, "21", "19");
    expect(
      mockSubmit,
      "positive control failed — the hook never submits at all, which makes the negative above vacuous"
    ).toHaveBeenCalledTimes(1);
    expect(mockSubmit.mock.calls[0][0], "the valid submit went to the wrong match").toBe(MATCH_ID);
  });
});
