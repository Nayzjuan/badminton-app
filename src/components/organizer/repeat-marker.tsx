"use client";

// ============================================================
// RepeatMarker — per-row "picking this repeats a pairing" chip
// ============================================================
// Shipped in BOTH queue renderers (the flat List table and the By-Skill
// cards) because they share one selection: a marker that appears in one
// lens and not the other reads as a bug, not as a lens difference.
//
// Placement rule: ALWAYS inline, immediately after the display name. The
// List table is `min-w-[640px]` inside an `overflow-x-auto`, so anything
// right-aligned is off-screen on a phone — the exact device the organizer
// is holding when they hand-build a match.
//
// A11y: the icon is `aria-hidden` and the visible micro-label is too; the
// accessible text is a real `<span className="sr-only">` node. `aria-label`
// is unreliable on an implicit `role=generic` container, and the chip is
// not focusable, so a title tooltip alone would never reach a screen reader.
//
// Colour: `cc-amber` — the sanctioned organizer warning hue. `cc-accent`
// (teal) already means SELECTED on this screen and must never be reused
// here. Teammate vs opponent is carried on the ICON and the LABEL
// ("TEAM" / "OPP"), never on hue alone.
// ============================================================

import { Sparkles, Swords, Users } from "lucide-react";
import {
  freshLabel,
  freshTitle,
  markerLabel,
  markerLegend,
  markerTitle,
  ordinal,
} from "@/lib/repeat-pairing-copy";
import type { LegendFamilies, NameLookup } from "@/lib/repeat-pairing-copy";
import type { CandidateMarker } from "@/lib/repeat-pairing";

interface RepeatMarkerProps {
  marker: CandidateMarker;
  nameOf: NameLookup;
}

export function RepeatMarker({ marker, nameOf }: RepeatMarkerProps) {
  // The chip shows the PRIMARY relation and that relation's OWN count.
  // `worstCount` is the max across ALL relations while `primaryRelation` is
  // teammate-first regardless of count, so pairing the two would weld the
  // teammate word to an opponent number ("TEAM 6TH" for a 3rd-time teammate
  // who has also faced someone 5x). relations[0] is the primary by
  // construction — deriveCandidateMarkers sorts teammate-first, then count
  // desc — so reading its count keeps word and number self-consistent.
  const primary = marker.relations[0];
  // deriveCandidateMarkers never emits an empty `relations` (it `continue`s
  // first), but this is now an indexed read and the repo does not enable
  // noUncheckedIndexedAccess — so a future producer with [] would crash the
  // whole queue tab for an advisory chip. Render nothing instead.
  if (!primary) return null;
  const isTeammate = primary.relation === "teammate";
  const Icon = isTeammate ? Users : Swords;

  return (
    <span
      data-testid="repeat-marker"
      title={markerTitle(marker, nameOf)}
      className="clip-cut-badge inline-flex shrink-0 items-center gap-1 border border-cc-amber/40
                 bg-cc-amber-dim px-1.5 py-0.5 font-command text-[9px] uppercase
                 tracking-[0.10em] text-cc-amber"
    >
      <Icon className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
      <span data-testid="repeat-marker-label" aria-hidden="true">
        {isTeammate ? "Team" : "Opp"} {ordinal(primary.count + 1)}
      </span>
      <span className="sr-only">{markerLabel(marker, nameOf)}</span>
    </span>
  );
}

/**
 * The fresh set bundled WITH the referent it was computed against.
 *
 * One prop rather than three for the same reason `markers` and `nameOf` are
 * both required together: the set is meaningless without the slot context, and
 * separate props let a renderer drift a stale referent against a fresh set —
 * which would label rows "no games with Alice" while pointing at Bob.
 * `null` means the family is gated off; renderers show nothing.
 */
export type FreshContext = {
  ids: ReadonlySet<string>;
  partnerId: string | null;
  opponentIds: string[];
};

interface FreshMarkerProps {
  /** Same referent the legend names — a chip saying only "Fresh" is unanchored. */
  partnerId: string | null;
  opponentIds: string[];
  nameOf: NameLookup;
}

/**
 * FreshMarker — the positive counterpart to RepeatMarker.
 *
 * Answers the question the amber chip structurally cannot: an unmarked row is
 * either "never played with any of them" or "played with one of them once",
 * and those are very different picks when you are hand-building a match after
 * clearing the engine's draft.
 *
 * Occupies the SAME inline position as RepeatMarker, immediately after the
 * name. They never collide — a marker needs count >= 2 and a fresh chip needs
 * count === 0 against the same referent set — so at most one renders per row.
 *
 * Colour: `cc-fresh`, added for this chip. Not `cc-accent` (teal), which means
 * SELECTED on this screen, and not `cc-live`/`cc-streak` (orange), which read
 * as urgency. Per the house rule the meaning is carried on the LABEL too, so
 * the chip survives being seen in greyscale or by a red-green-deficient eye.
 */
export function FreshMarker({ partnerId, opponentIds, nameOf }: FreshMarkerProps) {
  return (
    <span
      data-testid="fresh-marker"
      title={freshTitle(partnerId, opponentIds, nameOf)}
      className="clip-cut-badge inline-flex shrink-0 items-center gap-1 border border-cc-fresh/40
                 bg-cc-fresh-dim px-1.5 py-0.5 font-command text-[9px] uppercase
                 tracking-[0.10em] text-cc-fresh"
    >
      <Sparkles className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
      <span data-testid="fresh-marker-label" aria-hidden="true">
        Fresh
      </span>
      <span className="sr-only">{freshLabel(partnerId, opponentIds, nameOf)}</span>
    </span>
  );
}

interface RepeatMarkerLegendProps {
  team: "A" | "B";
  partnerId: string | null;
  opponentIds: string[];
  nameOf: NameLookup;
  /** Which chip families are actually on screen. Both are independently gated. */
  families: LegendFamilies;
}

/**
 * Resolves what the row glyphs refer to. Without it the markers are
 * unanchored — "a repeat with *whom*?" — because the relevant partner is
 * whichever slot the next tap happens to fill.
 *
 * The leading icon follows `families` rather than being fixed amber: on a
 * fresh-only screen an amber glyph would be the only warning-coloured thing
 * present, labelling a line that is not a warning.
 */
export function RepeatMarkerLegend({
  team,
  partnerId,
  opponentIds,
  nameOf,
  families,
}: RepeatMarkerLegendProps) {
  const freshOnly = families.fresh && !families.repeats;
  const Icon = freshOnly ? Sparkles : Users;
  return (
    <p
      data-testid="repeat-marker-legend"
      className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-cc-t2"
    >
      <Icon
        className={`mt-0.5 h-3 w-3 shrink-0 ${freshOnly ? "text-cc-fresh" : "text-cc-amber"}`}
        aria-hidden="true"
      />
      <span>{markerLegend(team, partnerId, opponentIds, nameOf, families)}</span>
    </p>
  );
}
