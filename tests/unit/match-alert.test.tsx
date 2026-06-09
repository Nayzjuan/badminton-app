// @vitest-environment happy-dom
// ============================================================
// Component Smoke Tests — MatchAlert
// ============================================================
// Pins the rendering contract for the MatchAlert overlay
// (src/components/player/match-alert.tsx) across its two
// visual states: pending (on-deck, amber) and in_progress (navy).
//
//   MA-1  Pending: renders "Heads Up." heading and "You're On Deck" pill
//   MA-2  Pending: shows "Coming Up Next" eyebrow when isNextUp (position 1)
//   MA-3  Pending: shows "#2 On Deck" eyebrow when onDeckPosition = 2
//   MA-4  Pending: shows "1 MATCH AHEAD IN LINE" when position = 2
//   MA-5  Pending: renders "Your Team" + "Opponents" columns
//   MA-6  Pending: marks the current player's row with "You" label
//   MA-7  Pending: shows Mixed Level badge when isMixedLevel = true
//   MA-8  In-progress: renders court name as heading
//   MA-9  In-progress: renders "Active Court" eyebrow
//   MA-10 In-progress: renders "Match in Progress" pill
//   MA-11 In-progress: shows Mixed Level badge when isMixedLevel = true
//   MA-12 No court: pending renders without crashing (court_id = null)
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MatchAlert } from "@/components/player/match-alert";
import type { Court, Profile } from "@/types/database";

// ── Suppress requestAnimationFrame noise in happy-dom ─────────
// MatchAlert uses two rAF calls to trigger the slide-up animation.
// happy-dom does not implement rAF; stubbing prevents console noise.
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
  cb(0);
  return 0;
});
vi.stubGlobal("cancelAnimationFrame", () => {});

// ── Fixtures ──────────────────────────────────────────────────

const mockCourt: Court = {
  id: "court-1",
  session_id: "sess-1",
  name: "Court 1",
  status: "in_use",
  created_at: "2026-01-01T00:00:00Z",
};

const makeProfile = (id: string, name: string): Profile => ({
  id,
  display_name: name,
  skill_level: "intermediate",
  pin: "1234",
  vip_tag: null,
  vip_theme: null,
  needs_rename: false,
  collided_name: null,
  flagged_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});

const teammate = makeProfile("t1", "Teammate");
const opp1 = makeProfile("o1", "Opp1");
const opp2 = makeProfile("o2", "Opp2");

const baseProps = {
  myDisplayName: "Me",
  mySkillLevel: "intermediate" as const,
  teammates: [teammate],
  opponents: [opp1, opp2],
  isMixedLevel: false,
};

// ── Tests ─────────────────────────────────────────────────────

describe("MatchAlert — Component Smoke Tests", () => {
  // ── MA-1 ─────────────────────────────────────────────────────
  it("MA-1: pending renders Heads Up heading and You're On Deck pill", () => {
    render(
      <MatchAlert
        {...baseProps}
        matchStatus="pending"
        court={null}
        onDeckPosition={1}
        totalOnDeck={1}
      />
    );

    expect(screen.getByRole("heading", { name: /heads up/i })).toBeInTheDocument();
    expect(screen.getByText(/you're on deck/i)).toBeInTheDocument();
  });

  // ── MA-2 ─────────────────────────────────────────────────────
  it("MA-2: pending position 1 shows 'Coming Up Next' eyebrow", () => {
    render(
      <MatchAlert
        {...baseProps}
        matchStatus="pending"
        court={null}
        onDeckPosition={1}
        totalOnDeck={1}
      />
    );

    expect(screen.getByText(/coming up next/i)).toBeInTheDocument();
  });

  // ── MA-3 ─────────────────────────────────────────────────────
  it("MA-3: pending position 2 shows '#2 On Deck' eyebrow", () => {
    render(
      <MatchAlert
        {...baseProps}
        matchStatus="pending"
        court={null}
        onDeckPosition={2}
        totalOnDeck={3}
      />
    );

    expect(screen.getByText(/#2 on deck/i)).toBeInTheDocument();
  });

  // ── MA-4 ─────────────────────────────────────────────────────
  it("MA-4: pending position 2 shows '1 MATCH AHEAD IN LINE'", () => {
    render(
      <MatchAlert
        {...baseProps}
        matchStatus="pending"
        court={null}
        onDeckPosition={2}
        totalOnDeck={3}
      />
    );

    expect(screen.getByText(/1 match ahead in line/i)).toBeInTheDocument();
  });

  // ── MA-5 ─────────────────────────────────────────────────────
  it("MA-5: pending renders Your Team and Opponents column labels", () => {
    render(
      <MatchAlert
        {...baseProps}
        matchStatus="pending"
        court={null}
        onDeckPosition={1}
        totalOnDeck={1}
      />
    );

    expect(screen.getByText("Your Team")).toBeInTheDocument();
    expect(screen.getByText("Opponents")).toBeInTheDocument();
  });

  // ── MA-6 ─────────────────────────────────────────────────────
  it("MA-6: pending marks current player's row with 'You' label", () => {
    render(
      <MatchAlert
        {...baseProps}
        matchStatus="pending"
        court={null}
        onDeckPosition={1}
        totalOnDeck={1}
      />
    );

    // "You" label appears on the current player's row
    expect(screen.getByText("You")).toBeInTheDocument();
    // Player display name is also rendered
    expect(screen.getByText("Me")).toBeInTheDocument();
  });

  // ── MA-7 ─────────────────────────────────────────────────────
  it("MA-7: pending shows Mixed Level banner when isMixedLevel=true", () => {
    render(
      <MatchAlert
        {...baseProps}
        matchStatus="pending"
        court={null}
        isMixedLevel={true}
        onDeckPosition={1}
        totalOnDeck={1}
      />
    );

    expect(screen.getByText(/mixed level match/i)).toBeInTheDocument();
  });

  // ── MA-8 ─────────────────────────────────────────────────────
  it("MA-8: in_progress renders court name as heading", () => {
    render(<MatchAlert {...baseProps} matchStatus="in_progress" court={mockCourt} />);

    // Court name is uppercased in the component via .toUpperCase()
    expect(screen.getByRole("heading", { name: /court 1/i })).toBeInTheDocument();
  });

  // ── MA-9 ─────────────────────────────────────────────────────
  it("MA-9: in_progress shows 'Active Court' eyebrow", () => {
    render(<MatchAlert {...baseProps} matchStatus="in_progress" court={mockCourt} />);

    expect(screen.getByText(/active court/i)).toBeInTheDocument();
  });

  // ── MA-10 ────────────────────────────────────────────────────
  it("MA-10: in_progress shows 'Match in Progress' status pill", () => {
    render(<MatchAlert {...baseProps} matchStatus="in_progress" court={mockCourt} />);

    expect(screen.getByText(/match in progress/i)).toBeInTheDocument();
  });

  // ── MA-11 ────────────────────────────────────────────────────
  it("MA-11: in_progress shows Mixed Level banner when isMixedLevel=true", () => {
    render(
      <MatchAlert {...baseProps} matchStatus="in_progress" court={mockCourt} isMixedLevel={true} />
    );

    expect(screen.getByText(/mixed level match/i)).toBeInTheDocument();
  });

  // ── MA-12 ────────────────────────────────────────────────────
  it("MA-12: pending without court renders 'Heads Up' without crashing", () => {
    render(<MatchAlert {...baseProps} matchStatus="pending" court={null} />);

    expect(screen.getByRole("heading", { name: /heads up/i })).toBeInTheDocument();
  });
});
