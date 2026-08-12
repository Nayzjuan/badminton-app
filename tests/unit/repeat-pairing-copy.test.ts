// ============================================================
// repeat-pairing-copy — the exact wording of the repeat warning
// ============================================================
// The copy is load-bearing, not decoration:
//   * PRIOR counts vs ORDINALS must never contradict each other on screen
//     ("partnered 2x" in the bar, "would be a 3rd match" on the row).
//   * The spoken register must not contain "x" glyphs — screen readers
//     mangle or skip U+00D7.
//   * Cross-net pairs are "Opponents", never "faced" (Wrapped owns "faced"
//     for a different statistic).
//
// IDs: RPC-O ordinals · RPC-J joins · RPC-H headlines · RPC-A announcement
//      RPC-M markers · RPC-L legend
// ============================================================

import { describe, it, expect } from "vitest";
import {
  announcementFor,
  joinWithAnd,
  markerLabel,
  freshLabel,
  freshTitle,
  markerLegend,
  markerTitle,
  ordinal,
  pairHeadline,
  pairHeadlineSpoken,
  pairRowSummary,
  relationNoun,
} from "@/lib/repeat-pairing-copy";
import { pairKey } from "@/lib/matchmaking-core";
import type { CandidateMarker, PairWarning } from "@/lib/repeat-pairing";

const NAMES: Record<string, string> = { p1: "Alice", p2: "Bob", p3: "Carol", p4: "Dave" };
const nameOf = (id: string) => NAMES[id] ?? "Unknown";

function warning(
  a: string,
  b: string,
  relation: "teammate" | "opponent",
  count: number
): PairWarning {
  return { pairKey: pairKey(a, b), playerIds: [a, b], relation, count };
}

function marker(playerId: string, relations: CandidateMarker["relations"]): CandidateMarker {
  return {
    playerId,
    relations,
    worstCount: Math.max(...relations.map((r) => r.count)),
    primaryRelation: relations[0].relation,
  };
}

describe("repeat-pairing-copy — ordinals", () => {
  it("RPC-O1: standard suffixes", () => {
    expect([1, 2, 3, 4, 5, 21, 22, 23].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "5th",
      "21st",
      "22nd",
      "23rd",
    ]);
  });

  it("RPC-O2: the 11-13 exception", () => {
    expect([11, 12, 13, 111, 112, 113].map(ordinal)).toEqual([
      "11th",
      "12th",
      "13th",
      "111th",
      "112th",
      "113th",
    ]);
  });
});

describe("repeat-pairing-copy — joins", () => {
  it("RPC-J1: 0, 1, 2 and 3 parts", () => {
    expect(joinWithAnd([])).toBe("");
    expect(joinWithAnd(["a"])).toBe("a");
    expect(joinWithAnd(["a", "b"])).toBe("a and b");
    expect(joinWithAnd(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("repeat-pairing-copy — headlines", () => {
  it("RPC-H1: teammate headline names the engine consequence", () => {
    const text = pairHeadline(warning("p1", "p2", "teammate", 2), nameOf);
    expect(text).toBe(
      "Alice & Bob have partnered 2× tonight — auto-matchmaking won't pair them again"
    );
  });

  it("RPC-H2: opponent headline says 'opponents', never 'faced'", () => {
    const text = pairHeadline(warning("p1", "p2", "opponent", 3), nameOf);
    expect(text).toContain("have been opponents 3×");
    expect(text).not.toMatch(/faced/i);
  });

  it("RPC-H2b: the opponent headline must NOT promise the engine will refuse", () => {
    // MAX_OPPONENT_REPEATS is a SOFT preference — snakeDraft only PREFERS
    // splits under it and never blocks, so the engine will happily re-run the
    // pairing when nothing better exists. The old copy said "won't match them
    // again", which made every such rematch look like a bug to the organizer.
    const text = pairHeadline(warning("p1", "p2", "opponent", 3), nameOf);
    expect(text).toBe(
      "Alice & Bob have been opponents 3× tonight — auto-matchmaking avoids this, but won't refuse it"
    );
    expect(text).not.toMatch(/won't match them again/);
    // The TEAMMATE claim is the one that is literally true (hard cap), so it
    // must survive untouched — asserting both together is what stops a future
    // edit from "harmonising" the two lines in the wrong direction.
    expect(pairHeadline(warning("p1", "p2", "teammate", 2), nameOf)).toContain(
      "won't pair them again"
    );
  });

  it("RPC-H3: relation nouns are Teammates / Opponents", () => {
    expect(relationNoun("teammate")).toBe("Teammates");
    expect(relationNoun("opponent")).toBe("Opponents");
  });

  it("RPC-H4: the row tail states the PRIOR count, pluralised", () => {
    expect(pairRowSummary(warning("p1", "p2", "teammate", 1))).toBe("1 prior match");
    expect(pairRowSummary(warning("p1", "p2", "teammate", 2))).toBe("2 prior matches");
  });

  it("RPC-H5: the spoken register contains no × glyph", () => {
    const spoken = pairHeadlineSpoken(warning("p1", "p2", "teammate", 2), nameOf);
    expect(spoken).toBe("Alice and Bob have partnered 2 times tonight.");
    expect(spoken).not.toContain("×");
  });

  it("RPC-H6: unknown ids degrade to 'Unknown', never 'undefined'", () => {
    const text = pairHeadline(warning("ghost", "p2", "teammate", 2), nameOf);
    expect(text).toContain("Unknown & Bob");
    expect(text).not.toContain("undefined");
  });
});

describe("repeat-pairing-copy — announcement", () => {
  it("RPC-A1: no warnings is the empty string (a silent live region)", () => {
    expect(announcementFor([], nameOf)).toBe("");
  });

  it("RPC-A2: a single warning is announced without a remainder clause", () => {
    const text = announcementFor([warning("p1", "p2", "teammate", 2)], nameOf);
    expect(text).toBe("Repeat pairing. Alice and Bob have partnered 2 times tonight.");
    expect(text).not.toMatch(/other repeat/);
  });

  it("RPC-A3: extra warnings are coalesced into a count, not enumerated", () => {
    const text = announcementFor(
      [
        warning("p1", "p2", "teammate", 2),
        warning("p1", "p3", "opponent", 2),
        warning("p2", "p4", "opponent", 2),
      ],
      nameOf
    );
    expect(text).toContain("Alice and Bob have partnered 2 times tonight.");
    expect(text).toContain("2 other repeat pairings in this match.");
    // Only the headline pair is named — enumerating all six pairs is unusable audio.
    expect(text).not.toContain("Carol");
  });

  it("RPC-A4: exactly one extra is singular", () => {
    const text = announcementFor(
      [warning("p1", "p2", "teammate", 2), warning("p1", "p3", "opponent", 2)],
      nameOf
    );
    expect(text).toContain("1 other repeat pairing in this match.");
  });

  it("RPC-A5: the announcement contains no × glyph", () => {
    expect(announcementFor([warning("p1", "p2", "opponent", 4)], nameOf)).not.toContain("×");
  });
});

describe("repeat-pairing-copy — markers", () => {
  it("RPC-M1: a single relation converts the PRIOR count to an ordinal", () => {
    const label = markerLabel(
      marker("p3", [{ relation: "teammate", withPlayerId: "p1", count: 2 }]),
      nameOf
    );
    expect(label).toBe(
      "Repeat pairing: picking this player would be a 3rd match with Alice as teammates."
    );
  });

  it("RPC-M2: every triggered relation is listed — one glyph cannot say three", () => {
    const label = markerLabel(
      marker("p4", [
        { relation: "teammate", withPlayerId: "p3", count: 2 },
        { relation: "opponent", withPlayerId: "p1", count: 3 },
        { relation: "opponent", withPlayerId: "p2", count: 2 },
      ]),
      nameOf
    );
    expect(label).toContain("a 3rd match with Carol as teammates");
    expect(label).toContain("a 4th match with Alice as opponents");
    expect(label).toContain("a 3rd match with Bob as opponents");
  });

  it("RPC-M3: the visible tooltip is the compact form of the same facts", () => {
    const title = markerTitle(
      marker("p3", [{ relation: "opponent", withPlayerId: "p1", count: 2 }]),
      nameOf
    );
    expect(title).toBe("3rd with Alice as opponents");
  });
});

describe("repeat-pairing-copy — legend", () => {
  it("RPC-L1: names the team AND both referents so the glyphs are anchored", () => {
    const text = markerLegend("B", "p3", ["p1", "p2"], nameOf);
    expect(text).toBe(
      "Marked players would repeat a pairing if picked next (Team B, alongside Carol, against Alice and Bob)."
    );
  });

  it("RPC-L2: omits the partner clause when that slot's partner is empty", () => {
    const text = markerLegend("A", null, ["p3"], nameOf);
    expect(text).toBe(
      "Marked players would repeat a pairing if picked next (Team A, against Carol)."
    );
    expect(text).not.toContain("alongside");
  });

  it("RPC-L3: degrades to the team alone when nothing else is selected", () => {
    expect(markerLegend("A", null, [], nameOf)).toBe(
      "Marked players would repeat a pairing if picked next (Team A)."
    );
  });

  it("RPC-L4: the default families argument reproduces the pre-FRESH string", () => {
    // Callers that predate the FRESH chips must be unaffected by the new
    // parameter — same call, same bytes.
    expect(markerLegend("B", "p3", ["p1", "p2"], nameOf)).toBe(
      markerLegend("B", "p3", ["p1", "p2"], nameOf, { repeats: true, fresh: false })
    );
  });

  it("RPC-L5: a fresh-only screen is not described as a repeat warning", () => {
    const text = markerLegend("B", "p3", ["p1", "p2"], nameOf, { repeats: false, fresh: true });
    expect(text).toBe(
      "Fresh players have no games yet with whoever the next pick joins (Team B, alongside Carol, against Alice and Bob)."
    );
    expect(text).not.toMatch(/repeat a pairing/);
  });

  it("RPC-L6: both families live — the legend explains both, and keeps the referent", () => {
    const text = markerLegend("A", "p1", ["p3"], nameOf, { repeats: true, fresh: true });
    expect(text).toBe(
      "Marked players would repeat a pairing if picked next; Fresh players have no games yet with whoever the next pick joins (Team A, alongside Alice, against Carol)."
    );
  });

  it("RPC-L7: the fresh clause is WORD-FOR-WORD the same in both branches", () => {
    // A shortened combined form ("…no games with them yet") reads as "them =
    // the Marked players", which is false — a fresh player may well have played
    // with a marked one. Pinning the two against each other is what stops a
    // future tightening pass from reintroducing that.
    const freshOnly = markerLegend("A", "p1", ["p3"], nameOf, { repeats: false, fresh: true });
    const clause = freshOnly.slice(0, freshOnly.indexOf(" (Team"));
    expect(markerLegend("A", "p1", ["p3"], nameOf, { repeats: true, fresh: true })).toContain(
      clause
    );
  });
});

describe("repeat-pairing-copy — FRESH chip", () => {
  it("RPC-F1: the tooltip names everyone the pick touches", () => {
    expect(freshTitle("p1", ["p3", "p4"], nameOf)).toBe(
      "No games with Alice, Carol and Dave yet tonight"
    );
  });

  it("RPC-F2: partner-only and opponent-only referents both read correctly", () => {
    expect(freshTitle("p1", [], nameOf)).toBe("No games with Alice yet tonight");
    expect(freshTitle(null, ["p3", "p4"], nameOf)).toBe("No games with Carol and Dave yet tonight");
  });

  it("RPC-F3: the spoken register spells out that BOTH roles are covered", () => {
    // "no games with Alice" alone leaves a listener unable to tell whether
    // that means never partnered, never faced, or neither.
    expect(freshLabel("p1", ["p3"], nameOf)).toBe(
      "Fresh pick: no games with Alice and Carol yet tonight, as teammates or opponents."
    );
  });

  it("RPC-F4: an empty referent degrades rather than rendering an empty list", () => {
    expect(freshTitle(null, [], nameOf)).toBe("No games yet tonight");
    expect(freshLabel(null, [], nameOf)).toBe("Fresh pick: no games yet tonight.");
  });

  it("RPC-F5: unknown ids degrade to 'Unknown', never 'undefined'", () => {
    expect(freshTitle("ghost", [], nameOf)).toBe("No games with Unknown yet tonight");
    expect(freshLabel("ghost", [], nameOf)).not.toContain("undefined");
  });
});
