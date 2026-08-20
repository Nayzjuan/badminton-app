// @vitest-environment happy-dom
// ============================================================
// Unit Tests — the add-court failure path
// ============================================================
// "+ Add Court" was the only court control that told the organizer nothing when
// it failed. Its two failure shapes are distinct and neither was visible:
//
//   AC-RET-*  the action RETURNS success:false. The live trigger is a duplicate
//     name — courts carries UNIQUE (session_id, name) — and the old handler read
//     result.error solely to decide whether to clear the input, never to show it.
//     Sibling handlers (remove, status) have always toasted theirs.
//
//   AC-THROW-*  the action REJECTS. A server action that 500s rejects rather than
//     returning success:false, so the branch above never runs at all. With no
//     catch, the throw skipped setAdding(false) and the button stayed on
//     "Adding…" with no explanation — the shape of the "use server" entry outage
//     (docs/incidents/2026-08-20-a-type-re-export-took-down-every-organizer-action.md),
//     during which every action on the organizer route rejected for four days.
//
// The server half of this fix — addCourtAction's 23505 mapping — needs the node
// environment and lives in tests/unit/add-court-action.test.ts.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ActiveCourts } from "@/components/organizer/active-courts";

// The swap sheet owns its own Supabase-backed state machine; this file never
// opens it. A closed INITIAL-shaped state renders nothing.
vi.mock("@/hooks/use-live-match-swap", () => ({
  useLiveMatchSwap: () => ({
    state: {
      isOpen: false,
      outgoingPlayer: null,
      outgoingTeam: null,
      match: null,
      selectedReplacement: null,
      selectedFill: null,
      isSubmitting: false,
      error: null,
      errorCode: null,
    },
    isOpen: false,
    isSubmitting: false,
    canConfirm: false,
    open: vi.fn(),
    close: vi.fn(),
    selectReplacement: vi.fn(),
    selectFill: vi.fn(),
    confirm: vi.fn(),
    undo: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

/** Renders with an empty court grid so only the add bar is under test. */
function renderAddBar(onAddCourt: (name: string) => Promise<{ error?: string }>) {
  return render(
    <ActiveCourts
      courts={[]}
      activeMatches={[]}
      onDeckMatches={[]}
      queuePlayers={[]}
      sessionId="session-1"
      timeLimitMinutes={null}
      onUpdateTimeLimit={vi.fn(async () => ({}))}
      onAddCourt={onAddCourt}
      onUpdateCourtStatus={vi.fn(async () => ({}))}
      onRemoveCourt={vi.fn(async () => ({}))}
      onCallNextMatch={vi.fn(async () => ({ success: true }) as never)}
      onEndMatch={vi.fn(async () => ({}) as never)}
      onCancelMatch={vi.fn(async () => ({}))}
      onClearOnDeckMatch={vi.fn(async () => ({}))}
    />
  );
}

function typeCourtName(value: string) {
  const input = screen.getByPlaceholderText(/Court name/i);
  fireEvent.change(input, { target: { value } });
  return input as HTMLInputElement;
}

function addButton() {
  return screen.getByRole("button", { name: /Add Court/i });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AC-RET — a returned failure is shown to the organizer", () => {
  it("surfaces the error message instead of silently doing nothing", async () => {
    const onAddCourt = vi.fn(async () => ({
      error: "This session already has a court named “Court 11”.",
    }));
    renderAddBar(onAddCourt);
    typeCourtName("Court 11");
    fireEvent.click(addButton());

    // The pre-fix handler rendered no banner at all on this path.
    expect(await screen.findByText("Add Court Failed")).toBeTruthy();
    expect(screen.getByText("This session already has a court named “Court 11”.")).toBeTruthy();
  });

  it("keeps the typed name so the organizer can correct it", async () => {
    const onAddCourt = vi.fn(async () => ({ error: "Not authorized." }));
    renderAddBar(onAddCourt);
    typeCourtName("Court 11");
    fireEvent.click(addButton());

    await screen.findByText("Add Court Failed");
    expect((screen.getByPlaceholderText(/Court name/i) as HTMLInputElement).value).toBe("Court 11");
  });

  it("clears the input and shows no banner on success", async () => {
    const onAddCourt = vi.fn(async () => ({}));
    renderAddBar(onAddCourt);
    typeCourtName("Court 13");
    fireEvent.click(addButton());

    await waitFor(() =>
      expect((screen.getByPlaceholderText(/Court name/i) as HTMLInputElement).value).toBe("")
    );
    expect(screen.queryByText("Add Court Failed")).toBeNull();
  });
});

describe("AC-THROW — a rejected action neither strands the spinner nor stays silent", () => {
  it('resets the button out of "Adding…" when the action throws', async () => {
    // Exactly what a 500 from a dead server-action entry produces client-side.
    const onAddCourt = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderAddBar(onAddCourt);
    typeCourtName("Court 11");
    fireEvent.click(addButton());

    // Pre-fix the throw skipped setAdding(false) and this stayed "Adding…" forever.
    await waitFor(() => expect(addButton().textContent).toMatch(/Add Court/i));
    expect(addButton().textContent).not.toMatch(/Adding/);
    expect((addButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("explains the failure rather than leaving a dead button", async () => {
    const onAddCourt = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderAddBar(onAddCourt);
    typeCourtName("Court 11");
    fireEvent.click(addButton());

    expect(await screen.findByText("Add Court Failed")).toBeTruthy();
    expect(screen.getByText(/server did not respond/i)).toBeTruthy();
  });
});
