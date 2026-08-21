// @vitest-environment happy-dom
// ============================================================
// Live swap — the CLIENT state machine (LS)
// ============================================================
// A live swap rewrites the roster of a match that is being PLAYED right now.
// The server half of that is covered twice already: Suite LMS drives the four
// RPCs against a real database, and Suite LSB proves the four server actions
// refuse a match id that belongs to another session. Neither of them ever
// renders the sheet, so neither can see the half of the feature the organizer
// actually touches — src/hooks/use-live-match-swap.ts, which decides WHICH
// action runs, WITH WHICH ids, and WHAT the sheet looks like afterwards.
//
// Three things in that file are dangerous, and all three fail silently:
//
//   1. ARGUMENT POSITION. The three actions take the same ids in DIFFERENT
//      orders — swapTeamsInActiveMatch is (matchId, sessionId, …) while
//      swapPlayerInActiveMatch is (matchId, outPlayerId, inPlayerId,
//      sessionId, …). Transpose two of them and the call still type-checks
//      (every parameter is a string), still returns success, and swaps the
//      wrong player, or names the outgoing player as the incoming one in the
//      broadcast every affected player receives. A test that asserts "the
//      action was called" cannot see any of that: the mutant makes the same
//      call, with the same arity, to the same function. So every dispatch
//      test below asserts the full positional tuple, with a distinct id and a
//      distinct name for every slot, and asserts that the OTHER TWO actions
//      were never called at all.
//
//   2. DOUBLE-START. confirm() is wired to a button that stays mounted while
//      the request is in flight. Its only protection is `|| isPending`, and a
//      second confirm on a live swap is not idempotent server-side — it is a
//      second swap, applied to the roster the first one just produced. LS-16
//      starts a swap, leaves it unresolved, and confirms again.
//
//   3. HALF-COMMITTED UI. On failure the sheet must keep exactly the
//      selection the organizer made, so the retry is one tap; on success it
//      must be emptied before the undo toast fires, or the next long-press
//      opens onto a stale pick and swaps a player nobody chose. Which of
//      those two happens is decided by errorCode — three codes mean "the
//      world moved, close the sheet", everything else means "keep it open and
//      let them re-pick". Those branches are asserted one code at a time,
//      because a dropped `||` clause changes exactly one of them.
//
// Tests:
//   LS-1   open() arms the sheet with the long-pressed player, team and match
//   LS-2   (edge) open() clears a stale selection left by the previous sheet
//   LS-3   close() returns the machine to its initial state — nothing survives
//   LS-4   selectReplacement stores the pick and clears a stale error banner
//   LS-5   (negative) a queue pick CLEARS a fill chosen for an on-deck pick
//   LS-6   an on-deck pick PRESERVES the fill already chosen (control for LS-5)
//   LS-7   (edge) selectReplacement(null) deselects and re-locks Confirm
//   LS-8   Confirm is locked until a replacement is picked, then unlocks
//   LS-9   (negative) an on-deck pick keeps Confirm locked until a fill is picked
//   LS-10  (negative) a pick made while no sheet is open never unlocks Confirm
//   LS-11  same_match → swapTeamsInActiveMatch, exact positional tuple, and
//          neither other action is called
//   LS-12  queue → swapPlayerInActiveMatch, exact positional tuple, and
//          neither other action is called
//   LS-13  ondeck → swapActiveFromOnDeck, exact 9-slot positional tuple, and
//          neither other action is called
//   LS-14  (negative) confirm() with nothing picked never reaches an action
//   LS-15  (negative) confirm() with the on-deck fill still missing is a total
//          no-op — no action call AND no error text
//   LS-16  (negative) an in-flight swap cannot be started a second time
//   LS-17  (edge) an on-deck pick carrying no onDeckMatchId is refused locally
//          with the fill prompt, and no action runs
//   LS-18  success clears the sheet and hands the undo context to onSuccess
//   LS-19  (negative) a failure restores the pre-swap selection intact and
//          never calls onSuccess
//   LS-20  (edge) a failure with no errorCode stores null, not undefined
//   LS-21  (negative) MATCH_NOT_ACTIVE closes the sheet
//   LS-22  (negative) PLAYER_NOT_IN_MATCH closes the sheet
//   LS-23  (negative) ONDECK_MATCH_STARTED closes the sheet
//   LS-24  (edge) success:true with no undoContext is NOT treated as success
//   LS-25  isSubmitting is true for the whole flight and false once it settles
//   LS-26  a retry after a failure re-dispatches and can succeed (positive
//          control for LS-16 — the machine refuses a DOUBLE start, and that
//          is ALL it refuses; a sheet that latched shut would pass LS-16 too)
//   LS-27  undo() forwards the exact context and reports the server's success
//   LS-28  (negative) undo() reports false when the server refuses
//
// WHAT THIS FILE DOES NOT PROVE
//   - That the RPCs move the right rows, or that they are atomic. That is
//     tests/integration/live-match-swap.test.ts (Suite LMS).
//   - That the server actions refuse a match id belonging to another session,
//     or an unauthenticated / non-organizer caller. That is
//     tests/unit/live-swap-session-binding.test.ts (Suite LSB); every action
//     here is mocked, so this file cannot and does not test any guard.
//   - That the undo toast is rendered, or that it expires after 3 seconds.
//     The hook only hands the context to onSuccess; the timer lives in the
//     parent component and is E2E territory.
//   - Which candidates the sheet offers. The hook never builds the candidate
//     lists — it is handed one that the organizer already tapped.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// The hook imports four "use server" actions. Replacing the whole module keeps
// next/server, the service client and the push sender out of this suite — and
// makes the positional tuple of each call directly observable, which is the
// property LS-11 … LS-13 exist for.
const mockSwapPlayerInActiveMatch = vi.fn();
const mockSwapTeamsInActiveMatch = vi.fn();
const mockSwapActiveFromOnDeck = vi.fn();
const mockUndoLiveSwap = vi.fn();

vi.mock("@/app/actions/live-match-swap", () => ({
  swapPlayerInActiveMatch: (...args: unknown[]) => mockSwapPlayerInActiveMatch(...args),
  swapTeamsInActiveMatch: (...args: unknown[]) => mockSwapTeamsInActiveMatch(...args),
  swapActiveFromOnDeck: (...args: unknown[]) => mockSwapActiveFromOnDeck(...args),
  undoLiveSwap: (...args: unknown[]) => mockUndoLiveSwap(...args),
}));

import {
  useLiveMatchSwap,
  type ReplacementCandidate,
  type FillCandidate,
} from "@/hooks/use-live-match-swap";
import type { LiveSwapUndoContext } from "@/app/actions/live-match-swap";
import type { RosterPlayer } from "@/components/organizer/match-roster";
import type { EnrichedMatch } from "@/hooks/use-organizer-data";

// ── Fixtures ──────────────────────────────────────────────────
// Every id and every name below is distinct from every other one. That is the
// whole point: a transposed argument pair is only visible if no two slots can
// hold the same value by coincidence.

const SESSION_ID = "sess-live-swap";
const MATCH_ID = "match-active-court-1";
const ONDECK_MATCH_ID = "match-ondeck-court-3";

const OUTGOING: RosterPlayer = {
  player_id: "player-out-olive",
  display_name: "Olive Out",
  skill_level: "intermediate",
};

const QUEUE_PICK: ReplacementCandidate = {
  player_id: "player-queue-quinn",
  display_name: "Quinn Queue",
  skill_level: "advanced",
  source: "queue",
  waitMinutes: 22,
};

const TEAM_PICK: ReplacementCandidate = {
  player_id: "player-team-tara",
  display_name: "Tara Team",
  skill_level: "beginner",
  source: "same_match",
};

const ONDECK_PICK: ReplacementCandidate = {
  player_id: "player-ondeck-dana",
  display_name: "Dana Deck",
  skill_level: "lower_advanced",
  source: "ondeck",
  onDeckMatchId: ONDECK_MATCH_ID,
  onDeckLabel: "Court 3",
};

const FILL_PICK: FillCandidate = {
  player_id: "player-fill-fiona",
  display_name: "Fiona Fill",
  skill_level: "upper_intermediate",
};

// The hook reads exactly one field off the match — its id. Everything else on
// EnrichedMatch is court/profile scaffolding the state machine never touches.
const MATCH = { id: MATCH_ID } as unknown as EnrichedMatch;

const UNDO_CTX: LiveSwapUndoContext = {
  type: "queue_replacement",
  matchId: MATCH_ID,
  outPlayerId: OUTGOING.player_id,
  inPlayerId: QUEUE_PICK.player_id,
  team: "a",
  sessionId: SESSION_ID,
  outPlayerName: OUTGOING.display_name,
  inPlayerName: QUEUE_PICK.display_name,
};

const OK = { success: true, message: "Player swapped.", undoContext: UNDO_CTX };

// ── Harness ───────────────────────────────────────────────────

type Hook = ReturnType<typeof useLiveMatchSwap>;

function setup() {
  const onSuccess = vi.fn();
  const view = renderHook(() => useLiveMatchSwap({ sessionId: SESSION_ID, onSuccess }));
  return { result: view.result as { current: Hook }, onSuccess };
}

/** Opens the sheet on OUTGOING (team a) and picks `candidate`. */
function arm(result: { current: Hook }, candidate: ReplacementCandidate, fill?: FillCandidate) {
  act(() => {
    result.current.open(OUTGOING, "a", MATCH);
  });
  act(() => {
    result.current.selectReplacement(candidate);
  });
  if (fill) {
    act(() => {
      result.current.selectFill(fill);
    });
  }
}

// Every gate handed out by deferred() is registered here and force-settled in
// afterEach. React 19 entangles concurrent async transitions PROCESS-WIDE, so a
// gate left hanging by an assertion that threw mid-flight keeps isPending true
// inside later tests — in freshly mounted hooks that never touched it. Without
// this drain, one genuine failure in a gated test reports itself as five
// spurious failures further down the file, and the suite becomes
// order-dependent.
const openGates: Array<() => void> = [];

/** A promise the test resolves by hand, so a swap can be observed mid-flight. */
function deferred<T>(fallback: T) {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  openGates.push(() => settle(fallback));
  return { promise, settle };
}

function noActionCalled(): boolean {
  return (
    mockSwapPlayerInActiveMatch.mock.calls.length === 0 &&
    mockSwapTeamsInActiveMatch.mock.calls.length === 0 &&
    mockSwapActiveFromOnDeck.mock.calls.length === 0
  );
}

// ── Tests ─────────────────────────────────────────────────────

describe("useLiveMatchSwap — client state machine (LS)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSwapPlayerInActiveMatch.mockResolvedValue(OK);
    mockSwapTeamsInActiveMatch.mockResolvedValue(OK);
    mockSwapActiveFromOnDeck.mockResolvedValue(OK);
    mockUndoLiveSwap.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    const gates = openGates.splice(0);
    if (gates.length === 0) return;
    await act(async () => {
      gates.forEach((settle) => settle());
      await Promise.resolve();
    });
  });

  // ── Phase 1: open / close / selection ───────────────────────

  // ── LS-1 ───────────────────────────────────────────────────
  it("LS-1: open() arms the sheet with the long-pressed player, team and match", () => {
    const { result } = setup();

    expect(
      result.current.isOpen,
      "the sheet must start closed — an unprompted swap sheet over a live court is how the wrong player gets pulled"
    ).toBe(false);

    act(() => {
      result.current.open(OUTGOING, "b", MATCH);
    });

    expect(result.current.isOpen, "the long-press did not open the sheet").toBe(true);
    expect(
      result.current.state.outgoingPlayer,
      "the sheet is not pointed at the player who was long-pressed — every id sent to the server is read off this field"
    ).toEqual(OUTGOING);
    expect(
      result.current.state.outgoingTeam,
      "the outgoing team was not recorded; confirm() bails out when it is null, so the Confirm button would do nothing"
    ).toBe("b");
    expect(
      result.current.state.match,
      "the sheet is not bound to the match that was long-pressed — the swap would be applied to whatever match was open last"
    ).toEqual(MATCH);
  });

  // ── LS-2 ───────────────────────────────────────────────────
  it("LS-2: (edge) open() clears a stale selection left by the previous sheet", () => {
    const { result } = setup();

    arm(result, ONDECK_PICK, FILL_PICK);
    act(() => {
      result.current.selectFill(FILL_PICK);
    });

    // Second long-press, different player, without closing first.
    const other: RosterPlayer = {
      player_id: "player-second-sam",
      display_name: "Sam Second",
      skill_level: "beginner",
    };
    act(() => {
      result.current.open(other, "b", MATCH);
    });

    expect(
      result.current.state.selectedReplacement,
      "the previous sheet's replacement survived a re-open — Confirm would be live on a pick made for a DIFFERENT outgoing player"
    ).toBeNull();
    expect(
      result.current.state.selectedFill,
      "the previous sheet's on-deck fill survived a re-open — a queue player would be moved for a swap nobody asked for"
    ).toBeNull();
    expect(
      result.current.canConfirm,
      "Confirm was already unlocked the instant the sheet re-opened, before the organizer picked anything"
    ).toBe(false);
    expect(result.current.state.outgoingPlayer, "the re-open did not retarget the sheet").toEqual(
      other
    );
  });

  // ── LS-3 ───────────────────────────────────────────────────
  it("LS-3: close() returns the machine to its initial state — nothing survives", () => {
    const { result } = setup();

    arm(result, ONDECK_PICK, FILL_PICK);
    expect(result.current.canConfirm, "setup failed: the sheet was never armed").toBe(true);

    act(() => {
      result.current.close();
    });

    expect(result.current.isOpen, "the sheet did not close").toBe(false);
    expect(
      result.current.state,
      "dismissing the sheet left state behind — the next long-press inherits a pick the organizer already abandoned"
    ).toEqual({
      isOpen: false,
      outgoingPlayer: null,
      outgoingTeam: null,
      match: null,
      selectedReplacement: null,
      selectedFill: null,
      isSubmitting: false,
      error: null,
      errorCode: null,
    });
  });

  // ── LS-4 ───────────────────────────────────────────────────
  it("LS-4: selectReplacement stores the pick and clears a stale error banner", async () => {
    mockSwapPlayerInActiveMatch.mockResolvedValue({
      success: false,
      message: "That player was just taken.",
      errorCode: "PLAYER_UNAVAILABLE",
    });
    const { result } = setup();
    arm(result, QUEUE_PICK);

    await act(async () => {
      result.current.confirm();
    });
    expect(result.current.state.error, "setup failed: no error banner to clear").toBe(
      "That player was just taken."
    );

    act(() => {
      result.current.selectReplacement(TEAM_PICK);
    });

    expect(
      result.current.state.selectedReplacement,
      "the new pick was not stored — the sheet would confirm the player the organizer just replaced"
    ).toEqual(TEAM_PICK);
    expect(
      result.current.state.error,
      "the previous failure's banner is still showing under a fresh pick, which reads as 'this one is unavailable too'"
    ).toBeNull();
    expect(
      result.current.state.errorCode,
      "the stale errorCode outlived the pick that produced it"
    ).toBeNull();
  });

  // ── LS-5 ───────────────────────────────────────────────────
  it("LS-5: (negative) a queue pick CLEARS a fill chosen for an on-deck pick", () => {
    const { result } = setup();

    arm(result, ONDECK_PICK, FILL_PICK);
    expect(result.current.state.selectedFill, "setup failed: no fill was selected").toEqual(
      FILL_PICK
    );

    // Organizer changes their mind and takes someone from the queue instead.
    act(() => {
      result.current.selectReplacement(QUEUE_PICK);
    });

    expect(
      result.current.state.selectedFill,
      "the on-deck fill survived a switch to a queue replacement — a queue player would be marked as filling an on-deck slot that was never vacated"
    ).toBeNull();
  });

  // ── LS-6 ───────────────────────────────────────────────────
  it("LS-6: an on-deck pick PRESERVES the fill already chosen (control for LS-5)", () => {
    const { result } = setup();

    arm(result, ONDECK_PICK, FILL_PICK);

    // A different on-deck player — the vacated slot still needs the same fill.
    const otherDeck: ReplacementCandidate = {
      ...ONDECK_PICK,
      player_id: "player-ondeck-dev",
      display_name: "Dev Deck",
    };
    act(() => {
      result.current.selectReplacement(otherDeck);
    });

    expect(
      result.current.state.selectedFill,
      "switching between two on-deck candidates wiped the fill, so Confirm re-locks and the organizer has to pick the same filler twice"
    ).toEqual(FILL_PICK);
    expect(
      result.current.canConfirm,
      "Confirm re-locked even though both a replacement and a fill are selected"
    ).toBe(true);
  });

  // ── LS-7 ───────────────────────────────────────────────────
  it("LS-7: (edge) selectReplacement(null) deselects and re-locks Confirm", () => {
    const { result } = setup();

    arm(result, QUEUE_PICK);
    expect(result.current.canConfirm, "setup failed: Confirm never unlocked").toBe(true);

    act(() => {
      result.current.selectReplacement(null);
    });

    expect(
      result.current.state.selectedReplacement,
      "tapping the selected candidate again did not deselect it"
    ).toBeNull();
    expect(
      result.current.canConfirm,
      "Confirm stayed live with nothing selected — the button would fire a swap with no incoming player"
    ).toBe(false);
  });

  // ── Phase 2: Confirm readiness ──────────────────────────────

  // ── LS-8 ───────────────────────────────────────────────────
  it("LS-8: Confirm is locked until a replacement is picked, then unlocks", () => {
    const { result } = setup();

    act(() => {
      result.current.open(OUTGOING, "a", MATCH);
    });
    expect(
      result.current.canConfirm,
      "Confirm was live on a freshly opened sheet with no replacement picked"
    ).toBe(false);

    act(() => {
      result.current.selectReplacement(QUEUE_PICK);
    });
    expect(
      result.current.canConfirm,
      "Confirm stayed locked after a valid queue pick — the organizer cannot complete the swap at all"
    ).toBe(true);
  });

  // ── LS-9 ───────────────────────────────────────────────────
  it("LS-9: (negative) an on-deck pick keeps Confirm locked until a fill is picked", () => {
    const { result } = setup();

    arm(result, ONDECK_PICK);

    expect(
      result.current.canConfirm,
      "Confirm unlocked on an on-deck pick with no fill chosen — confirming would strip a player off the on-deck match and leave that slot empty"
    ).toBe(false);

    act(() => {
      result.current.selectFill(FILL_PICK);
    });

    expect(
      result.current.canConfirm,
      "Confirm never unlocked even with both the on-deck pick and its fill chosen — the 3-way swap is unreachable"
    ).toBe(true);
  });

  // ── LS-10 ──────────────────────────────────────────────────
  it("LS-10: (negative) a pick made while no sheet is open never unlocks Confirm", () => {
    const { result } = setup();

    // No open() — there is no outgoing player and no match to swap within.
    act(() => {
      result.current.selectReplacement(QUEUE_PICK);
    });

    expect(
      result.current.canConfirm,
      "Confirm unlocked with no match and no outgoing player — confirm() would read match.id off null"
    ).toBe(false);

    // Positive control: the same pick unlocks once the sheet is properly armed.
    arm(result, QUEUE_PICK);
    expect(result.current.canConfirm, "the same pick did not unlock Confirm on an open sheet").toBe(
      true
    );
  });

  // ── Phase 3: dispatch — which action, which argument positions ──

  // ── LS-11 ──────────────────────────────────────────────────
  it("LS-11: same_match → swapTeamsInActiveMatch with the exact positional tuple", async () => {
    const { result } = setup();
    arm(result, TEAM_PICK);

    await act(async () => {
      result.current.confirm();
    });

    expect(
      mockSwapTeamsInActiveMatch,
      "a same-match pick did not reach swapTeamsInActiveMatch"
    ).toHaveBeenCalledTimes(1);
    expect(
      mockSwapTeamsInActiveMatch,
      "the team-swap arguments are out of position: this action takes (matchId, sessionId, playerA, playerB, nameA, nameB) — transposing matchId with sessionId, or either id with its name, still type-checks and still returns success while swapping the wrong pair"
    ).toHaveBeenCalledWith(
      MATCH_ID,
      SESSION_ID,
      OUTGOING.player_id,
      TEAM_PICK.player_id,
      OUTGOING.display_name,
      TEAM_PICK.display_name
    );
    expect(
      mockSwapPlayerInActiveMatch,
      "a same-match pick also invoked the queue-replacement action — the queue player would be consumed as well"
    ).not.toHaveBeenCalled();
    expect(
      mockSwapActiveFromOnDeck,
      "a same-match pick also invoked the 3-way on-deck action"
    ).not.toHaveBeenCalled();
  });

  // ── LS-12 ──────────────────────────────────────────────────
  it("LS-12: queue → swapPlayerInActiveMatch with the exact positional tuple", async () => {
    const { result } = setup();
    arm(result, QUEUE_PICK);

    await act(async () => {
      result.current.confirm();
    });

    expect(
      mockSwapPlayerInActiveMatch,
      "a queue pick did not reach swapPlayerInActiveMatch"
    ).toHaveBeenCalledTimes(1);
    expect(
      mockSwapPlayerInActiveMatch,
      "the queue-swap arguments are out of position: this action takes (matchId, outPlayerId, inPlayerId, sessionId, outName, inName) — note that sessionId sits FOURTH here and SECOND in swapTeamsInActiveMatch. Transposing out with in pulls the queue player off the court and puts the player who was playing back in the queue"
    ).toHaveBeenCalledWith(
      MATCH_ID,
      OUTGOING.player_id,
      QUEUE_PICK.player_id,
      SESSION_ID,
      OUTGOING.display_name,
      QUEUE_PICK.display_name
    );
    expect(
      mockSwapTeamsInActiveMatch,
      "a queue pick also invoked the team-swap action"
    ).not.toHaveBeenCalled();
    expect(
      mockSwapActiveFromOnDeck,
      "a queue pick also invoked the 3-way on-deck action"
    ).not.toHaveBeenCalled();
  });

  // ── LS-13 ──────────────────────────────────────────────────
  it("LS-13: ondeck → swapActiveFromOnDeck with the exact 9-slot positional tuple", async () => {
    const { result } = setup();
    arm(result, ONDECK_PICK, FILL_PICK);

    await act(async () => {
      result.current.confirm();
    });

    expect(
      mockSwapActiveFromOnDeck,
      "an on-deck pick did not reach swapActiveFromOnDeck"
    ).toHaveBeenCalledTimes(1);
    expect(
      mockSwapActiveFromOnDeck,
      "the 3-way arguments are out of position: (activeMatchId, outPlayerId, onDeckPlayerId, onDeckMatchId, fillPlayerId, sessionId, outName, onDeckName, fillName). Two match ids and three player ids sit adjacent here — transpose the active and on-deck match ids and the swap is applied to the wrong court; transpose the on-deck player with the filler and the queue player is put on court while the on-deck player is sent to fill their own slot"
    ).toHaveBeenCalledWith(
      MATCH_ID,
      OUTGOING.player_id,
      ONDECK_PICK.player_id,
      ONDECK_MATCH_ID,
      FILL_PICK.player_id,
      SESSION_ID,
      OUTGOING.display_name,
      ONDECK_PICK.display_name,
      FILL_PICK.display_name
    );
    expect(
      mockSwapPlayerInActiveMatch,
      "an on-deck pick also invoked the queue-replacement action"
    ).not.toHaveBeenCalled();
    expect(
      mockSwapTeamsInActiveMatch,
      "an on-deck pick also invoked the team-swap action"
    ).not.toHaveBeenCalled();
  });

  // ── LS-14 ──────────────────────────────────────────────────
  it("LS-14: (negative) confirm() with nothing picked never reaches an action", async () => {
    const { result } = setup();

    act(() => {
      result.current.open(OUTGOING, "a", MATCH);
    });
    await act(async () => {
      result.current.confirm();
    });

    expect(
      noActionCalled(),
      "confirm() fired a swap with no replacement selected — the action would receive undefined as the incoming player id"
    ).toBe(true);
    expect(
      result.current.state.isSubmitting,
      "the sheet went into its submitting state without a request having been sent, so the Confirm button is disabled forever"
    ).toBe(false);
    expect(result.current.isOpen, "an unarmed confirm() closed the sheet").toBe(true);
  });

  // ── LS-15 ──────────────────────────────────────────────────
  it("LS-15: (negative) confirm() with the on-deck fill still missing is a total no-op", async () => {
    const { result } = setup();
    arm(result, ONDECK_PICK); // no fill

    await act(async () => {
      result.current.confirm();
    });

    expect(
      noActionCalled(),
      "an on-deck swap was sent with no filler chosen — the on-deck match would be left a player short"
    ).toBe(true);
    // The distinction from LS-17: this attempt is stopped by canConfirm BEFORE
    // the transition starts, so the organizer sees no error at all. If the
    // readiness gate is removed, the request gets as far as the in-transition
    // guard and the fill prompt appears instead — same refusal, different and
    // wrong UX, and one that flickers isSubmitting on the way through.
    expect(
      result.current.state.error,
      "a locked Confirm produced an error banner, which means the attempt was actually started and then aborted mid-flight rather than never begun"
    ).toBeNull();
    expect(
      result.current.state.selectedReplacement,
      "the refused confirm dropped the on-deck pick"
    ).toEqual(ONDECK_PICK);
  });

  // ── LS-16 ──────────────────────────────────────────────────
  it("LS-16: (negative) an in-flight swap cannot be started a second time", async () => {
    const gate = deferred(OK);
    mockSwapPlayerInActiveMatch.mockReturnValue(gate.promise);

    const { result } = setup();
    arm(result, QUEUE_PICK);

    await act(async () => {
      result.current.confirm();
    });

    expect(
      result.current.isSubmitting,
      "setup failed: the first confirm did not leave the machine in flight"
    ).toBe(true);
    expect(mockSwapPlayerInActiveMatch, "the first confirm never dispatched").toHaveBeenCalledTimes(
      1
    );

    // Second tap on a Confirm button that is still mounted.
    await act(async () => {
      result.current.confirm();
    });

    expect(
      mockSwapPlayerInActiveMatch,
      "a second confirm dispatched while the first was still in flight — the second swap applies to the roster the first one produced, so the player who was just brought on is swapped straight back out"
    ).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.settle(OK);
      await gate.promise;
    });
    // Settle and then drain. If the guard above is ever broken there are TWO
    // transitions in flight here, and an undrained second one lands its state
    // update inside the NEXT test's render — which would report this file's
    // regression as a failure somewhere else entirely.
    await act(async () => {
      await Promise.resolve();
    });
  });

  // ── LS-17 ──────────────────────────────────────────────────
  it("LS-17: (edge) an on-deck pick with no onDeckMatchId is refused locally", async () => {
    const { result } = setup();
    // A malformed candidate: readiness passes (source ondeck + a fill), but the
    // id of the match to pull from is missing.
    const noMatchId: ReplacementCandidate = { ...ONDECK_PICK, onDeckMatchId: undefined };
    arm(result, noMatchId, FILL_PICK);
    expect(result.current.canConfirm, "setup failed: readiness should pass here").toBe(true);

    await act(async () => {
      result.current.confirm();
    });

    expect(
      mockSwapActiveFromOnDeck,
      "a 3-way swap was dispatched with no on-deck match id — the action would be handed undefined where a match id belongs"
    ).not.toHaveBeenCalled();
    expect(
      result.current.state.error,
      "the local refusal left no message, so the organizer taps a Confirm button that silently does nothing"
    ).toBe("Please select a player to fill the on-deck slot.");
    expect(
      result.current.state.isSubmitting,
      "the sheet is stuck in its submitting state after a request that was never sent"
    ).toBe(false);
    expect(result.current.isOpen, "the local refusal closed the sheet").toBe(true);
  });

  // ── Phase 4: outcomes ───────────────────────────────────────

  // ── LS-18 ──────────────────────────────────────────────────
  it("LS-18: success clears the sheet and hands the undo context to onSuccess", async () => {
    const { result, onSuccess } = setup();
    arm(result, QUEUE_PICK);

    await act(async () => {
      result.current.confirm();
    });

    expect(result.current.isOpen, "the sheet stayed open after a successful swap").toBe(false);
    expect(
      result.current.state.selectedReplacement,
      "the completed swap's selection survived — the next long-press opens onto a pick that has already been applied"
    ).toBeNull();
    expect(
      result.current.state.selectedFill,
      "the completed swap's fill selection survived into the next sheet"
    ).toBeNull();
    expect(
      result.current.isSubmitting,
      "the machine never left its submitting state, so the next swap can never be started"
    ).toBe(false);
    expect(
      onSuccess,
      "the undo context never reached the parent — the 3-second undo toast has nothing to reverse"
    ).toHaveBeenCalledTimes(1);
    expect(
      onSuccess,
      "the parent was handed something other than the server's undo context; undo would reverse the wrong swap or nothing at all"
    ).toHaveBeenCalledWith(UNDO_CTX);
  });

  // ── LS-19 ──────────────────────────────────────────────────
  it("LS-19: (negative) a failure restores the pre-swap selection and never calls onSuccess", async () => {
    mockSwapPlayerInActiveMatch.mockResolvedValue({
      success: false,
      message: "That player was just taken.",
      errorCode: "PLAYER_UNAVAILABLE",
    });
    const { result, onSuccess } = setup();
    arm(result, QUEUE_PICK);

    await act(async () => {
      result.current.confirm();
    });

    expect(
      result.current.isOpen,
      "a recoverable failure closed the sheet — the organizer loses the whole selection and has to long-press again"
    ).toBe(true);
    expect(
      result.current.state.selectedReplacement,
      "the failure wiped the pre-swap selection, leaving the sheet half-committed: open, but pointing at nothing"
    ).toEqual(QUEUE_PICK);
    expect(
      result.current.state.outgoingPlayer,
      "the failure dropped the outgoing player the sheet was opened for"
    ).toEqual(OUTGOING);
    expect(
      result.current.state.error,
      "the server's reason was not shown; the organizer sees a Confirm that did nothing"
    ).toBe("That player was just taken.");
    expect(result.current.state.errorCode, "the machine-readable code was dropped").toBe(
      "PLAYER_UNAVAILABLE"
    );
    expect(
      result.current.isSubmitting,
      "the sheet is still submitting after the swap failed — Confirm never re-enables and the retry is impossible"
    ).toBe(false);
    expect(
      onSuccess,
      "a failed swap fired the undo callback — the organizer is offered an undo for a swap that never happened"
    ).not.toHaveBeenCalled();
  });

  // ── LS-20 ──────────────────────────────────────────────────
  it("LS-20: (edge) a failure with no errorCode stores null, not undefined", async () => {
    mockSwapPlayerInActiveMatch.mockResolvedValue({
      success: false,
      message: "Swap failed: connection reset.",
    });
    const { result } = setup();
    arm(result, QUEUE_PICK);

    await act(async () => {
      result.current.confirm();
    });

    expect(
      result.current.state.errorCode,
      "an uncoded failure left errorCode undefined instead of null, so any consumer comparing it to null reads a coded error where none exists"
    ).toBeNull();
    expect(result.current.state.error, "an uncoded failure lost its message entirely").toBe(
      "Swap failed: connection reset."
    );
    expect(
      result.current.isOpen,
      "an uncoded failure closed the sheet — only the three world-moved codes may do that"
    ).toBe(true);
  });

  // ── LS-21 ──────────────────────────────────────────────────
  it("LS-21: (negative) MATCH_NOT_ACTIVE closes the sheet", async () => {
    mockSwapPlayerInActiveMatch.mockResolvedValue({
      success: false,
      message: "Match is no longer active.",
      errorCode: "MATCH_NOT_ACTIVE",
    });
    const { result, onSuccess } = setup();
    arm(result, QUEUE_PICK);

    await act(async () => {
      result.current.confirm();
    });

    expect(
      result.current.isOpen,
      "the match finished mid-confirm and the sheet stayed open over it — every retry from here targets a match that no longer exists"
    ).toBe(false);
    expect(
      result.current.state.selectedReplacement,
      "the closed sheet kept its selection"
    ).toBeNull();
    expect(onSuccess, "a refused swap fired the undo callback").not.toHaveBeenCalled();
  });

  // ── LS-22 ──────────────────────────────────────────────────
  it("LS-22: (negative) PLAYER_NOT_IN_MATCH closes the sheet", async () => {
    mockSwapPlayerInActiveMatch.mockResolvedValue({
      success: false,
      message: "Player already moved.",
      errorCode: "PLAYER_NOT_IN_MATCH",
    });
    const { result } = setup();
    arm(result, QUEUE_PICK);

    await act(async () => {
      result.current.confirm();
    });

    expect(
      result.current.isOpen,
      "the outgoing player had already been moved off the court and the sheet stayed open on them — every retry swaps a player who is not there"
    ).toBe(false);
    expect(
      result.current.state.outgoingPlayer,
      "the closed sheet kept its outgoing player"
    ).toBeNull();
  });

  // ── LS-23 ──────────────────────────────────────────────────
  it("LS-23: (negative) ONDECK_MATCH_STARTED closes the sheet", async () => {
    mockSwapActiveFromOnDeck.mockResolvedValue({
      success: false,
      message: "That on-deck match already started.",
      errorCode: "ONDECK_MATCH_STARTED",
    });
    const { result } = setup();
    arm(result, ONDECK_PICK, FILL_PICK);

    await act(async () => {
      result.current.confirm();
    });

    expect(
      result.current.isOpen,
      "the on-deck match was promoted mid-confirm and the sheet stayed open offering its players — they are on court now"
    ).toBe(false);
    expect(
      result.current.state.selectedFill,
      "the closed sheet kept its fill selection"
    ).toBeNull();
  });

  // ── LS-24 ──────────────────────────────────────────────────
  it("LS-24: (edge) success:true with no undoContext is NOT treated as success", async () => {
    // The contract says a successful swap always returns an undo context. If it
    // ever does not, the hook must not clear the sheet — clearing it would
    // strand the organizer with no undo and no evidence anything happened.
    mockSwapPlayerInActiveMatch.mockResolvedValue({ success: true, message: "Player swapped." });
    const { result, onSuccess } = setup();
    arm(result, QUEUE_PICK);

    await act(async () => {
      result.current.confirm();
    });

    expect(
      onSuccess,
      "onSuccess was invoked without an undo context — the parent renders an undo toast whose action has nothing to send"
    ).not.toHaveBeenCalled();
    expect(
      result.current.isOpen,
      "the sheet was cleared on a payload that carried no undo context, so the organizer is left with no way to reverse a swap that may have happened"
    ).toBe(true);
    expect(
      result.current.isSubmitting,
      "the machine stayed in flight after the payload came back"
    ).toBe(false);
  });

  // ── LS-25 ──────────────────────────────────────────────────
  it("LS-25: isSubmitting is true for the whole flight and false once it settles", async () => {
    const gate = deferred(OK);
    mockSwapTeamsInActiveMatch.mockReturnValue(gate.promise);

    const { result } = setup();
    arm(result, TEAM_PICK);

    expect(result.current.isSubmitting, "the machine reported in-flight before any confirm").toBe(
      false
    );

    await act(async () => {
      result.current.confirm();
    });

    expect(
      result.current.isSubmitting,
      "the in-flight flag never went true, so the Confirm button stays enabled over a live request and the organizer taps it again"
    ).toBe(true);
    // NOTE — the flag above is carried ENTIRELY by the transition's isPending.
    // The `setState({ isSubmitting: true })` at the top of the transition is
    // never separately observable: React 19 holds every update made inside an
    // async action until the action settles, so state.isSubmitting goes true
    // and false in the same commit. Deleting `isPending ||` from the exposed
    // flag therefore leaves the sheet with NO in-flight signal at all.

    await act(async () => {
      gate.settle(OK);
      await gate.promise;
    });

    expect(
      result.current.isSubmitting,
      "the in-flight flag never cleared after the swap settled"
    ).toBe(false);
  });

  // ── LS-26 ──────────────────────────────────────────────────
  it("LS-26: a retry after a failure re-dispatches and can succeed", async () => {
    mockSwapPlayerInActiveMatch.mockResolvedValueOnce({
      success: false,
      message: "That player was just taken.",
      errorCode: "PLAYER_UNAVAILABLE",
    });
    mockSwapPlayerInActiveMatch.mockResolvedValueOnce(OK);

    const { result, onSuccess } = setup();
    arm(result, QUEUE_PICK);

    await act(async () => {
      result.current.confirm();
    });
    expect(result.current.state.error, "setup failed: the first attempt did not fail").toBe(
      "That player was just taken."
    );

    // Retry, same selection, second tap. LS-16 refuses a second CONCURRENT
    // swap; this is the control proving that is all it refuses — a machine
    // that simply latched shut after one call would satisfy LS-16 too.
    await act(async () => {
      result.current.confirm();
    });

    expect(
      mockSwapPlayerInActiveMatch,
      "the retry never dispatched — after one recoverable failure the sheet is wedged and the only way out is to dismiss it and long-press again"
    ).toHaveBeenCalledTimes(2);
    expect(
      mockSwapPlayerInActiveMatch,
      "the retry did not re-send the same swap the organizer is still looking at"
    ).toHaveBeenLastCalledWith(
      MATCH_ID,
      OUTGOING.player_id,
      QUEUE_PICK.player_id,
      SESSION_ID,
      OUTGOING.display_name,
      QUEUE_PICK.display_name
    );
    expect(result.current.isOpen, "the successful retry did not clear the sheet").toBe(false);
    expect(
      result.current.state.error,
      "the first attempt's banner outlived the retry that succeeded"
    ).toBeNull();
    expect(onSuccess, "the successful retry did not offer an undo").toHaveBeenCalledWith(UNDO_CTX);
  });

  // ── Phase 5: undo ───────────────────────────────────────────

  // ── LS-27 ──────────────────────────────────────────────────
  it("LS-27: undo() forwards the exact context and reports the server's success", async () => {
    const { result } = setup();

    let reversed: boolean | undefined;
    await act(async () => {
      reversed = await result.current.undo(UNDO_CTX);
    });

    expect(mockUndoLiveSwap, "undo() never reached the server action").toHaveBeenCalledTimes(1);
    expect(
      mockUndoLiveSwap,
      "undo() sent something other than the context the swap returned — the reversal would target the wrong match or the wrong players"
    ).toHaveBeenCalledWith(UNDO_CTX);
    expect(
      reversed,
      "a successful reversal was reported as a failure, so the toast tells the organizer the undo did not work while the roster has already been put back"
    ).toBe(true);
  });

  // ── LS-28 ──────────────────────────────────────────────────
  it("LS-28: (negative) undo() reports false when the server refuses", async () => {
    mockUndoLiveSwap.mockResolvedValue({ success: false });
    const { result } = setup();

    let reversed: boolean | undefined;
    await act(async () => {
      reversed = await result.current.undo(UNDO_CTX);
    });

    expect(
      reversed,
      "a refused reversal was reported as success — the organizer is told the swap was undone while both players are still where the swap put them"
    ).toBe(false);
  });
});
