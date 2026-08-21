// @vitest-environment happy-dom
// ============================================================
// Unit Tests — useEditMatch (Suite EMH)
// ============================================================
//
// PREFIX NOTE: `tests/unit/edit-match-dialog-repeat.test.tsx` already owns the
// prefix **EM**, and it covers the *component* (EditMatchDialog) through the
// rendered DOM. This file is **EMH** — the *hook*, driven directly. The two are
// not interchangeable: the component suite can only see what a click produces,
// so it cannot advance a timer to a chosen millisecond, cannot observe a timer
// that is still armed at unmount, and cannot distinguish "no close scheduled"
// from "close scheduled but not yet fired". Those are exactly the properties
// below.
//
// WHY THIS FILE EXISTS
// --------------------
// useEditMatch is the only place in the organizer surface that owns a *detached
// timer*. `closeTimerRef` holds a `setTimeout` that closes the dialog
// DIALOG_CLOSE_DELAY_MS after a successful revert (and after a successful
// notification-backed correction). A detached timer is dangerous in three
// specific ways, and every one of them has already shipped here once:
//
//   1. **Fire after unmount.** The pre-fix version scheduled an untracked
//      `setTimeout(() => setOpen(false), …)`. It outlived the dialog and ran
//      against whatever the component had become — a setState on a dead
//      component, or worse, a slam-shut of a *reopened* dialog mid-typing.
//      `useEffect(() => cancelPendingClose, [])` is the only thing preventing
//      that, and nothing else in the app would go red if it were deleted.
//   2. **Stacked timers.** Every action path calls `cancelPendingClose()` on
//      entry. Without it, two reverts arm two timers and the first one closes
//      the dialog at the *wrong* deadline — under the organizer's second edit.
//   3. **A close that never comes, or comes on the wrong branch.** The plain
//      save path deliberately does NOT auto-close (a score correction is a
//      repeatable operation; see the ⚠️ block in the hook). The revert path and
//      the notification path DO. A regression that unified them in either
//      direction is invisible to a test that only asserts "the action was
//      called" — the dialog is a *court-state* surface, and a revert puts a
//      match back on court, so leaving it open parks the organizer on a history
//      card that no longer exists.
//
// The second property that carries weight is the **validation gate**. The three
// early returns in `handleSaveScore` run before any server call. If one of them
// stops refusing, a typo like `211` or a tie like `21–21` reaches
// `updateMatchDetails` and the only feedback the organizer gets is a
// round-trip's worth of latency followed by a server rejection — or, for the
// tie, a completed match with no winner. Every negative below therefore asserts
// that the write was **never started**, not merely that the return value was a
// refusal.
//
// TEST IDS
// --------
//   EMH-1   initial state seeds the score strings from the numeric props
//   EMH-2   valid save calls updateMatchDetails(matchId, a, b, revert=false)
//   EMH-3   (negative) empty/non-numeric score refuses AND never calls either action
//   EMH-4   (negative) a negative score refuses AND never calls either action
//   EMH-5   (edge)     MAX_BADMINTON_SCORE accepted; +1 refused; -1 accepted
//   EMH-6   (negative) equal scores refuse AND never call either action
//   EMH-7   save success drives message/savedOnce/onSaved, re-seeds, stays OPEN
//   EMH-8   (negative) save failure sets isError, no savedOnce, no onSaved, no timer
//   EMH-9   setScoreA/setScoreB invalidate the standing verdict
//   EMH-10  revert calls updateMatchDetails(matchId, 0, 0, revert=true) + onSaved
//   EMH-11  (edge) still open at DELAY-1ms, closed at exactly DELAY
//   EMH-12  (negative) a failed revert arms NO close timer
//   EMH-13  a timer pending at unmount is CLEARED (with positive control)
//   EMH-14  a second revert does not stack a second timer
//   EMH-15  a save started during a pending close disarms it (with positive control)
//   EMH-16  (edge) a validation refusal does NOT disarm a pending close
//   EMH-17  re-opening re-seeds from the CURRENT props and clears the verdict
//   EMH-18  a manual close cancels the pending timer (one close, not two)
//   EMH-19  (edge) controlled mode: options.open wins, internal state never flips
//   EMH-20  notificationId routes to resolveScoreCorrection, not updateMatchDetails
//   EMH-21  (edge) an EMPTY-STRING notificationId routes to updateMatchDetails
//   EMH-22  notification success DOES auto-close after DIALOG_CLOSE_DELAY_MS
//   EMH-23  (negative) alreadyResolved: error state, server scores, no timer
//   EMH-24  (edge) alreadyResolved message fallback chain (actorName → error → literal)
//   EMH-25  (edge) alreadyResolved applies a currentScore of 0 on EITHER field,
//                  but leaves an absent one alone
//   EMH-26  (negative) a plain notification failure arms no timer and sets no
//                  savedOnce; (edge) a failure with neither message nor error
//                  leaves `message` a real null, not the string "undefined"
//   EMH-27  isPending is true for the whole in-flight window and false after
//
// STRATEGY
// --------
// Both server actions are module-mocked; the hook is driven through renderHook
// + act. Timers are FAKE for every test (`vi.useFakeTimers()` in beforeEach) so
// that "before the deadline" and "at the deadline" are exact rather than racy.
// Testing Library's `waitFor`/`findBy` are deliberately NOT used anywhere in
// this file: @testing-library/dom's fake-timer detection keys off a `jest`
// global that does not exist under Vitest, so `waitFor` would poll on a
// setInterval that fake timers freeze. `await act(async () => …)` flushes the
// async transition instead, and `act(() => vi.advanceTimersByTime(n))` moves
// the clock by an exact amount.
//
// Where a test needs an ERROR verdict merely as a FIXTURE (EMH-9, EMH-17) it
// sources it from a failing server result rather than from a local validation
// refusal. That is deliberate: a regression in one of the three validation
// guards should redden the test that NAMES that guard, not a test about
// clearFeedback or about the reopen reset. EMH-16 is the exception — a local
// refusal is the thing it is about.
//
// WHAT THIS FILE DOES NOT PROVE
// -----------------------------
//   - That the DOM disables the inputs and the Save button while `isPending`.
//     The hook only *reports* isPending; it does not itself refuse a re-entrant
//     handleSaveScore call. Re-entry gating is `disabled={isPending}` in
//     src/components/organizer/edit-match-dialog.tsx and is covered by
//     Suite EM (tests/unit/edit-match-dialog-repeat.test.tsx).
//   - That updateMatchDetails / resolveScoreCorrection authorize the caller,
//     bound the scores server-side, or write the right row. Both are mocked
//     here. Their guards are covered in the match-lifecycle and notification
//     action suites.
//   - That Radix restores `body { pointer-events }` after a timer-driven close.
//     That hypothesis is explicitly recorded as FALSE in the hook's docblock;
//     it is a library concern with no unit surface.
//   - Realtime refresh of the history card behind the dialog — the hook does no
//     subscription work at all.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { DIALOG_CLOSE_DELAY_MS, MAX_BADMINTON_SCORE } from "@/lib/constants";
import type { UseEditMatchOptions } from "@/hooks/use-edit-match";

vi.mock("@/app/actions/match-lifecycle", () => ({
  updateMatchDetails: vi.fn(),
}));

vi.mock("@/app/actions/notifications", () => ({
  resolveScoreCorrection: vi.fn(),
}));

import { updateMatchDetails } from "@/app/actions/match-lifecycle";
import { resolveScoreCorrection } from "@/app/actions/notifications";
import { useEditMatch } from "@/hooks/use-edit-match";

const mockUpdate = vi.mocked(updateMatchDetails);
const mockResolve = vi.mocked(resolveScoreCorrection);

// ── Constants ─────────────────────────────────────────────────

const MATCH_ID = "11111111-1111-4111-8111-111111111111";
const NOTIFICATION_ID = "22222222-2222-4222-8222-222222222222";
const INITIAL_A = 21;
const INITIAL_B = 19;

// ── Harness ───────────────────────────────────────────────────

type Props = { a: number; b: number; options: UseEditMatchOptions };

function mount(options: UseEditMatchOptions = {}, a = INITIAL_A, b = INITIAL_B) {
  return renderHook((p: Props) => useEditMatch(MATCH_ID, p.a, p.b, p.options), {
    initialProps: { a, b, options },
  });
}

type Rendered = ReturnType<typeof mount>;

/** Opens the dialog through the hook's own handler (not by poking state). */
function open(view: Rendered) {
  act(() => {
    view.result.current.handleOpenChange(true);
  });
}

/** Types both score fields through the public (feedback-clearing) setters. */
function typeScores(view: Rendered, a: string, b: string) {
  act(() => {
    view.result.current.setScoreA(a);
  });
  act(() => {
    view.result.current.setScoreB(b);
  });
}

/** Fires handleSaveScore and flushes the async transition it starts. */
async function save(view: Rendered) {
  await act(async () => {
    view.result.current.handleSaveScore();
  });
}

/** Fires handleRevert and flushes the async transition it starts. */
async function revert(view: Rendered) {
  await act(async () => {
    view.result.current.handleRevert();
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** How many times the hook told its parent to close. */
function closeCalls(onOpenChange: ReturnType<typeof vi.fn>) {
  return onOpenChange.mock.calls.filter((c) => c[0] === false).length;
}

// ── Tests ─────────────────────────────────────────────────────

describe("useEditMatch — Unit Suite (EMH)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockUpdate.mockReset();
    mockResolve.mockReset();
    mockUpdate.mockResolvedValue({ success: true, message: "Scores updated." });
    mockResolve.mockResolvedValue({ success: true, message: "Correction saved." });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── EMH-1 ──────────────────────────────────────────────────
  it("EMH-1: initial state seeds the score strings from the numeric props", () => {
    const view = mount();

    expect(
      view.result.current.scoreA,
      "the dialog did not open pre-filled with the persisted team A score — the organizer would have to retype a score they only meant to nudge"
    ).toBe("21");
    expect(
      view.result.current.scoreB,
      "the dialog did not open pre-filled with the persisted team B score"
    ).toBe("19");
    expect(
      view.result.current.open,
      "an uncontrolled dialog mounted already open — it would appear over the history list unprompted"
    ).toBe(false);
    expect(view.result.current.message, "a verdict was showing before any action ran").toBeNull();
    expect(view.result.current.isError, "the error styling was armed before any action ran").toBe(
      false
    );
    expect(
      view.result.current.savedOnce,
      "savedOnce started true — the button would read 'Save Again' before anything was saved"
    ).toBe(false);
    expect(view.result.current.isPending, "isPending started true with no action in flight").toBe(
      false
    );
  });

  // ── EMH-2 ──────────────────────────────────────────────────
  it("EMH-2: valid save calls updateMatchDetails(matchId, a, b, revert=false)", async () => {
    const view = mount();
    open(view);
    typeScores(view, "23", "21");
    await save(view);

    expect(
      mockUpdate,
      "the score correction did not reach the server exactly once — either nothing was written, or it was written twice"
    ).toHaveBeenCalledTimes(1);
    // Column=value pairing: a swapped-argument mutant makes the SAME number of
    // calls. 23 must land on team A and 21 on team B, and the fourth argument
    // must be false — `true` there would send the match back onto a court
    // instead of correcting a finished result.
    expect(
      mockUpdate,
      "the save path sent the wrong arguments — the two scores are swapped, bound to the wrong match, or revertToActive was set (which reopens a finished match onto a court)"
    ).toHaveBeenCalledWith(MATCH_ID, 23, 21, false);
    expect(
      mockResolve,
      "a plain score edit went through the notification-resolution path, which would close a correction request nobody filed"
    ).not.toHaveBeenCalled();
  });

  // ── EMH-3 (negative) ───────────────────────────────────────
  it("EMH-3 (negative): empty/non-numeric score refuses AND never calls either action", async () => {
    // Positive control lives in EMH-2: the same hook, the same handler, with
    // valid input, does reach updateMatchDetails. So a refusal here is a
    // refusal of THIS input, not a universally dead function.
    const view = mount();
    open(view);

    typeScores(view, "", "19");
    await save(view);
    expect(
      view.result.current.message,
      "an empty team A score produced no refusal — parseInt('') is NaN and would be sent to the server as-is"
    ).toBe("Enter valid non-negative scores.");
    expect(view.result.current.isError, "the refusal was not painted as an error").toBe(true);

    typeScores(view, "21", "abc");
    await save(view);
    expect(view.result.current.message, "a non-numeric team B score produced no refusal").toBe(
      "Enter valid non-negative scores."
    );

    // GUARD ORDER: the point is not that the caller got a refusal string, it is
    // that the write was never STARTED.
    expect(
      mockUpdate,
      "the validation gate ran after the server call instead of before it — an unparseable score reached updateMatchDetails"
    ).not.toHaveBeenCalled();
    expect(
      mockResolve,
      "an unparseable score reached resolveScoreCorrection"
    ).not.toHaveBeenCalled();
  });

  // ── EMH-4 (negative) ───────────────────────────────────────
  it("EMH-4 (negative): a negative score refuses AND never calls either action", async () => {
    const view = mount({ notificationId: NOTIFICATION_ID });
    open(view);

    typeScores(view, "-1", "19");
    await save(view);
    expect(
      view.result.current.message,
      "a negative team A score was accepted — badminton has no negative scores and the server would reject it a round-trip later"
    ).toBe("Enter valid non-negative scores.");
    expect(view.result.current.isError, "the refusal was not painted as an error").toBe(true);

    typeScores(view, "21", "-5");
    await save(view);
    expect(view.result.current.message, "a negative team B score was accepted").toBe(
      "Enter valid non-negative scores."
    );

    // 0 is NOT negative — the boundary must be inclusive, or a 21–0 shutout
    // becomes unrecordable.
    typeScores(view, "21", "0");
    await save(view);
    expect(
      mockResolve,
      "a legitimate 21–0 shutout was refused — the non-negative guard is off by one at zero"
    ).toHaveBeenCalledWith(NOTIFICATION_ID, 21, 0);

    expect(
      mockResolve,
      "a negative score reached the server: the only call should be the legitimate 21–0"
    ).toHaveBeenCalledTimes(1);
    expect(
      mockUpdate,
      "the notification path leaked into updateMatchDetails"
    ).not.toHaveBeenCalled();
  });

  // ── EMH-5 (edge) ───────────────────────────────────────────
  it("EMH-5 (edge): MAX_BADMINTON_SCORE accepted; one above refused; one below accepted", async () => {
    const view = mount();
    open(view);

    // One BELOW the boundary.
    typeScores(view, String(MAX_BADMINTON_SCORE - 1), "10");
    await save(view);
    expect(
      mockUpdate,
      "a score one below the cap was refused — the upper bound is off by one and legal scores are unenterable"
    ).toHaveBeenCalledWith(MATCH_ID, MAX_BADMINTON_SCORE - 1, 10, false);

    // AT the boundary — 31 is a legal badminton score (30-all golden point).
    typeScores(view, String(MAX_BADMINTON_SCORE), "30");
    await save(view);
    expect(
      mockUpdate,
      `a score of exactly ${MAX_BADMINTON_SCORE} was refused — the cap is exclusive when it must be inclusive, and a real 31-30 golden-point result cannot be corrected`
    ).toHaveBeenCalledWith(MATCH_ID, MAX_BADMINTON_SCORE, 30, false);

    expect(
      mockUpdate,
      "one of the two legal scores did not reach the server"
    ).toHaveBeenCalledTimes(2);

    // ONE ABOVE the boundary — must be refused locally, without a round-trip.
    typeScores(view, String(MAX_BADMINTON_SCORE + 1), "10");
    await save(view);
    expect(
      view.result.current.message,
      "a score above the cap produced no local refusal — the organizer's only feedback on a typo like 211 becomes a server round-trip"
    ).toBe(`Enter valid scores (0–${MAX_BADMINTON_SCORE}) for both teams.`);
    expect(view.result.current.isError, "the out-of-range refusal was not painted red").toBe(true);
    expect(
      mockUpdate,
      "an out-of-range score reached the server — the upper-bound gate is not blocking the write"
    ).toHaveBeenCalledTimes(2);

    // The bound applies to team B independently, not just to team A.
    typeScores(view, "10", String(MAX_BADMINTON_SCORE + 1));
    await save(view);
    expect(
      mockUpdate,
      "the upper bound is only checked on team A — an out-of-range team B score reached the server"
    ).toHaveBeenCalledTimes(2);
  });

  // ── EMH-6 (negative) ───────────────────────────────────────
  it("EMH-6 (negative): equal scores refuse AND never call either action", async () => {
    const view = mount();
    open(view);
    typeScores(view, "21", "21");
    await save(view);

    expect(
      view.result.current.message,
      "a tie was accepted — a completed badminton match with equal scores has no winning team, and every downstream stat (wins, streaks, Wrapped) reads a winner off these two numbers"
    ).toBe("Scores cannot be equal — there must be a winning team.");
    expect(view.result.current.isError, "the tie refusal was not painted red").toBe(true);
    expect(
      mockUpdate,
      "a tie reached updateMatchDetails — the equality gate ran after the write instead of before it"
    ).not.toHaveBeenCalled();

    // Positive control on the same input shape: change ONE digit and it goes.
    typeScores(view, "21", "20");
    await save(view);
    expect(
      mockUpdate,
      "a one-point win was also refused — the guard is rejecting more than ties"
    ).toHaveBeenCalledWith(MATCH_ID, 21, 20, false);

    // 0-0 is equal too, and must be refused for the same reason.
    typeScores(view, "0", "0");
    await save(view);
    expect(
      mockUpdate,
      "0-0 was accepted — the equality gate special-cases zero"
    ).toHaveBeenCalledTimes(1);
  });

  // ── EMH-7 ──────────────────────────────────────────────────
  it("EMH-7: save success drives message/savedOnce/onSaved, re-seeds inputs, stays OPEN", async () => {
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    const view = mount({ onSaved, onOpenChange });
    open(view);
    // Deliberately non-canonical input: leading zero and whitespace. The hook
    // re-seeds from the PARSED integers, so the inputs must normalise.
    typeScores(view, "07", " 15 ");
    await save(view);

    expect(mockUpdate, "the parsed integers were not sent").toHaveBeenCalledWith(
      MATCH_ID,
      7,
      15,
      false
    );
    expect(
      view.result.current.message,
      "the server's own message was not surfaced — the organizer gets no confirmation that the correction landed"
    ).toBe("Scores updated.");
    expect(view.result.current.isError, "a successful save was painted as an error").toBe(false);
    expect(
      view.result.current.savedOnce,
      "savedOnce did not latch — the dialog's button never becomes 'Save Again' and the organizer cannot tell the first save took"
    ).toBe(true);
    expect(
      onSaved,
      "the parent was not told to refresh after a successful correction"
    ).toHaveBeenCalledTimes(1);
    expect(
      view.result.current.scoreA,
      "the inputs were not re-seeded from what was persisted — a second correction starts from the raw typed text, not from the truth"
    ).toBe("7");
    expect(view.result.current.scoreB, "team B was not re-seeded from what was persisted").toBe(
      "15"
    );

    // The re-seed uses the RAW setters on purpose: going through the public
    // setters would clear the "Scores updated." that was set one line earlier.
    expect(
      view.result.current.message,
      "the success message was erased by the re-seed — the save silently succeeds with no confirmation on screen"
    ).toBe("Scores updated.");

    // A score correction is repeatable BY DESIGN. It must not auto-close, and
    // it must not even ARM a close: advance ten deadlines and nothing happens.
    advance(DIALOG_CLOSE_DELAY_MS * 10);
    expect(
      view.result.current.open,
      "a plain score save auto-closed the dialog — correcting a score is a repeatable operation and every repeat becomes a close/reopen cycle"
    ).toBe(true);
    expect(
      closeCalls(onOpenChange),
      "a close was scheduled on the plain save path; a detached timer here is exactly the bug the ref-tracked timer replaced"
    ).toBe(0);
  });

  // ── EMH-8 (negative) ───────────────────────────────────────
  it("EMH-8 (negative): save failure sets isError, no savedOnce, no onSaved, no timer", async () => {
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    mockUpdate.mockResolvedValue({ success: false, message: "Not authorized." });
    const view = mount({ onSaved, onOpenChange });
    open(view);
    typeScores(view, "23", "21");
    await save(view);

    expect(
      view.result.current.message,
      "the server's rejection reason was swallowed — the organizer sees nothing and retries the same failing edit"
    ).toBe("Not authorized.");
    expect(
      view.result.current.isError,
      "a rejected save was painted as a success — the organizer walks away believing the score was corrected"
    ).toBe(true);
    expect(
      view.result.current.savedOnce,
      "savedOnce latched on a FAILED save — the dialog claims a save happened when none did"
    ).toBe(false);
    expect(
      onSaved,
      "the parent was told to refresh after a failed save — it would refetch and show the unchanged score under a dialog claiming otherwise"
    ).not.toHaveBeenCalled();

    // The dialog must stay open and re-armed so the organizer can retry.
    advance(DIALOG_CLOSE_DELAY_MS * 10);
    expect(
      view.result.current.open,
      "a failed save closed the dialog — the organizer loses their typed scores and the reason for the failure"
    ).toBe(true);
    expect(closeCalls(onOpenChange), "a close was scheduled on a failed save").toBe(0);

    // Positive control: the identical handler succeeds when the server does.
    mockUpdate.mockResolvedValue({ success: true, message: "Scores updated." });
    await save(view);
    expect(
      view.result.current.isError,
      "a retry after a failure stayed red — the error state is latched and the dialog is unusable without a reopen"
    ).toBe(false);
    expect(view.result.current.savedOnce, "the retry did not latch savedOnce").toBe(true);
  });

  // ── EMH-9 ──────────────────────────────────────────────────
  it("EMH-9: setScoreA/setScoreB invalidate the standing verdict", async () => {
    const view = mount();
    open(view);
    typeScores(view, "23", "21");
    await save(view);
    // Positive control: there IS a verdict on screen to invalidate.
    expect(view.result.current.message, "no verdict was on screen to invalidate").toBe(
      "Scores updated."
    );

    act(() => {
      view.result.current.setScoreA("25");
    });
    expect(
      view.result.current.message,
      "the green 'Scores updated.' outlived the value it was about — the organizer retypes 23→25 and is left reading a success message next to a number that was never sent"
    ).toBeNull();
    expect(view.result.current.scoreA, "the keystroke itself was dropped").toBe("25");

    // Same for the error verdict, and via the team B setter. The error comes
    // from the SERVER rather than from a local validation refusal, so that a
    // regression in one of the three validation guards cannot redden this test
    // — the property here is about clearFeedback, not about validation.
    mockUpdate.mockResolvedValue({ success: false, message: "Not authorized." });
    typeScores(view, "24", "22");
    await save(view);
    expect(view.result.current.isError, "no error verdict was on screen to invalidate").toBe(true);
    act(() => {
      view.result.current.setScoreB("19");
    });
    expect(
      view.result.current.message,
      "a stale refusal survived the keystroke that fixed it"
    ).toBeNull();
    expect(
      view.result.current.isError,
      "the red styling survived the keystroke that fixed the input — the next message paints red even when it is a success"
    ).toBe(false);
  });

  // ── EMH-10 ─────────────────────────────────────────────────
  it("EMH-10: revert calls updateMatchDetails(matchId, 0, 0, revert=true) and refreshes the parent", async () => {
    const onSaved = vi.fn();
    const view = mount({ onSaved });
    open(view);
    // Whatever is typed must be ignored — a revert zeroes the score.
    typeScores(view, "23", "21");
    await revert(view);

    expect(mockUpdate, "the revert did not reach the server exactly once").toHaveBeenCalledTimes(1);
    expect(
      mockUpdate,
      "the revert sent the typed scores instead of 0/0, or left revertToActive false — a false fourth argument corrects the score without putting the match back on court, so players are told to re-submit a match that is still finished"
    ).toHaveBeenCalledWith(MATCH_ID, 0, 0, true);
    expect(
      onSaved,
      "the parent was not told to refresh after the match went back on court — the history card stays on screen and the court board does not repaint until the next realtime event"
    ).toHaveBeenCalledTimes(1);
    expect(
      mockResolve,
      "a revert leaked into the notification-resolution path, closing a correction request that nobody answered"
    ).not.toHaveBeenCalled();
  });

  // ── EMH-11 (edge) ──────────────────────────────────────────
  it("EMH-11 (edge): still open at DIALOG_CLOSE_DELAY_MS-1, closed at exactly DIALOG_CLOSE_DELAY_MS", async () => {
    const onOpenChange = vi.fn();
    const view = mount({ onOpenChange });
    open(view);
    await revert(view);

    // The delay exists so the organizer can read the confirmation. Closing
    // early eats the message; never closing parks them on a history card that
    // realtime has already removed.
    advance(DIALOG_CLOSE_DELAY_MS - 1);
    expect(
      view.result.current.open,
      "the dialog closed BEFORE the delay elapsed — the confirmation message is unreadable"
    ).toBe(true);
    expect(closeCalls(onOpenChange), "the parent was told to close before the deadline").toBe(0);

    advance(1);
    expect(
      view.result.current.open,
      "the dialog did not close at the deadline — after a revert the match is back on court and the history card behind this dialog no longer exists"
    ).toBe(false);
    expect(
      closeCalls(onOpenChange),
      "the parent was never told the dialog closed — a controlled parent would keep rendering it open"
    ).toBe(1);
  });

  // ── EMH-12 (negative) ──────────────────────────────────────
  it("EMH-12 (negative): a failed revert arms NO close timer", async () => {
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    mockUpdate.mockResolvedValue({ success: false, message: "Match is not editable." });
    const view = mount({ onSaved, onOpenChange });
    open(view);
    await revert(view);

    expect(view.result.current.message, "the failure reason was swallowed").toBe(
      "Match is not editable."
    );
    expect(view.result.current.isError, "a failed revert was painted as a success").toBe(true);
    expect(
      onSaved,
      "the parent was told to refresh after a revert that did not happen"
    ).not.toHaveBeenCalled();

    advance(DIALOG_CLOSE_DELAY_MS * 10);
    expect(
      view.result.current.open,
      "a FAILED revert still auto-closed the dialog — the match is untouched, the organizer never reads why, and the close reads as confirmation"
    ).toBe(true);
    expect(closeCalls(onOpenChange), "a close was scheduled on a failed revert").toBe(0);

    // Positive control: the same handler DOES arm a close when the revert works
    // (proved end-to-end in EMH-11), so the assertion above is about failure,
    // not about a dead code path.
    mockUpdate.mockResolvedValue({ success: true, message: "Match reopened." });
    await revert(view);
    advance(DIALOG_CLOSE_DELAY_MS);
    expect(
      view.result.current.open,
      "a successful revert after a failed one did not close — the failure latched something"
    ).toBe(false);
  });

  // ── EMH-13 ─────────────────────────────────────────────────
  it("EMH-13: a timer pending at unmount is CLEARED", async () => {
    // Positive control FIRST: the identical flow, left mounted, does close.
    const controlOnOpenChange = vi.fn();
    const control = mount({ onOpenChange: controlOnOpenChange });
    open(control);
    await revert(control);
    advance(DIALOG_CLOSE_DELAY_MS);
    expect(
      closeCalls(controlOnOpenChange),
      "the control never closed — the unmount assertion below would then be vacuously true"
    ).toBe(1);
    control.unmount();

    const onOpenChange = vi.fn();
    const view = mount({ onOpenChange });
    open(view);
    await revert(view);
    // Halfway to the deadline the organizer navigates away / the card unmounts.
    advance(DIALOG_CLOSE_DELAY_MS - 1);
    expect(closeCalls(onOpenChange), "closed early, before the unmount could matter").toBe(0);
    expect(
      vi.getTimerCount(),
      "no close timer was armed at all, so 'cleared at unmount' proves nothing"
    ).toBeGreaterThan(0);

    view.unmount();

    expect(
      vi.getTimerCount(),
      "the pending close timer survived unmount — it will fire against a dead component (a setState on nothing) or, if the dialog was reopened in the meantime, slam it shut mid-typing"
    ).toBe(0);

    advance(DIALOG_CLOSE_DELAY_MS * 10);
    expect(
      closeCalls(onOpenChange),
      "the close fired AFTER unmount — the detached-timer bug the closeTimerRef cleanup exists to prevent"
    ).toBe(0);
  });

  // ── EMH-14 ─────────────────────────────────────────────────
  it("EMH-14: a second revert does not stack a second timer", async () => {
    const onOpenChange = vi.fn();
    const view = mount({ onOpenChange });
    open(view);

    await revert(view); // timer #1 armed, deadline t = DELAY
    const half = Math.floor(DIALOG_CLOSE_DELAY_MS / 2);
    advance(half); // t = DELAY/2
    expect(closeCalls(onOpenChange), "timer #1 fired before its own deadline").toBe(0);

    await revert(view); // must CANCEL #1 and arm #2, deadline t = DELAY/2 + DELAY
    expect(
      vi.getTimerCount(),
      "two close timers are armed at once — the first will fire at the OLD deadline and close the dialog out from under the second action"
    ).toBe(1);

    advance(DIALOG_CLOSE_DELAY_MS - half); // t = DELAY — timer #1's old deadline
    expect(
      closeCalls(onOpenChange),
      "the dialog closed at the FIRST revert's deadline — the second action's own delay was cut short and its confirmation is unreadable"
    ).toBe(0);
    expect(view.result.current.open, "the stale timer closed the dialog").toBe(true);

    advance(half); // t = DELAY/2 + DELAY — timer #2's deadline
    expect(
      closeCalls(onOpenChange),
      "the second revert's close never fired, or fired more than once"
    ).toBe(1);
    expect(view.result.current.open, "the dialog did not close at the second deadline").toBe(false);
  });

  // ── EMH-15 ─────────────────────────────────────────────────
  it("EMH-15: a save started during a pending close disarms it", async () => {
    // Positive control: with NO intervening save, the pending close fires.
    const controlOnOpenChange = vi.fn();
    const control = mount({ onOpenChange: controlOnOpenChange });
    open(control);
    await revert(control);
    advance(DIALOG_CLOSE_DELAY_MS);
    expect(
      closeCalls(controlOnOpenChange),
      "the control's pending close never fired, so the disarm assertion below proves nothing"
    ).toBe(1);
    control.unmount();

    const onOpenChange = vi.fn();
    const view = mount({ onOpenChange });
    open(view);
    await revert(view); // close armed, deadline t = DELAY
    const half = Math.floor(DIALOG_CLOSE_DELAY_MS / 2);
    advance(half);

    // Organizer changes their mind and corrects the score instead.
    typeScores(view, "23", "21");
    await save(view);
    expect(
      mockUpdate,
      "the save never ran, so nothing could have disarmed the timer"
    ).toHaveBeenCalledWith(MATCH_ID, 23, 21, false);
    expect(
      vi.getTimerCount(),
      "the revert's close timer is still armed after a new action started — it will slam the dialog shut while the organizer is mid-edit"
    ).toBe(0);

    advance(DIALOG_CLOSE_DELAY_MS * 10);
    expect(
      view.result.current.open,
      "the stale revert close fired anyway and shut the dialog under an in-progress score edit"
    ).toBe(true);
    expect(closeCalls(onOpenChange), "the disarmed close still reached the parent").toBe(0);
  });

  // ── EMH-16 (edge) ──────────────────────────────────────────
  it("EMH-16 (edge): a validation refusal does NOT disarm a pending close", async () => {
    // The three early returns in handleSaveScore precede cancelPendingClose().
    // That ordering is load-bearing: the revert has already been COMMITTED
    // server-side, so a keystroke the hook itself refuses must not cancel the
    // close that the committed revert scheduled — the match is back on court
    // and this dialog is stale regardless of what is typed into it.
    const onOpenChange = vi.fn();
    const view = mount({ onOpenChange });
    open(view);
    await revert(view);
    const half = Math.floor(DIALOG_CLOSE_DELAY_MS / 2);
    advance(half);

    typeScores(view, "21", "21"); // refused: a tie
    await save(view);
    expect(view.result.current.message, "the tie was not refused").toBe(
      "Scores cannot be equal — there must be a winning team."
    );
    expect(mockUpdate, "the refused save reached the server").toHaveBeenCalledTimes(1);

    advance(DIALOG_CLOSE_DELAY_MS - half);
    expect(
      view.result.current.open,
      "a refused keystroke cancelled the close that a COMMITTED revert scheduled — the dialog stays open over a match that is already back on court"
    ).toBe(false);
    expect(closeCalls(onOpenChange), "the committed revert's close never reached the parent").toBe(
      1
    );
  });

  // ── EMH-17 ─────────────────────────────────────────────────
  it("EMH-17: re-opening re-seeds from the CURRENT props and clears the verdict", async () => {
    const view = mount();
    open(view);
    typeScores(view, "23", "21");
    await save(view);
    expect(view.result.current.savedOnce, "the setup save did not latch").toBe(true);
    // Leave an ERROR verdict standing as well as savedOnce. Sourced from the
    // SERVER, not from a local validation refusal — the property under test is
    // the reopen reset, so a regression in a validation guard must not be able
    // to redden this test.
    mockUpdate.mockResolvedValue({ success: false, message: "Not authorized." });
    typeScores(view, "24", "22");
    await save(view);
    expect(view.result.current.isError, "the setup failure did not paint red").toBe(true);

    act(() => {
      view.result.current.handleOpenChange(false);
    });

    // Realtime has since delivered a different persisted score.
    view.rerender({ a: 15, b: 21, options: {} });
    open(view);

    expect(
      view.result.current.scoreA,
      "re-opening seeded team A from the MOUNT-time score, not the current one — the organizer edits against a stale number and overwrites a correction someone else just made"
    ).toBe("15");
    expect(view.result.current.scoreB, "re-opening seeded team B from a stale score").toBe("21");
    expect(
      view.result.current.message,
      "a verdict from the previous open survived the reopen — the organizer reads a message about scores that are no longer on screen"
    ).toBeNull();
    expect(
      view.result.current.isError,
      "isError survived the close and will paint the NEXT open's first message red, even a successful one"
    ).toBe(false);
    expect(
      view.result.current.savedOnce,
      "savedOnce survived the reopen — the button opens reading 'Save Again' for a session in which nothing has been saved"
    ).toBe(false);
  });

  // ── EMH-18 ─────────────────────────────────────────────────
  it("EMH-18: a manual close cancels the pending timer (one close, not two)", async () => {
    const onOpenChange = vi.fn();
    const view = mount({ onOpenChange });
    open(view);
    await revert(view);
    advance(Math.floor(DIALOG_CLOSE_DELAY_MS / 2));

    // Organizer hits ✕ before the auto-close lands.
    act(() => {
      view.result.current.handleOpenChange(false);
    });
    expect(view.result.current.open, "the manual close did not close the dialog").toBe(false);
    expect(closeCalls(onOpenChange), "the manual close was not reported to the parent").toBe(1);
    expect(
      vi.getTimerCount(),
      "the auto-close timer survived the manual close — it stays armed across a reopen and can shut a freshly reopened dialog"
    ).toBe(0);

    advance(DIALOG_CLOSE_DELAY_MS * 10);
    expect(
      closeCalls(onOpenChange),
      "the parent received a SECOND close after the organizer already closed it — a controlled parent that reopened in between gets slammed shut"
    ).toBe(1);
  });

  // ── EMH-19 (edge) ──────────────────────────────────────────
  it("EMH-19 (edge): controlled mode — options.open wins and internal state never flips", async () => {
    const onOpenChange = vi.fn();
    const view = mount({ open: true, onOpenChange });

    expect(
      view.result.current.open,
      "a controlled dialog ignored the parent's open prop — the parent renders it open and the hook reports it closed"
    ).toBe(true);

    act(() => {
      view.result.current.handleOpenChange(false);
    });
    expect(
      onOpenChange,
      "the controlled parent was never notified of the close, so it can never actually close"
    ).toHaveBeenCalledWith(false);
    expect(
      view.result.current.open,
      "the hook closed itself while controlled — it and the parent now disagree about whether the dialog is open"
    ).toBe(true);

    view.rerender({ a: INITIAL_A, b: INITIAL_B, options: { open: false, onOpenChange } });
    expect(
      view.result.current.open,
      "the parent lowered the open prop and the hook still reported open"
    ).toBe(false);

    // The revert timer must drive the PARENT, not internal state, in this mode.
    view.rerender({ a: INITIAL_A, b: INITIAL_B, options: { open: true, onOpenChange } });
    onOpenChange.mockClear();
    await revert(view);
    advance(DIALOG_CLOSE_DELAY_MS);
    expect(
      closeCalls(onOpenChange),
      "the auto-close never reached the controlled parent — the dialog stays open forever over a match that is back on court"
    ).toBe(1);
    expect(
      view.result.current.open,
      "the hook flipped its own state while controlled instead of deferring to the prop"
    ).toBe(true);
  });

  // ── EMH-20 ─────────────────────────────────────────────────
  it("EMH-20: notificationId routes to resolveScoreCorrection, not updateMatchDetails", async () => {
    const view = mount({ notificationId: NOTIFICATION_ID });
    open(view);
    typeScores(view, "23", "21");
    await save(view);

    expect(
      mockResolve,
      "a score edit opened from a correction REQUEST did not resolve the notification — the request stays open and keeps nagging every organizer"
    ).toHaveBeenCalledTimes(1);
    // Column=value pairing: the notification id and the two scores must not be
    // transposed. A swapped pair makes the same number of calls.
    expect(
      mockResolve,
      "the notification path sent transposed arguments — the wrong notification is resolved, or the two team scores are swapped"
    ).toHaveBeenCalledWith(NOTIFICATION_ID, 23, 21);
    expect(
      mockUpdate,
      "the notification path ALSO wrote through updateMatchDetails — a double write, and the notification-resolving RPC is no longer the single source of the correction"
    ).not.toHaveBeenCalled();
  });

  // ── EMH-21 (edge) ──────────────────────────────────────────
  it("EMH-21 (edge): an empty-string notificationId routes to updateMatchDetails", async () => {
    // The branch is `if (options.notificationId)` — a truthiness check. An
    // empty string is not a notification, and must fall through to the plain
    // edit rather than call resolveScoreCorrection("") and be rejected.
    for (const notificationId of ["", null, undefined] as const) {
      mockUpdate.mockClear();
      mockResolve.mockClear();
      const view = mount({ notificationId });
      open(view);
      typeScores(view, "23", "21");
      await save(view);

      expect(
        mockUpdate,
        `notificationId=${JSON.stringify(notificationId)} did not fall through to the plain edit — the correction is never written`
      ).toHaveBeenCalledWith(MATCH_ID, 23, 21, false);
      expect(
        mockResolve,
        `notificationId=${JSON.stringify(notificationId)} was treated as a real notification — the server is asked to resolve a notification that does not exist and the edit is lost`
      ).not.toHaveBeenCalled();
      view.unmount();
    }
  });

  // ── EMH-22 ─────────────────────────────────────────────────
  it("EMH-22: notification success DOES auto-close after DIALOG_CLOSE_DELAY_MS", async () => {
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    mockResolve.mockResolvedValue({ success: true, message: "Correction saved." });
    const view = mount({ notificationId: NOTIFICATION_ID, onSaved, onOpenChange });
    open(view);
    typeScores(view, "07", "21");
    await save(view);

    expect(view.result.current.message, "the server's confirmation was not surfaced").toBe(
      "Correction saved."
    );
    expect(view.result.current.isError, "a resolved correction was painted red").toBe(false);
    expect(view.result.current.savedOnce, "savedOnce did not latch on the notification path").toBe(
      true
    );
    expect(
      onSaved,
      "the parent was not told to refresh the notification list"
    ).toHaveBeenCalledTimes(1);
    expect(
      view.result.current.scoreA,
      "the inputs were not re-seeded from the parsed integers"
    ).toBe("7");

    // Unlike the plain save, this path DOES close — the notification it was
    // opened from is gone, so there is nothing left to return to.
    advance(DIALOG_CLOSE_DELAY_MS - 1);
    expect(
      view.result.current.open,
      "the notification dialog closed before the delay — the confirmation is unreadable"
    ).toBe(true);
    advance(1);
    expect(
      view.result.current.open,
      "a resolved correction request left its dialog open over a notification that no longer exists"
    ).toBe(false);
    expect(closeCalls(onOpenChange), "the close was not reported to the parent exactly once").toBe(
      1
    );
  });

  // ── EMH-23 (negative) ──────────────────────────────────────
  it("EMH-23 (negative): alreadyResolved shows the actor, re-seeds the SERVER scores, arms no timer", async () => {
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    mockResolve.mockResolvedValue({
      success: false,
      alreadyResolved: true,
      actorName: "Jake L",
      error: "Already handled.",
      currentScoreA: 21,
      currentScoreB: 18,
    });
    const view = mount({ notificationId: NOTIFICATION_ID, onSaved, onOpenChange });
    open(view);
    typeScores(view, "23", "21");
    await save(view);

    expect(
      view.result.current.message,
      "a race with another organizer produced no attribution — the second organizer cannot tell their edit was discarded or by whom"
    ).toBe("Already handled by Jake L.");
    expect(
      view.result.current.isError,
      "a discarded edit was painted as a success — the organizer believes their scores were written when the other organizer's were"
    ).toBe(true);
    expect(
      view.result.current.savedOnce,
      "savedOnce latched even though THIS organizer's edit was rejected"
    ).toBe(false);
    expect(
      onSaved,
      "the parent was not refreshed after losing the race — the resolved notification would keep showing as open"
    ).toHaveBeenCalledTimes(1);

    // The typed values must be replaced by what actually won.
    expect(
      view.result.current.scoreA,
      "the losing organizer's typed team A score stayed on screen next to an 'already handled' message — they resubmit and overwrite the winner"
    ).toBe("21");
    expect(view.result.current.scoreB, "team B was not re-seeded from the winning scores").toBe(
      "18"
    );

    advance(DIALOG_CLOSE_DELAY_MS * 10);
    expect(
      view.result.current.open,
      "the dialog auto-closed on a LOST race — the 'already handled by' explanation disappears before it can be read"
    ).toBe(true);
    expect(closeCalls(onOpenChange), "a close was scheduled on the alreadyResolved branch").toBe(0);
  });

  // ── EMH-24 (edge) ──────────────────────────────────────────
  it("EMH-24 (edge): alreadyResolved message fallback chain (actorName → error → literal)", async () => {
    // actorName null, error present → the server's error text.
    mockResolve.mockResolvedValue({
      success: false,
      alreadyResolved: true,
      actorName: null,
      error: "Resolved by another organizer.",
    });
    const withError = mount({ notificationId: NOTIFICATION_ID });
    open(withError);
    typeScores(withError, "23", "21");
    await save(withError);
    expect(
      withError.result.current.message,
      "with no actor name the server's own explanation was dropped — the organizer gets a blank or generic message when a specific one was available"
    ).toBe("Resolved by another organizer.");
    withError.unmount();

    // actorName null AND no error → the literal fallback, never null.
    mockResolve.mockResolvedValue({ success: false, alreadyResolved: true, actorName: null });
    const bare = mount({ notificationId: NOTIFICATION_ID });
    open(bare);
    typeScores(bare, "23", "21");
    await save(bare);
    expect(
      bare.result.current.message,
      "a race with no actor and no server error left the dialog SILENT — the edit vanishes with no explanation at all"
    ).toBe("Already handled.");
    expect(bare.result.current.isError, "the silent-race fallback was not painted red").toBe(true);
  });

  // ── EMH-25 (edge) ──────────────────────────────────────────
  it("EMH-25 (edge): alreadyResolved applies a currentScore of 0 but leaves undefined alone", async () => {
    // The guard is `!= null`, not truthiness. A legitimate 21-0 shutout has a
    // zero in it; a truthiness check would silently skip it and leave the
    // losing organizer's typed number on screen as if it had won.
    //
    // The zero has to be exercised on EACH field independently: the two guards
    // are separate statements, so a truthiness regression in only one of them
    // is invisible to a fixture that puts the 0 in the other.
    mockResolve.mockResolvedValue({
      success: false,
      alreadyResolved: true,
      actorName: "Stelle",
      currentScoreA: 21,
      currentScoreB: 0,
    });
    const zeroB = mount({ notificationId: NOTIFICATION_ID });
    open(zeroB);
    typeScores(zeroB, "23", "19");
    await save(zeroB);
    expect(
      zeroB.result.current.scoreB,
      "a winning team B score of 0 was skipped as falsy — the dialog shows the losing organizer's own number as though the shutout never happened, and resubmitting it overwrites the winner"
    ).toBe("0");
    expect(zeroB.result.current.scoreA, "the non-zero winning team A score was not applied").toBe(
      "21"
    );
    zeroB.unmount();

    mockResolve.mockResolvedValue({
      success: false,
      alreadyResolved: true,
      actorName: "Stelle",
      currentScoreA: 0,
      currentScoreB: 21,
    });
    const zeroA = mount({ notificationId: NOTIFICATION_ID });
    open(zeroA);
    typeScores(zeroA, "23", "19");
    await save(zeroA);
    expect(
      zeroA.result.current.scoreA,
      "a winning team A score of 0 was skipped as falsy — the same shutout bug, on the other field"
    ).toBe("0");
    expect(zeroA.result.current.scoreB, "the non-zero winning team B score was not applied").toBe(
      "21"
    );
    zeroA.unmount();

    // Absent scores (the server could not read the match row) must leave the
    // typed values untouched rather than blanking them to "undefined".
    mockResolve.mockResolvedValue({ success: false, alreadyResolved: true, actorName: "Stelle" });
    const absent = mount({ notificationId: NOTIFICATION_ID });
    open(absent);
    typeScores(absent, "23", "21");
    await save(absent);
    expect(
      absent.result.current.scoreA,
      "with no server scores to show, the input was overwritten (with 'undefined' or 'null') instead of being left as typed"
    ).toBe("23");
    expect(absent.result.current.scoreB, "team B was overwritten with an absent server score").toBe(
      "21"
    );
  });

  // ── EMH-26 (negative) ──────────────────────────────────────
  it("EMH-26 (negative): a plain notification failure arms no timer and latches no savedOnce", async () => {
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    mockResolve.mockResolvedValue({ success: false, error: "Not authorized." });
    const view = mount({ notificationId: NOTIFICATION_ID, onSaved, onOpenChange });
    open(view);
    typeScores(view, "23", "21");
    await save(view);

    // message is undefined on this shape, so the error must be surfaced.
    expect(
      view.result.current.message,
      "a rejected correction showed nothing — the organizer retries the same failing edit forever"
    ).toBe("Not authorized.");
    expect(view.result.current.isError, "a rejected correction was painted as a success").toBe(
      true
    );
    expect(view.result.current.savedOnce, "savedOnce latched on a rejected correction").toBe(false);
    expect(
      onSaved,
      "the parent was refreshed after a correction that never landed"
    ).not.toHaveBeenCalled();

    advance(DIALOG_CLOSE_DELAY_MS * 10);
    expect(
      view.result.current.open,
      "a rejected correction auto-closed its dialog, discarding the reason"
    ).toBe(true);
    expect(closeCalls(onOpenChange), "a close was scheduled on a rejected correction").toBe(0);
    view.unmount();

    // (edge) A failure with NEITHER message NOR error — the `?? null` tail of
    // the fallback chain. The dialog has nothing to say, but `message` must be
    // a real null so the component renders no banner at all, rather than the
    // string "undefined" in the feedback slot.
    mockResolve.mockResolvedValue({ success: false });
    const silent = mount({ notificationId: NOTIFICATION_ID });
    open(silent);
    typeScores(silent, "23", "21");
    await save(silent);
    expect(
      silent.result.current.message,
      "a failure with no text at all put a non-null value in the feedback slot — the dialog renders a banner reading 'undefined'"
    ).toBeNull();
    expect(
      silent.result.current.isError,
      "a silent failure was treated as a success — savedOnce and the parent refresh would follow"
    ).toBe(true);
    expect(silent.result.current.savedOnce, "savedOnce latched on a silent failure").toBe(false);
  });

  // ── EMH-27 ─────────────────────────────────────────────────
  it("EMH-27: isPending is true for the whole in-flight window and false after", async () => {
    let release: (r: { success: boolean; message: string }) => void = () => {};
    mockUpdate.mockImplementation(
      () =>
        new Promise<{ success: boolean; message: string }>((resolve) => {
          release = resolve;
        })
    );

    const view = mount();
    open(view);
    typeScores(view, "23", "21");

    act(() => {
      view.result.current.handleSaveScore();
    });
    expect(
      view.result.current.isPending,
      "isPending never went true while the server call was outstanding — the dialog's inputs and Save button stay enabled and the organizer can fire a second write over the first"
    ).toBe(true);
    expect(
      view.result.current.message,
      "a verdict was rendered before the server answered"
    ).toBeNull();

    await act(async () => {
      release({ success: true, message: "Scores updated." });
    });

    expect(
      view.result.current.isPending,
      "isPending never came back down — the dialog stays disabled and no further correction can be made without a reopen"
    ).toBe(false);
    expect(view.result.current.message, "the resolved verdict was not applied").toBe(
      "Scores updated."
    );
  });
});
