# 3.30 Closure fallback + the draft firewall extended to rosters (2026-08-10)

> Extracted from `APP_MANIFEST.md` §3.30 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


Two changes that look unrelated and are not: both exist because a **broadcast/realtime channel is the only thing telling a player something happened**, and both close a case where that channel legitimately says nothing.

**Files:** `src/app/actions/sessions.ts` (`getPlayerSessionStatus`) · `src/hooks/use-organizer-broadcast.ts` · `src/hooks/use-player-match.ts` · `supabase/migrations/20260810000001_extend_draft_firewall_to_match_players.sql` · `supabase/migrations/20260810000000_declare_compute_session_wrapped.sql` · `tests/unit/use-organizer-broadcast-closure.test.ts` · `tests/unit/use-player-match.test.ts` (U-HELD-1) · `tests/integration/rls-edge-cases.test.ts`

#### A. `session_closed` has a fallback now (closes `PENDING_WORK_2026-07-23.md` §2.3)

**The gap.** The `session-events` broadcast is the *only* mechanism that moves a player to Wrapped — `useSessionData` fetches `courts` and `queue_entries`, never the session row. `session_closed` is fire-and-forget with **no replay**, so a player whose channel was down for the one second it was emitted sits on a dead dashboard forever. Since the channel went private (`20260723100000`) there is a second way in: an *authorization*-refused join.

**The fix, in three parts.**
1. **`getPlayerSessionStatus(sessionId)`** — auth-gated server action, service-role read of **`is_active` only**. It never returns the row, which carries `organizer_passcode`. Service role rather than a client read because the failure mode it must survive is exactly the one where the client's own RLS predicate has stopped holding: `sessions_select` is `is_session_organizer(id) OR is_club_member(club_id)`, so an admin soft-removing a member mid-session makes the predicate fail **and** `session_access_level` go NULL, refusing the channel join at the same instant. That player is stranded on both paths; only an RLS-bypassing read can answer them.
2. **`onStatus` is wired** (it was deliberately declined in PR4a — see §2.1 of the pending-work doc — and only became wireable once the action existed). It carries **no user-visible signal**: transient `CHANNEL_ERROR`/`TIMED_OUT` is normal on gym wifi and Realtime reconnects itself, so a "live updates are down" toast would misfire constantly. It drives the closure re-check instead. Every transition in **either** direction means the channel either never joined or dropped and re-joined, and any such gap is a message that can never arrive on its own.
3. **A slow poll + a visibilitychange listener.** `SESSION_STATUS_POLL_MS = 120_000`, floored by `SESSION_STATUS_MIN_GAP_MS = 10_000` so a flapping channel cannot turn `onStatus` into a request storm. The visibility listener is separate from `useVisibilityRefresh` on purpose — that hook also calls `router.refresh()`, which the dashboard already does; this one asks the single question, at the realistic recovery moment (phone unlock after the socket was killed with the screen off).

**The invariant that matters: `isActive: null` is NOT `false`.** A missing row, an RLS error, a service-client construction failure and a transport throw all resolve to "unknown", and the caller **holds** the dashboard. Only a definite `success && !isActive` navigates. Reporting "closed" on a transient error would eject a player from a live session — precisely the failure the original note warned against, and worse than the gap being fixed.

**Deliberately not covered: a de-authed client.** The action's `getUser()` gate and the `TO authenticated` channel policy fail *together*, so this is a fallback for a dead **channel**, not a dead **session**. Auth loss has its own recovery path (§3.26) and a `sessions` read is not the place to re-solve it.

**Disclosure, stated honestly.** An authenticated caller holding a session UUID learns whether it is active. `lookup_active_session` already exposes almost the same bit to **anon** for the QR-join path, with one real delta: it carries `AND s.is_active = true`, so it collapses "closed session" and "no such session" into one empty answer, while this action distinguishes them. One bit, to an authenticated caller, about a UUID they already hold — accepted, not nil.

#### B. The draft firewall now covers `match_players` and `match_games` (tenancy audit finding #11)

**The asymmetry.** `matches` carries the firewall (`matches_select_draft_firewall`, RESTRICTIVE): a member sees a row only when `status <> 'pending' OR is_published`. `match_players_select` was just `has_match_access(match_id)` → `session_access_level(session_id) IS NOT NULL`, which never asks the draft question. So any club member could read — and was **pushed, live** — the full named roster of an unpublished draft over a plain PostgREST GET, and those rows hand out the very `match_id` the hidden `matches` row withheld. That defeats draft mode's entire review window.

**The fix.** Fold the CASE into the helper rather than into the policies, so both dependents inherit it and their quals stay byte-identical:

```
CASE public.session_access_level(session_id)
  WHEN 'organizer' THEN true
  WHEN 'member'    THEN (status <> 'pending' OR is_published)
  ELSE false
END
```

Blast radius is exactly two policies — `match_players_select` (TO `authenticated`) and `match_games_select` (TO `public`). No RPC body references the helper. The migration re-asserts grants unchanged and carries a 4-check `DO $$` block (helper carries the firewall · still `SECURITY DEFINER` with a pinned `search_path` · still exactly 2 dependents · both policies present with unchanged roles), each with an explicit row-count guard — a bare `SELECT … INTO` leaves NULL on zero rows and `IF NULL <> 'x'` is **not taken**, so without the guards an assertion against a *dropped* policy would silently pass.

**The client half — a third subscription, and it is load-bearing.** `create_held_cross_court_match` inserts the match as `status='pending', is_published=false` and flips three `queue_entries` rows to `'drafted'` in the same transaction. Now that the firewall has landed (applied to prod 2026-08-10), that draft's `matches` row **and** its `match_players` rows are both hidden from the very player it reserves — so the `queue_entries` flip is the *only* event that still reaches them. `use-player-match.ts` therefore subscribes to `queue_entries` alongside `matches` and `match_players` (`channelPrefix: "player-match"`). It was harmless before the migration and is **required now**; **do not remove it as redundant.** Pinned by U-HELD-1.

> ✅ **Both migrations in this section were APPLIED to production on 2026-08-10** — stamps `20260810151122` (`…000000`, a proven strict no-op: function md5 `ec5c724c…` unchanged) and `20260810151355` (`…000001`). **Finding #11 is CLOSED.** The apply was gated behind the code deploy (merge `23ced21`) reaching Vercel READY, the migration's 4-check `DO $$` block passed, and the helper was verified functionally through real `authenticated`/`anon` roles inside a rolled-back transaction — a plain member is now denied exactly the `pending`-and-unpublished case and nothing else. Zero existing rows lost visibility (every prod match is `completed` or `cancelled`), so the change is forward-looking. Revert **only** via `supabase/rollbacks/20260810000001_rollback_has_match_access.sql` — never `DROP FUNCTION`, which cascades to both roster SELECT policies and blanks every roster read as a 0-row *success*. Evidence: `TENANCY_AUDIT_2026-07-21.md` §2 #11.

#### C. `compute_session_wrapped` is finally declared in the repo

`20260810000000` is a verbatim `pg_get_functiondef` capture of production's definition (44 897 chars, md5 `ec5c724c4fd8705449d0fd014d57b82d`). The repo had **never** held the function's full body: `20260423100000` created a much smaller early version and every change since has been an in-place text substitution against whatever prod happened to contain. It is convergent and a strict no-op against prod today; its value is giving future edits a diffable baseline instead of another blind substitution. `pg_get_functiondef` and **not** `prosrc` — `prosrc` drops the `SECURITY DEFINER` marker and the `SET search_path` in `proconfig`, so replaying a `prosrc` capture would silently de-harden the function. Note it does **not** by itself make a from-scratch replay work; that still aborts earlier, at `20260718150312_harden_first_to_100_claim.sql`.

#### D. The six all-time milestone awards become one-time (2026-08-11)

`20260811000000_one_time_milestone_awards.sql` — first consumer of the baseline above, and the first change to this function that is a real full-body replacement instead of a blind text substitution. `20260811000001_repair_duplicate_milestone_awards.sql` — strips the 188 historical duplicates the RPC fix cannot reach on its own. Full rationale, the two load-bearing properties of the ledger lookup, the per-club advisory lock that keeps concurrent computes from both granting, and the second (`first_to_100` recompute) defect fixed alongside: **§3.7.1**.

> ✅ **Both APPLIED to production 2026-08-11**, in order — `…000000` (stamp `20260810173410`) then `…000001` (stamp `20260810173605`) — emptying the by-hand queue. The repair rewrote **128** player-visible wraps: 252 milestone grants → **64**, duplicates → **0**, and every slug now has exactly one grant per player. Verified live afterwards, including two real recomputes inside rolled-back transactions: recomputing a **non-holding** session no longer re-grants the award, and recomputing the **holding** session does not revoke it. Because there is no `psql`/CLI on the host, both were applied through the Supabase MCP in equivalent-but-not-identical forms — see the "How the two `20260811*` were actually applied" note in `MEMORY.md` before re-running either.

---

