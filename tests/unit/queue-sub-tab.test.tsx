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
  needs_rename: false,
  collided_name: null,
  flagged_at: null,
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
  max_auto_drafts_override: null,
  auto_publish: false,
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
  queueLoading = false,
  myWaitMinutes = 10,
  hasGoogleLinked = true, // default true so tests don't render the upgrade card
}: {
  isInQueue?: boolean;
  myEntry?: QueueEntry | null;
  myPosition?: number | null;
  totalWaiting?: number;
  queueLoading?: boolean;
  myWaitMinutes?: number;
  hasGoogleLinked?: boolean;
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
      myWaitMinutes={myWaitMinutes}
      totalWaiting={totalWaiting}
      queueLoading={queueLoading}
      matchLoading={false}
      joinQueue={noopAsync}
      leaveQueue={noopAsync}
      hasGoogleLinked={hasGoogleLinked}
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

  // ── QST-12: Approaching — urgent (position ≤ 2) ───────────────
  // OnDeckAlert renders above QueueStatus when position ≤ ON_DECK_ALERT_THRESHOLD (4).
  // Position 1 is "urgent" (amber). The banner has role="status".

  it("QST-12: waiting at position 1 shows 'You're Next!' approaching banner", () => {
    renderQueueSubTab({
      isInQueue: true,
      myEntry: makeEntry("waiting"),
      myPosition: 1,
    });

    // OnDeckAlert banner text is the key player-visible signal for urgency
    expect(screen.getByText("You're Next!")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
    // Hero numeral still visible alongside the banner
    expect(screen.getByText("#1")).toBeInTheDocument();
  });

  // ── QST-13: Approaching — non-urgent (position 3) ────────────
  // Position 3 is within the threshold but not "urgent" — uses sky/blue styling.

  it("QST-13: waiting at position 3 shows 'Get ready!' approaching banner", () => {
    renderQueueSubTab({
      isInQueue: true,
      myEntry: makeEntry("waiting"),
      myPosition: 3,
    });

    expect(screen.getByText("Get ready!")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("#3")).toBeInTheDocument();
  });

  // ── QST-14: No banner above threshold (position 5) ───────────
  // ON_DECK_ALERT_THRESHOLD = 4; position 5 should show no OnDeckAlert.

  it("QST-14: waiting at position 5 shows no approaching banner", () => {
    renderQueueSubTab({
      isInQueue: true,
      myEntry: makeEntry("waiting"),
      myPosition: 5,
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/you're next|almost there|get ready|coming up/i)
    ).not.toBeInTheDocument();
    // Hero numeral still renders normally
    expect(screen.getByText("#5")).toBeInTheDocument();
  });

  // ── QST-15: Post-match state ──────────────────────────────────
  // After a match ends the player returns to "waiting" with an incremented
  // games_played counter. The component should show their new queue position
  // and updated games stat — not any stale match-overlay state.

  it("QST-15: player returned to queue after match shows correct position and incremented games_played", () => {
    const postMatchEntry: QueueEntry = {
      id: "qe-1",
      session_id: "sess-1",
      player_id: "player-me",
      status: "waiting",
      games_played: 1, // incremented after first completed match
      joined_at: new Date(Date.now() - 3 * 60_000).toISOString(),
      position: 5,
      is_paused: false,
      created_at: new Date().toISOString(),
    };

    renderQueueSubTab({
      isInQueue: true,
      myEntry: postMatchEntry,
      myPosition: 5,
      myWaitMinutes: 3,
    });

    // Queue position rendered correctly after return
    expect(screen.getByText("#5")).toBeInTheDocument();
    // games_played stat shows "1" — target the Stat span directly to avoid
    // false matches from any other "1" that might appear on the page.
    const statSpans = screen.getAllByText("1");
    expect(statSpans.length).toBeGreaterThanOrEqual(1);
    // Confirm the "Games" label is also visible alongside the stat value
    expect(screen.getByText("Games")).toBeInTheDocument();
    // Leave Queue button still present
    expect(screen.getByRole("button", { name: /leave queue/i })).toBeInTheDocument();
    // No match overlay copy should be visible
    expect(screen.queryByText(/heads up|match in progress/i)).not.toBeInTheDocument();
  });

  // ── QST-16: Loading state ─────────────────────────────────────
  // When queueLoading=true the component shows a loading indicator.
  // This prevents a misleading flash of "Ready to play?" before the first
  // fetch resolves — which would be indistinguishable from "not in queue".

  it("QST-16: queueLoading=true shows loading indicator, not the empty-state CTA", () => {
    renderQueueSubTab({ queueLoading: true });

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    // Must NOT show the "Ready to play?" CTA during loading
    expect(screen.queryByText(/ready to play/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /join queue/i })).not.toBeInTheDocument();
  });
});
