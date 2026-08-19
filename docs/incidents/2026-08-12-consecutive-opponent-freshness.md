# 3.32 Consecutive-opponent freshness — the engine now previews the split before choosing the four (2026-08-12)

> Extracted from `APP_MANIFEST.md` §3.32 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


**Files:** `src/lib/matchmaking-db.ts` (`deriveLastOpponents`), `src/lib/matchmaking-core.ts` (`countConsecutiveOpponentRepeats`, `selectSplit`, `TeamSplit`/`LastOpponents`/`SplitPreviewContext`, argmin in `buildCombinationGroup`, `runAlgorithm` param 7), `src/lib/constants.ts` (`CONSECUTIVE_OPPONENT_PENALTY`, `MAX_CONSECUTIVE_OPPONENT_REPEATS`, `SPLIT_PREVIEW_BUDGET`), `src/app/actions/matchmaking.ts`, `scripts/replay/simulate.ts`.

**The complaint this closes.** Players were not objecting to *seeing* the same opponents over a night — they were objecting to facing them in **back-to-back** games. The engine had no notion of "last match" at all: `MAX_OPPONENT_REPEATS` is a whole-session count with no recency gradient, and `deriveOverlapMap` is anchor-relative. Measured on five real sessions, **79.3% of back-to-back opponent repeats are between two NON-anchor co-players** — invisible to the anchor-relative map at any weight, which is why re-tuning `OVERLAP_WEIGHT_OPPONENT` was a dead end.

**The mechanism.** Rematch avoidance is applied at two points, both strictly *inside* an existing fairness tier:

1. **Split choice** (`selectSplit`, shared by `snakeDraft` and `rotatedDraft`). The 4-pass partnership-freshness ladder is unchanged; within **each rung** the split with the fewest consecutive-opponent repeats now wins, ties keeping the earliest (most balanced) split. Only **cross-net** pairs count — two players who just faced each other and are now drafted as **teammates** cost nothing, which is where most of the gain comes from.
2. **Group choice** (`buildCombinationGroup`). The four is chosen by argmin over `fairness + 3 × repeats` rather than first-valid. See §3.1 for the `previewing` gate and the unseatable-four rule.

⚠️ **Never hoist the repeat count above the partnership predicates in `selectSplit`.** Promoting it out of the rung was tried and regressed partner variety in 5 of 5 sessions. Opponent freshness is a tie-break *within* a partnership-freshness rung, never a rung promotion (pinned by `CCO-7`).

**Why the penalty is 3.** `GAMES_AHEAD_PENALTY` is 10,000 per game owed — "the quantum". Any new term must be provably sub-quantum so it can only reorder candidates already tied on fairness. Max magnitude here is `MAX_CONSECUTIVE_OPPONENT_REPEATS × CONSECUTIVE_OPPONENT_PENALTY` = 4 × 3 = **12**, i.e. 833× below the quantum; the reach is ~12 summed priority-minutes ≈ 4 minutes per displaced seat, and at `MIN_REST_MINUTES = 18` a 4-minute gap is routine. A sweep of {2,3,4,5} put 3 in the middle of the winning plateau; past 5 the engine starts pulling materially lower-priority players in to dodge a repeat, desynchronising the rotation (near-identical foursomes jump 4 → 24 on 07/25). Treat the exact value as noise-level tuning and *"any positive sub-quantum value helps"* as the robust finding.

**Measured** by `scripts/replay-sessions.ts` over five real production sessions, A/B'd against `REPLAY_NO_LAST_OPPONENTS=true` (which feeds an empty map and must reproduce the baseline exactly — the control for porting bugs):

| Metric                        | Engine before | Engine after | Organizer's own night |
| ----------------------------- | ------------- | ------------ | --------------------- |
| Back-to-back opponent repeats | 244/550 (44.4%) | **186/550 (33.8%)** | 170/479 (35.5%) |
| Near-identical foursomes      | 32            | **28**       | 0                     |
| Opponent pairs over soft cap  | 52            | **36**       | 33                    |
| Partnerships over hard cap    | 0             | **0**        | 0                     |

The engine now beats the organizer's hand-run rate. **Repeats improve in 5 of 5 sessions; partner variety improves in 2, is unchanged in 3, and regresses in 0.**

⚠️ **Per-session regressions worth naming rather than burying** — the flat aggregates hide a redistribution:

- **07/30**: near-identical foursomes **8 → 12**, and consecutive-*partner* repeats **2 → 4**.
- **07/25**: games-played spread widens **4–7 → 3–7** (one player ends a game further behind).
- The aggregate consecutive-partner figure is flat at 4 only because 06/25 improves 2 → 0 while 07/30 worsens 2 → 4.

**Replay caveats** (all stated in `scripts/replay/simulate.ts`): the draft queue is collapsed to the bypassGate path at 100% court occupancy, nobody leaves early or pauses, there is no cross-court augmentation, and rejection memory is empty. Compare **rates**, never absolute counts.

**Wiring note — parameter order is a trap.** `lastOpponents` is `runAlgorithm` **param 7**, deliberately *after* `rejectedRosters` (param 6). An earlier draft of this feature branched before rejection memory landed and put it at 6; that merges textually, compiles clean, passes type-check — and **silently drops rejection memory**. If you add another optional param, append it.

