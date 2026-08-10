# Plan Re-Review — Round 2

**File:** `CROSS_COURT_DRAFTING_PLAN.md` (155 lines, revised after Round 1)  
**Date:** 2026-06-07  
**Reviewer:** Kimi Code CLI

---

## Verdict

**The plan is now solid.** My Round-1 findings were addressed with precision. Three of my findings (C-2, M-1, M-3) were correctly identified as false positives and rejected with code-grounded justification. All true positives were folded into the plan.

**Remaining: 2 minor gaps + 2 clarifications. No blockers.**

---

## My Round-1 Findings — Resolution Status

| ID | Finding | Status | Notes |
|---|---|---|---|
| **C-1** | `estimatedWaiting` decrement wrong for held drafts | ✅ **Fixed** | Phase 4 now decrements by `PLAYERS_PER_MATCH − pulledCount` (3 for held, 4 for ready). |
| **C-2** | `forcedRepeat` under-specified | ❌ **False positive** | Author verified: `runAlgorithm` has exactly 2 "forced repeat" return sites — Tier-3 rotation (~line 690, log says `"(forced repeat)"`) and last-resort fallback (~line 747). Set `forcedRepeat: true` at those two literals only. All other success returns are normal. |
| **C-3** | Pulled player can become anchor | ✅ **Fixed** | `priorityScore: -1` (was `0`). Verified: `scoreAndSortPool` sorts by `priorityScore` desc then `joined_at` asc. `-1` guarantees every waiting player (score ≥ 0) sorts ahead. Pulled body can never anchor. |
| **C-4** | PostgREST OR syntax invalid | ❌ **False positive** | Author verified: nested `and()` inside `.or()` is already used in 4 places in the codebase (`tv.ts:64`, `use-enriched-matches.ts:90`, etc.). The actual bug was **whitespace after the comma** — `" and(..."` fails to parse. Fixed: `"is_held.eq.false,and(...)"` with no space. |
| **C-5** | "Promotions since freed" tracking unspecified | ✅ **Fixed** | No new column needed. Derivable query: `COUNT(matches WHERE session_id=… AND status IN ('in_progress','completed','cancelled') AND started_at > pulled_from_match.completed_at)`. |
| **M-1** | Publish guard for held-not-ready missing | ❌ **Rejected by design** | Publish-then-gate is intentional (decision 8). Promotion filter already skips unready held drafts. Blocking publish would contradict "organizer is never blocked." |
| **M-2** | Pulled body checks out — unhandled | ✅ **Addressed** | `checkout_player_cleanup_drafts` RPC already finds `status='pending'` + `is_published=false` matches where the player is in `match_players`. Since held drafts insert all 4 into `match_players` and set `is_published=false`, the RPC automatically cancels the held draft and frees the 3 waiting members. Verified in migration `20260511210000_atomic_server_actions.sql:13-65`. |
| **M-3** | `fetchRecentRosters` should exclude held drafts | ❌ **False positive** | Held drafts MUST count toward `recentRosters`/`partnershipCounts` — that's the "intentional reservation" that stops the engine from re-pairing the same group into a second concurrent draft. Excluding them would re-introduce the exact back-to-back repeat this feature prevents. |
| **M-4** | `callNextMatch` bypassGate might create held drafts | ✅ **Fixed** | `bypassGate=true` now explicitly suppresses cross-court. Slot-0-always-ready already prevents stalls; this just makes the inline run predictable. |
| **M-5** | Swap auto-downgrade only covers tap-to-swap | ✅ **Fixed** | Now explicitly hooks: `swapPlayerInMatch`, `swapMatchPlayers`, `swapActiveFromOnDeck` (and `undoLiveSwap`'s on-deck branch). Explicitly excludes `swapPlayerInActiveMatch` / `swapTeamsInActiveMatch` which only mutate `in_progress` matches. |
| **M-6** | Lock contention on pulled body's row | ✅ **Fixed** | `FOR UPDATE` now covers **only the 3 waiting members**. The pulled body is validated with a non-locking read. Eliminates blocking `endMatchAction` entirely. |
| **L-2** | Pull cooldown unspecified | ✅ **Fixed** | `CROSS_COURT_PULL_COOLDOWN_MINUTES = 10`. Time-based: exclude if player appears in `pulled_player_ids` of any match created within the last 10 minutes. |
| **L-4** | `pulled_from_match_id` FK missing `ON DELETE` | ✅ **Fixed** | `ON DELETE SET NULL`. Held draft self-downgrades if source match is deleted. |

---

## New Findings — Round 2

### N-1: The `≤1 pulled body` constraint — `>1 pulled` is unspecified

**Location:** Phase 4, engine loop  
**Severity:** Low

The plan says: "Zero pulled ⇒ `executeMatch` (ready). One pulled ⇒ `executeHeldMatch`."

But the augmented pool could produce a proposal with **2+ pulled players** (e.g., two courts both have highly diverse, low-overlap players that the algorithm prefers). The plan doesn't specify what happens.

**Fix:** Add an explicit branch:

```
if (augmentedProposal.pulledCount === 0) → executeMatch (waiting-only result)
if (augmentedProposal.pulledCount === 1) → executeHeldMatch
if (augmentedProposal.pulledCount >= 2) → executeMatch (waiting-only result)
```

This treats >1 pulled as "cross-court didn't help enough" and falls back to the waiting-only match.

---

### N-2: `recomputeHeldReadiness` spec in Phase 5 omits the roster-mismatch check

**Location:** Phase 5 (spec) vs Phase 7 (swap auto-downgrade)  
**Severity:** Low

Phase 7 says: "a post-swap `recomputeHeldReadiness` detects the roster-vs-`pulled_player_ids` mismatch and clears `pulled_player_ids`/`held_ready_at`."

But Phase 5's specification of `recomputeHeldReadiness` only mentions:
1. Check `pulled_from_match_id` status
2. Count promotions since freed
3. Stamp `held_ready_at` if ready

It does **not** mention checking whether `pulled_player_ids[0]` is still in `match_players` for this match.

**Fix:** Add to Phase 5's `recomputeHeldReadiness` spec:

> For each held match, also verify that `pulled_player_ids[0]` still exists in `match_players` for this match. If the pulled player has been swapped out (roster mismatch), clear `pulled_player_ids` and `held_ready_at` — the draft downgrades to normal.

This makes Phase 7's swap auto-downgrade a natural consequence of the recompute function, rather than a separate mechanism.

---

### N-3: `pickEarliestFinishing` usage is unspecified

**Location:** Phase 3  
**Severity:** Info

The plan defines `pickEarliestFinishing(candidates)` as a "court-preference tiebreak" but never says where it's called. Since the augmented pool runs the existing algorithm, and the algorithm scores by overlap + diversity, the "earliest finishing" preference isn't automatically applied.

**Clarification needed:** Is this used in `fetchPullablePlayers` (when two players have identical eligibility, pick the one whose match started earliest)? Or is it a secondary sort in the algorithm itself?

If the former: add a `.sort()` in `fetchPullablePlayers` by `currentMatchStartedAt` ASC.  
If the latter: the algorithm's `scoreCandidates` would need a tiebreak modifier.

**Recommendation:** Use it in `fetchPullablePlayers` as a pre-filter tiebreak — when two pullable players have the same `priorityScore` (-1) and similar overlap, the one whose match started earlier is preferred. This is a one-line `.sort()` and doesn't require algorithm changes.

---

### N-4: `isPullEligible` "skill window" check is ambiguous

**Location:** Phase 3  
**Severity:** Info

The plan says `isPullEligible` checks "skill window." But the skill window is relative to the **anchor**, which isn't known until `runAlgorithm` runs. `isPullEligible` is called in `fetchPullablePlayers` (before the anchor is chosen).

**Clarification:** Does this mean:
- (a) The pulled player must be within `SKILL_VARIANCE_MAX` of **any** waiting player?
- (b) The pulled player must be within `SKILL_VARIANCE_MAX` of the **session's skill range**?
- (c) Don't filter by skill window at all in `fetchPullablePlayers`; let the algorithm handle it?

**Recommendation:** Option (c). The algorithm already enforces skill variance. Pre-filtering by skill window in `fetchPullablePlayers` is premature — a pulled player who seems "too far" from the current anchor might be perfect for a different anchor in a later slot. Let the algorithm decide.

If you want a cheap guard: check that the pulled player's `skill_level_int` is within `RED_ZONE_SKILL_VARIANCE_MAX` (±4) of the session's min/max waiting skill. Anything within ±4 covers the full 6-level spectrum and is guaranteed to be acceptable to the algorithm.

---

## Summary

| Round | Critical | Medium | Low/Info |
|---|---|---|---|
| 1 | 5 | 6 | 5 |
| 2 (after fixes) | 0 | 0 | 4 |

**The plan is ready to implement.** The 4 remaining items are minor clarifications that can be resolved during coding without architectural risk. The consumer-before-producer rollout strategy remains the strongest safety feature.
