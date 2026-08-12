// ============================================================
// repeat-pairing-copy — the words for the manual-match repeat warning
// ============================================================
// Pure string builders, kept out of the components so the exact wording
// is unit-testable and identical across the three surfaces that use it:
// the sticky bar headline, the per-row markers, and the screen-reader
// announcement.
//
// Two registers on purpose:
//   * VISIBLE copy may use "2x" and glyphs — it is scanned, not read.
//   * SPOKEN copy (sr-only / aria) spells everything out: some screen
//     readers skip or mangle the multiplication sign.
//
// Vocabulary rules (from the design review):
//   * Counts are always PRIOR counts — "have partnered 2x" means twice
//     BEFORE the match being built. The marker copy converts to an
//     ordinal ("would be a 3rd match") so the two never read as
//     contradicting each other.
//   * Cross-net pairs are "opponents", never "faced" — Wrapped already
//     owns "faced" and reusing it would imply the same statistic.
// ============================================================

import type { CandidateMarker, PairRelation, PairWarning } from "@/lib/repeat-pairing";

/** id -> display name. Falls back to "Unknown" so copy never renders "undefined". */
export type NameLookup = (playerId: string) => string;

/** 1st, 2nd, 3rd, 4th … (English ordinals, including the 11-13 exception). */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** "a", "a and b", "a, b and c" */
export function joinWithAnd(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Plural-safe "1 player" / "2 players". */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Human label for a relation — carried on the LABEL, never on hue alone. */
export function relationNoun(relation: PairRelation): string {
  return relation === "teammate" ? "Teammates" : "Opponents";
}

/**
 * The one-line headline for a triggered pair (visible register).
 * Deliberately explains WHY it matters — but the two relations do not mean
 * the same thing to the engine, and the copy must not pretend they do:
 *
 *   * TEAMMATE is a HARD cap. `snakeDraft` returns null when every split puts
 *     a team pair at MAX_PARTNERSHIP_REPEATS, and every call site passes that
 *     cap — including the last-resort fallback. So "won't pair them again" is
 *     literally true, and the organizer is knowingly overriding it.
 *   * OPPONENT is a SOFT preference. `MAX_OPPONENT_REPEATS` only ranks splits
 *     ("PREFERS splits where no cross-net pair is at the opponent cap — never
 *     a hard block so the engine cannot stall on small sessions"). This line
 *     used to promise "won't match them again", which is simply false: the
 *     engine will absolutely re-run the pairing when nothing better exists.
 *     An organizer who trusted it would read every such rematch as a bug.
 */
export function pairHeadline(w: PairWarning, nameOf: NameLookup): string {
  const a = nameOf(w.playerIds[0]);
  const b = nameOf(w.playerIds[1]);
  return w.relation === "teammate"
    ? `${a} & ${b} have partnered ${w.count}× tonight — auto-matchmaking won't pair them again`
    : `${a} & ${b} have been opponents ${w.count}× tonight — auto-matchmaking avoids this, but won't refuse it`;
}

/** Compact per-pair row tail, e.g. "2 prior matches". */
export function pairRowSummary(w: PairWarning): string {
  return `${w.count} prior ${plural(w.count, "match", "matches")}`;
}

/**
 * Screen-reader register for a triggered pair. No glyphs, explicit words.
 */
export function pairHeadlineSpoken(w: PairWarning, nameOf: NameLookup): string {
  const a = nameOf(w.playerIds[0]);
  const b = nameOf(w.playerIds[1]);
  const verb = w.relation === "teammate" ? "partnered" : "been opponents";
  return `${a} and ${b} have ${verb} ${w.count} ${plural(w.count, "time", "times")} tonight.`;
}

/**
 * The coalesced live-region string for the current selection.
 * Empty string when there is nothing to say — an empty live region is
 * silent, which is the correct outcome for "no repeats".
 */
export function announcementFor(warnings: PairWarning[], nameOf: NameLookup): string {
  if (warnings.length === 0) return "";
  const head = pairHeadlineSpoken(warnings[0], nameOf);
  const rest = warnings.length - 1;
  return rest > 0
    ? `Repeat pairing. ${head} ${rest} other repeat ${plural(rest, "pairing", "pairings")} in this match.`
    : `Repeat pairing. ${head}`;
}

/**
 * The sr-only text node that rides alongside a row marker icon.
 * Lists EVERY triggered relation — filling a Team B slot can repeat a
 * teammate and both opponents at once, and a single glyph can't say that.
 */
export function markerLabel(m: CandidateMarker, nameOf: NameLookup): string {
  const parts = m.relations.map(
    (r) =>
      `a ${ordinal(r.count + 1)} match with ${nameOf(r.withPlayerId)} as ${
        r.relation === "teammate" ? "teammates" : "opponents"
      }`
  );
  return `Repeat pairing: picking this player would be ${joinWithAnd(parts)}.`;
}

/** Short visible tooltip for the same marker. */
export function markerTitle(m: CandidateMarker, nameOf: NameLookup): string {
  const parts = m.relations.map(
    (r) =>
      `${ordinal(r.count + 1)} with ${nameOf(r.withPlayerId)} as ${
        r.relation === "teammate" ? "teammates" : "opponents"
      }`
  );
  return joinWithAnd(parts);
}

/** Which chip families are on screen — the legend must describe all of them. */
export type LegendFamilies = { repeats: boolean; fresh: boolean };

/** Amber only, the behaviour before FRESH chips existed. */
const REPEATS_ONLY: LegendFamilies = { repeats: true, fresh: false };

/**
 * Resolves the referent for the row markers: which slot the next tap
 * fills, and who that makes the candidate a teammate / opponent of.
 * Without this the glyphs are unanchored ("a repeat with *whom*?").
 *
 * `families` matters because the two chip families are independently gated —
 * the amber markers sit behind the avoidability gate and the FRESH chips
 * behind the discrimination gate, so either can be on screen alone. A legend
 * that only ever mentions repeats would leave a screen full of green chips
 * unexplained, which is the same defect this line was written to fix.
 */
export function markerLegend(
  team: "A" | "B",
  partnerId: string | null,
  opponentIds: string[],
  nameOf: NameLookup,
  families: LegendFamilies = REPEATS_ONLY
): string {
  const bits: string[] = [];
  if (partnerId) bits.push(`alongside ${nameOf(partnerId)}`);
  if (opponentIds.length > 0) {
    bits.push(`against ${joinWithAnd(opponentIds.map(nameOf))}`);
  }
  const where = bits.length > 0 ? ` (Team ${team}, ${bits.join(", ")})` : ` (Team ${team})`;

  // The combined line repeats the fresh-only phrasing verbatim rather than
  // shortening it to "…no games with them yet": the nearest plural antecedent
  // for "them" is *Marked players*, and that reading is false — a fresh player
  // may well have played with a marked one. On a change whose whole premise is
  // that the copy must not assert something untrue, the longer clause wins.
  const FRESH_CLAUSE = "Fresh players have no games yet with whoever the next pick joins";
  const REPEATS_CLAUSE = "Marked players would repeat a pairing if picked next";
  const subject =
    families.repeats && families.fresh
      ? `${REPEATS_CLAUSE}; ${FRESH_CLAUSE}`
      : families.fresh
        ? FRESH_CLAUSE
        : REPEATS_CLAUSE;
  return `${subject}${where}.`;
}

/**
 * Visible tooltip for a FRESH chip. Names everyone the pick touches, because
 * "fresh" is only meaningful relative to a referent — and unlike the amber
 * chip there is no count to carry the meaning.
 */
export function freshTitle(
  partnerId: string | null,
  opponentIds: string[],
  nameOf: NameLookup
): string {
  const ids = [...(partnerId ? [partnerId] : []), ...opponentIds];
  if (ids.length === 0) return "No games yet tonight";
  return `No games with ${joinWithAnd(ids.map(nameOf))} yet tonight`;
}

/**
 * Screen-reader register for the same chip. Spells out that BOTH roles are
 * covered — a listener who hears only "no games with Alice" cannot tell
 * whether that means never partnered, never faced, or neither.
 */
export function freshLabel(
  partnerId: string | null,
  opponentIds: string[],
  nameOf: NameLookup
): string {
  const ids = [...(partnerId ? [partnerId] : []), ...opponentIds];
  if (ids.length === 0) return "Fresh pick: no games yet tonight.";
  return `Fresh pick: no games with ${joinWithAnd(
    ids.map(nameOf)
  )} yet tonight, as teammates or opponents.`;
}
