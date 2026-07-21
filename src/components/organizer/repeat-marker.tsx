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

import { Swords, Users } from "lucide-react";
import { markerLabel, markerLegend, markerTitle, ordinal } from "@/lib/repeat-pairing-copy";
import type { NameLookup } from "@/lib/repeat-pairing-copy";
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

interface RepeatMarkerLegendProps {
  team: "A" | "B";
  partnerId: string | null;
  opponentIds: string[];
  nameOf: NameLookup;
}

/**
 * Resolves what the row glyphs refer to. Without it the markers are
 * unanchored — "a repeat with *whom*?" — because the relevant partner is
 * whichever slot the next tap happens to fill.
 */
export function RepeatMarkerLegend({
  team,
  partnerId,
  opponentIds,
  nameOf,
}: RepeatMarkerLegendProps) {
  return (
    <p
      data-testid="repeat-marker-legend"
      className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-cc-t2"
    >
      <Users className="mt-0.5 h-3 w-3 shrink-0 text-cc-amber" aria-hidden="true" />
      <span>{markerLegend(team, partnerId, opponentIds, nameOf)}</span>
    </p>
  );
}
