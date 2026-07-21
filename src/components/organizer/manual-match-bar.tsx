"use client";

// ============================================================
// ManualMatchBar — the sticky head of the manual-match builder
// ============================================================
// STICKY/NON-STICKY SPLIT. On a 375x667 phone a bar that carries the full
// warning detail leaves under three queue rows visible — i.e. it hides the
// very list the organizer is picking from. So this component holds only
// what must stay on screen while they scroll the queue:
//
//   row 1  selection count + the CTA slot + Clear
//   row 2  team preview (tap a name to move it across the net)
//   row 3  ONE line-clamped headline + a "+N more" disclosure button
//
// Everything else — the full per-pair rows, the expanded match lists, and
// the creation error — renders BELOW the bar and scrolls normally. There is
// deliberately no `overflow-y-auto` in here: a scroller inside a sticky
// element is a trap on touch (the page stops scrolling when your thumb
// lands on it). The height is hard-capped instead.
//
// STICKY OFFSET. `organizer-dashboard.tsx` renders its header as
// `sticky top-0 z-20`, so a `top-0 z-10` bar would be invisible underneath
// it. The dashboard publishes its measured header height as `--cc-header-h`
// (ResizeObserver — the header's height genuinely changes with breakpoint
// and session state), and this bar offsets by it at `z-[15]`: above the
// queue's `z-10` checkbox hit-areas, below the header.
//
// SURFACES. Opaque `cc-*` only. The pre-existing amber tint was
// `dark:bg-amber-950/30` — 30% translucent, so queue rows scrolled visibly
// through the sticky bar. `cc-accent` (teal) already means SELECTED on this
// screen, so it marks readiness (4 of 4) and never the warning; the warning
// is `cc-amber` with the relation carried on icon + label.
// ============================================================

import { AlertTriangle, Swords } from "lucide-react";
import { pairHeadline } from "@/lib/repeat-pairing-copy";
import type { NameLookup } from "@/lib/repeat-pairing-copy";
import { deriveTeams, filledCount, type PairWarning, type Slots } from "@/lib/repeat-pairing";

interface ManualMatchBarProps {
  slots: Slots;
  requiredPlayers: number;
  nameOf: NameLookup;
  creating: boolean;
  onCreate: () => void;
  onClear: () => void;
  /** Move the player in this slot to the other side of the net. */
  onMoveAcrossNet: (slotIndex: number) => void;
  /** Stable headline pair for this build episode, or null. */
  headline: PairWarning | null;
  /** Total repeat pairings in the current selection (headline included). */
  warningCount: number;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  /** id of the non-sticky details region this bar's button controls. */
  detailsId: string;
}

export function ManualMatchBar({
  slots,
  requiredPlayers,
  nameOf,
  creating,
  onCreate,
  onClear,
  onMoveAcrossNet,
  headline,
  warningCount,
  detailsOpen,
  onToggleDetails,
  detailsId,
}: ManualMatchBarProps) {
  const filled = filledCount(slots);
  const isReady = filled === requiredPlayers;
  const hasSelection = filled > 0;

  return (
    <div
      data-testid="manual-match-bar"
      // Hard height cap, no inner scroller — see the header comment.
      // The offset lives in the className, not an inline style, so the whole
      // sticky contract (offset + stacking + cap) reads in one place and can
      // be asserted in a DOM test. The fallback matters: the dashboard header
      // measures ~178px on a phone, and before the ResizeObserver first fires
      // a `top:0` bar would render underneath it.
      className={`clip-cut-sm sticky top-[var(--cc-header-h,176px)] z-[15]
                  max-h-[min(33vh,200px)] overflow-hidden border bg-cc-bg-2 p-3
                  transition-colors duration-200 ${
                    isReady
                      ? "border-cc-accent/60"
                      : hasSelection
                        ? "border-cc-border-hi"
                        : "border-cc-border"
                  }`}
    >
      {/* ── Row 1: count · CTA · Clear ─────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-cc-t1">
            {filled === 0
              ? "Select 4 players to create a manual match"
              : `${filled} of ${requiredPlayers} players selected`}
          </p>
          {hasSelection && !isReady && (
            <p className="text-xs text-cc-t3">Select {requiredPlayers - filled} more</p>
          )}
        </div>

        {/* The CTA slot is RESERVED from the first pick (invisible, not
            unmounted) so the row does not jump height on the 4th tap —
            which is precisely when a mis-tap creates the wrong match. */}
        {hasSelection && (
          <button
            type="button"
            onClick={onCreate}
            // NEVER disabled by the warning — only by the in-flight create.
            // The whole feature is advisory; a disabled CTA would make it a gate.
            disabled={creating}
            aria-hidden={isReady ? undefined : true}
            tabIndex={isReady ? undefined : -1}
            className={`clip-cut-badge min-h-[44px] shrink-0 whitespace-nowrap border
                        border-cc-accent/50 bg-cc-accent px-5 font-command text-[10px]
                        uppercase tracking-[0.12em] text-cc-btn-on-accent transition-colors
                        duration-200 hover:bg-cc-accent/90 focus-visible:outline-none
                        focus-visible:ring-2 focus-visible:ring-cc-accent disabled:cursor-not-allowed
                        disabled:opacity-50 ${isReady ? "" : "pointer-events-none invisible"}`}
          >
            {creating ? "Adding…" : "Add to On Deck"}
          </button>
        )}

        {hasSelection && (
          <button
            type="button"
            onClick={onClear}
            className="min-h-[44px] shrink-0 px-2 text-xs text-cc-t3 underline transition-colors
                       duration-200 hover:text-cc-t1 focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-cc-accent"
          >
            Clear
          </button>
        )}
      </div>

      {/* ── Row 2: team preview + swap-across-the-net ──────────
          Always on from the first pick, so the slot model is legible
          BEFORE a warning appears. Moving one player across the net is
          the remedy for most teammate flags, which is what makes the
          warning actionable rather than merely disapproving. */}
      {hasSelection && <TeamPreview slots={slots} nameOf={nameOf} onMove={onMoveAcrossNet} />}

      {/* ── Row 3: ONE headline + disclosure ───────────────────
          Plain markup, no live semantics — the sr-only status node in
          QueueControl owns announcement, on a trailing debounce. */}
      {headline && (
        <div className="mt-2 flex items-center gap-2 border-t border-cc-border pt-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-cc-amber" aria-hidden="true" />
          <p
            data-testid="repeat-headline"
            className="line-clamp-1 min-w-0 flex-1 font-sans text-sm font-semibold text-cc-t1"
          >
            {pairHeadline(headline, nameOf)}
          </p>
          <button
            type="button"
            onClick={onToggleDetails}
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            className="clip-cut-badge min-h-[44px] shrink-0 whitespace-nowrap border
                       border-cc-amber/40 bg-cc-amber-dim px-2.5 font-command text-[9px]
                       uppercase tracking-[0.10em] text-cc-amber transition-colors duration-200
                       hover:bg-cc-amber/20 focus-visible:outline-none focus-visible:ring-2
                       focus-visible:ring-cc-accent"
          >
            {detailsOpen ? (
              <>
                Hide<span className="sr-only"> repeat pairing details</span>
              </>
            ) : warningCount > 1 ? (
              <>
                +{warningCount - 1} more
                <span className="sr-only">
                  {" "}
                  repeat {warningCount - 1 === 1 ? "pairing" : "pairings"} — show details
                </span>
              </>
            ) : (
              <>
                Details<span className="sr-only"> — show the prior matches</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Team preview ─────────────────────────────────────────────

function TeamPreview({
  slots,
  nameOf,
  onMove,
}: {
  slots: Slots;
  nameOf: NameLookup;
  onMove: (slotIndex: number) => void;
}) {
  const { teamA, teamB } = deriveTeams(slots);

  return (
    <div
      data-testid="team-preview"
      className="mt-2 flex min-w-0 items-center gap-2 overflow-hidden"
    >
      <TeamSide letter="A" slotIndices={[0, 1]} slots={slots} nameOf={nameOf} onMove={onMove} />
      <Swords className="h-3 w-3 shrink-0 text-cc-t3" aria-hidden="true" />
      <TeamSide letter="B" slotIndices={[2, 3]} slots={slots} nameOf={nameOf} onMove={onMove} />
      <span className="sr-only">
        Team A: {teamA.length ? teamA.map(nameOf).join(" and ") : "empty"}. Team B:{" "}
        {teamB.length ? teamB.map(nameOf).join(" and ") : "empty"}.
      </span>
    </div>
  );
}

function TeamSide({
  letter,
  slotIndices,
  slots,
  nameOf,
  onMove,
}: {
  letter: "A" | "B";
  slotIndices: number[];
  slots: Slots;
  nameOf: NameLookup;
  onMove: (slotIndex: number) => void;
}) {
  const other = letter === "A" ? "B" : "A";

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      {/* Explicit letter — team identity is never carried by hue alone. */}
      <span
        aria-hidden="true"
        className="shrink-0 font-command text-[10px] font-bold uppercase tracking-[0.12em] text-cc-t3"
      >
        {letter}
      </span>
      {slotIndices.map((i) => {
        const id = slots[i] ?? null;
        if (!id) {
          return (
            <span
              key={i}
              aria-hidden="true"
              className="flex min-h-[44px] flex-1 basis-0 items-center justify-center text-sm text-cc-t3"
            >
              —
            </span>
          );
        }
        const name = nameOf(id);
        return (
          <button
            key={i}
            type="button"
            onClick={() => onMove(i)}
            title={`Move ${name} to Team ${other}`}
            aria-label={`Move ${name} to Team ${other}`}
            // `basis-0 flex-1` (not the default `basis-auto`) so all four
            // names share the row EQUALLY. With auto basis a single long
            // name takes the width and starves the others down to "B…".
            className="clip-cut-badge min-h-[44px] min-w-0 flex-1 basis-0 truncate border
                       border-cc-border bg-cc-bg-3 px-2 text-sm text-cc-t1 transition-colors
                       duration-200 hover:border-cc-accent hover:text-cc-accent
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset
                       focus-visible:ring-cc-accent"
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}
