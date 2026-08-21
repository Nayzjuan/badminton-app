// @vitest-environment happy-dom
// ============================================================
// Unit Tests — useFixRecord Hook (State Machine)
// ============================================================
//
// Pins every transition in the 4-step roster-correction flow:
//
//   selecting_out → selecting_in → confirming → submitting
//                                             ↑
//                             cancelConfirm ──┘
//              goBack ────────────────────────────────────────┘
//
// Design decisions under test:
//   • selectOut clears any previously-selected inPlayer and error
//   • selectIn does NOT overwrite outPlayer
//   • goBack resets BOTH outPlayer AND inPlayer (full restart of step 1)
//   • cancelConfirm only clears inPlayer (stays in selecting_in)
//   • confirm is a no-op when outPlayer OR inPlayer is null
//   • confirm transitions synchronously to "submitting" before the
//     server responds — the confirmation strip stays mounted
//   • On error the hook stays in "confirming" (not "selecting_out")
//     so the organiser can read the error before retrying
//   • isTeamFlip is derived from match.players, not from the RPC —
//     this drives the UI warning badge shown before confirm
//
// Test IDs: FR = Fix Record (hook)
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFixRecord } from "@/hooks/use-fix-record";
import type { SelectedPlayer } from "@/hooks/use-fix-record";
import type { CompletedMatch } from "@/hooks/use-match-history";

// ── Mock fixPlayerRecord ───────────────────────────────────────
// Hoisted above imports so vi.mock() runs before the module resolves.

vi.mock("@/app/actions/fix-player-record", () => ({
  fixPlayerRecord: vi.fn(),
}));

import { fixPlayerRecord } from "@/app/actions/fix-player-record";
const mockFixPlayerRecord = vi.mocked(fixPlayerRecord);

// ── Fixtures ──────────────────────────────────────────────────

const MATCH_ID = "match-aaaaaaaa";
const SESSION_ID = "sess-bbbbbbbb";

/** Build a minimal SelectedPlayer. */
function makePlayer(id: string, team: "a" | "b", name = `Player-${id}`): SelectedPlayer {
  return { player_id: id, display_name: name, skill_level: "intermediate", team };
}

/** Build a minimal CompletedMatch with 4 named players (2 per team). */
function makeMatch(playerIds = ["p1", "p2", "p3", "p4"]): CompletedMatch {
  const players = playerIds.map((id, i) => ({
    id: `mp-${id}`,
    match_id: MATCH_ID,
    player_id: id,
    team: (i < 2 ? "a" : "b") as "a" | "b",
    profile: {
      id,
      display_name: `Player-${id}`,
      skill_level: "intermediate" as const,
      pin: null,
      vip_tag: null,
      vip_theme: null,
      needs_rename: false,
      collided_name: null,
      flagged_at: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  }));
  return {
    id: MATCH_ID,
    session_id: SESSION_ID,
    court_id: null,
    status: "completed",
    team_a_score: 21,
    team_b_score: 15,
    is_mixed_level: false,
    sort_order: null,
    created_method: "auto",
    modification_count: 0,
    final_classification: "auto_clean",
    provenance_backfilled: false,
    is_published: true,
    created_at: "2026-01-01T00:00:00Z",
    started_at: "2026-01-01T00:05:00Z",
    completed_at: "2026-01-01T00:25:00Z",
    pulled_player_ids: [],
    pulled_from_match_id: null,
    held_ready_at: null,
    is_held: false,
    players,
    courtName: null,
  };
}

const DEFAULT_MATCH = makeMatch();
const PLAYER_A1 = makePlayer("p1", "a");
const PLAYER_A2 = makePlayer("p2", "a");
const PLAYER_B1 = makePlayer("p3", "b");

/** Helper that renders the hook with default props and a spy onSuccess. */
function setup(match = DEFAULT_MATCH) {
  const onSuccess = vi.fn();
  const { result } = renderHook(() => useFixRecord({ match, sessionId: SESSION_ID, onSuccess }));
  return { result, onSuccess };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────
// FR-1  Initial state
// ─────────────────────────────────────────────────────────────

describe("useFixRecord — initial state", () => {
  it("FR-1: starts in selecting_out with no players selected and no error", () => {
    const { result } = setup();
    expect(result.current.step).toBe("selecting_out");
    expect(result.current.outPlayer).toBeNull();
    expect(result.current.inPlayer).toBeNull();
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.isPending).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// FR-2 … FR-4  selectOut()
// ─────────────────────────────────────────────────────────────

describe("useFixRecord — selectOut()", () => {
  it("FR-2: transitions to selecting_in and sets outPlayer", () => {
    const { result } = setup();
    act(() => result.current.selectOut(PLAYER_A1));
    expect(result.current.step).toBe("selecting_in");
    expect(result.current.outPlayer).toEqual(PLAYER_A1);
  });

  it("FR-3: clears any previously-selected inPlayer and errorMessage", () => {
    const { result } = setup();
    // Get to confirming state
    act(() => result.current.selectOut(PLAYER_A1));
    act(() => result.current.selectIn(PLAYER_B1));
    expect(result.current.inPlayer).toEqual(PLAYER_B1);

    // Select a different outgoing player — inPlayer must be wiped
    act(() => result.current.selectOut(PLAYER_A2));
    expect(result.current.inPlayer).toBeNull();
    expect(result.current.errorMessage).toBeNull();
  });

  it("FR-4: selecting a different out player replaces the previous selection", () => {
    const { result } = setup();
    act(() => result.current.selectOut(PLAYER_A1));
    act(() => result.current.selectOut(PLAYER_A2));
    expect(result.current.outPlayer).toEqual(PLAYER_A2);
  });
});

// ─────────────────────────────────────────────────────────────
// FR-5 … FR-6  selectIn()
// ─────────────────────────────────────────────────────────────

describe("useFixRecord — selectIn()", () => {
  it("FR-5: transitions to confirming and sets inPlayer", () => {
    const { result } = setup();
    act(() => result.current.selectOut(PLAYER_A1));
    act(() => result.current.selectIn(PLAYER_B1));
    expect(result.current.step).toBe("confirming");
    expect(result.current.inPlayer).toEqual(PLAYER_B1);
  });

  it("FR-6: does NOT overwrite outPlayer when selecting an in player", () => {
    const { result } = setup();
    act(() => result.current.selectOut(PLAYER_A1));
    act(() => result.current.selectIn(PLAYER_B1));
    // outPlayer must be unchanged
    expect(result.current.outPlayer).toEqual(PLAYER_A1);
  });
});

// ─────────────────────────────────────────────────────────────
// FR-7 … FR-8  cancelConfirm()
// ─────────────────────────────────────────────────────────────

describe("useFixRecord — cancelConfirm()", () => {
  it("FR-7: returns to selecting_in and clears inPlayer — does NOT clear outPlayer", () => {
    const { result } = setup();
    act(() => result.current.selectOut(PLAYER_A1));
    act(() => result.current.selectIn(PLAYER_B1));
    expect(result.current.step).toBe("confirming");

    act(() => result.current.cancelConfirm());
    expect(result.current.step).toBe("selecting_in");
    expect(result.current.inPlayer).toBeNull();
    // outPlayer preserved so the user doesn't have to re-select step 1
    expect(result.current.outPlayer).toEqual(PLAYER_A1);
  });

  it("FR-8: clears errorMessage when cancelling the confirmation strip", async () => {
    mockFixPlayerRecord.mockResolvedValueOnce({ success: false, message: "Something went wrong." });
    const { result } = setup();
    act(() => result.current.selectOut(PLAYER_A1));
    act(() => result.current.selectIn(PLAYER_B1));

    // Trigger a failed confirm and wait for the async transition to surface the error.
    // (waitFor ensures the state update lands inside an act boundary.)
    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.errorMessage).not.toBeNull());
    expect(result.current.step).toBe("confirming");

    // Now cancel — error must be wiped
    act(() => result.current.cancelConfirm());
    expect(result.current.errorMessage).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// FR-9 … FR-10  goBack()
// ─────────────────────────────────────────────────────────────

describe("useFixRecord — goBack()", () => {
  it("FR-9: returns to selecting_out and clears BOTH outPlayer and inPlayer", () => {
    const { result } = setup();
    act(() => result.current.selectOut(PLAYER_A1));
    act(() => result.current.selectIn(PLAYER_B1));

    act(() => result.current.goBack());
    expect(result.current.step).toBe("selecting_out");
    expect(result.current.outPlayer).toBeNull();
    expect(result.current.inPlayer).toBeNull();
  });

  it("FR-10: also clears errorMessage when going back", () => {
    const { result } = setup();
    act(() => result.current.selectOut(PLAYER_A1));
    act(() => result.current.selectIn(PLAYER_B1));

    act(() => result.current.goBack());
    expect(result.current.errorMessage).toBeNull();
  });

  it("FR-10b: goBack from selecting_in (before confirming) still returns to selecting_out", () => {
    const { result } = setup();
    act(() => result.current.selectOut(PLAYER_A1));
    // Still on step 2 picker, haven't tapped a replacement yet
    expect(result.current.step).toBe("selecting_in");

    act(() => result.current.goBack());
    expect(result.current.step).toBe("selecting_out");
    expect(result.current.outPlayer).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// FR-11 … FR-13  confirm() — success path
// ─────────────────────────────────────────────────────────────

describe("useFixRecord — confirm() success path", () => {
  it("FR-11: transitions synchronously to submitting before the server responds", () => {
    // A never-resolving promise lets us observe the "submitting" step in isolation.
    // No async state update ever fires, so there is no act() boundary issue.
    mockFixPlayerRecord.mockReturnValue(new Promise<never>(() => {}));
    const { result } = setup();
    act(() => result.current.selectOut(PLAYER_A1));
    act(() => result.current.selectIn(PLAYER_B1));

    act(() => result.current.confirm());
    // Step is already "submitting" — the confirmation strip stays mounted
    expect(result.current.step).toBe("submitting");
  });

  it("FR-12: calls fixPlayerRecord with match.id, outPlayer.player_id, inPlayer.player_id, sessionId", async () => {
    mockFixPlayerRecord.mockResolvedValue({ success: true, message: "Player record corrected." });
    const { result } = setup();
    act(() => result.current.selectOut(PLAYER_A1));
    act(() => result.current.selectIn(PLAYER_B1));

    act(() => result.current.confirm());
    await waitFor(() => expect(mockFixPlayerRecord).toHaveBeenCalled());

    expect(mockFixPlayerRecord).toHaveBeenCalledWith(
      MATCH_ID,
      PLAYER_A1.player_id,
      PLAYER_B1.player_id,
      SESSION_ID
    );
  });

  it("FR-13: calls onSuccess and resets all state after a successful correction", async () => {
    mockFixPlayerRecord.mockResolvedValue({ success: true, message: "Player record corrected." });
    const { result, onSuccess } = setup();
    act(() => result.current.selectOut(PLAYER_A1));
    act(() => result.current.selectIn(PLAYER_B1));

    act(() => result.current.confirm());
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());

    // Full state reset — back to initial.
    //
    // Waiting on onSuccess is NOT waiting on the reset. use-fix-record.ts runs
    // `reset(); onSuccess();` — the spy records synchronously, while the four
    // setState calls inside reset() are still queued for a later commit. On a
    // loaded machine that commit lands after the assertion and the test reads
    // step === "submitting". Wait for the reset itself; the remaining three
    // fields are set in the same commit, so they stay synchronous.
    await waitFor(() => expect(result.current.step).toBe("selecting_out"));
    expect(result.current.outPlayer).toBeNull();
    expect(result.current.inPlayer).toBeNull();
    expect(result.current.errorMessage).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// FR-14 … FR-15  confirm() — failure path
// ─────────────────────────────────────────────────────────────

describe("useFixRecord — confirm() failure path", () => {
  it("FR-14: stays in confirming and surfaces errorMessage on a server error", async () => {
    mockFixPlayerRecord.mockResolvedValue({
      success: false,
      message: "The player being replaced is no longer in this match.",
      errorCode: "PLAYER_NOT_IN_MATCH" as const,
    });
    const { result, onSuccess } = setup();
    act(() => result.current.selectOut(PLAYER_A1));
    act(() => result.current.selectIn(PLAYER_B1));

    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.errorMessage).not.toBeNull());

    expect(result.current.step).toBe("confirming");
    expect(result.current.errorMessage).toMatch(/no longer in this match/i);
    // onSuccess was NOT called — the correction did not succeed
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("FR-15: catches unexpected exceptions and shows a fallback error message without crashing", async () => {
    mockFixPlayerRecord.mockRejectedValue(new Error("Network timeout"));
    const { result, onSuccess } = setup();
    act(() => result.current.selectOut(PLAYER_A1));
    act(() => result.current.selectIn(PLAYER_B1));

    act(() => result.current.confirm());
    await waitFor(() => expect(result.current.errorMessage).not.toBeNull());

    expect(result.current.step).toBe("confirming");
    expect(result.current.errorMessage).toMatch(/unexpected error/i);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// FR-16 … FR-17  confirm() — no-op guards
// ─────────────────────────────────────────────────────────────

describe("useFixRecord — confirm() guard conditions", () => {
  it("FR-16: confirm() is a no-op when outPlayer is null (called before selectOut)", () => {
    const { result } = setup();
    // Do not selectOut — outPlayer is null
    act(() => result.current.confirm());
    // Step must not change
    expect(result.current.step).toBe("selecting_out");
    expect(mockFixPlayerRecord).not.toHaveBeenCalled();
  });

  it("FR-17: confirm() is a no-op when inPlayer is null (called after selectOut only)", () => {
    const { result } = setup();
    act(() => result.current.selectOut(PLAYER_A1));
    // Do not selectIn — inPlayer is null
    act(() => result.current.confirm());
    expect(result.current.step).toBe("selecting_in");
    expect(mockFixPlayerRecord).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// FR-18  reset()
// ─────────────────────────────────────────────────────────────

describe("useFixRecord — reset()", () => {
  it("FR-18: resets all state to the initial values from any mid-flow step", () => {
    const { result } = setup();
    act(() => result.current.selectOut(PLAYER_A1));
    act(() => result.current.selectIn(PLAYER_B1));
    expect(result.current.step).toBe("confirming");

    act(() => result.current.reset());
    expect(result.current.step).toBe("selecting_out");
    expect(result.current.outPlayer).toBeNull();
    expect(result.current.inPlayer).toBeNull();
    expect(result.current.errorMessage).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// FR-19 … FR-21  isTeamFlip derivation
// ─────────────────────────────────────────────────────────────
// isTeamFlip is computed client-side from match.players so the sheet
// can show a warning badge ("Switching teams") before the user confirms.
// The RPC performs the same check on the server — this is purely UI.

describe("useFixRecord — isTeamFlip derivation", () => {
  it("FR-19: isTeamFlip is false when no inPlayer is selected", () => {
    const { result } = setup();
    act(() => result.current.selectOut(PLAYER_A1));
    // inPlayer still null
    expect(result.current.isTeamFlip).toBe(false);
  });

  it("FR-20: isTeamFlip is true when the selected inPlayer is already in the match", () => {
    // DEFAULT_MATCH has players p1, p2 (team A) and p3, p4 (team B)
    const { result } = setup();
    act(() => result.current.selectOut(PLAYER_A1)); // remove p1
    act(() => result.current.selectIn(PLAYER_B1)); // bring in p3 (already in match → flip)
    expect(result.current.isTeamFlip).toBe(true);
  });

  it("FR-21: isTeamFlip is false when inPlayer comes from another session match", () => {
    // Use a match whose player IDs do NOT include the inPlayer
    const { result } = setup(makeMatch(["p1", "p2", "p3", "p4"]));
    const outsider = makePlayer("p99-outsider", "a");
    act(() => result.current.selectOut(PLAYER_A1));
    act(() => result.current.selectIn(outsider));
    expect(result.current.isTeamFlip).toBe(false);
  });
});
