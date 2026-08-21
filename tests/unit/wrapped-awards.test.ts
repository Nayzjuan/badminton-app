// ============================================================
// Wrapped award metadata — the render table and its three readers (WA)
// ============================================================
// src/lib/wrapped-awards.ts is the ONLY translation layer between an award
// slug written by a Postgres migration and the words a player reads at the
// end of a session. Nothing else in the app knows what `serial_rivals` means.
// It has no database, no network and no async — which is exactly why it is
// dangerous: every failure here is silent, cosmetic-looking, and lands in
// front of every attendee at once.
//
// Three properties carry real weight.
//
// 1. DRIFT — a slug the DB emits that this table does not define.
//    Award slugs are minted by migrations (20260510, 20260811000000, …);
//    AWARD_META is hand-maintained TypeScript. The two WILL diverge. The
//    source handles the unknown slug with `AWARD_META[a]?.rarity ?? "common"`,
//    so an undefined slug is NOT dropped and does NOT throw — it is ranked as
//    a common award and keeps its place in the list. Meanwhile
//    WrappedAwardCard (`const meta = AWARD_META[slug]; if (!meta) return null`)
//    renders NOTHING for it. Combined with the hard cap of 6 in
//    wrapped-shell.tsx, an unknown slug silently EATS A CARD SLOT from a real
//    award: the player sees five cards instead of six and no error anywhere.
//    WA-8 and WA-9 pin that behaviour precisely, because the day a migration
//    adds an award is the day someone has to read this test.
//
// 2. ORDER — RARITY_ORDER is legendary 0 / rare 1 / uncommon 2 / common 3, and
//    the cap keeps the FIRST n. So the sort is not decoration: it decides
//    which six of a player's awards exist at all. Invert it and a Session MVP
//    is dropped in favour of a Participation Trophy. The tie-break is
//    Array#sort's ES2019-guaranteed stability, i.e. input order within a
//    tier — WA-4 asserts that in both directions so a passing run cannot be
//    coincidence.
//
// 3. FALSY-ZERO — renderSubtitle interpolates values into user-visible copy
//    and guards with `if (val === undefined || val === null) return ""`, NOT
//    with a truthiness check. That distinction is load-bearing: `0` is a legal
//    award value ("Won 0 of your last 3 games", "0% win rate"), and the
//    ubiquitous `val || ""` refactor would blank it out, producing "Won  of
//    your last 3 games." WA-20 and WA-21 exist to make that refactor red.
//
// A note so nobody adds a false invariant later: emoji are DELIBERATELY
// reused across awards (⚡, 🎯, 📈, 😅, 👑, ⚔️, 🔁 each appear twice). Titles
// are not — they are the card headline and WA-36 pins their uniqueness.
//
// Tests:
//   WA-0  the four fixture slugs really are one per tier — a re-tiering of
//         any of them would silently invalidate every ordering test below
//   WA-1  sortAwardsByRarity orders legendary → rare → uncommon → common
//   WA-2  the whole 63-slug table sorts into a non-decreasing rank sequence
//   WA-3  every tier outranks every lower tier, pairwise
//   WA-4  (edge) ties are STABLE — input order is preserved within a tier,
//         proven in both directions
//   WA-5  (edge) the caller's array is not mutated; a new array is returned
//   WA-6  (edge) an empty list sorts to an empty list
//   WA-7  (edge) duplicate slugs are preserved, not de-duplicated
//   WA-8  (edge) DRIFT — an unknown slug is KEPT, ranked as common, and does
//         not throw; the known awards around it still sort correctly
//   WA-9  (edge) DRIFT — an unknown slug displaces a real award from the
//         6-card cap, and that card renders as nothing
//   WA-10 (edge) an empty-string slug is ranked as common, not crashed on
//   WA-11 (edge) an Object.prototype key ("constructor") does not throw in
//         the sort path — the `?.` is doing real work
//   WA-12 topAwardsByRarity defaults to a cap of 6
//   WA-13 the cap keeps the RAREST n and drops the commonest
//   WA-14 (edge) n greater than the input returns the whole input, unpadded
//   WA-15 (edge) n = 0 returns an empty list
//   WA-16 (edge) a negative n drops from the END — Array#slice semantics
//   WA-17 (edge) an explicit `undefined` n falls back to the default 6
//   WA-18 (edge) an empty award list caps to an empty list
//   WA-19 renderSubtitle interpolates every token in a multi-token template
//   WA-20 (edge) FALSY-ZERO — a numeric 0 renders as "0", not blank
//   WA-21 (edge) FALSY-ZERO — win_pct 0 renders "0%", not "%"
//   WA-22 (negative) an unknown slug renders "" — not the slug, not a template
//   WA-23 (edge) a template with no tokens is returned verbatim
//   WA-24 (edge) a missing data key renders EMPTY, not the string "undefined"
//   WA-25 (edge) an explicit null renders empty, and an empty string too
//   WA-26 win_pct is rounded to a whole number; .5 rounds up
//   WA-27 (edge) only win_pct is rounded — other numeric tokens render raw
//   WA-28 (edge) a win_pct arriving as a STRING bypasses the rounding
//   WA-29 (edge) an Object.prototype key THROWS out of renderSubtitle — the
//         `!meta` guard does not cover the prototype chain, and the sort path
//         disagrees with it
//   WA-30 every one of the 63 subtitles renders with no {token} left behind,
//         both fully fed and fed nothing at all
//   WA-31 AWARD_META holds exactly 63 entries
//   WA-32 every entry's object key equals its own `slug` field
//   WA-33 every entry carries a non-empty emoji, title and subtitle
//   WA-34 every rarity is one of the four literals, and all four are populated
//   WA-35 the per-tier counts are 9 / 19 / 22 / 13
//   WA-36 titles are unique across the table
//   WA-37 every {token} in the table is one the renderer's own regex can match
//
// WHAT THIS FILE DOES NOT PROVE
//   - That the RPC emits these slugs. compute_session_wrapped() lives in
//     Postgres; the repo-side coverage of what the Wrapped read returns is
//     tests/unit/wrapped-actions.test.ts (Suite WR), and the slug-vs-migration
//     reconciliation is docs/reference/MIGRATION_RECONCILIATION.md.
//   - That the award is *earned* correctly, or once. The one-time gate for
//     century_club / the_dynasty / serial_rivals / winning_formula is SQL
//     (migration 20260811000000) and has no TypeScript surface at all.
//   - That a card is painted. Rarity → colour, the null-render of an unknown
//     slug, and the 6-card cap live in src/components/wrapped/
//     wrapped-award-card.tsx and wrapped-shell.tsx; this file asserts only the
//     data those components consume.
//   - That the copy is *good*. WA-30 proves no {token} survives rendering; it
//     says nothing about grammar. Two known copy defects are pinned as real
//     behaviour rather than fixed here: "+{point_diff}" renders "+-4" for a
//     negative differential (WA-27), and a missing token leaves the sentence
//     with a leading space (WA-24). Both are product calls, not test calls.
//
// IDs: WA
// ============================================================

import { describe, it, expect } from "vitest";
import {
  AWARD_META,
  sortAwardsByRarity,
  topAwardsByRarity,
  renderSubtitle,
  type AwardMeta,
  type AwardRarity,
} from "@/lib/wrapped-awards";

// The four tiers, written out in the order the page must show them. Declaring
// this here rather than importing RARITY_ORDER is deliberate: RARITY_ORDER is
// module-private, and a test that re-derives its expectation from the value
// under test proves nothing.
const TIERS: AwardRarity[] = ["legendary", "rare", "uncommon", "common"];

const ALL_SLUGS = Object.keys(AWARD_META);

/** Real slugs, one per tier, used as fixed points throughout the suite. */
const LEGENDARY = "session_mvp";
const RARE = "top_scorer";
const UNCOMMON = "hot_streak";
const COMMON = "fast_starter";

/** A slug a future migration might mint without touching this table. */
const UNKNOWN = "quadruple_bagel_2027";

function rarityOf(slug: string): AwardRarity | "UNKNOWN" {
  return AWARD_META[slug]?.rarity ?? "UNKNOWN";
}

/** Position of a slug's tier in the display order the page requires. */
function tierIndex(slug: string): number {
  const r = rarityOf(slug);
  return r === "UNKNOWN" ? TIERS.indexOf("common") : TIERS.indexOf(r);
}

/** Every token the renderer would try to substitute in `template`. */
function tokensIn(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

// ── The fixed points have to actually be what the suite claims ────
// If a future edit re-tiers session_mvp, half of this file would start
// asserting something other than what its names say. Fail loudly instead.
describe("WA: suite fixtures", () => {
  it("WA-0: the four fixture slugs really are one per tier", () => {
    expect(
      [rarityOf(LEGENDARY), rarityOf(RARE), rarityOf(UNCOMMON), rarityOf(COMMON)],
      "a fixture slug was re-tiered or renamed in AWARD_META — every ordering test below is now asserting the wrong thing"
    ).toEqual(TIERS);
    expect(
      AWARD_META[UNKNOWN],
      "the 'unknown slug' fixture was added to AWARD_META, so the drift tests are no longer testing drift"
    ).toBeUndefined();
  });
});

// ── sortAwardsByRarity — the order the player's feed is built in ──
describe("WA: sortAwardsByRarity — rarity order", () => {
  it("WA-1: orders legendary before rare before uncommon before common", () => {
    // Shuffled so a no-op sort cannot pass: the input is the exact reverse.
    const sorted = sortAwardsByRarity([COMMON, UNCOMMON, RARE, LEGENDARY]);

    expect(
      sorted,
      "the rarity order is inverted or ignored — the Wrapped feed leads with a Participation Trophy and the 6-card cap can drop the Session MVP entirely"
    ).toEqual([LEGENDARY, RARE, UNCOMMON, COMMON]);
  });

  it("WA-2: the whole table sorts into a non-decreasing tier sequence", () => {
    const ranks = sortAwardsByRarity(ALL_SLUGS).map(tierIndex);
    const nonDecreasing = ranks.every((r, i) => i === 0 || ranks[i - 1] <= r);

    expect(
      nonDecreasing,
      `sorting all ${ALL_SLUGS.length} awards produced a tier sequence that goes backwards somewhere — some award outranks a rarer one: ${ranks.join(",")}`
    ).toBe(true);
    expect(
      ranks.length,
      "sorting dropped or duplicated awards — the feed no longer shows what the player earned"
    ).toBe(ALL_SLUGS.length);
  });

  it("WA-3: every tier outranks every lower tier, pairwise", () => {
    // One representative per tier, so this survives a re-tiering of any single
    // award while still testing all six ordered pairs.
    const rep: Record<AwardRarity, string> = {
      legendary: LEGENDARY,
      rare: RARE,
      uncommon: UNCOMMON,
      common: COMMON,
    };

    for (let i = 0; i < TIERS.length; i++) {
      for (let j = i + 1; j < TIERS.length; j++) {
        const rarer = rep[TIERS[i]];
        const commoner = rep[TIERS[j]];
        expect(
          sortAwardsByRarity([commoner, rarer]),
          `${TIERS[i]} did not sort ahead of ${TIERS[j]} — the rarity ladder is broken between those two tiers`
        ).toEqual([rarer, commoner]);
      }
    }
  });

  it("WA-4: (edge) ties are stable — input order is preserved within a tier", () => {
    // All four are common, so the comparator returns 0 for every pair and the
    // ONLY thing deciding the output is Array#sort's stability guarantee.
    const commons = ["fast_starter", "ice_cold", "friendly_fire", "night_cap"];
    for (const s of commons) {
      expect(rarityOf(s), `${s} is no longer common — WA-4 is not testing a tie`).toBe("common");
    }

    expect(
      sortAwardsByRarity(commons),
      "same-rarity awards were reordered — the feed's within-tier order is not the order it was handed"
    ).toEqual(commons);

    // Positive control for the assertion above: reversing the input must
    // reverse the output. Without this, a sort that always emits a fixed
    // order would satisfy the first assertion by accident.
    const reversed = [...commons].reverse();
    expect(
      sortAwardsByRarity(reversed),
      "the within-tier order is fixed rather than stable — it ignores the order it was given"
    ).toEqual(reversed);
  });

  it("WA-5: (edge) the caller's array is not mutated and a new array comes back", () => {
    const input = [COMMON, LEGENDARY];
    const snapshot = [...input];
    const out = sortAwardsByRarity(input);

    expect(
      input,
      "sortAwardsByRarity reordered its caller's array in place — the Wrapped page's own stats.earnedAwards would be rewritten under it"
    ).toEqual(snapshot);
    expect(
      out,
      "the sorted result is the same array object as the input — an in-place sort leaked to the caller"
    ).not.toBe(input);
    expect(out, "the sort did not actually order the copy it made").toEqual([LEGENDARY, COMMON]);
  });

  it("WA-6: (edge) an empty list sorts to an empty list", () => {
    expect(
      sortAwardsByRarity([]),
      "a player who earned nothing did not get an empty feed — sorting invented or threw on an empty award list"
    ).toEqual([]);
  });

  it("WA-7: (edge) duplicate slugs are preserved, not de-duplicated", () => {
    const out = sortAwardsByRarity([LEGENDARY, COMMON, LEGENDARY]);

    expect(
      out,
      "duplicate award slugs were collapsed or dropped — the sort is silently editing the earned-award list instead of ordering it"
    ).toEqual([LEGENDARY, LEGENDARY, COMMON]);
  });
});

// ── DRIFT: a slug the DB emits that this file has never heard of ──
describe("WA: sortAwardsByRarity — unknown slugs (migration drift)", () => {
  it("WA-8: (edge) an unknown slug is kept, ranked as common, and does not throw", () => {
    const out = sortAwardsByRarity([COMMON, UNKNOWN, LEGENDARY, UNCOMMON]);

    expect(
      out,
      "an award slug missing from AWARD_META was dropped, thrown on, or ranked as something other than common — pick whichever happened, all three change what the player sees when a migration adds an award this file does not define"
    ).toEqual([LEGENDARY, UNCOMMON, COMMON, UNKNOWN]);

    // Positive control: the known awards in the same call sorted correctly, so
    // the assertion above is not being satisfied by a universally broken sort.
    expect(
      out.filter((s) => s !== UNKNOWN),
      "the KNOWN awards in the same list did not sort correctly — WA-8's unknown-slug claim proves nothing"
    ).toEqual([LEGENDARY, UNCOMMON, COMMON]);
  });

  it("WA-9: (edge) an unknown slug takes a card slot away from a real award", () => {
    // Seven awards, cap of six. The unknown slug sits ahead of a real common
    // in the input, and ties are stable, so it survives the cap and the real
    // award behind it does not.
    const earned = [LEGENDARY, RARE, UNCOMMON, UNKNOWN, "ice_cold", COMMON, "friendly_fire"];
    const shown = topAwardsByRarity(earned, 6);

    expect(shown, "the 6-card cap stopped capping").toHaveLength(6);
    expect(
      shown,
      "an unknown slug no longer occupies a card slot — if it is now dropped instead, that is an improvement, but wrapped-shell.tsx and WrappedAwardCard need re-reading before this expectation is relaxed"
    ).toContain(UNKNOWN);
    expect(
      shown,
      "a real award that used to be cut by the cap now survives it — the unknown-slug displacement described in this file's header no longer holds"
    ).not.toContain("friendly_fire");
  });

  it("WA-10: (edge) an empty-string slug is ranked as common rather than crashing", () => {
    expect(
      sortAwardsByRarity(["", LEGENDARY]),
      "an empty award slug was not tolerated — a null/blank row coming back from the RPC would take down the whole Wrapped feed instead of one card"
    ).toEqual([LEGENDARY, ""]);
  });

  it("WA-11: (edge) an Object.prototype key does not throw in the sort path", () => {
    // AWARD_META is a plain object literal, so AWARD_META["constructor"] is a
    // FUNCTION, not undefined. The optional chain on `.rarity` is the only
    // thing keeping this from ranking as something nonsensical.
    expect(
      sortAwardsByRarity(["constructor", LEGENDARY]),
      "a slug that collides with an Object.prototype member is no longer ranked as common — the `?.rarity` optional chain in sortAwardsByRarity is load-bearing and something changed it"
    ).toEqual([LEGENDARY, "constructor"]);
  });
});

// ── topAwardsByRarity — the cap that decides what exists ──────────
describe("WA: topAwardsByRarity — the display cap", () => {
  it("WA-12: defaults to a cap of six", () => {
    expect(
      topAwardsByRarity(ALL_SLUGS),
      "the default award cap moved off 6 — wrapped-shell.tsx passes 6 explicitly, but every other caller now gets a different number of cards"
    ).toHaveLength(6);
  });

  it("WA-13: keeps the rarest n and drops the commonest", () => {
    const out = topAwardsByRarity([COMMON, UNCOMMON, RARE, LEGENDARY], 2);

    expect(
      out,
      "the cap kept the wrong end of the list — a player's rarest awards are being cut in favour of common ones"
    ).toEqual([LEGENDARY, RARE]);
    expect(out, "a common award survived a cap of 2 while a rarer one was cut").not.toContain(
      COMMON
    );
  });

  it("WA-14: (edge) n larger than the input returns the whole input, unpadded", () => {
    expect(
      topAwardsByRarity([LEGENDARY, COMMON], 50),
      "a cap larger than the award count padded or truncated the list — a player with two awards must see exactly two cards"
    ).toEqual([LEGENDARY, COMMON]);
  });

  it("WA-15: (edge) n = 0 returns an empty list", () => {
    expect(
      topAwardsByRarity([LEGENDARY, COMMON], 0),
      "a cap of zero did not suppress every award — a zero cap that falls back to a default would render a feed a caller explicitly asked to hide"
    ).toEqual([]);
  });

  it("WA-16: (edge) a negative n drops from the END, per Array#slice", () => {
    // Not a desirable API, but it IS the behaviour, and a caller computing
    // `remainingSlots` can hand this function a negative number. Pinned so the
    // next person to touch it discovers it here rather than in production.
    expect(
      topAwardsByRarity([LEGENDARY, RARE, COMMON], -1),
      "the negative-n path changed — slice(0, -1) drops the last element, and any caller computing the cap arithmetically depends on knowing that"
    ).toEqual([LEGENDARY, RARE]);
  });

  it("WA-17: (edge) an explicit undefined n falls back to the default six", () => {
    expect(
      topAwardsByRarity(ALL_SLUGS, undefined),
      "passing undefined for the cap no longer takes the default — an optional prop threaded through from a component would silently produce an empty or uncapped feed"
    ).toHaveLength(6);
  });

  it("WA-18: (edge) an empty award list caps to an empty list", () => {
    expect(
      topAwardsByRarity([], 6),
      "capping an empty award list did not produce an empty list"
    ).toEqual([]);
  });
});

// ── renderSubtitle — the words the player actually reads ──────────
describe("WA: renderSubtitle — interpolation", () => {
  it("WA-19: interpolates every token in a multi-token template", () => {
    // `loyal_partner` mixes a numeric token and a name token in one sentence.
    expect(
      renderSubtitle("loyal_partner", { shared_games: 7, partner_name: "Aim" }),
      "a multi-token subtitle did not interpolate every token — the player is shown raw {braces} on their recap card"
    ).toBe("Played 7 games with Aim. Built a real partnership.");

    // A second template with two tokens of the SAME kind, to catch a renderer
    // that only ever replaces the first match.
    expect(
      renderSubtitle("bounced_back", { last_win_pct: 33, this_win_pct: 71 }),
      "only the first token of a two-token template was replaced — the /g flag on the replace regex is gone"
    ).toBe("Last session: 33%. Tonight: 71%. That's a comeback.");
  });

  it('WA-20: (edge) a numeric zero renders as "0", not as blank', () => {
    // THE bug shape. `if (val === undefined || val === null)` is correct;
    // `if (!val)` is the refactor that breaks this and nothing else.
    expect(
      renderSubtitle("sunset_surge", { final_wins: 0 }),
      "a zero award value was swallowed — the guard was changed from a null/undefined check to a truthiness check, and the card now reads 'Won  of your last 3 games.'"
    ).toBe("Won 0 of your last 3 games. Saved the best for last.");
  });

  it('WA-21: (edge) a win_pct of zero renders "0%", not "%"', () => {
    expect(
      renderSubtitle("dominant_night", { win_pct: 0 }),
      "a 0% win rate rendered as an empty percentage — the win_pct branch is treating 0 as absent"
    ).toBe("0% win rate. You weren't just winning — you were making a statement.");
  });

  it("WA-22: (negative) an unknown slug renders the empty string", () => {
    expect(
      renderSubtitle(UNKNOWN, { games: 9 }),
      "an award slug missing from AWARD_META no longer renders as empty — if it now leaks the raw slug or a template, that string goes straight onto a card in front of every player in the session"
    ).toBe("");

    // Positive control: the same call shape against a KNOWN slug produces real
    // copy, so WA-22 is not being satisfied by a renderer that returns "" for
    // everything.
    expect(
      renderSubtitle("just_getting_started", { games: 9 }),
      "renderSubtitle returns empty for a KNOWN slug too — WA-22's negative proves nothing and the whole feed is blank"
    ).toBe("Played 9 game(s) this session. Your story is just beginning.");
  });

  it("WA-23: (edge) a template with no tokens is returned verbatim", () => {
    // 17 of the 63 subtitles have no tokens at all. The replace must be a
    // no-op on them rather than mangling punctuation or the em dash.
    expect(
      renderSubtitle("shutout_artist", {}),
      "a token-free subtitle was altered on its way to the card — the interpolation is rewriting copy it was supposed to leave alone"
    ).toBe("Won a game without letting them score. That's not badminton — that's an execution.");
  });

  it('WA-24: (edge) a missing data key renders EMPTY, not the string "undefined"', () => {
    // Note the leading space in the expectation: it is the real output, and
    // pinning it is the point. Rendering "undefined wins in a row" instead
    // would be a far worse failure than the gap.
    expect(
      renderSubtitle("hot_streak", {}),
      "an absent award_data key rendered as literal 'undefined' (or left the {token} in place) — this is the exact shape of a migration adding an award whose data payload this file names differently"
    ).toBe(" wins in a row at some point. Momentum is a real thing.");
  });

  it("WA-25: (edge) an explicit null renders empty, and so does an empty string", () => {
    expect(
      renderSubtitle("hot_streak", { streak: null }),
      "a JSON null in award_data did not render as empty — 'null wins in a row' is what the player would read"
    ).toBe(" wins in a row at some point. Momentum is a real thing.");

    expect(
      renderSubtitle("kryptonite", { victim_name: "", win_count: 3 }),
      "an empty-string value did not render as empty — an unnamed player must leave a gap, not a literal token"
    ).toBe("Beat  3 times. They're going to be practicing this week.");
  });
});

describe("WA: renderSubtitle — numeric formatting", () => {
  it("WA-26: win_pct is rounded to a whole number, and .5 rounds up", () => {
    expect(
      renderSubtitle("dominant_night", { win_pct: 66.666 }),
      "win_pct is no longer rounded — the card would read '66.666% win rate', which is the raw float straight out of the RPC"
    ).toBe("67% win rate. You weren't just winning — you were making a statement.");

    expect(
      renderSubtitle("solid_outing", { win_pct: 66.5 }),
      "a half-point win rate did not round up — Math.round was swapped for a floor or a truncation"
    ).toBe("67% win rate. Consistent, reliable, dangerous.");
  });

  it("WA-27: (edge) only win_pct is rounded — other numeric tokens render raw", () => {
    // Positive control lives inside this test: blowout_king carries BOTH a
    // fractional token and an integer one, so a renderer that rounded
    // everything and a renderer that rounded nothing produce different output.
    expect(
      renderSubtitle("blowout_king", { avg_margin: 8.5, wins: 3 }),
      "a non-win_pct numeric token was rounded — the win_pct special case has widened to every number, and averages lose their precision on the card"
    ).toBe("8.5-pt average winning margin across 3 wins. Surgical.");

    // The renderer inserts the number verbatim, sign and all, and the
    // point_diff_king template hard-codes a "+" in front of the token. A
    // negative differential therefore reads "+-4". Pinned as CURRENT
    // behaviour: the fix is a copy change, which is a product call.
    expect(
      renderSubtitle("point_diff_king", { point_diff: -4 }),
      "the negative-point_diff rendering changed. If the sign is now handled (template or renderer), that is a FIX and this expectation should become '-4 point differential…' — but nothing in this file made that change, so check what did."
    ).toBe("+-4 point differential. Nobody controlled margins like you did.");
  });

  it("WA-28: (edge) a win_pct arriving as a string bypasses the rounding", () => {
    // The rounding branch is gated on `typeof val === "number"`. JSONB numerics
    // deserialize as numbers today; if that ever changes, this test is what
    // says so, rather than a player noticing a 12-decimal percentage.
    expect(
      renderSubtitle("dominant_night", { win_pct: "66.666" }),
      "a string-typed win_pct is now being rounded, or is no longer passed through verbatim — either way the typeof gate in renderSubtitle changed and JSONB deserialization assumptions need re-checking"
    ).toBe("66.666% win rate. You weren't just winning — you were making a statement.");
  });

  it("WA-29: (edge) a slug from Object.prototype throws — the !meta guard misses it", () => {
    // AWARD_META["toString"] is inherited and TRUTHY, so `if (!meta) return ""`
    // does not fire and `meta.subtitle` is undefined. This is a real sharp
    // edge, pinned as CURRENT behaviour, not as a desired one: hardening the
    // lookup to Object.hasOwn would be a correct fix, and would turn this test
    // red on purpose.
    expect(
      () => renderSubtitle("toString", {}),
      'renderSubtitle no longer throws on an Object.prototype key. If the lookup was hardened (Object.hasOwn / a null-prototype table), that is a FIX — update this test to expect "". If nothing was hardened, the guard changed by accident.'
    ).toThrow(TypeError);

    // Contrast, and the reason this asymmetry matters: the same input is
    // handled safely by the sort path (WA-11), so the two readers of
    // AWARD_META disagree about what a bad slug is.
    expect(
      () => sortAwardsByRarity(["toString"]),
      "the sort path now throws on the same input renderSubtitle throws on — a single bad slug would take down the whole feed rather than one card"
    ).not.toThrow();
  });

  it("WA-30: every subtitle in the table renders with no {token} left behind", () => {
    // The completeness sweep. Every one of the 63 subtitles is rendered twice:
    // once with a value for each of its own tokens, and once with NOTHING.
    // Neither may leave a brace on the card.
    const fedFailures: string[] = [];
    const starvedFailures: string[] = [];

    for (const slug of ALL_SLUGS) {
      const tokens = tokensIn(AWARD_META[slug].subtitle);
      const data: Record<string, unknown> = {};
      for (const t of tokens) data[t] = 7;

      if (/\{\w+\}/.test(renderSubtitle(slug, data))) fedFailures.push(slug);
      if (/\{\w+\}/.test(renderSubtitle(slug, {}))) starvedFailures.push(slug);
    }

    expect(
      fedFailures,
      `these awards printed a raw {token} on the card even with a value supplied for every token they declare: ${fedFailures.join(", ")}`
    ).toEqual([]);
    expect(
      starvedFailures,
      `these awards printed a raw {token} when award_data was empty — the exact state a player hits when the RPC grants an award without its payload: ${starvedFailures.join(", ")}`
    ).toEqual([]);
  });
});

// ── AWARD_META — the table itself ─────────────────────────────────
describe("WA: AWARD_META — table invariants", () => {
  it("WA-31: holds exactly 63 entries", () => {
    expect(
      ALL_SLUGS.length,
      "the award table changed size. If an award was ADDED, bump this number and add its slug to the migration reconciliation notes. If one was DELETED, every historical grant of that slug in the DB now renders as a blank card, because WrappedAwardCard returns null for a slug it cannot find."
    ).toBe(63);
  });

  it("WA-32: every entry's object key equals its own slug field", () => {
    const mismatched = ALL_SLUGS.filter((k) => AWARD_META[k].slug !== k);

    expect(
      mismatched,
      `these entries have a \`slug\` field that disagrees with the key they are stored under: ${mismatched.map((k) => `${k} -> ${AWARD_META[k].slug}`).join(", ")}. Lookups go through the KEY, so a copy-pasted entry silently renders the wrong award's copy under another award's name.`
    ).toEqual([]);
  });

  it("WA-33: every entry carries a non-empty emoji, title and subtitle", () => {
    const fields: (keyof AwardMeta)[] = ["slug", "emoji", "title", "subtitle", "rarity"];
    const broken: string[] = [];

    for (const k of ALL_SLUGS) {
      const meta = AWARD_META[k];
      for (const f of fields) {
        if (typeof meta[f] !== "string" || meta[f].trim() === "") broken.push(`${k}.${f}`);
      }
    }

    expect(
      broken,
      `these award fields are missing, blank or not a string: ${broken.join(", ")}. Each one renders as an empty element on the card — an award with no title is a coloured rectangle.`
    ).toEqual([]);
  });

  it("WA-34: every rarity is one of the four literals, and all four are populated", () => {
    const bad = ALL_SLUGS.filter((k) => !TIERS.includes(AWARD_META[k].rarity));

    expect(
      bad,
      `these awards carry a rarity outside the four legal tiers: ${bad.map((k) => `${k}=${AWARD_META[k].rarity}`).join(", ")}. WrappedAwardCard indexes RARITY_STYLES by rarity with no fallback, so an unrecognised tier throws while rendering the card.`
    ).toEqual([]);

    for (const tier of TIERS) {
      expect(
        ALL_SLUGS.some((k) => AWARD_META[k].rarity === tier),
        `no award is rated '${tier}' any more — a whole rarity tier was emptied, and its RARITY_STYLES palette is now dead code`
      ).toBe(true);
    }
  });

  it("WA-35: the per-tier counts are 9 / 19 / 22 / 13", () => {
    const counts = Object.fromEntries(
      TIERS.map((t) => [t, ALL_SLUGS.filter((k) => AWARD_META[k].rarity === t).length])
    );

    expect(
      counts,
      "the rarity mix shifted. This is not automatically a defect — but a bulk edit that re-tiers awards changes which six of them survive the cap for every player, so it must be a deliberate change with these numbers updated, not a side effect."
    ).toEqual({ legendary: 9, rare: 19, uncommon: 22, common: 13 });
  });

  it("WA-36: titles are unique across the table", () => {
    const titles = ALL_SLUGS.map((k) => AWARD_META[k].title);
    const dupes = [...new Set(titles.filter((t, i) => titles.indexOf(t) !== i))];

    expect(
      dupes,
      `these award titles appear on more than one award: ${dupes.join(", ")}. The title is the card headline and the only thing distinguishing two cards in the feed — a duplicate reads as the same award granted twice.`
    ).toEqual([]);
  });

  it("WA-37: every token in the table is one the renderer's regex can match", () => {
    // renderSubtitle only replaces /\{(\w+)\}/g. A token with a space or a
    // hyphen — {partner name}, {win-rate} — is invisible to it and ships to
    // the player as literal braces. This catches that at author time.
    const unrenderable: string[] = [];
    let tokenCount = 0;

    for (const k of ALL_SLUGS) {
      const subtitle = AWARD_META[k].subtitle;
      tokenCount += tokensIn(subtitle).length;
      // Strip everything the renderer CAN handle; anything brace-shaped left
      // over is a token it can never fill.
      if (/\{[^}]*\}/.test(subtitle.replace(/\{(\w+)\}/g, ""))) unrenderable.push(k);
    }

    expect(
      unrenderable,
      `these subtitles contain a {placeholder} that renderSubtitle's \\w+ regex cannot match, so it ships to the player as literal braces: ${unrenderable.join(", ")}`
    ).toEqual([]);
    expect(
      tokenCount,
      "the table has no interpolation tokens at all — WA-37 would pass vacuously, and every personalised line has become static copy"
    ).toBeGreaterThan(0);
  });
});
