# DB Optimization Audit — 2026-07-17

**Method:** 8-domain multi-agent audit over all 342 `.from()`/`.rpc()` call sites, every RPC/view/policy in `supabase/migrations/`, and the client realtime layer — graded against **live prod evidence** (pg_stat_statements, pg_stat_user_tables, pg_policies/pg_proc introspection, Supabase advisors) from project `usxftpexoimletqmrggb`. High/medium claims were re-verified by hand against the live DB before inclusion (the three 🚨 items below were confirmed by querying prod function definitions directly).

**Prod cost headlines (lifetime):** realtime WAL polling = #1 total DB time (2M+ calls, ~3.7h); `refresh_alltime_leaderboard()` = 1,219 calls × 94 ms (the module-level 30s debounce is per-serverless-worker, so it barely gates); `sessions` = 14.3M seq scans on a 22-row table and `club_members` = 9.6M idx scans — almost all from RLS helper-function chains evaluated per row/per event. Data is tiny (781 matches); every win here is **call-volume and round-trip** reduction, not big-table tuning.

---

## 🚨 Correctness bugs found by the audit (fix first — all need a migration)

### C1. `create_match_with_players` lost its `drafted` branch (broken since 2026-06-17)
**Verified against live prod functiondef.** The 20260617 provenance rewrite kept only `IF NOT p_is_on_deck → 'playing'` / `ELSIF p_is_published → 'on_deck'` and dropped the `ELSE → 'drafted'` branch that 20260511000000 introduced. In draft mode (the default; only 1 of 22 sessions ever enabled auto-publish), engine-created draft rosters leave their 4 players at `status='waiting'`:

- The engine's next slot re-picks those same top-priority players → the RPC's conflict guard returns NULL → slot skipped. **Draft mode chronically under-generates** (~1 draft per trigger instead of filling the 3/5/6 cap), and keeps NULL-looping while those players stay on top of the pool.
- **`publish_match` / `publish_all_drafts` only flip `WHERE status='drafted'`** (verified live) — so publishing an engine draft never sets `on_deck` on queue rows either. The "Match Forming" card (PR #20) and queue-side on-deck states silently never fire for engine drafts. The on-deck overlay itself still works (it reads published matches, not queue status), which is why this went unnoticed.
- `auto_publish_match` (written 20260623) handles `IN ('drafted','waiting')` — its author unknowingly coded around the bug, masking it in auto-publish mode.

**Fix (one migration):** restore the `ELSE UPDATE ... SET status='drafted'` branch in `create_match_with_players` AND widen `publish_match`/`publish_all_drafts` queue predicates to `status IN ('drafted','waiting')` (heals pre-existing stuck rows; mirrors `auto_publish_match`). Verify the held/cross-court create path sets drafted for pulled bodies too.

### C2. `migrate_player_identity` silently deletes `first_to_100` milestones
`club_milestones.player_id` is `ON DELETE CASCADE` (created 2026-07-04), but `migrate_player_identity` (last touched 2026-07-01, repoints 8 other tables) was never retrofitted — its final `DELETE FROM profiles` cascades the milestone away, permanently vacating the one-per-club `UNIQUE(club_id, milestone)` slot for the *next* crosser to claim. **Fix:** add the standard guarded repoint block (`UPDATE club_milestones SET player_id = p_new WHERE player_id = p_old`) before the profile delete.

### C3. `reconnectPlayer` Phase-2 live-match probe checks an arbitrary row
`auth.ts:309-326` fetches `match_players → matches(status)` with `.limit(1)` and **no status filter in SQL** — it inspects one arbitrary historical match (~18 per player), so a player actually in a live match almost never gets Phase-2 targeting and falls through to recency heuristics. **Fix (code-only):** add `.in("matches.status", ["pending","in_progress"])`. Note: this *restores* documented behavior — observable improvement on reconnect targeting.

---

## Tier 1 — code-only optimizations (no DDL, no user-visible behavior change)

Ranked by measured/derived impact:

1. **Debounce realtime refetch bursts (hooks)** — every subscription callback refetches immediately; one engine draft writes ~9 rows fanning into up to 3 channels/table/device, each firing 4-7-query refetch pipelines. Add a ~200ms trailing-edge debounce inside the subscription effects (wrapping the existing ref-callbacks; fetchSeq guards stay). ~5× fewer refetch storms on every device. (`use-session-data`, `use-player-match`, `use-enriched-matches`, `use-match-alerts`, `use-match-history`)
2. **One channel per table per page** — ❌ **NO-GO 2026-08-04** (`PENDING_WORK_2026-07-23.md` §6.3). Re-derivation found the design unsafe as written and the census wrong: steady state is **11 channels, not 12**, and `matches` has **3** subscribers, not 4 (`MatchHistory` is not mounted by default — `my-status-tab.tsx:59` defaults to `"queue"`). `supabase.channel(topic)` dedupes by topic; `REALTIME_CHANNEL_COUNT = 5` is an **exact-equality** check that any dedup would peg to "disconnected" forever; and `on()` throws after `subscribe()`. Five revisit preconditions are recorded in §6.3 — the first being that item 1's shared debounce (which already removed the fan-out cost this was blamed for) is re-measured.
3. **Organizer hub count fan-out** — `(full)/organizer/page.tsx` runs 3 count queries per active session + 1 per past session (unbounded). Replace with 3 bulk `.in("session_id", ids)` fetches grouped in JS: ~dozens-to-200 round trips → 3.
4. **Session leaderboard computed twice per 15s tick** — `fetchMyStats` re-runs `get_session_leaderboard_public` (full board aggregation, non-inlinable SECURITY DEFINER) just to pluck one row; with `MIN_SESSION_GP=1` the board already contains it. Derive myStats from the fetched board → halves the heaviest read aggregation per tick. Same shape for **monthly**: one action returning `{rows, myRow}` instead of executing the RPC twice.
5. **TV board: 5 sequential round trips → 2** — `tv.ts` awaits sessions → matches → courts → match_players → profiles serially, 4 ticks/min for hours; collapse to session + one embedded matches select (service client, firewall filter preserved).
6. **`isSessionOrganizer` 3 serial round trips** — `_shared.ts` awaits sessions → session_organizers → club_members in sequence on ~25 organizer action call sites. Single embedded-select on the service client (or at minimum `Promise.all` the first two). 3 hops → 1.
7. **Engine per-slot diversity fetches** (filed as "9 → 3 round trips"; the audited 9 counted the
   commit RPC, so the read phase proper is **8 → 3**) — ✅ **SHIPPED 2026-08-04.** `fetchRecentRosters` + `fetchPartnershipCounts` + `buildOverlapMap` were all projections of the same *(session matches + match_players)* set; they are now one `fetchSessionMatchSnapshot` per slot plus three pure derivations. Also fixed `buildOverlapMap`'s unordered global `.limit(200)` truncation landmine. Per-slot cadence kept (sibling-draft visibility is load-bearing). Per slot 8 queries/depth 8 → 3/depth 2; a maximum 6-draft burst (`MAX_AUTO_DRAFTS_XLARGE`) 54 → 24 requests. Details in `PENDING_WORK_2026-07-23.md` §6.1.
8. **`endMatchAction` requeue loop** — 8 statements per match end (SELECT+UPDATE per player, JS read-modify-write that can lose increments). Best as a tiny RPC (Tier 2); interim code win: single fetch + parallel updates.
9. **Submit-path duplicate auth** — `submitMatchScore → endMatchAction` validates the GoTrue user twice and runs the 3-query organizer gate for plain players whose membership is already proven. Internal `endMatchInternal(user, …, participantVerified)` skips both.
10. **Misc round-trip merges** — `resolveSessionClubSlug` 2 queries → 1 embedded (hits every push send + redirect shims + reconnect); `pushToPlayers` fetch subs ∥ slug; request-scoped `cache()` for `auth.getUser()` in RSC layout+page pairs (2-3 GoTrue hops per navigation → 1); `(app)` layout adopting the `(full)` layout's count-first `getMyClubs` gate; engine `sessions` row fetched once per run instead of 2-3×; dead `is_paused` supplemental query in `fetchActivePool` (the view exposes `is_paused`; the justifying comment is stale).

## Tier 2 — migration-required (needs your explicit go-ahead, per standing rule)

Grouped into three migrations:

**M1 — Hot-path restores + global refresh debounce + indexes** (low risk, high value)
- C1 + C2 fixes above.
- `refresh_alltime_leaderboard()`: wrap body with `pg_try_advisory_xact_lock` + a one-row `last_refreshed_at` state check (skip if <30-60s old). Call sites stay fire-and-forget; the broken per-worker JS debounce becomes a real global one. Kills the 1,219-call refresh storm (~94ms × every score submit/reconnect). (`pg_cron` 1.6.4 is available-but-not-installed as an alternative; in-function gate is simpler.)
- Index pack (advisor-cross-checked, all tiny-write-cost): `queue_entries(player_id, joined_at DESC)` (primary-club resolver seq-scans + identity-migration repoints), partial `matches(pulled_from_match_id)` (RI probe per engine draft delete), `sessions(created_by)`, `club_invites(created_by)`, partial `club_invites(consumed_by)`, partial `club_members(invited_by)`, `clubs(created_by)`, `club_milestones(player_id)`, `match_events(session_id)`.

**M2 — RLS consolidation** (highest leverage, needs careful equivalence review)
- Merge the `is_session_organizer(x) OR is_session_club_member(x)` pair (4 policies) into one single-pass `has_session_access()` helper — halves the 14.3M `sessions` probes; and `has_match_access()` for `match_players`/`match_games` (6 probes → 3-4 per row on the tables realtime broadcasts unfiltered).
- Drop duplicate PERMISSIVE policies (`queue_entries_update`/`_select`/`_insert`, `profiles_update` are subsumed by their twins — verified against live pg_policies).
- Wrap bare `auth.uid()` → `(select auth.uid())` in the 28 advisor-flagged policies (initplan hoisting; zero semantic change).
- `ALTER PUBLICATION supabase_realtime DROP TABLE session_organizers, match_games` (zero subscribers exist; pure WAL-decode waste).

**M3 — Structural (optional, bigger)**
- ❌ **DECLINED 2026-08-04** — Denormalized `match_players.session_id` → filtered realtime subscription. It would suppress no measured traffic (`postgres_changes` already re-checks RLS per row, so cross-club is server-side-suppressed, and prod has had **zero** cross-session-within-a-club events across 27 sessions), and it **cannot cover DELETE at all**: filters match the OLD row, and the table is `REPLICA IDENTITY DEFAULT`, so a `session_id` filter silently drops every DELETE. Verdict + banked design: `src/lib/realtime.ts:180-209` and `PENDING_WORK_2026-07-23.md` §6.4.
- ❌ **WON'T DO 2026-08-04** — `compute_session_wrapped` per-player-loop hoists (~10 stmts/player → CTE aggregates). The "236.5 ms" that justified it is a `pg_stat_statements` **mean over 44 calls** (sd 121.9); the honest saving is ~2–12% ≈ 15–25 ms warm ≈ **2 s of DB CPU per year**, and there is **no valid regression oracle** — of the 621 stored `session_wrapped` rows, 419 predate the deuce `>= 30` change and a further 130 predate the first-to-100 hardening, so the stored values disagree with current correct behaviour and a re-run diff would be pure noise. See `PENDING_WORK_2026-07-23.md` §6.2, which also carries a separate **human-gated** ticket worth doing on its own: prod's 44,706-byte `compute_session_wrapped` exists in no repo file and should be snapshotted via `pg_get_functiondef(oid)` — never `prosrc`.
- Still open: `requeue_finished_players` RPC (atomic `games_played = games_played + 1`, fixes the lost-increment race); set-based `reorder_on_deck_matches`; VIP columns folded into leaderboard RPCs/matview (removes a query per board fetch); drop `match_events`' 3 never-used indexes + ledger prefix-redundant indexes.

## Low-priority / scaling landmines (25 items — see workflow output for full detail)
Notables: RESTRICTIVE draft-firewall policy duplicates the PERMISSIVE qual (2× helper chain per matches row — cosmetic to merge); `get_h2h_record` aggregates the club's entire completed history per on-deck card; `v_match_history`'s baked `ORDER BY` wastes a sort in every aggregate consumer; `matches.completed_at` unindexed for monthly RPCs; `/play` lobby 6-hop waterfall; `closeSession` serial updates.

## Verified non-issues (do not re-litigate)
- RLS helpers are correctly `STABLE SECURITY DEFINER` with pinned search_path; the cost is call volume, not misconfiguration. No missing indexes behind them — the 22-29-row seq scans are the planner being right.
- `IN (SELECT … session_organizers …)` policy quals execute as one hashed subplan per statement, not per row.
- `profiles_select USING(true)` is deliberate (public leaderboard/Wrapped) and cheap; `pin` is protected by column REVOKE + publication column list.
- The 15s/45s polls are by-design fallbacks; engine per-slot re-fetch cadence is load-bearing (sibling-draft visibility); `checkoutPlayer`'s manual fallback loop is dead code behind the deployed RPC; engine-path indexes all exist.
- Full per-domain non-issue lists: workflow output `w5dm4tno1.output`.
