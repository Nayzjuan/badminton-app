# 3.39 A player can no longer self-leave from a live match — the refusal, and the TOCTOU window under it (2026-08-15)

> Extracted from `APP_MANIFEST.md` §3.39 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


**Files:** `src/app/actions/queue.ts` (`checkoutPlayer`), `src/components/player/player-dashboard.tsx`,
`src/components/player/my-status-tab.tsx`, `tests/integration/player-checkout.test.ts`.
Supersedes the self-checkout half of §3.19.

**The incident.** Self-checkout used to mark the caller `left` from *any* status and clean up only
**unpublished** drafts. A player who was `on_deck` (published, waiting for a court) or `playing` therefore
kept their seat in a live roster while being gone from the queue — a ghost. When that on-deck match was
pulled to a court it broke the live queue. The cleanup path was never wrong; it simply had no jurisdiction
over a *published* match, and nothing else refused the request.

**The rule.** `checkoutPlayer` now refuses when the caller's queue status is `on_deck` or `playing`.
`waiting` and `drafted` still leave freely — a drafted player's match is tentative, and the
`checkout_player_cleanup_drafts` RPC tears it down cleanly.

⚠️ **Do not read this as "the organizer can just remove them instead."** No single action removes an
`on_deck`/`playing` player — not the organizer's either. Two UI limits make the organizer's remove control
`waiting`-only, and a third limit means the RPC behind it could not repair the damage anyway: it sweeps
only `pending` matches (all three enumerated in §3.19). Getting an active player out is deliberately **two steps**: tear the match down first so
its roster returns to `waiting`, then check them out. (One exception to "returns to `waiting`": a finishing
player who is the pulled body of a held cross-court draft is re-reserved as `drafted`, not `waiting`
(`match-lifecycle.ts`, R3-1) — and `drafted` is `isLocked` in the organizer UI too, so that draft has to be
cleared as well.) The capability was not moved to another actor — it was
**gated behind repairing the match**, which is the thing that was actually missing.

**Two gates, because one is not enough.** The status read and the write are separate round-trips, and the
engine can promote a `waiting` player to `on_deck` in between — publishing a roster containing someone who
is about to vanish. So the write itself is guarded:

```ts
.update({ status: "left" })
.eq("session_id", sessionId).eq("player_id", user.id)
.in("status", ["waiting", "drafted", "left"])
.select("id")
```

If the promotion won the race, the `.in(...)` predicate no longer matches and **0 rows** come back; the
action returns the same refusal. Two details are load-bearing:

- **`"left"` stays in the allowed set** so a double-checkout still updates its own row and succeeds — Q-8's
  idempotency is a real behaviour, not an accident of ordering.
- **A null pre-read is excluded from the 0-rows guard.** A caller who was never in this session also updates
  0 rows, but that is a harmless no-op, not a lost race. Only "read as leaveable, wrote nothing" is a race.

**Client.** The leave dialog's copy branches on `hasActiveMatch` and the confirm button is
`disabled={checkingOut || hasActiveMatch}` — the client blocks the *tap*, the server remains authoritative
(the two derive from different sources: `hasActiveMatch` from the current match's status, the server from
the queue row). `handleCheckout` now surfaces `result.error` as a toast instead of failing silently. In
`my-status-tab`, the **Match Forming card's** "Leave Queue" button now renders only for
`status === "drafted"` — that card is the one a drafted *or* on-deck player sees, and only the drafted half
may still leave. The **paused** branch now carries the same gate (see the follow-up below — the claim that
once stood here, that paused is itself a leaveable state, was false). The waiting branch keeps its Leave
button unconditionally, because `waiting` really is always leaveable.
The `MatchAlert` court-call overlay is deliberately no longer passed `onLeaveQueue` — the prop is optional
and gates two buttons, so dropping it removes both, and by the time that overlay fires the player is on deck.

**Tests.** Suite Q `Q-4`/`Q-5` were **inverted, not added** — they previously asserted the superseded
contract (`expect(entry?.status).toBe("left")` while on deck) and would have stayed green against the bug
forever. Both now assert `result.success === false`, that the queue status and match status are unchanged, **and
that the message is the refusal** — `expect(result!.error).toMatch(/on deck|in a match/i)`. That last
assertion is the one doing the work: `success === false` plus unchanged rows is *also* what a broken
`mockAuthAs` or a rejected UUID produces, so without pinning the message the test would stay green for
reasons having nothing to do with the guard.

**Follow-up (same day, `cbf57df`) — three defects the review gate found in the above.**

1. **The guard had its own false-success hole.** The pre-read discarded its error, and a null `currentEntry`
   is indistinguishable from "not in this session". So on a transient read failure the `on_deck`/`playing`
   check never fired, the UPDATE matched 0 rows (an `on_deck` status is outside its `.in()` set), and the
   0-rows guard was skipped *precisely because* it requires a non-null `currentEntry` — the exclusion
   described two paragraphs above. The action returned `success` and the client navigated away while the
   player sat in a live roster. That is the very failure this section exists to describe, reachable through
   the fix for it. The read now fails closed.
2. **The paused branch rendered an ungated Leave button**, and it returns *before* the drafted/on-deck
   branch, so the gate at that branch never saw a paused player. `is_paused` is orthogonal to status:
   `togglePlayerPause` (`queue.ts:83`) has no status guard, and the organizer's pause control
   (`queue-control.tsx:942`) — unlike its checkout control at `:969` — is not hidden for locked rows, so an
   on-deck player can be paused and land there. The server refused correctly, so this was UX-only: a dead
   button contradicting the rule applied 34 lines below it.
3. **`handleCheckout` used `try/finally`**, which cleared `checkingOut` on the *success* path too, flipping
   the button out of "Leaving…" while `router.push` was still in flight (`origin/main` never reset it). The
   `finally` also silenced `react-hooks/set-state-in-effect` across the **entire component** — that, not the
   `prevHasActiveMatchRef` tab-switch effect the directive sits on, is what had orphaned that disable into
   an unused directive. (Mechanism: the compiler-backed `react-hooks` rules cannot lower a `TryStatement`
   with no `catch` handler, so they bail on the enclosing component.) Measured both ways: `finally` → 1
   warning, `catch` → 0. Now `try/catch`, which keeps throw-safety, removes the flicker, and makes the
   disable load-bearing again — it also toasts on a throw, which the `finally` never did.

🪤 Two of the three are the repo's standing defect class rather than new logic bugs: a doc/comment asserting
something the code does not do. The parenthetical corrected above ("paused … both are leaveable states") is
what made #2 invisible, and it shipped in the same commit as the fix it contradicted.

---

