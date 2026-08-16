// @vitest-environment happy-dom
// ============================================================
// Component Tests — the organizer-facing half of the held-draft fix
// ============================================================
// Two surfaces, one rule (isHeldAwaitingReadiness):
//
//   SortableCard  — an unready held draft must not offer a Publish button. It
//     used to render one unguarded, so the organizer's only available action was
//     one that could not succeed: HOLDING publishes returned CONFLICT (the
//     fourth player is mid-game on another court), and RESTING publishes
//     "succeeded" into a stuck, un-promotable on-deck card.
//
//   OnDeckPanel   — the review-queue count and the cap it is compared against
//     both have to match what runEngineInternal actually enforces. Held drafts
//     are excluded from the engine's draft-mode cap count, and the engine caps
//     at min(override, dynamicCap). The panel used to count held drafts AND
//     ignore the override, so with max_auto_drafts_override = 1 the engine
//     stopped generating at one draft while the notice sat waiting for three —
//     the organizer saw generation stop with no explanation at all. That is the
//     configuration the 08/15 live session was running.
//
// UI-HELD-*  SortableCard publish suppression
// UI-CAP-*   OnDeckPanel review-queue count + effective cap
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { SortableCard } from "@/components/organizer/sortable-card";
import { OnDeckPanel } from "@/components/organizer/on-deck-panel";
import type { EnrichedMatch } from "@/hooks/use-organizer-data";
import { MAX_AUTO_DRAFTS } from "@/lib/constants";

// H2HStrip fetches head-to-head history through Supabase. It renders null for a
// first meeting anyway, so stub the hook rather than the network.
vi.mock("@/hooks/use-h2h", () => ({
  useH2H: () => ({ record: null, loading: false, error: null }),
}));

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const STAMP = "2026-08-16T00:00:00.000Z";

// ── Fixtures ──────────────────────────────────────────────────

type RosterRow = EnrichedMatch["players"][number];

const seat = (id: string, name: string, team: "a" | "b"): RosterRow =>
  ({
    id: `mp-${id}`,
    player_id: id,
    team,
    win_streak: 0,
    profile: {
      id,
      display_name: name,
      skill_level: "intermediate",
      vip_tag: null,
      vip_theme: null,
    },
  }) as unknown as RosterRow;

const ROSTER = [
  seat("p1", "Ana", "a"),
  seat("p2", "Ben", "a"),
  seat("p3", "Cara", "b"),
  seat("p4", "Dev", "b"),
];

const makeMatch = (over: Partial<EnrichedMatch> = {}): EnrichedMatch =>
  ({
    id: "m1",
    session_id: SESSION_ID,
    created_at: new Date().toISOString(),
    status: "pending",
    is_published: false,
    is_held: false,
    held_ready_at: null,
    pulled_player_ids: [],
    pulled_from_match_id: null,
    is_mixed_level: false,
    // Generated column, NOT NULL — MatchOriginTag parses it unguarded.
    final_classification: "auto_clean",
    court: null,
    court_id: null,
    players: ROSTER,
    ...over,
  }) as unknown as EnrichedMatch;

/** is_held with no stamp — HOLDING or RESTING, the two unpublishable states. */
const unreadyHold = (over: Partial<EnrichedMatch> = {}) =>
  makeMatch({
    is_held: true,
    held_ready_at: null,
    pulled_player_ids: ["p4"],
    final_classification: "held_clean",
    ...over,
  });

/** is_held WITH a stamp — READY, and publishable like any other draft. */
const readyHold = (over: Partial<EnrichedMatch> = {}) =>
  makeMatch({
    is_held: true,
    held_ready_at: STAMP,
    pulled_player_ids: ["p4"],
    final_classification: "held_clean",
    ...over,
  });

function renderCard(match: EnrichedMatch, isDraft = true) {
  return render(
    <DndContext>
      <SortableContext items={[match.id]}>
        <SortableCard
          match={match}
          sectionIndex={0}
          isDraft={isDraft}
          isClearing={false}
          isPublishing={false}
          isOptimisticPublished={false}
          swapContext={null}
          onClear={vi.fn()}
          onPublish={vi.fn()}
          onPlayerTap={vi.fn()}
        />
      </SortableContext>
    </DndContext>
  );
}

const noop = vi.fn().mockResolvedValue({});

function renderPanel(matches: EnrichedMatch[], over: Record<string, unknown> = {}) {
  return render(
    <OnDeckPanel
      matches={matches}
      swapContext={null}
      onClearOnDeckMatch={noop}
      onReorderMatches={noop}
      onPlayerTap={vi.fn()}
      onPublishMatch={noop}
      onPublishAllDrafts={noop}
      isAutoMatchmakingOn
      waitingCount={8}
      {...over}
    />
  );
}

// ─────────────────────────────────────────────────────────────
// SortableCard
// ─────────────────────────────────────────────────────────────

describe("SortableCard — publish suppression for unready holds", () => {
  it("UI-HELD-1: an unready hold offers Clear but not Publish", () => {
    renderCard(unreadyHold());

    expect(screen.queryByRole("button", { name: /publish/i })).toBeNull();
    // Clear must survive. Abandoning the hold is the one legitimate action left,
    // and it is also how the organizer frees the three reserved players.
    expect(screen.getByRole("button", { name: /clear/i })).toBeInTheDocument();
  });

  it("UI-HELD-2: the suppression is explained, not silent", () => {
    renderCard(unreadyHold());

    // A button that vanishes with no reason reads as a bug. Two things carry the
    // explanation: the footer copy, and the violet HELD chip naming the player
    // still finishing. Neither is decorative.
    expect(screen.getByText(/publish unlocks when this hold is ready/i)).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /waiting on Dev to finish/i })).toBeInTheDocument();
  });

  it("UI-HELD-3: a stamped hold gets its Publish button back", () => {
    renderCard(readyHold());

    // held_ready_at is precisely what makes a hold publishable — suppressing a
    // READY hold would be the same bug with the sign flipped, and permanent.
    expect(screen.getByRole("button", { name: /publish/i })).toBeInTheDocument();
    expect(screen.getByText(/publish to reveal/i)).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /ready to promote/i })).toBeInTheDocument();
  });

  it("UI-HELD-4: a plain draft is untouched by the guard", () => {
    renderCard(makeMatch());

    expect(screen.getByRole("button", { name: /publish/i })).toBeInTheDocument();
    expect(screen.getByText(/publish to reveal/i)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────
// OnDeckPanel
// ─────────────────────────────────────────────────────────────
// waitingCount=8 ⇒ getDynamicDraftCap returns MAX_AUTO_DRAFTS (3): below both
// the LARGE (25) and XLARGE (30) thresholds. Every case below is written against
// MAX_AUTO_DRAFTS rather than a literal 3 so a constant change can't silently
// turn these into no-ops.

const CAP_NOTICE = /auto-generation paused/i;

describe("OnDeckPanel — draft cap notice", () => {
  it("UI-CAP-1: the override is the binding cap — one draft is enough to fire the notice", () => {
    renderPanel([makeMatch({ id: "d1" })], { maxAutoDraftsOverride: 1 });

    // The exact case the organizer cannot deduce for themselves: the engine
    // stopped at one draft because they set the ceiling to one, not because the
    // dynamic cap was reached. This notice used to be a strict under-reporter —
    // it could only fire when the dynamic cap was ALSO hit.
    expect(screen.getByRole("alert", { name: CAP_NOTICE })).toBeInTheDocument();
    expect(screen.getByText(/1\/1 draft slots filled/)).toBeInTheDocument();
  });

  it("UI-CAP-2: with no override the dynamic cap still governs", () => {
    renderPanel([makeMatch({ id: "d1" })], { maxAutoDraftsOverride: null });

    expect(screen.queryByRole("alert", { name: CAP_NOTICE })).toBeNull();
  });

  it("UI-CAP-3: the override never RAISES the cap above the dynamic one", () => {
    const drafts = Array.from({ length: MAX_AUTO_DRAFTS }, (_, i) => makeMatch({ id: `d${i}` }));
    renderPanel(drafts, { maxAutoDraftsOverride: MAX_AUTO_DRAFTS + 5 });

    // min(override, dynamicCap), exactly as runEngineInternal computes it. A
    // panel that took the override alone here would stay silent while the engine
    // was blocked — the same failure as UI-CAP-1 in the other direction.
    expect(screen.getByRole("alert", { name: CAP_NOTICE })).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`${MAX_AUTO_DRAFTS}/${MAX_AUTO_DRAFTS} draft slots filled`))
    ).toBeInTheDocument();
  });

  it("UI-CAP-4: an unready hold does not fill a review slot", () => {
    renderPanel([makeMatch({ id: "d1" }), unreadyHold({ id: "h1" })], {
      maxAutoDraftsOverride: 2,
    });

    // Counting it would produce the worst version of this notice: "2/2 draft
    // slots filled — publish the drafts below to resume", pointing at a card
    // whose Publish button UI-HELD-1 just removed. The engine excludes held
    // drafts from the same count, so the two agree.
    expect(screen.queryByRole("alert", { name: CAP_NOTICE })).toBeNull();
    // ...and it still RENDERS. It is not hidden — the organizer needs to see
    // that three players are reserved.
    expect(screen.getByRole("status", { name: /waiting on Dev to finish/i })).toBeInTheDocument();
  });

  it("UI-CAP-5: a stamped hold DOES fill a review slot", () => {
    renderPanel([makeMatch({ id: "d1" }), readyHold({ id: "h1" })], { maxAutoDraftsOverride: 2 });

    // Symmetry check for UI-CAP-4: a READY hold is an ordinary publishable draft
    // and must be counted, or the notice under-reports once holds resolve.
    expect(screen.getByRole("alert", { name: CAP_NOTICE })).toBeInTheDocument();
    expect(screen.getByText(/2\/2 draft slots filled/)).toBeInTheDocument();
  });

  it("UI-CAP-6: the Publish All banner counts the same review queue", () => {
    renderPanel([makeMatch({ id: "d1" }), unreadyHold({ id: "h1" })], {
      maxAutoDraftsOverride: null,
    });

    // Below the cap, so the banner shows instead of the notice. It must report
    // one match awaiting approval, not two — "2 waiting for approval" next to a
    // Publish All that can only ever publish one is the same lie the skip
    // message used to tell.
    expect(
      screen.getByRole("status", { name: /1 on-deck match waiting for approval/i })
    ).toBeInTheDocument();
  });
});
