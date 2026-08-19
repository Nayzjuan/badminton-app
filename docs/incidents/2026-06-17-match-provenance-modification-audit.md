# 3.23a Match Provenance & Modification Audit (2026-06-17)

> Extracted from `APP_MANIFEST.md` §3.23a on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


**Merged to `main` 2026-06-17 (`98e7f6e`); both migrations applied to prod (`match_provenance_audit` + `drop_match_origin` — live, `match_events` accumulating real rows).** Replaces the flat `matches.origin` enum with an auditable 3-layer model so every match's birth + every roster change is known.

**Files:** `src/lib/match-provenance.ts` (pure logic), `src/lib/match-event-log.ts` (best-effort), `src/app/actions/match-events.ts` (reads), `src/components/organizer/match-event-timeline.tsx` (UI), migrations `20260617000000` (additive) + `20260617000001` (origin drop).

**Data model:**

| Layer | Column / table | Meaning |
|---|---|---|
| Birth (immutable) | `matches.created_method` | `auto` \| `manual` \| `held` — never overwritten |
| Rollup | `matches.modification_count` | composition changes net of undos; `provenance_backfilled` marks pre-cutover rows |
| Ultimate label | `matches.final_classification` | GENERATED: `created_method \|\| (count>0 ? '_modified' : '_clean')` → 6 values |
| Full trail | `match_events` (append-only) | one row per organizer ACTION; JSONB movements; snapshotted actor/player names; `correlation_id` ties cross-match legs; `reverses_event_id` for undo; `ON DELETE SET NULL` + snapshots survive deletion |

**How counting works:** the `record_match_event` RPC (called from inside every composition RPC under the match row lock) computes per-match `seq`, inserts the event, and applies the delta (`roster_swap`/`team_flip`/`ondeck_pull`/`player_left` = +1, `undo` = −1, else 0). The old `WHERE origin='auto'` guard is removed — composition changes count on auto/manual/held alike, so `manual_modified` is now real. **Undo correctness:** the two live undo paths re-call the forward RPC with `p_is_undo:true` → records an `undo` (−1), not a second forward (+1), so net counting and partial-undo are correct.

**Cross-match:** the on-deck pull and the cross-match draft swap each write **two correlated rows** (+1 per match). Score edits / reverts / cancels are logged (best-effort, server-action) but never count.

**Origin retirement (B-clean):** migration 1's RPCs are origin-free; the badge (`MatchOriginTag`) + `v_match_history` move to `final_classification`; migration 2 rebuilds the view chain and `DROP COLUMN origin`. The `match_origin` ENUM type is retained (vestigial — `p_origin` params still map to `created_method`).

**Backfill:** birth method is recovered exactly for all existing matches (sticky rule: `origin='modified'` ⇒ born auto; `is_held` ⇒ held), so "% auto vs manual vs held" is accurate retroactively. `manual_modified` is unrecoverable for history (accurate only going forward); legacy modified rows get `modification_count=1` floor.

**Reading the trail is bound to the AUTHORIZED session (PR3, tenancy audit #4).** `getMatchEvents(matchId, sessionId)` gates on `isSessionOrganizer(user.id, sessionId)` and then reads through the service client, which bypasses RLS — so the gate is the only check there is. The read was keyed on `match_id_snapshot` alone: two independent client-supplied arguments, only one of them authorized, which let an organizer of session A pass a match id from session B and pull another club's full trail (actor names, roster snapshots, swap history). It now filters on `session_id_snapshot` as well, so a mismatched pair returns zero rows instead of someone else's audit log. `session_id_snapshot` is `NOT NULL` and, unlike the live FK, survives match deletion, so historical rows are covered — verified on prod: 648 events over 465 matches, zero null snapshots and zero rows where the snapshot disagrees with the live match's `session_id`, i.e. the filter excludes nothing legitimate. `getSessionProvenance` was already session-keyed. **Tests:** `tests/unit/tenancy-session-binding.test.ts` (TB-EVENTS).

**Clear/cancel/leaver audit trail (PR #22 `dad594f`, 2026-07-13):** the three previously-silent delete paths now log a best-effort `cancelled` event via `logMatchEvent` — `clearOnDeckMatch` (actor + roster snapshot + `created_method`/`is_published`, `reason:'on_deck_cleared'`), `clearAllUnpublishedDrafts` (one event per swept draft; TS pre-fetch mirrors the RPC filter exactly: pending + unpublished + not-held; `reason:'batch_clear_unpublished'`), `checkoutPlayer` (one event per `cancelled_match_id` from the cleanup RPC; `actorId:null` → `actor_type='system'`; `payload:{reason:'checkout_below_min', trigger_player_id}`). Delete paths log BEFORE the delete so the FK is valid at insert (`ON DELETE SET NULL` + `match_id_snapshot` preserve the trail); a domain error after the log can leave a false `cancelled` row (narrow, accepted per §14.E-2); the PGRST202 fallback loops are intentionally un-audited. No migration — `event_type` is text, `record_match_event` already live. **Still deferred:** `published` events on the publish paths (zero metric impact). See MEMORY.md + `MATCH_PROVENANCE_AUDIT_PLAN.md`.

**Organizer queue-kick audit (`fix/audit-organizer-remove`, 2026-07-23):** closes the last silent cancel path PR #22 deferred. When an organizer kicks a player via `removePlayerFromQueue` → `remove_player_from_queue_organizer` RPC, any pending match the player was on that then drops below 4 is **soft-cancelled** (`status='cancelled'`, row survives). The action now re-queries the RPC's returned match ids for `status='cancelled'` and logs one best-effort `cancelled` event each — `actorId=organizer` (`actor_type='organizer'`, contrasting checkout's `system`), `phase:'draft'` (the RPC only touches `pending`, never `in_progress`), `payload:{reason:'organizer_removed_player', trigger_player_id, was_published}`. This is why a kicked on-deck match (the "Bri & Veejay vs Stelle & Alvin DG" incident) previously vanished with no trail. Logging runs after the soft-cancel (FK stays valid). Note a repo↔prod drift on the RPC's return array (deployed returns all-affected ids, repo migration returns only-cancelled) — the `status='cancelled'` filter is correct under both; reconcile the migration file in a later pass.

---

