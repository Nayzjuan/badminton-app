// @vitest-environment happy-dom

// ============================================================
// QueueControl — slot selection + the repeat-pairing warning
// ============================================================
// The contract this file defends, in one line: the warning is ADVISORY.
// It must never block, disable, or reject match creation — and the slot
// model must mean that the team preview the organizer just read is exactly
// the match that gets created.
//
// IDs: QRP-S slot model · QRP-P team preview / swap · QRP-M markers
//      QRP-W warning surface · QRP-D disclosure · QRP-A a11y
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { QueueControl } from "@/components/organizer/queue-control";
import { RepeatMarker } from "@/components/organizer/repeat-marker";
import { ANNOUNCE_DEBOUNCE_MS } from "@/hooks/use-repeat-pairing";
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

import { getSessionPairCounts, getPairMatches } from "@/app/actions/repeat-pairing";

const SESSION_ID = "sess-xyz";

// Five waiting players. Alice & Bob have already partnered twice tonight —
// exactly MAX_PARTNERSHIP_REPEATS, so pairing them again is what the engine
// itself refuses to do.
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

const onCreateManualMatch = vi.fn().mockResolvedValue({});

let lastRerender: ((ui: React.ReactElement) => void) | null = null;

/** Re-render the SAME mounted QueueControl with tweaked props. */
function rerenderQueue(props: Partial<React.ComponentProps<typeof QueueControl>> = {}) {
  if (!lastRerender) throw new Error("rerenderQueue called before renderQueue");
  lastRerender(queueControl(props));
}

function queueControl(props: Partial<React.ComponentProps<typeof QueueControl>> = {}) {
  return (
    <QueueControl
      sessionId={SESSION_ID}
      queue={QUEUE}
      onCreateManualMatch={onCreateManualMatch}
      onRemoveFromQueue={vi.fn().mockResolvedValue({})}
      onPausePlayer={vi.fn().mockResolvedValue({})}
      matchesRevision={0}
      {...props}
    />
  );
}

function renderQueue(props: Partial<React.ComponentProps<typeof QueueControl>> = {}) {
  const utils = render(queueControl(props));
  lastRerender = utils.rerender;
  return utils;
}

/**
 * The flat-List table row for a player. Scoped to the table on purpose: the
 * team preview renders the same names as buttons, so an unscoped getByText
 * is ambiguous the moment someone is selected.
 */
function row(name: string): HTMLTableRowElement {
  const cell = within(screen.getByRole("table")).getByText(name);
  const tr = cell.closest("tr");
  expect(tr).not.toBeNull();
  return tr as HTMLTableRowElement;
}

/** Click a player's row (the primary tap target). */
function tapRow(name: string) {
  fireEvent.click(row(name));
}

/** Wait until the counts fetch has landed and been applied. */
async function countsLoaded() {
  await waitFor(() => expect(vi.mocked(getSessionPairCounts)).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  onCreateManualMatch.mockResolvedValue({});
  vi.mocked(getSessionPairCounts).mockResolvedValue({
    success: true,
    data: { partnerships: [["p1:p2", 2]], opponents: [] },
  });
});

describe("QRP-S: slot selection model", () => {
  it("QRP-S1: teams come from the SLOTS, not from Set iteration order", async () => {
    renderQueue();
    await countsLoaded();

    ["Alice", "Bob", "Carol", "Dave"].forEach(tapRow);
    fireEvent.click(screen.getByRole("button", { name: /add to on deck/i }));

    await waitFor(() =>
      expect(onCreateManualMatch).toHaveBeenCalledWith(["p1", "p2"], ["p3", "p4"])
    );
  });

  it("QRP-S2: deselecting frees THAT slot — the other three keep their teams", async () => {
    renderQueue();
    await countsLoaded();

    ["Alice", "Bob", "Carol", "Dave"].forEach(tapRow);
    tapRow("Bob"); // frees A2
    tapRow("Eve"); // refills A2 — Carol/Dave must stay on Team B

    fireEvent.click(screen.getByRole("button", { name: /add to on deck/i }));
    await waitFor(() =>
      expect(onCreateManualMatch).toHaveBeenCalledWith(["p1", "p5"], ["p3", "p4"])
    );
  });

  it("QRP-S3: at the 4-player cap an unselected row is inert, not a dead tap", async () => {
    renderQueue();
    await countsLoaded();

    ["Alice", "Bob", "Carol", "Dave"].forEach(tapRow);
    const eveRow = row("Eve");
    expect(eveRow.getAttribute("aria-disabled")).toBe("true");
    expect(eveRow.getAttribute("tabindex")).toBe("-1");

    // Selected rows stay interactive so the pick is still reversible.
    expect(row("Alice").getAttribute("aria-disabled")).toBeNull();

    fireEvent.click(eveRow);
    fireEvent.click(screen.getByRole("button", { name: /add to on deck/i }));
    await waitFor(() =>
      expect(onCreateManualMatch).toHaveBeenCalledWith(["p1", "p2"], ["p3", "p4"])
    );
  });
});

describe("QRP-P: team preview + swap across the net", () => {
  it("QRP-P1: the preview appears from the FIRST pick, before any warning", async () => {
    renderQueue();
    await countsLoaded();

    expect(screen.queryByTestId("team-preview")).toBeNull();
    tapRow("Carol");
    expect(screen.getByTestId("team-preview")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("team-preview")).getByRole("button", { name: /move carol/i })
    ).toBeInTheDocument();
  });

  it("QRP-P2: tapping a name moves that player across the net", async () => {
    renderQueue();
    await countsLoaded();

    ["Alice", "Bob", "Carol", "Dave"].forEach(tapRow);
    // Both far slots are occupied, so Alice swaps with her mirror (Carol).
    fireEvent.click(screen.getByRole("button", { name: "Move Alice to Team B" }));

    fireEvent.click(screen.getByRole("button", { name: /add to on deck/i }));
    await waitFor(() =>
      expect(onCreateManualMatch).toHaveBeenCalledWith(["p3", "p2"], ["p1", "p4"])
    );
  });

  it("QRP-P3: with a free far slot the player moves rather than swapping", async () => {
    renderQueue();
    await countsLoaded();

    ["Alice", "Bob"].forEach(tapRow);
    fireEvent.click(screen.getByRole("button", { name: "Move Bob to Team B" }));
    ["Carol", "Dave"].forEach(tapRow);

    // Bob vacated A2, so Carol fills it and Dave lands on B2.
    fireEvent.click(screen.getByRole("button", { name: /add to on deck/i }));
    await waitFor(() =>
      expect(onCreateManualMatch).toHaveBeenCalledWith(["p1", "p3"], ["p2", "p4"])
    );
  });
});

describe("QRP-M: per-row markers", () => {
  it("QRP-M1: marks the bench player who would repeat, in the List lens", async () => {
    renderQueue();
    await countsLoaded();

    expect(screen.queryAllByTestId("repeat-marker")).toHaveLength(0);
    tapRow("Alice");

    await waitFor(() => expect(screen.getAllByTestId("repeat-marker")).toHaveLength(1));
    const bobRow = row("Bob");
    expect(within(bobRow).getByTestId("repeat-marker")).toBeInTheDocument();
    // The referent is spelled out for screen readers, not left to the glyph.
    expect(
      within(bobRow).getByText(/would be a 3rd match with Alice as teammates/i)
    ).toBeInTheDocument();
  });

  it("QRP-M2: the SAME marker ships in the By Skill lens", async () => {
    renderQueue();
    await countsLoaded();
    tapRow("Alice");
    await waitFor(() => expect(screen.getAllByTestId("repeat-marker")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "By Skill" }));
    await waitFor(() => expect(screen.getAllByTestId("repeat-marker")).toHaveLength(1));
    expect(screen.getByText(/would be a 3rd match with Alice as teammates/i)).toBeInTheDocument();
  });

  it("QRP-M3: a legend resolves which pick the markers refer to", async () => {
    renderQueue();
    await countsLoaded();
    tapRow("Alice");

    await waitFor(() =>
      expect(screen.getByTestId("repeat-marker-legend")).toHaveTextContent(
        /Team A, alongside Alice/i
      )
    );
  });

  it("QRP-M4: an already-selected player is never marked", async () => {
    renderQueue();
    await countsLoaded();
    tapRow("Alice");
    tapRow("Bob");

    await waitFor(() => expect(screen.getByTestId("repeat-headline")).toBeInTheDocument());
    expect(screen.queryAllByTestId("repeat-marker")).toHaveLength(0);
  });
});

describe("QRP-W: the warning is advisory, never a gate", () => {
  it("QRP-W1: the headline states the prior count and the engine consequence", async () => {
    renderQueue();
    await countsLoaded();
    tapRow("Alice");
    tapRow("Bob");

    await waitFor(() =>
      expect(screen.getByTestId("repeat-headline")).toHaveTextContent(
        "Alice & Bob have partnered 2× tonight — auto-matchmaking won't pair them again"
      )
    );
  });

  it("QRP-W2: creation still goes through while the warning is showing", async () => {
    renderQueue();
    await countsLoaded();
    ["Alice", "Bob", "Carol", "Dave"].forEach(tapRow);

    await waitFor(() => expect(screen.getByTestId("repeat-headline")).toBeInTheDocument());
    const cta = screen.getByRole("button", { name: /add to on deck/i });
    expect(cta).not.toBeDisabled();

    fireEvent.click(cta);
    await waitFor(() =>
      expect(onCreateManualMatch).toHaveBeenCalledWith(["p1", "p2"], ["p3", "p4"])
    );
  });

  it("QRP-W3: cap saturation suppresses the whole surface", async () => {
    renderQueue({ capSaturationActive: true });
    await countsLoaded();
    tapRow("Alice");
    tapRow("Bob");

    expect(screen.queryByTestId("repeat-headline")).toBeNull();
    expect(screen.queryAllByTestId("repeat-marker")).toHaveLength(0);
  });

  it("QRP-W4: nothing is shown when the counts never load", async () => {
    vi.mocked(getSessionPairCounts).mockResolvedValue({ success: false, error: "nope" });
    renderQueue();
    await countsLoaded();
    tapRow("Alice");
    tapRow("Bob");

    expect(screen.queryByTestId("repeat-headline")).toBeNull();
    // Two selected: the CTA is still slot-reserved (aria-hidden), so query by
    // text rather than role — the point is that nothing became disabled.
    expect(screen.getByText(/add to on deck/i)).not.toBeDisabled();
  });

  it("QRP-W5: the CTA slot is reserved from the first pick, so the row never jumps", async () => {
    renderQueue();
    await countsLoaded();

    expect(screen.queryByRole("button", { name: /add to on deck/i })).toBeNull();
    tapRow("Alice");
    // Present in the DOM but hidden from AT and pointer until the 4th pick.
    const reserved = screen.getByText(/add to on deck/i);
    expect(reserved.className).toContain("invisible");
    expect(reserved.getAttribute("aria-hidden")).toBe("true");
    expect(reserved.getAttribute("tabindex")).toBe("-1");
  });
});

describe("QRP-D: disclosure", () => {
  it("QRP-D1: opening it lists the actual prior matches behind the count", async () => {
    vi.mocked(getPairMatches).mockResolvedValue({
      success: true,
      data: [
        {
          matchId: "m1",
          status: "completed",
          at: "2026-07-20T10:00:00Z",
          courtName: "Court 2",
          sameTeam: true,
          teamAScore: 21,
          teamBScore: 17,
          players: [
            { playerId: "p1", displayName: "Alice", team: "A" },
            { playerId: "p2", displayName: "Bob", team: "A" },
            { playerId: "p3", displayName: "Carol", team: "B" },
            { playerId: "p4", displayName: "Dave", team: "B" },
          ],
        },
      ],
    });

    renderQueue();
    await countsLoaded();
    tapRow("Alice");
    tapRow("Bob");
    await waitFor(() => expect(screen.getByTestId("repeat-headline")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /details/i }));
    const panel = await screen.findByTestId("repeat-pair-details");
    expect(within(panel).getByText(/advisory only/i)).toBeInTheDocument();

    // happy-dom has no layout, so scrollIntoView is not implemented — spy it.
    // Without this, deleting the whole scroll effect passes the suite.
    const scrollSpy = vi.fn();
    const proto = Element.prototype as unknown as { scrollIntoView?: unknown };
    const original = proto.scrollIntoView;
    proto.scrollIntoView = scrollSpy;
    try {
      fireEvent.click(within(panel).getByRole("button", { name: /Alice & Bob/ }));
      await waitFor(() =>
        expect(vi.mocked(getPairMatches)).toHaveBeenCalledWith(SESSION_ID, "p1", "p2")
      );
      // Fires on open AND once the list resolves — at open the body is just
      // "Loading matches…", so block:"nearest" on that one-liner can leave the
      // real list below the fold on a 375px viewport.
      await waitFor(() => expect(scrollSpy.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" });
      const afterOpen = scrollSpy.mock.calls.length;

      // A realtime re-render must NOT re-scroll: an inline ref callback would
      // detach/re-attach every commit and yank the organizer back up.
      rerenderQueue({ queue: [...QUEUE] });
      await waitFor(() => expect(screen.getByTestId("repeat-pair-details")).toBeInTheDocument());
      expect(scrollSpy.mock.calls.length).toBe(afterOpen);
    } finally {
      proto.scrollIntoView = original;
    }
    expect(await within(panel).findByText(/Court 2/)).toBeInTheDocument();
    expect(within(panel).getByText(/same team/)).toBeInTheDocument();
  });

  it("QRP-D2: the panel folds away when the selection clears", async () => {
    renderQueue();
    await countsLoaded();
    tapRow("Alice");
    tapRow("Bob");
    await waitFor(() => expect(screen.getByTestId("repeat-headline")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /details/i }));
    expect(await screen.findByTestId("repeat-pair-details")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));
    expect(screen.queryByTestId("repeat-pair-details")).toBeNull();
    expect(screen.queryByTestId("repeat-headline")).toBeNull();
  });
});

describe("QRP-A: accessibility", () => {
  it("QRP-A1: the live region is mounted before anything is selected", async () => {
    renderQueue();
    await countsLoaded();

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status.textContent).toBe("");
  });

  it("QRP-A2: the visible headline carries no live semantics of its own", async () => {
    renderQueue();
    await countsLoaded();
    tapRow("Alice");
    tapRow("Bob");

    const headline = await screen.findByTestId("repeat-headline");
    expect(headline.getAttribute("aria-live")).toBeNull();
    expect(headline.getAttribute("role")).toBeNull();
  });

  it("QRP-A3: Clear meets the 44px courtside touch target", async () => {
    renderQueue();
    await countsLoaded();
    tapRow("Alice");

    expect(screen.getByRole("button", { name: /^clear$/i }).className).toContain("min-h-[44px]");
  });
});

describe("QRP-R: render-time state adjustments converge", () => {
  // QueueControl and useRepeatPairing deliberately adjust state DURING RENDER
  // (React's "adjusting state when props change" pattern) rather than in an
  // effect: this repo's lint gate errors on `react-hooks/set-state-in-effect`,
  // and an effect would paint one frame of stale UI first. The risk that
  // buys is non-convergence, so it is pinned here — under StrictMode, whose
  // double-invoked render is exactly what an unguarded adjustment breaks on.
  it("QRP-R1: the full build -> warn -> disclose -> clear cycle is stable in StrictMode", async () => {
    render(
      <StrictMode>
        <QueueControl
          sessionId={SESSION_ID}
          queue={QUEUE}
          onCreateManualMatch={onCreateManualMatch}
          onRemoveFromQueue={vi.fn().mockResolvedValue({})}
          onPausePlayer={vi.fn().mockResolvedValue({})}
          matchesRevision={0}
        />
      </StrictMode>
    );
    await countsLoaded();

    tapRow("Alice");
    tapRow("Bob");
    await waitFor(() => expect(screen.getByTestId("repeat-headline")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /details/i }));
    expect(await screen.findByTestId("repeat-pair-details")).toBeInTheDocument();

    // Clearing drives BOTH render-time adjustments at once: QueueControl folds
    // the disclosure, and useRepeatPairing ends the episode + drops the
    // headline. If either failed to converge this would loop or throw
    // "Too many re-renders" instead of settling.
    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));
    expect(screen.queryByTestId("repeat-pair-details")).toBeNull();
    expect(screen.queryByTestId("repeat-headline")).toBeNull();
    expect(screen.queryByTestId("team-preview")).toBeNull();

    // And the component is still live afterwards — it settled, it did not wedge.
    tapRow("Alice");
    expect(screen.getByTestId("team-preview")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByTestId("repeat-marker")).toHaveLength(1));
  });

  it("QRP-R2: re-opening after a clear does not resurrect the previous panel", async () => {
    render(
      <StrictMode>
        <QueueControl
          sessionId={SESSION_ID}
          queue={QUEUE}
          onCreateManualMatch={onCreateManualMatch}
          onRemoveFromQueue={vi.fn().mockResolvedValue({})}
          onPausePlayer={vi.fn().mockResolvedValue({})}
          matchesRevision={0}
        />
      </StrictMode>
    );
    await countsLoaded();

    tapRow("Alice");
    tapRow("Bob");
    await waitFor(() => expect(screen.getByTestId("repeat-headline")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /details/i }));
    expect(await screen.findByTestId("repeat-pair-details")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));
    tapRow("Alice");
    tapRow("Bob");

    // The warning is back, but the disclosure starts folded.
    await waitFor(() => expect(screen.getByTestId("repeat-headline")).toBeInTheDocument());
    expect(screen.queryByTestId("repeat-pair-details")).toBeNull();
  });
});

// ============================================================
// Gap-closing suite (added after the adversarial review)
// ============================================================
// Every test below pins a behaviour that a reviewer proved could be broken
// by a one-line mutation while the rest of the suite stayed green, or is a
// regression test for a bug that review found.
// ============================================================

describe("QRP-L: live region is actually written", () => {
  it("QRP-L1: a user-initiated selection speaks the warning after the debounce", async () => {
    renderQueue();
    await countsLoaded();

    vi.useFakeTimers();
    try {
      tapRow("Alice");
      tapRow("Bob");
      // Pins BOTH halves of constraint 8: the epoch bump in togglePlayer and
      // the {announcement} binding on the sr-only node. Blanking either one
      // leaves this empty forever and the warning becomes inaudible.
      expect(screen.getByRole("status").textContent).toBe("");
      await act(async () => {
        vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS + 50);
      });
      expect(screen.getByRole("status").textContent).toContain(
        "Alice and Bob have partnered 2 times tonight."
      );
      // Spoken register: no × glyph, which screen readers mangle.
      expect(screen.getByRole("status").textContent).not.toContain("×");
    } finally {
      vi.useRealTimers();
    }
  });

  it("QRP-L2: clearing the selection falls silent again", async () => {
    renderQueue();
    await countsLoaded();

    vi.useFakeTimers();
    try {
      tapRow("Alice");
      tapRow("Bob");
      await act(async () => {
        vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS + 50);
      });
      expect(screen.getByRole("status").textContent).toContain("partnered");

      fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));
      await act(async () => {
        vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS + 50);
      });
      expect(screen.getByRole("status").textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("QRP-B: By Skill lens parity", () => {
  it("QRP-B1: at the cap an unselected card is inert there too", async () => {
    renderQueue();
    await countsLoaded();
    ["Alice", "Bob", "Carol", "Dave"].forEach(tapRow);
    fireEvent.click(screen.getByRole("button", { name: "By Skill" }));

    // The checkbox stays RENDERED (only paused rows drop it) but disabled…
    const eveBox = screen.getByLabelText("Select Eve for a match") as HTMLInputElement;
    expect(eveBox).toBeDisabled();

    // …and the card click is a no-op rather than a dead tap.
    const card = screen.getByText("Eve").closest("div.clip-cut-tr")!;
    expect(card.className).toContain("cursor-default");
    fireEvent.click(card);

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("button", { name: /add to on deck/i }));
    await waitFor(() =>
      expect(onCreateManualMatch).toHaveBeenCalledWith(["p1", "p2"], ["p3", "p4"])
    );
  });

  it("QRP-B2: a selected card stays tappable at the cap so picks are reversible", async () => {
    renderQueue();
    await countsLoaded();
    ["Alice", "Bob", "Carol", "Dave"].forEach(tapRow);
    fireEvent.click(screen.getByRole("button", { name: "By Skill" }));

    const daveBox = screen.getByLabelText("Select Dave for a match");
    expect(daveBox).not.toBeDisabled();
    // Scoped via the checkbox: the team preview renders "Dave" too.
    const card = daveBox.closest("div.clip-cut-tr")!;
    expect(card.className).toContain("cursor-pointer");
  });
});

describe("QRP-E: creation failure", () => {
  it("QRP-E1: an error is announced and the four picks are PRESERVED", async () => {
    onCreateManualMatch.mockResolvedValue({ error: "Court is busy" });
    renderQueue();
    await countsLoaded();
    ["Alice", "Bob", "Carol", "Dave"].forEach(tapRow);
    fireEvent.click(screen.getByRole("button", { name: /add to on deck/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Court is busy");
    // Wiping the selection on failure would make the organizer re-pick blind.
    expect(screen.getByText("4 of 4 players selected")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("team-preview")).getByRole("button", {
        name: "Move Alice to Team B",
      })
    ).toBeInTheDocument();
  });
});

describe("QRP-H: headline stability at the component level", () => {
  // Two tripping pairs, with the HIGHER count on the pair picked SECOND —
  // so a bar that re-ranks would visibly rewrite its top line on the 4th tap.
  const TWO_PAIRS = {
    success: true as const,
    data: {
      partnerships: [
        ["p1:p2", 2],
        ["p3:p4", 5],
      ] as [string, number][],
      opponents: [] as [string, number][],
    },
  };

  it("QRP-H1: the first pair to trip stays the headline through the 4th tap", async () => {
    vi.mocked(getSessionPairCounts).mockResolvedValue(TWO_PAIRS);
    renderQueue();
    await countsLoaded();

    tapRow("Alice");
    tapRow("Bob");
    await waitFor(() =>
      expect(screen.getByTestId("repeat-headline")).toHaveTextContent(/Alice & Bob/)
    );

    tapRow("Carol");
    tapRow("Dave");
    // Carol & Dave rank first by count, but the line must not rewrite.
    expect(screen.getByTestId("repeat-headline")).toHaveTextContent(/Alice & Bob/);
    expect(screen.getByTestId("repeat-headline")).not.toHaveTextContent(/Carol/);
  });

  it("QRP-H2: the disclosure button switches to the +N form with several pairs", async () => {
    vi.mocked(getSessionPairCounts).mockResolvedValue(TWO_PAIRS);
    renderQueue();
    await countsLoaded();
    ["Alice", "Bob", "Carol", "Dave"].forEach(tapRow);

    const more = await screen.findByRole("button", { name: /\+1 more repeat pairing/i });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);

    const panel = await screen.findByTestId("repeat-pair-details");
    expect(within(panel).getByText(/2 repeat pairings/i)).toBeInTheDocument();
    // Both pairs are listed even though only one is headlined.
    expect(within(panel).getByRole("button", { name: /Alice & Bob/ })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /Carol & Dave/ })).toBeInTheDocument();
  });
});

describe("QRP-C: the candidate pool is only what the organizer can tap", () => {
  it("QRP-C1: paused and locked rows are never marked", async () => {
    const mixed: QueueFullWithWaitTime[] = [
      makeQueueEntry({ id: "e1", player_id: "p1", display_name: "Alice", position: 1 }),
      makeQueueEntry({ id: "e2", player_id: "p2", display_name: "Bob", position: 2 }),
      // Both would trip a repeat with Alice, but neither is selectable.
      makeQueueEntry({
        id: "e3",
        player_id: "p3",
        display_name: "Carol",
        position: 3,
        is_paused: true,
      }),
      makeQueueEntry({
        id: "e4",
        player_id: "p4",
        display_name: "Dave",
        position: 4,
        status: "on_deck",
        status_priority: 1,
      }),
      makeQueueEntry({ id: "e5", player_id: "p5", display_name: "Eve", position: 5 }),
    ];
    vi.mocked(getSessionPairCounts).mockResolvedValue({
      success: true,
      data: {
        partnerships: [
          ["p1:p2", 2],
          ["p1:p3", 2],
          ["p1:p4", 2],
        ],
        opponents: [],
      },
    });

    renderQueue({ queue: mixed });
    await countsLoaded();
    tapRow("Alice");

    await waitFor(() => expect(screen.getAllByTestId("repeat-marker")).toHaveLength(1));
    expect(within(row("Bob")).getByTestId("repeat-marker")).toBeInTheDocument();
    expect(within(row("Carol")).queryByTestId("repeat-marker")).toBeNull();
    expect(within(row("Dave")).queryByTestId("repeat-marker")).toBeNull();
  });
});

describe("QRP-K: keyboard selection", () => {
  it("QRP-K1: Space and Enter toggle a row and suppress page scroll", async () => {
    renderQueue();
    await countsLoaded();

    const alice = row("Alice");
    const spaceEvt = fireEvent.keyDown(alice, { key: " " });
    // preventDefault matters: Space on a focused row must not scroll the page.
    expect(spaceEvt).toBe(false);
    fireEvent.keyDown(row("Bob"), { key: "Enter" });
    fireEvent.keyDown(row("Carol"), { key: " " });
    fireEvent.keyDown(row("Dave"), { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: /add to on deck/i }));
    await waitFor(() =>
      expect(onCreateManualMatch).toHaveBeenCalledWith(["p1", "p2"], ["p3", "p4"])
    );
  });
});

describe("QRP-G: sticky-bar geometry (constraints 6 + 7)", () => {
  it("QRP-G1: the bar is sticky under the header, capped, and has no inner scroller", () => {
    renderQueue();
    const bar = screen.getByTestId("manual-match-bar");

    // Below the dashboard's `sticky top-0 z-20` header, above the queue's
    // `z-10` checkbox hit-areas.
    expect(bar.className).toContain("sticky");
    expect(bar.className).toContain("z-[15]");
    // Offset by the ResizeObserver-published header height, with a fallback
    // so the first paint is not at top:0 underneath the header.
    expect(bar.className).toContain("top-[var(--cc-header-h,176px)]");
    // Hard cap + NO overflow-y-auto: a scroller inside a sticky element is a
    // touch trap, and an uncapped bar leaves <3 queue rows on an iPhone SE.
    expect(bar.className).toContain("max-h-[min(33vh,200px)]");
    expect(bar.className).toContain("overflow-hidden");
    expect(bar.className).not.toContain("overflow-y-auto");
    // Opaque surface — the old bar was dark:bg-amber-950/30 and rows showed through.
    expect(bar.className).toContain("bg-cc-bg-2");
    // cc-accent (teal) means SELECTED on this screen; it must never tint the warning.
    expect(bar.className).not.toContain("bg-cc-amber");
  });
});

describe("QRP-V: counts refresh without a sixth realtime channel", () => {
  it("QRP-V1: a matchesRevision tick refetches the counts", async () => {
    const { rerender } = render(
      <QueueControl
        sessionId={SESSION_ID}
        queue={QUEUE}
        onCreateManualMatch={onCreateManualMatch}
        onRemoveFromQueue={vi.fn().mockResolvedValue({})}
        onPausePlayer={vi.fn().mockResolvedValue({})}
        matchesRevision={0}
      />
    );
    await waitFor(() => expect(vi.mocked(getSessionPairCounts)).toHaveBeenCalledTimes(1));

    // This is the ENTIRE refresh mechanism that exists instead of a sixth
    // realtime channel (a 6th would break useOrganizerSession's health check).
    rerender(
      <QueueControl
        sessionId={SESSION_ID}
        queue={QUEUE}
        onCreateManualMatch={onCreateManualMatch}
        onRemoveFromQueue={vi.fn().mockResolvedValue({})}
        onPausePlayer={vi.fn().mockResolvedValue({})}
        matchesRevision={1}
      />
    );
    await waitFor(() => expect(vi.mocked(getSessionPairCounts)).toHaveBeenCalledTimes(2));
  });
});

describe("QRP-N: the marker chip's VISIBLE text", () => {
  // The component tests above all match the sr-only markerLabel, which is
  // built from every relation individually and so cannot catch a chip that
  // welds the wrong number to the right word.
  const nameOf = (id: string) => ({ p1: "Alice", p3: "Carol" })[id] ?? "Unknown";

  it("QRP-N1: pairs the primary relation with THAT relation's own count", () => {
    // primaryRelation is teammate-first regardless of count; worstCount is the
    // max across ALL relations. Using worstCount here rendered "Team 6th" for
    // someone who would be Alice's 3rd-time teammate.
    render(
      <RepeatMarker
        marker={{
          playerId: "p9",
          relations: [
            { relation: "teammate", withPlayerId: "p1", count: 2 },
            { relation: "opponent", withPlayerId: "p3", count: 5 },
          ],
          worstCount: 5,
          primaryRelation: "teammate",
        }}
        nameOf={nameOf}
      />
    );

    // Scoped to the VISIBLE label: the chip element also contains the sr-only
    // sentence, which legitimately mentions the 6th opponent meeting.
    const label = screen.getByTestId("repeat-marker-label");
    expect(label.textContent).toBe("Team 3rd");

    // …and that sr-only sentence still enumerates BOTH relations, because a
    // single glyph cannot say two things.
    const chip = screen.getByTestId("repeat-marker");
    expect(chip).toHaveTextContent(/a 3rd match with Alice as teammates/);
    expect(chip).toHaveTextContent(/a 6th match with Carol as opponents/);
  });

  it("QRP-N2: an opponent-only marker says Opp, not Team", () => {
    render(
      <RepeatMarker
        marker={{
          playerId: "p9",
          relations: [{ relation: "opponent", withPlayerId: "p3", count: 2 }],
          worstCount: 2,
          primaryRelation: "opponent",
        }}
        nameOf={nameOf}
      />
    );
    expect(screen.getByTestId("repeat-marker-label").textContent).toBe("Opp 3rd");
  });
});
