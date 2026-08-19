# Final Plan Review — `CROSS_COURT_DRAFTING_PLAN.md`

**Date:** 2026-06-07  
**Reviewer:** Kimi Code CLI  
**File version:** 156 lines (Round 3 revisions)

---

## Verdict

**✅ APPROVED FOR IMPLEMENTATION**

The plan is now technically sound, edge-case-hardened, and ready to build. The Round 3 additions (R3-1, R3-A, R3-B, R3-C) are high-quality fixes that address subtle lifecycle and data-integrity issues I didn't catch in earlier rounds.

**Remaining: 3 documentation/semantic nits. Zero blockers.**

---

## Round 3 Additions — Assessment

| Tag | Addition | Assessment |
|---|---|---|
| **R3-A** | Promotion filter moved to in-memory JS filtering | ✅ Excellent. Sidesteps all PostgREST `.or()` syntax and URL-encoding concerns entirely. Result set is tiny (≤ cap, typically ≤ 6), so performance is irrelevant. |
| **R3-B** | Source-match integrity check in `recomputeHeldReadiness` | ✅ Excellent. Handles `ON DELETE SET NULL` and missing refs safely by cancelling the held draft instead of leaving it in "Holding" limbo. |
| **R3-C** | Relational cooldown via consecutive-games streak | ✅ Excellent. Replaces the fragile time-based cooldown. Pulled games count toward the streak, so game-length variance is automatically handled. Guard 1b remains the hard in-flight reservation. |
| **R3-1** | Ghost-availability fix in `endMatchAction` | ✅ Excellent and important. Without this, the pulled body would revert to `waiting` after their match ends, and the engine would propose them again in new matches (blocked only by `create_match_with_players` Guard 2 NULL-return — correct-by-construction is much better). Setting them to `drafted` reserves them cleanly. |
| **R3-2** | `is_held` generation uses `cardinality(pulled_player_ids) > 0` | ✅ Cleaner than `array_length(...,1) IS NOT NULL`. Avoids three-valued logic. |

---

## Nits to Clean Up Before/During Coding

### NIT-1: Language inconsistency — "pulled body was never reserved"

The plan still uses this phrase in multiple places (e.g., Phase 2 line 65, Phase 5 line 97). **R3-1 contradicts this** — the pulled body IS reserved by setting their queue status to `'drafted'` when their current match ends.

**Fix:** Update the wording to:

> "The held-draft RPC itself never mutates the pulled body's queue row; instead, `endMatchAction` reserves them by setting `status='drafted'` when their current match completes."

This is more accurate and avoids confusion during implementation.

---

### NIT-2: R3-1 should be more explicit in `endMatchAction` flow

R3-1 is currently a bullet under Phase 6. The actual change happens inside `endMatchAction`'s re-queueing loop (lines 204-230 of `match-lifecycle.ts`).

**Fix:** Add a small code-shape note in Phase 6 (or Phase 5) showing the exact insertion point:

```ts
// BEFORE updating each finishing player to 'waiting',
// query pending held drafts in this session to build a Set of pulled_player_ids.
const { data: heldDrafts } = await db
  .from("matches")
  .select("pulled_player_ids")
  .eq("session_id", match.session_id)
  .eq("status", "pending")
  .eq("is_published", false)
  .eq("is_held", true);

const pulledIds = new Set(
  (heldDrafts ?? []).flatMap((m) => m.pulled_player_ids)
);

// In the re-queueing loop:
const nextStatus = pulledIds.has(mp.player_id) ? "drafted" : "waiting";
await db.from("queue_entries").update({ status: nextStatus, ... })
```

This removes any ambiguity about whether the query is batched or per-player.

---

### NIT-3: `recomputeHeldReadiness` should handle `clear_on_deck_match_atomic` "not found"

When R3-B cancels a held draft via `clear_on_deck_match_atomic`, the RPC raises `MATCH_NOT_FOUND` if another concurrent call already deleted the match. `recomputeHeldReadiness` should swallow this error and continue to the next held draft.

**Fix:** Add to the Phase 5 spec:

> If `clear_on_deck_match_atomic` returns `MATCH_NOT_FOUND`, the match was already cancelled by a concurrent caller — swallow the error and continue.

---

## New Edge Cases Verified (No Issues Found)

| Scenario | Expected Behavior per Plan | Verdict |
|---|---|---|
| Pulled body checks out while `playing` | `checkout_player_cleanup_drafts` finds held match (pending+unpublished+player in `match_players`), cancels it, frees 3 waiting members | ✅ Correct |
| Pulled body checks out after match ends (`drafted`) | Same RPC finds them, cancels match; pulled body is `left`, excluded from UPDATE | ✅ Correct |
| Held draft promoted after pulled body ends (`drafted`) | `promoteOnDeckMatchInternal` updates all 4 to `playing` (`.neq("status","left")` covers `drafted`) | ✅ Correct |
| Held draft cancelled after pulled body ends (`drafted`) | `clear_on_deck_match_atomic` updates all `match_players` to `waiting` if not `left` | ✅ Correct |
| Source match deleted (`ON DELETE SET NULL`) | `recomputeHeldReadiness` detects NULL ref, cancels held draft | ✅ Correct |
| Concurrent held draft creation while match ends | Guard 0 in RPC sees `drafted`/`waiting` instead of `playing` → returns NULL → engine falls back to waiting-only | ✅ Correct (race is harmless) |
| Swap removes pulled body | Post-swap `recomputeHeldReadiness` detects roster mismatch, clears `pulled_player_ids`/`held_ready_at`, draft becomes normal | ✅ Correct |

---

## Summary

| Round | Critical | Medium | Low/Info | Nits |
|---|---|---|---|---|
| 1 | 5 | 6 | 5 | — |
| 2 | 0 | 0 | 4 | — |
| 3 (final) | 0 | 0 | 0 | 3 |

**No blockers. No new risks. The plan is approved for implementation.**

Recommended next step: implement Phase 1 (constants) → Phase 3 (pure core + unit tests) → Phase 2 (migration + RPC) → Phase 5a/5b (promotion readiness filter) per the consumer-before-producer rollout strategy.
