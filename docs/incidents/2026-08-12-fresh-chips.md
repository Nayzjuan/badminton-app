# 3.33 FRESH chips — the green half of the manual-match picker (2026-08-12)

> Extracted from `APP_MANIFEST.md` §3.33 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


**Files:** `src/lib/repeat-pairing.ts` (`deriveFreshCandidates`, `eligibleCandidates`, `freshMarkersAreInformative`) · `src/lib/repeat-pairing-copy.ts` (`freshTitle`, `freshLabel`, `LegendFamilies`, `markerLegend`'s 5th param, **and the `pairHeadline` opponent fix**) · `src/hooks/use-repeat-pairing.ts` (`fresh`, `legendFamilies`) · `src/components/organizer/repeat-marker.tsx` (`FreshMarker`, `FreshContext`) · wired into `queue-control.tsx` + `queue-skill-groups.tsx` · `--cc-fresh` in `globals.css`.

Extends §3.25. Two things ship together because they are the same defect seen from two sides: the manual-match screen only ever spoke about what was *wrong*, and one of the things it said was untrue.

**The false headline (the fix that matters most).** `pairHeadline` told the organizer that an opponent repeat means "auto-matchmaking won't match them again". That is **false**. The two caps are not the same kind of thing:

- **Teammate is HARD.** `selectSplit` requires `bothPairsUnderCap` in every one of its four passes, so `snakeDraft` returns `null` rather than exceed `MAX_PARTNERSHIP_REPEATS` — and *every* call site passes that cap, including the last-resort fallback (`matchmaking-core.ts:1447`). "Won't pair them again" is literally true; the organizer overriding it knows they are overriding the engine.
- **Opponent is SOFT.** `crossNetOk` appears only in passes 1a/2a; passes 1b/2b drop it explicitly so the engine cannot stall on a small session. It is a ranking preference, never a block.

The opponent line now reads "auto-matchmaking avoids this, but won't refuse it". An organizer who trusted the old wording would read every legitimate engine rematch as a bug — and this is a screen they open *because* they already distrust the drafts.

**Why a green chip and not just fewer amber ones.** An unmarked row is ambiguous: a marker only fires at `count >= cap`, so "no chip" mixes *never played* with *played once*. That is precisely the distinction the organizer is hand-building a match to act on, and the amber family structurally cannot express it.

**ZERO in BOTH maps — the one deliberate divergence from the engine.** `deriveFreshCandidates` takes the next pick's referents (partner slot + both opposing slots, same targeting as `deriveCandidateMarkers`) and keeps only candidates at count `0` in the teammate map **and** the opponent map, whatever role the pick would actually create. The amber marker mirrors the engine because it *predicts what the engine will refuse*; the green chip answers a human question — "have these people shared a court tonight" — and its own copy ("no games with Alice, Bob and Carol yet tonight") is a plain lie under role-specific checking. Strictness only ever withholds a chip; it can never over-promise. Zero also buys a free property: a pair that has never met cannot have met *last game*, so a FRESH pick is automatically clear of §3.32's consecutive-opponent penalty.

**The discrimination gate — a different gate, on purpose.** `freshMarkersAreInformative(freshCount, poolCount)` renders the family only when `0 < fresh < pool`. Both silent ends carry no information: a chip on every row (early session) and a chip on none. It is **not** `hasCleanAlternative`, the avoidability gate that governs the warnings — that gate asks whether the organizer could have done better, which is the question a *warning* must justify itself against; a FRESH chip is the answer, not the accusation. It is likewise **not** suppressed by `capSaturationActive`: that notice tells the organizer to override by hand, so hiding the only positive signal at that exact moment inverts the point. Deliberately all-or-nothing rather than a ratio floor — any threshold would be a number invented with no evidence, while the two degenerate ends are provably information-free, and the lopsided case self-corrects as the referent set grows from 1 to 3 by the fourth pick.

**One basis for the ratio.** `eligibleCandidates(slots, candidateIds)` exists so the numerator and denominator are measured after the same exclusion. Measuring fresh post-exclusion against a pool that still holds the selected players turns a correctly-silent all-fresh bench into a wall of green — the exact failure the gate was written to prevent.

**Episode snapshot, shared.** `fresh` rides the same frozen counts as the amber family (chips that move under the organizer's finger mid-build are worse than chips one match stale) but sits outside `gateOpen`. `markerContext` — the referent line — now renders when *either* family has something to show, and travels to both lenses inside a single `FreshContext` object so a set can never be rendered against a stale referent.

**Copy + colour.** `--cc-fresh` is a new token (hue 150 green). Not `cc-accent`: teal already means SELECTED on this exact screen, and two cyan-family chips in one row read as two states of one thing. Against the `cc-bg-2` card it measures **4.97:1 light / 9.78:1 dark**, clearing AA for the chip's 9px text and sitting slightly *above* the existing `cc-amber` baseline (4.35 / 8.72) in both modes. Per the house rule the meaning is on the **label** too — the chip always carries the word "Fresh" — so it survives greyscale and red-green deficiency. The legend adapts to `LegendFamilies` and swaps its icon (`Sparkles`, `cc-fresh`) on a fresh-only screen, because an amber glyph labelling a non-warning is its own small lie. The combined legend repeats the fresh clause **word for word** rather than shortening it to "…no games with them yet": the nearest plural antecedent for "them" is *Marked players*, and that reading is false.

**Mutual exclusivity** is structural — `>= cap` versus `=== 0` over a superset of the same referents — and belt-and-braces at both render sites (`!marker && …`).

**Tests:** `repeat-pairing.test.ts` RP-F1–F15 · `repeat-pairing-copy.test.ts` RPC-F1–F5 / L4–L7 / H2b (pins both headlines together so a later pass cannot "harmonise" them back to the false one) · `use-repeat-pairing.test.tsx` RPH-F1–F5, C3 · `queue-control-repeat-pairing.test.tsx` **QRP-X1–X9** (both lenses by name, mutual exclusivity across every row, legend adaptation, both silent ends, and the episode-snapshot freeze).

---

