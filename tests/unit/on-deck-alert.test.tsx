// @vitest-environment happy-dom
// ============================================================
// Component Tests — OnDeckAlert
// ============================================================
// OnDeckAlert shows an "approaching" banner above QueueStatus
// when the player is near the front of the line (positions 1–4).
// It renders null for any other state (match active, not waiting,
// position > ON_DECK_ALERT_THRESHOLD).
//
// ODA-1  position=1 → "You're Next!" (amber, urgent)
// ODA-2  position=2 → "Almost there…" (amber, urgent)
// ODA-3  position=3 → "Get ready!" (sky/blue, non-urgent)
// ODA-4  position=4 → "Coming up soon" (sky/blue, non-urgent)
// ODA-5  position=5 → returns null (above threshold)
// ODA-6  queueStatus="drafted" → returns null (not waiting)
// ODA-7  queueStatus="on_deck" → returns null
// ODA-8  matchStatus set → returns null (match overlay takes over)
// ODA-9  role="status" present on rendered output (accessibility)
// ODA-10 aria-label includes position and label text
// ============================================================

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { OnDeckAlert } from "@/components/player/on-deck-alert";

describe("OnDeckAlert — Component Tests", () => {
  // ── ODA-1 ──────────────────────────────────────────────────────

  it("ODA-1: position=1 renders 'You're Next!' with amber urgency styling", () => {
    render(<OnDeckAlert matchStatus={null} queueStatus="waiting" position={1} />);

    expect(screen.getByText("You're Next!")).toBeInTheDocument();
    // role="status" is the semantic landmark for this live region
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  // ── ODA-2 ──────────────────────────────────────────────────────

  it("ODA-2: position=2 renders 'Almost there…'", () => {
    render(<OnDeckAlert matchStatus={null} queueStatus="waiting" position={2} />);

    expect(screen.getByText("Almost there…")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  // ── ODA-3 ──────────────────────────────────────────────────────

  it("ODA-3: position=3 renders 'Get ready!' (sky, non-urgent)", () => {
    render(<OnDeckAlert matchStatus={null} queueStatus="waiting" position={3} />);

    expect(screen.getByText("Get ready!")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  // ── ODA-4 ──────────────────────────────────────────────────────

  it("ODA-4: position=4 renders 'Coming up soon'", () => {
    render(<OnDeckAlert matchStatus={null} queueStatus="waiting" position={4} />);

    expect(screen.getByText("Coming up soon")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  // ── ODA-5 ──────────────────────────────────────────────────────

  it("ODA-5: position=5 renders nothing (above threshold)", () => {
    const { container } = render(
      <OnDeckAlert matchStatus={null} queueStatus="waiting" position={5} />
    );

    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // ── ODA-6 ──────────────────────────────────────────────────────

  it("ODA-6: queueStatus='drafted' renders nothing (match overlay owns this state)", () => {
    const { container } = render(
      <OnDeckAlert matchStatus={null} queueStatus="drafted" position={1} />
    );

    expect(container.firstChild).toBeNull();
  });

  // ── ODA-7 ──────────────────────────────────────────────────────

  it("ODA-7: queueStatus='on_deck' renders nothing", () => {
    const { container } = render(
      <OnDeckAlert matchStatus={null} queueStatus="on_deck" position={1} />
    );

    expect(container.firstChild).toBeNull();
  });

  // ── ODA-8 ──────────────────────────────────────────────────────

  it("ODA-8: when matchStatus is set the banner is suppressed (MatchAlert takes over)", () => {
    const { container } = render(
      <OnDeckAlert matchStatus="pending" queueStatus="waiting" position={1} />
    );

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("You're Next!")).not.toBeInTheDocument();
  });

  // ── ODA-9 ──────────────────────────────────────────────────────

  it("ODA-9: rendered element has role='status' for screen-reader live region", () => {
    render(<OnDeckAlert matchStatus={null} queueStatus="waiting" position={2} />);

    const el = screen.getByRole("status");
    expect(el).toBeInTheDocument();
  });

  // ── ODA-10 ─────────────────────────────────────────────────────

  it("ODA-10: aria-label includes the position number and the label text", () => {
    render(<OnDeckAlert matchStatus={null} queueStatus="waiting" position={3} />);

    const el = screen.getByRole("status");
    expect(el).toHaveAttribute("aria-label", expect.stringContaining("3"));
    expect(el).toHaveAttribute("aria-label", expect.stringContaining("Get ready!"));
  });
});
