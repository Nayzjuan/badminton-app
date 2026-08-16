// @vitest-environment happy-dom

// ============================================================
// QueueControl — the duplicate-roster confirm dialog
// ============================================================
// The server softly refuses a manual match when these same four already have a
// completed match in this session inside the recent window (see
// duplicate-roster-confirm.test.ts for the refusal itself). That refusal is not
// an error, and this file pins the difference:
//
//   • a `duplicateMessage` opens a prompt and offers a way THROUGH
//   • an `error` never does — there is nothing to confirm
//   • the confirmed re-send carries the roster the organizer was ASKED about,
//     not whatever is selected by the time they press the button
//
// IDs: QDC-1 the prompt · QDC-2 confirm · QDC-3 cancel · QDC-4 roster identity
//      QDC-5 plain errors · QDC-6 failure on the confirmed re-send
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueueControl } from "@/components/organizer/queue-control";
import type { QueueFullWithWaitTime } from "@/types/database";

vi.mock("@/app/actions/profile", () => ({
  getPlayerPin: vi.fn(),
  resetPlayerPin: vi.fn(),
  updatePlayerPin: vi.fn(),
  updatePlayerSkill: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@/app/actions/repeat-pairing", () => ({
  getSessionPairCounts: vi.fn(),
  getPairMatches: vi.fn(),
}));

import { getSessionPairCounts } from "@/app/actions/repeat-pairing";

const SESSION_ID = "sess-xyz";
const DUPLICATE_MESSAGE =
  "These players finished a match together 10 minutes ago. Creating this match will record a second result for the same lineup. Create it anyway?";

const ROSTER: Array<[string, string]> = [
  ["p1", "Alice"],
  ["p2", "Bob"],
  ["p3", "Carol"],
  ["p4", "Dave"],
  ["p5", "Eve"],
];

function makeQueueEntry(overrides: Partial<QueueFullWithWaitTime> = {}): QueueFullWithWaitTime {
  return {
    id: "entry-1",
    session_id: SESSION_ID,
    player_id: "p1",
    joined_at: new Date().toISOString(),
    games_played: 3,
    status: "waiting",
    position: 1,
    is_paused: false,
    paused_at: null,
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

const QUEUE: QueueFullWithWaitTime[] = ROSTER.map(([id, name], i) =>
  makeQueueEntry({ id: `entry-${id}`, player_id: id, display_name: name, position: i + 1 })
);

const onCreateManualMatch = vi.fn();

function renderQueue() {
  return render(
    <QueueControl
      sessionId={SESSION_ID}
      queue={QUEUE}
      onCreateManualMatch={onCreateManualMatch}
      onRemoveFromQueue={vi.fn().mockResolvedValue({})}
      onPausePlayer={vi.fn().mockResolvedValue({})}
      matchesRevision={0}
    />
  );
}

/**
 * Tap a player's queue row.
 *
 * Reached through the DOM rather than getByRole("table") on purpose: while the
 * confirm is open Radix marks everything outside it aria-hidden, so the table
 * leaves the accessibility tree and a role query no longer finds it. QDC-4a
 * needs to tap a row in exactly that state.
 */
function tapRow(name: string) {
  const table = document.querySelector("table");
  if (!table) throw new Error("queue table not rendered");
  const cell = within(table as HTMLElement).getByText(name);
  fireEvent.click(cell.closest("tr") as HTMLTableRowElement);
}

/** Select Alice/Bob vs Carol/Dave and press the create button. */
async function selectFourAndCreate() {
  await waitFor(() => expect(vi.mocked(getSessionPairCounts)).toHaveBeenCalled());
  ["Alice", "Bob", "Carol", "Dave"].forEach(tapRow);
  // act: the click kicks off an async handler whose settle (setCreating(false),
  // and either the prompt or the error) lands after the event returns.
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /add to on deck/i }));
  });
}

const dialog = () => screen.queryByRole("alertdialog");

beforeEach(() => {
  vi.clearAllMocks();
  onCreateManualMatch.mockResolvedValue({});
  vi.mocked(getSessionPairCounts).mockResolvedValue({
    success: true,
    data: { partnerships: [], opponents: [] },
  });
});

// ─────────────────────────────────────────────────────────────
describe("QDC-1: the prompt", () => {
  it("QDC-1a: a duplicateMessage opens a confirm carrying the server's wording", async () => {
    onCreateManualMatch.mockResolvedValue({ duplicateMessage: DUPLICATE_MESSAGE });
    renderQueue();
    await selectFourAndCreate();

    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(within(dialog() as HTMLElement).getByText(DUPLICATE_MESSAGE)).toBeInTheDocument();
    // Offering a way through is the whole point of a soft refusal.
    expect(
      within(dialog() as HTMLElement).getByRole("button", { name: /create anyway/i })
    ).toBeInTheDocument();
  });

  it("QDC-1b: no dialog before anything is submitted", async () => {
    renderQueue();
    await waitFor(() => expect(vi.mocked(getSessionPairCounts)).toHaveBeenCalled());
    expect(dialog()).toBeNull();
  });

  it("QDC-1c: a soft refusal is not rendered as an error", async () => {
    onCreateManualMatch.mockResolvedValue({ duplicateMessage: DUPLICATE_MESSAGE });
    renderQueue();
    await selectFourAndCreate();

    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
describe("QDC-2: confirming", () => {
  it("QDC-2a: 'Create anyway' re-sends the same roster with confirmDuplicate true", async () => {
    onCreateManualMatch.mockResolvedValueOnce({ duplicateMessage: DUPLICATE_MESSAGE });
    renderQueue();
    await selectFourAndCreate();

    await waitFor(() => expect(dialog()).not.toBeNull());
    onCreateManualMatch.mockResolvedValueOnce({});
    fireEvent.click(
      within(dialog() as HTMLElement).getByRole("button", { name: /create anyway/i })
    );

    await waitFor(() => expect(onCreateManualMatch).toHaveBeenCalledTimes(2));
    expect(onCreateManualMatch).toHaveBeenNthCalledWith(2, ["p1", "p2"], ["p3", "p4"], true);
  });

  it("QDC-2b: a successful confirm closes the prompt and clears the selection", async () => {
    onCreateManualMatch.mockResolvedValueOnce({ duplicateMessage: DUPLICATE_MESSAGE });
    renderQueue();
    await selectFourAndCreate();

    await waitFor(() => expect(dialog()).not.toBeNull());
    onCreateManualMatch.mockResolvedValueOnce({});
    fireEvent.click(
      within(dialog() as HTMLElement).getByRole("button", { name: /create anyway/i })
    );

    await waitFor(() => expect(dialog()).toBeNull());
    // The team preview only renders while someone is selected.
    await waitFor(() => expect(screen.queryByTestId("team-preview")).toBeNull());
  });
});

// ─────────────────────────────────────────────────────────────
describe("QDC-3: cancelling", () => {
  it("QDC-3a: Cancel closes the prompt without re-sending", async () => {
    onCreateManualMatch.mockResolvedValue({ duplicateMessage: DUPLICATE_MESSAGE });
    renderQueue();
    await selectFourAndCreate();

    await waitFor(() => expect(dialog()).not.toBeNull());
    await act(async () => {
      fireEvent.click(within(dialog() as HTMLElement).getByRole("button", { name: /cancel/i }));
    });

    await waitFor(() => expect(dialog()).toBeNull());
    expect(onCreateManualMatch).toHaveBeenCalledTimes(1);
  });

  it("QDC-3b: Cancel keeps the selection, so the organizer can edit it", async () => {
    onCreateManualMatch.mockResolvedValue({ duplicateMessage: DUPLICATE_MESSAGE });
    renderQueue();
    await selectFourAndCreate();

    await waitFor(() => expect(dialog()).not.toBeNull());
    await act(async () => {
      fireEvent.click(within(dialog() as HTMLElement).getByRole("button", { name: /cancel/i }));
    });

    await waitFor(() => expect(dialog()).toBeNull());
    // Four still picked — wiping the roster would make the "no, let me fix it"
    // answer cost the organizer the whole selection.
    expect(screen.getByTestId("team-preview")).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────
// The dialog is modal, so a real organizer cannot reach the rows behind it —
// this reaches past that deliberately. What is being pinned is that the confirm
// is bound to the roster the prompt was raised for, independent of the dialog's
// modality: if `modal` were ever dropped, or a future effect pruned a slot on a
// realtime queue update, "Create anyway" must still send the lineup the server
// refused, not whatever `slots` holds by then.
describe("QDC-4: the confirmed roster is the one that was asked about", () => {
  it("QDC-4a: changing the selection under the open dialog does not change the re-send", async () => {
    onCreateManualMatch.mockResolvedValueOnce({ duplicateMessage: DUPLICATE_MESSAGE });
    renderQueue();
    await selectFourAndCreate();

    await waitFor(() => expect(dialog()).not.toBeNull());

    // Swap Dave out for Eve while the prompt is up. The organizer was asked
    // about Alice/Bob vs Carol/Dave — that is what "Create anyway" must send.
    tapRow("Dave");
    tapRow("Eve");

    onCreateManualMatch.mockResolvedValueOnce({});
    fireEvent.click(
      within(dialog() as HTMLElement).getByRole("button", { name: /create anyway/i })
    );

    await waitFor(() => expect(onCreateManualMatch).toHaveBeenCalledTimes(2));
    expect(onCreateManualMatch).toHaveBeenNthCalledWith(2, ["p1", "p2"], ["p3", "p4"], true);
  });
});

// ─────────────────────────────────────────────────────────────
describe("QDC-5: plain errors are not confirmable", () => {
  it("QDC-5a: an error opens no dialog and surfaces inline", async () => {
    onCreateManualMatch.mockResolvedValue({ error: "Court is busy" });
    renderQueue();
    await selectFourAndCreate();

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Court is busy"));
    expect(dialog()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
describe("QDC-6: the confirmed re-send can still fail", () => {
  it("QDC-6a: an error on confirm closes the dialog so the reason is readable", async () => {
    onCreateManualMatch.mockResolvedValueOnce({ duplicateMessage: DUPLICATE_MESSAGE });
    renderQueue();
    await selectFourAndCreate();

    await waitFor(() => expect(dialog()).not.toBeNull());
    onCreateManualMatch.mockResolvedValueOnce({ error: "This session has ended." });
    fireEvent.click(
      within(dialog() as HTMLElement).getByRole("button", { name: /create anyway/i })
    );

    // The inline error renders behind the dialog; leaving it open would hide it.
    await waitFor(() => expect(dialog()).toBeNull());
    expect(screen.getByRole("alert")).toHaveTextContent("This session has ended.");
  });
});
