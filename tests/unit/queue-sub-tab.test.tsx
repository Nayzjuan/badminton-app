// @vitest-environment happy-dom
// ============================================================
// Component Smoke Tests — QueueSubTab (inside MyStatusTab)
// ============================================================
// Pins the rendering contract for the QueueSubTab state machine
// (src/components/player/my-status-tab.tsx).
//
// QueueSubTab has 4 states:
//   paused   — isInQueue + is_paused=true
//   drafted  — isInQueue + status="drafted"   ← NEW (added this session)
//   waiting  — isInQueue + status="waiting"
//   empty    — !isInQueue (not in queue)
//
//   QST-1  Not in queue → shows "Ready to play?" / "Join Queue" CTA
//   QST-2  Waiting → shows QueueStatus position numeral
//   QST-3  On deck (status="on_deck") → falls to "Ready to play?" via
//          QueueSubTab (has no on_deck branch; on_deck players have
//          hasActiveMatch=true so MyStatusTab returns null above)
//   QST-4  Drafted → shows "Match Forming" heading (exact, title case)
//   QST-5  Drafted → shows "Hang tight" body copy
//   QST-6  Drafted → shows lowercase "Match forming" indicator span
//   QST-7  Drafted → shows "selected from N queued" context line
//   QST-8  Drafted → shows "Leave Queue" button
//   QST-9  Paused → shows "On a break" text
//   QST-10 Paused → shows "Leave Queue" button
//   QST-11 Session name shown as eyebrow in not-in-queue state
// ============================================================

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { QueueEntry } from "@/types/database";

// ── Import the internal QueueSubTab via its parent MyStatusTab ─
// QueueSubTab is not exported — test it through MyStatusTab's
// rendered output when hasActiveMatch=false (so it doesn't
// short-circuit with null).
// Re-export trick: we render MyStatusTab with controlled props.
import { MyStatusTab } from "@/components/player/my-status-tab";
import type { Profile, Session } from "@/types/database";

// ── Fixtures ──────────────────────────────────────────────────

const SESSION_NAME = "🏸 Test Session";

const mockProfile: Profile = {
  id: "player-me",
  display_name: "E2E_Me",
  skill_level: "intermediate",
  pin: "1234",
  vip_tag: null,
  vip_theme: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const mockSession: Session = {
  id: "sess-1",
  name: SESSION_NAME,
  created_by: "org-1",
  organizer_passcode: null,
  scoring: "single",
  is_active: true,
  is_auto_matchmaking_on: false,
  court_time_limit_minutes: null,
  ended_at: null,
  created_at: "2026-01-01T00:00:00Z",
};

function makeEntry(status: QueueEntry["status"], isPaused = false): QueueEntry {
  return {
    id: "qe-1",
    session_id: "sess-1",
    player_id: "player-me",
    status,
    games_played: 2,
    joined_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    position: 1,
    is_paused: isPaused,
    created_at: new Date().toISOString(),
  };
}

const noopAsync = async (): Promise<{ error?: string }> => ({});

function renderQueueSubTab({
  isInQueue = false,
  myEntry = null,
  myPosition = null,
  totalWaiting = 4,
}: {
  isInQueue?: boolean;
  myEntry?: QueueEntry | null;
  myPosition?: number | null;
  totalWaiting?: number;
}) {
  return render(
    <MyStatusTab
      profile={mockProfile}
      session={mockSession}
      hasActiveMatch={false}
      currentMatch={null}
      isInQueue={isInQueue}
      myEntry={myEntry}
      myPosition={myPosition}
      myWaitMinutes={10}
      totalWaiting={totalWaiting}
      queueLoading={false}
      matchLoading={false}
      joinQueue={noopAsync}
      leaveQueue={noopAsync}
    />
  );
}

// ── Tests ─────────────────────────────────────────────────────

describe("QueueSubTab — Component Smoke Tests", () => {
  // ── QST-1 ─────────────────────────────────────────────────────
  it("QST-1: not in queue shows 'Ready to play?' and Join Queue button", () => {
    renderQueueSubTab({ isInQueue: false });

    expect(screen.getByText(/ready/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /join queue/i })).toBeInTheDocument();
  });

  // ── QST-2 ─────────────────────────────────────────────────────
  it("QST-2: waiting shows QueueStatus with position numeral", () => {
    renderQueueSubTab({
      isInQueue: true,
      myEntry: makeEntry("waiting"),
      myPosition: 3,
    });

    // QueueStatus renders "#3" as the hero numeral
    expect(screen.getByText("#3")).toBeInTheDocument();
  });

  // ── QST-3 ─────────────────────────────────────────────────────
  it("QST-3: on_deck without active match falls to Ready to play (QueueSubTab has no on_deck branch)", () => {
    // on_deck is handled by the MatchAlert overlay in the parent (hasActiveMatch=true).
    // If somehow hasActiveMatch=false with on_deck status, it falls to "Ready to play?"
    renderQueueSubTab({
      isInQueue: true,
      myEntry: makeEntry("on_deck"),
      myPosition: null,
    });

    // Falls through to the default "Ready to play?" branch
    expect(screen.getByText(/ready/i)).toBeInTheDocument();
  });

  // ── QST-4 ─────────────────────────────────────────────────────
  it("QST-4: drafted shows 'Match Forming' heading (title case, exact)", () => {
    renderQueueSubTab({
      isInQueue: true,
      myEntry: makeEntry("drafted"),
    });

    expect(screen.getByRole("heading", { name: "Match Forming" })).toBeInTheDocument();
  });

  // ── QST-5 ─────────────────────────────────────────────────────
  it("QST-5: drafted shows 'Hang tight' body copy", () => {
    renderQueueSubTab({
      isInQueue: true,
      myEntry: makeEntry("drafted"),
    });

    expect(screen.getByText(/hang tight/i)).toBeInTheDocument();
  });

  // ── QST-6 ─────────────────────────────────────────────────────
  it("QST-6: drafted shows lowercase 'Match forming' indicator span", () => {
    renderQueueSubTab({
      isInQueue: true,
      myEntry: makeEntry("drafted"),
    });

    // Lowercase "Match forming" — different from the h2 "Match Forming"
    expect(screen.getByText("Match forming", { exact: true })).toBeInTheDocument();
  });

  // ── QST-7 ─────────────────────────────────────────────────────
  it("QST-7: drafted shows 'selected from N queued' with correct count", () => {
    renderQueueSubTab({
      isInQueue: true,
      myEntry: makeEntry("drafted"),
      totalWaiting: 6,
    });

    expect(screen.getByText(/selected from 6 queued/i)).toBeInTheDocument();
  });

  // ── QST-8 ─────────────────────────────────────────────────────
  it("QST-8: drafted shows Leave Queue button", () => {
    renderQueueSubTab({
      isInQueue: true,
      myEntry: makeEntry("drafted"),
    });

    expect(screen.getByRole("button", { name: /leave queue/i })).toBeInTheDocument();
  });

  // ── QST-9 ─────────────────────────────────────────────────────
  it("QST-9: paused shows 'On a break' text", () => {
    renderQueueSubTab({
      isInQueue: true,
      myEntry: makeEntry("waiting", /* isPaused */ true),
    });

    expect(screen.getByText(/on a break/i)).toBeInTheDocument();
  });

  // ── QST-10 ───────────────────────────────────────────────────
  it("QST-10: paused shows Leave Queue button", () => {
    renderQueueSubTab({
      isInQueue: true,
      myEntry: makeEntry("waiting", /* isPaused */ true),
    });

    expect(screen.getByRole("button", { name: /leave queue/i })).toBeInTheDocument();
  });

  // ── QST-11 ───────────────────────────────────────────────────
  it("QST-11: session name shown as eyebrow in not-in-queue state", () => {
    renderQueueSubTab({ isInQueue: false });

    expect(screen.getByText(SESSION_NAME)).toBeInTheDocument();
  });
});
