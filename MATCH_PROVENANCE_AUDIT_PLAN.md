# Match Provenance & Modification Audit — Implementation Plan

## 1. Intent

Today a match carries a single flat `origin` enum (`auto | manual | modified`). Any
modification — tap-to-swap, team flip, on-deck pull, fix-record correction — collapses an
`auto` match into one flat `modified` tag. There is **zero** persistent record of *who*
changed it, *what* changed, *when*, or *in what order*. Undo context lives in memory for 3s
then is discarded. Score edits/reverts aren't even flagged.

**Goal.** Make match provenance *distinct and auditable*:

1. Know exactly **how each match was born** (auto engine / manual organizer / cross-court held draft) — immutable, never overwritten.
2. Capture **every composition change** granularly and completely — who replaced whom, on which team, in which match, in order, at any phase (draft / active / post-completion), including changes after the game ends.
3. Classify each match **ultimately** at finalization, accounting for modifications.
4. Answer analytics accurately, e.g. "what % of matches are manual vs auto-generated" and "show Match A's full story: born auto, 2 players swapped, then pulled from the bench, then re-swapped mid-game — who replaced who."

**The worked example (Match A) the model must reproduce:**

```
matches row (rollups):
  created_method: auto      ← immutable
  modification_count: 3
  final_classification: auto_modified   ← generated

match_events (complete ordered trail):
  seq 1  created        method=auto    actor=engine            phase=draft
  seq 2  roster_swap     Carlo →Stelle  team=a  actor=Alice     phase=draft
  seq 3  roster_swap     Veejay→Mike    team=b  actor=Alice     phase=active
  seq 4  ondeck_pull     Mike  →Jhun    team=b  actor=Alice     phase=active   (2 correlated rows)
  seq 5  roster_swap     Jhun  →Paolo   team=b  actor=Alice     phase=post_completion
```

---

## 2. Locked Design Decisions (from grilling)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Hybrid model**: append-only `match_events` log (source of truth) + denormalized rollups on `matches` for fast filtering. | Flat columns can't hold an unbounded modification sequence; pure log makes common reads aggregate every time. Mirrors existing `player_renames` precedent. |
| D2 | **Two axes**: immutable `created_method` (birth) + append-only modification trail. Never overwrite birth. | Today `origin` does both jobs, so a swapped auto match masquerades as `modified` and birth is destroyed — making "% auto vs manual" impossible. |
| D3 | **`created_method` ∈ {`auto`, `manual`, `held`}** — held is distinct from auto. | A held draft borrows a still-playing body across courts; materially different mechanism worth analyzing separately. |
| D4 | **`final_classification`** is a 6-value **generated** column derived from the two axes. Never hand-written → can't drift. | `auto_clean / auto_modified / manual_clean / manual_modified / held_clean / held_modified`. |
| D5 | **Composition changes count; result changes don't.** Roster/team changes → `modification_count++`. Score edits & reverts are logged but never count (players unchanged). | "Modified" must mean "roster differs from what was originally composed" — the integrity signal. |
| D6 | **Composition changes count in EVERY phase** — draft, active, *and* post-completion (fix-record). Publishing a modified draft does **not** un-modify it. | A draft swapped before publish is still modified. Post-completion roster corrections are still composition changes. |
| D7 | **Event granularity = one row per organizer ACTION**, with individual player movements in a JSONB payload. `modification_count` counts actions, not limb-movements (a team flip = 1 modification). | A 3-way pull / team flip is one causal decision; splitting loses causality and over-counts. |
| D8 | **Cross-match actions (on-deck pull) write TWO correlated rows** — one per affected match, shared `correlation_id` — each incrementing its own match's count. | Both the active match and the backfilled on-deck draft end up with rosters different from what the engine produced → both are modified, both queryable by their own `match_id`. |
| D9 | **Undo = net accounting.** Undo reverses exactly ONE action (single-level, confirmed in code), decrements `modification_count` by 1 (never resets to 0), and writes its own append-only `undo` event referencing the reversed event. | Final roster = birth roster after undo ⇒ not modified; but a partial undo (2 swaps, undo 1) correctly leaves the match `modified`. Trail stays complete. |
| D10 | **`origin` retired (B-clean).** Replace with `created_method` + `modification_count` + generated `final_classification`. Migrate the single badge component + view + types; drop `origin` in the same migration. No legacy shim. | Reader surface is tiny (one `MatchOriginTag` component, 4 sites, 1 view, no external consumers). One authoritative model, zero leftover. |
| D11 | **Names snapshotted** into events (actor + every player) alongside ids; `actor_type` ∈ {`engine`, `organizer`}. No hard FK dependency for readability. | App actively merges/renames profiles (`migrate_player_identity`, dup-name resolution). An audit trail must remain a true historical fact regardless of later profile churn. |

---

## 3. Data Model

### 3.1 `matches` rollup columns (new)

```sql
ALTER TABLE matches
  ADD COLUMN created_method     text NOT NULL DEFAULT 'auto'
             CHECK (created_method IN ('auto','manual','held')),
  ADD COLUMN modification_count integer NOT NULL DEFAULT 0
             CHECK (modification_count >= 0);

-- 6-value ultimate label, never hand-written (references only stored columns)
ALTER TABLE matches
  ADD COLUMN final_classification text
  GENERATED ALWAYS AS (
    created_method ||
    CASE WHEN modification_count > 0 THEN '_modified' ELSE '_clean' END
  ) STORED;

-- origin dropped at the END of the migration, after readers migrate (see §6).
```

> **Note on generated column legality:** `final_classification` references only `created_method`
> and `modification_count` (both plain stored columns) — Postgres permits this. It must NOT
> reference `is_held` or any other generated column. `STORED` so it's indexable for analytics.

### 3.2 `match_events` table (new — append-only audit log)

```sql
CREATE TABLE match_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id         uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  session_id       uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,  -- denormalized for RLS + session queries
  seq              integer NOT NULL,            -- per-match monotonic order (1,2,3,…)
  event_type       text NOT NULL CHECK (event_type IN
                     ('created','published','roster_swap','team_flip',
                      'ondeck_pull','undo','score_edit','revert')),
  phase            text NOT NULL CHECK (phase IN ('draft','active','post_completion')),
  counts_as_modification boolean NOT NULL DEFAULT false,
  actor_type       text NOT NULL CHECK (actor_type IN ('engine','organizer','system')),
  actor_id         uuid,                          -- organizer profile id; NULL for engine/system
  actor_name       text,                          -- snapshot at write time
  correlation_id   uuid,                          -- ties the 2 rows of a cross-match pull
  reverses_event_id uuid REFERENCES match_events(id), -- for undo
  movements        jsonb NOT NULL DEFAULT '[]'::jsonb, -- granular player moves (see §3.3)
  payload          jsonb,                         -- event-specific extras (created method/roster, score deltas)
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, seq)
);

CREATE INDEX idx_match_events_match     ON match_events(match_id, seq);
CREATE INDEX idx_match_events_session   ON match_events(session_id);
CREATE INDEX idx_match_events_type      ON match_events(session_id, event_type);
CREATE INDEX idx_match_events_correlation ON match_events(correlation_id) WHERE correlation_id IS NOT NULL;
```

`seq` is assigned inside the writing RPC as `COALESCE(MAX(seq),0)+1` under the row lock the
swap RPCs already take, so it's race-safe.

### 3.3 `movements` JSONB shape (per event_type)

```jsonc
// roster_swap (1 out, 1 in, same team)
[{ "out_player_id": "...", "out_player_name": "Carlo",
   "in_player_id": "...",  "in_player_name": "Stelle", "team": "a" }]

// team_flip (2 players swap sides)
[{ "player_id": "...", "player_name": "Glenn", "from_team": "b", "to_team": "a" },
 { "player_id": "...", "player_name": "JV",    "from_team": "a", "to_team": "b" }]

// ondeck_pull — ACTIVE match row (correlation_id = X)
[{ "out_player_id": "...", "out_player_name": "Mike",
   "in_player_id": "...",  "in_player_name": "Jhun", "team": "b" }]
// ondeck_pull — ON-DECK match row (correlation_id = X, secondary_match_id in payload)
[{ "out_player_id": "...", "out_player_name": "Jhun",
   "in_player_id": "...",  "in_player_name": "Zed",  "team": "b" }]
```

`payload` examples: `created` → `{ "method":"auto", "roster":[{id,name,team}×4] }`;
`score_edit` → `{ "old":{a,b}, "new":{a,b} }`; `ondeck_pull` → `{ "secondary_match_id":"…" }`.

---

## 4. Event Taxonomy & Capture Points

| event_type | counts | phase(s) | written by |
|------------|:---:|----------|-----------|
| `created` | no | draft (manual: draft, published immediately) | `create_match_with_players`, `create_held_cross_court_match` |
| `published` | no | draft→published | `publishMatchAction`, `publishAllDraftMatchesAction` |
| `roster_swap` | **yes** | draft / active / post_completion | `swap_player_in_active_match`, `swap_player_in_match`, `swap_match_players`, `fix_record_swap_player` (full-replacement path) |
| `team_flip` | **yes** | active / post_completion | `swap_teams_in_active_match`, `fix_record_swap_player` (team-flip path) |
| `ondeck_pull` | **yes** (×2 rows) | active | `swap_active_from_ondeck` |
| `undo` | **−1** | matches reversed event's phase | `undo_swap_active_from_ondeck`, and the re-call undo paths in `undoLiveSwap` |
| `score_edit` | no | post_completion | `updateMatchDetails` (score path) |
| `revert` | no | post_completion→active | `updateMatchDetails` (revert path) |

### 4.1 Counter maintenance (the critical correctness rule)

- Every `roster_swap` / `team_flip` / `ondeck_pull` row: `UPDATE matches SET modification_count = modification_count + 1 WHERE id = <that row's match_id>`. **The old `WHERE origin='auto'` guard is REMOVED** — composition changes now count on auto, manual, *and* held matches (this is what makes `manual_modified` trackable).
- Every `undo` row: `modification_count = modification_count - 1` on the match(es) it reverses (the on-deck pull undo decrements both correlated matches). Guard `GREATEST(0, …)` as a floor.
- `created` / `published` / `score_edit` / `revert`: no counter change.

All counter writes happen **in the same transaction** as the event insert, inside the existing
SECURITY DEFINER RPCs (which already take `FOR UPDATE` row locks).

### 4.2 Cross-match pull mechanics (D8)

`swap_active_from_ondeck` writes:
1. `correlation_id := gen_random_uuid()`
2. Active-match row: `event_type=ondeck_pull`, `match_id=active`, movements=[active move], `modification_count(active)++`
3. On-deck-match row: `event_type=ondeck_pull`, `match_id=ondeck`, movements=[backfill move], `payload.secondary_match_id`, `modification_count(ondeck)++`, same `correlation_id`

`undo_swap_active_from_ondeck` writes two `undo` rows (same new correlation), decrementing both.

---

## 5. Backfill Strategy (existing ~469+ matches)

Birth method is **fully recoverable** because of the sticky rule + `is_held`:

```sql
UPDATE matches SET
  created_method = CASE
    WHEN is_held THEN 'held'             -- engine held draft (was origin auto/modified, is_held=true)
    WHEN origin = 'manual' THEN 'manual' -- manual never demotes (sticky) → still manual
    ELSE 'auto'                          -- origin auto OR modified ⇒ born auto (sticky proves it)
  END,
  modification_count = CASE WHEN origin = 'modified' THEN 1 ELSE 0 END;
```

- `final_classification` then computes correctly for all history; **"% auto vs manual vs held" is accurate retroactively.**
- `modification_count = 1` for legacy `modified` rows is a **floor** meaning "≥1, exact count/trail unknown" — the granular per-swap history never existed and is honestly not fabricated.
- **No synthetic `match_events` rows are created for history.** The log starts empty and accrues real events going forward. A `MEMORY.md` note records the cutover date so analysts know pre-cutover matches have accurate rollups but no event trail.
- Document explicitly: legacy `*_modified` matches have `modification_count=1` as a floor.

---

## 6. `origin` Retirement (B-clean)

Readers to migrate (full surface, verified — no external consumers):

| File | Change |
|------|--------|
| `src/components/organizer/match-origin-tag.tsx` | Prop `origin: MatchOrigin` → `classification: MatchClassification` (6-value). Render auto(silent)/manual/held + a "modified" sub-mark. |
| `court-card.tsx:197`, `match-history-panel.tsx:148,229`, `sortable-card.tsx:320,453` | Pass `match.final_classification` instead of `match.origin`. |
| `v_match_history` view | Replace `m.origin AS match_origin` with `m.created_method`, `m.modification_count`, `m.final_classification`. |
| `src/types/database.ts` | `Match.origin` → `created_method` + `modification_count` + `final_classification`; new `MatchClassification` type; `MatchHistory.match_origin` → new fields; new `MatchEvent` row type + RPC signature updates (`p_origin` → `p_created_method`); register `match_events` writes. |
| `src/app/sandbox/match-origin/page.tsx` | Update sandbox to the 6-value showcase (non-prod, low priority). |
| RPC writers (10 migration-defined fns) | Stop writing `origin`; write `created_method` at insert + maintain `modification_count`. |

Then `ALTER TABLE matches DROP COLUMN origin;` at the end of the migration, after the view is
recreated (the view depends on the column; recreate it first).

---

## 7. RLS & Security

- `match_events`: enable RLS.
  - `SELECT`: session organizers only — `EXISTS (session_organizers WHERE session_id = match_events.session_id AND user_id = auth.uid())` OR `sessions.created_by = auth.uid()`. Players do **not** read the trail (organizer analytics surface).
  - No `INSERT/UPDATE/DELETE` policies → only SECURITY DEFINER RPCs (service role) write. Append-only by construction; never updated or deleted.
- Mirrors the `player_renames` deny-all + service-bypass pattern.
- All writes go through existing SECURITY DEFINER swap/create RPCs — no new attack surface; add `SET search_path` while touching them (closes the pre-existing advisor nit on these functions).

---

## 8. Surfacing (v1)

1. **Badge upgrade** (cheap, high value): `MatchOriginTag` shows `auto` (silent) / `manual` / `held`, with a subtle "modified" sub-mark when `*_modified`. Drives off `final_classification`.
2. **Per-match modification timeline** (organizer): in the match-history panel / fix-record area, an expandable "History" view rendering the `match_events` trail for a match — ordered, human-readable ("13:02 · Alice swapped Carlo → Stelle (team A) · mid-game"). New read action `getMatchEvents(matchId)` + view `v_match_events` (joins nothing — names are snapshotted).
3. **Session provenance summary** (cheap query, organizer): counts by `created_method` and `final_classification` for the session ("28 auto · 6 manual · 1 held · 7 modified"). Surfaced in the organizer session view / optionally session-wrapped.
4. **Deferred:** cross-session analytics dashboard; player-facing trail.

---

## 9. TypeScript / Types

- `MatchOrigin` removed; add `MatchCreatedMethod = "auto" | "manual" | "held"` and
  `MatchClassification = "auto_clean" | "auto_modified" | "manual_clean" | "manual_modified" | "held_clean" | "held_modified"`.
- `Match` gains `created_method`, `modification_count`, `final_classification`; loses `origin`.
- New `MatchEvent` row type + `MatchEventType`, `MatchPhase`, `MatchEventActorType`, `MatchMovement` types.
- RPC registrations updated (`p_created_method`, new event-returning shapes where relevant).
- `v_match_events` view type.

---

## 10. Migration Ordering (single migration file)

1. Add `created_method`, `modification_count` columns (defaults make it safe on a live table).
2. Backfill (§5).
3. Add generated `final_classification`.
4. Create `match_events` + indexes + RLS.
5. Redefine all create/swap/fix-record/score RPCs: write `created_method`, maintain `modification_count`, insert events, add `SET search_path`. Remove `WHERE origin='auto'` guards.
6. Recreate `v_match_history` without `origin`; create `v_match_events`.
7. `DROP COLUMN matches.origin`.
8. Regenerate `src/types/database.ts` from the live schema; reconcile by hand.

---

## 11. Test Strategy (Vitest ^4.1.4 — pure logic, no DB)

Unit-testable (the classification + counting logic, extracted to a pure helper):
- `final_classification` derivation: all 6 combinations.
- Counter transitions: create→0; each composition type → +1; undo → −1 (floor at 0); partial-undo scenario (2 swaps, undo 1 → count 1, still modified).
- Cross-match pull → both matches +1; its undo → both −1.
- Score edit / revert / publish → counter unchanged.
- Movement payload builders (roster_swap / team_flip / ondeck_pull) produce correct shapes incl. snapshot names.
- Backfill mapping function: (origin, is_held) → (created_method, modification_count) for all 6 input combos.

Integration / manual checklist (real Postgres RPC guards — NOT unit-tested, per repo convention):
- RPC transactional integrity (event + counter + roster in one tx; rollback on guard failure).
- `seq` race-safety under the existing row lock.
- RLS: organizer can read, player cannot.
- `DROP COLUMN origin` after view recreate (no dependency error).

---

## 12. Phase Breakdown

| Phase | Scope |
|-------|-------|
| P0 | Pure helpers + types: `match-provenance.ts` (classification, counting, movement builders, backfill mapper) + Vitest suite (TDD, red-first). |
| P1 | Migration: columns + backfill + generated col + `match_events` + RLS + indexes. **PAUSE before live apply.** |
| P2 | Redefine RPCs (create/swap/fix-record/score/publish/undo): write events + maintain counters + snapshots + `SET search_path`. |
| P3 | Server actions: thread `actor_id`/`actor_name` from `getAuthenticatedUser()` into RPC calls; new `getMatchEvents` read action. |
| P4 | `origin` retirement: badge component → `final_classification`, repoint 4 sites, recreate `v_match_history`, drop column, update types. |
| P5 | Surfacing: per-match timeline UI + session provenance summary. |
| P6 | Full validation (tsc/lint/build/tests) + review gate + docs (APP_MANIFEST, MEMORY, database.ts). |

---

## 13. Open / Deferred

- Player-facing modification trail (out of scope; organizer-only v1).
- Cross-session provenance analytics dashboard (v1 ships the per-session query only).
- Whether `score_edit`/`revert` events are worth surfacing in the timeline or just stored (stored in v1).
- Retiring `seq` in favor of pure `created_at` ordering if monotonic-int proves awkward (kept for now — deterministic ordering for same-millisecond events).

---

## 14. Review Hardening — v2 Amendments (supersede the sections noted)

A 6-dimension adversarial review (grounded in the live DB + actual RPC bodies) found real
structural problems in the v1 draft above. The fixes below **supersede** the cited sections.
**Live data reality (541 matches):** 62% manual (335), 31% auto (168), 7% modified-born-auto
(38), **0 held**, 55 cancelled (10%). The "~90% auto" assumption in v1 and in code comments is
false — re-anchor all framing to manual being the majority.

### 14.A BLOCKERS — must be resolved before any live apply

- **A1 (supersedes D9, §4.1 undo) — Undo must not re-call forward RPCs.** Today `undoLiveSwap`
  reverses team-swap and queue-replacement by **re-invoking the forward RPC** with args swapped
  ([live-match-swap.ts:375-399](src/app/actions/live-match-swap.ts)); only the on-deck pull has a
  dedicated `undo_swap_active_from_ondeck`. If the forward RPC emits a `+1` event, an undo emits a
  *second* `+1` → "swap once, undo" lands at count=2, not 0. **Fix:** build dedicated undo RPCs
  (`undo_swap_player_in_active_match`, `undo_swap_teams_in_active_match`) OR add `p_is_undo` +
  `p_reverses_event_id` params so the forward RPC emits an `undo` event and applies
  `GREATEST(0, count-1)` **inside the same status guard the RPC already uses** (the existing
  on-deck undo silently `RETURN`s on a status change — a server-side decrement would corrupt the
  count). The "undo → −1" unit test is fiction until the counter lives in PL/pgSQL (see A-tests).

- **A2 (supersedes §6, §10 step 6) — Dropping `origin` breaks a 3-object view chain.**
  `v_match_history` exposes `m.origin`; it is consumed by `v_session_leaderboard` (view) **and**
  `v_alltime_leaderboard_mat` (materialized view, with `idx_alltime_leaderboard_player_id` used by
  `REFRESH … CONCURRENTLY`), and `get_player_streaks` also reads the view. **Fix:** the migration
  must teardown/rebuild in the exact order used by `20260502000000`: DROP `v_session_leaderboard`
  → DROP MATERIALIZED `v_alltime_leaderboard_mat` → DROP `v_match_history` → recreate
  `v_match_history` (new cols) → recreate `v_session_leaderboard` → recreate the matview WITH DATA
  → recreate its index → recreate `get_player_streaks` → **then** `DROP COLUMN origin`. Never
  `CASCADE`.

- **A3 (supersedes §4, §7, §10 step 5) — `score_edit`/`revert` have no RPC.** The score path is a
  raw `db.from('matches').update(...)` ([match-lifecycle.ts:366](src/app/actions/match-lifecycle.ts));
  revert uses `revert_match_to_active` (status/queue only) **plus a non-atomic JS fallback**. The
  §7 blanket "all writes go through SECURITY DEFINER RPCs" is false. **Decision required (see
  §14.E-2).** Default fix: since these don't count toward `modification_count` (D5), log them
  **best-effort** (server-action insert into `match_events`, explicitly outside the seq-under-lock
  guarantee) and drop the §7 blanket claim — OR add a real `update_match_scores` RPC (new surface).

- **A4 (supersedes §4 row for `swap_match_players`) — the cross-match DRAFT swap mutates TWO
  matches.** Its cross-match branch moves A→matchB and B→matchA ([20260425000000:88-99]) — both
  rosters diverge from birth, identical to the on-deck pull (D8): **two correlated `roster_swap`
  rows, +1 each.** Its same-match branch is a `team_flip` (players exchange teams, nobody
  enters/leaves) — recording out/in movements there is wrong. This RPC has **no** origin flip
  today; counting is added from scratch. Branch on `p_a_match_id = p_b_match_id`.

- **A5 (supersedes §4 "complete" claim) — leaver / auto-removal is unaudited.** Checkout
  (`checkout_player_cleanup_drafts` DELETEs the player from every unpublished draft and may CANCEL
  sub-4 drafts), `cancelMatchAction`, `clearOnDeckMatch`, `clearAllUnpublishedDrafts` are genuine
  composition changes with no event. **Decision required (see §14.E-1).**

- **A6 (supersedes §4) — non-RPC fallback paths skip events.** `publishMatchAction` /
  `publishAllDraftMatchesAction` / revert fall back to raw table updates when the RPC is absent.
  Inventory every RPC-or-fallback action and either remove the now-redundant fallback or replicate
  the event write. Add a §4 column noting fallback handling.

### 14.B Completeness gaps (also pre-apply)

- **C1 — CASCADE delete contradicts immutability.** `match_events.match_id … ON DELETE CASCADE`
  means cancelling/purging a draft **destroys its trail** — the log is not append-only against row
  deletion. **Decision required (see §14.E-1).** Options: `ON DELETE SET NULL` + a
  `match_id_snapshot`/`session_id_snapshot` (orphan-but-retain), or accept loss and document it.
- **C2 — Match A example uses a global `seq`; the schema's `seq` is per-`match_id`.** The on-deck
  pull's two rows live in **different** matches' seq-streams, joined only by `correlation_id`;
  cross-match ordering relies on `created_at`, not `seq`. Fix the §1 example annotation and state
  this explicitly.
- **C3 — engine birth RPC confirmed.** `create_match_with_players`
  ([20260507000000_fix_toctou_matchmaking.sql]) is the single engine/manual insert point and takes
  `p_origin` today — rename to `p_created_method`. (Verified; was unbacked in v1.)
- **C4 — `reverses_event_id` + cross-match CASCADE interact badly** (an on-deck-pull undo references
  rows in a different match_id). Resolve together with C1.
- **C5 — republish ambiguity.** A reverted-then-republished match emits two `published` events; the
  `phase` CHECK has no "republished" notion. Allow multiple `published` events ordered by
  `created_at`; analysts read the last one as effective.
- **C6 — `counts_as_modification` is a second source of truth for `modification_count`.** Drop the
  stored boolean and derive it from `event_type` (composition types count, `undo` decrements), OR
  add a fold-equality integration test reconciling `Σ(counts) − Σ(undos) = modification_count`.
  **Chosen: drop the stored column; derive from `event_type`.**

### 14.C HIGH — mandatory plan-text corrections

- **H1 (supersedes §5) — legacy `manual_modified` is UNRECOVERABLE.** The sticky `WHERE
  origin='auto'` guard means a swapped *manual* match stays `origin='manual'` → backfills
  `manual_clean`. With 335 manual matches, an unknown subset that were swapped read clean. There is
  **no schema signal** to recover them (no `matches.updated_at`). State plainly: birth-split
  (auto/manual/held) is accurate retroactively; **`manual_modified` is accurate only going
  forward.** Do not claim retroactive modified-accuracy for manual.
- **H2 (supersedes §3.2 race claim) — add `FOR UPDATE` before `seq`.** `swap_player_in_match`
  and the same-match branch of `swap_match_players` do **not** lock the match row today; concurrent
  `MAX(seq)+1` collides on `UNIQUE(match_id,seq)` → spurious failure. Add
  `SELECT … FROM matches WHERE id=… FOR UPDATE` before computing `seq` in every event-writing RPC
  (or `INSERT … ON CONFLICT` retry). Stop claiming the lock already exists.
- **H3 (supersedes §5, §10) — backfill must be idempotent + split.** Use
  `ADD COLUMN IF NOT EXISTS` (nullable) → backfill `WHERE created_method IS NULL` → `SET NOT NULL`.
  Move `DROP COLUMN origin` to a **follow-up migration** so a partial apply can't strand the table,
  and so a re-run can never clobber live event-derived counts back to the floor.
- **H4 (supersedes D11, P3) — `actor_name` is not free.** `getAuthenticatedUser()` returns only the
  auth user (no `display_name`). Add a `getActorContext()` helper doing one `profiles` lookup;
  pass `p_actor_id` + `p_actor_name` into every redefined RPC (none accept them today). Audit
  anonymous/PIN organizers — confirm they always have a `profiles.display_name`.
- **H5 (supersedes §3.1, §8) — floor=1 distorts SUM/AVG.** Add a `provenance_backfilled boolean`
  marker (true for floored rows). `COUNT(*) WHERE modification_count>0` is safe across the cutover;
  `SUM`/`AVG` are not. Some of the 38 legacy `auto_modified` may be net-zero swap-then-undo false
  positives (the old on-deck undo never cleaned `origin`). Surface the caveat in any count UI, not
  just MEMORY.
- **H6 (new work item, P0/P4) — TS + tests break the validation gate.** 3 prod `p_origin` sites
  ([matchmaking-db.ts:392](src/lib/matchmaking-db.ts) `'auto'`, **[:610](src/lib/matchmaking-db.ts)
  must become `'held'`**, [match-lifecycle.ts:670](src/app/actions/match-lifecycle.ts) `'manual'`),
  plus `MatchInsert`/`MatchUpdate` Picks include `"origin"` (database.ts:323/337), plus ~13
  `p_origin` test assertions and `.origin` typed fixtures across `tests/`, plus
  `manual-and-swap.test.ts` / `match-origin-tracking.test.ts` are obsoleted by D10. Add an explicit
  item: migrate all call sites + tests + the `makeMatch` factory; gate with
  `grep -rn 'p_origin\|\.origin\|origin:' tests/ src/`.
- **H7 (supersedes §11, §12) — counting is NOT unit-testable.** The real counter lives in PL/pgSQL.
  Only `final_classification` string derivation, the backfill mapper, and the movement-SHAPE
  builder (given already-resolved names) are pure-unit. Move ALL counter transitions + name
  snapshotting to the **integration checklist** (real local Postgres). Don't claim unit coverage
  for counting.

### 14.D MEDIUM / LOW (fold-in refinements)

- **M1** `matchmaking-db.ts:610` held creator → `p_created_method:'held'` (latent bug). Enumerate
  the 3 TS producers in §6.
- **M2** `fix_record_swap_player` picks team-flip vs full-replacement at **runtime**
  (`v_is_team_flip := v_in_team IS NOT NULL`); event_type + movement shape must be decided **inside**
  the RPC; add the post-completion team-flip timeline template + movement shape.
- **M3** Remove `"origin"` from `MatchInsert`/`MatchUpdate` Picks; add `created_method`
  (Insert+Update) and `modification_count` (Update); **exclude** `final_classification` (generated).
- **M4** Badge surface is **5 invocations across 3 files** + `active-courts-grid` renders
  `<MatchOriginTag origin="manual"/>`; sandbox has 4 more + literals. Update the §6 count.
- **M5** Define the headline-metric denominator: filter `status='completed'` (exclude the 55
  cancelled) in the §8.3 query, matching `v_match_history`.
- **M6** The generated `STORED` `final_classification` forces a one-time full table rewrite (ACCESS
  EXCLUSIVE) — sub-second at 541 rows; note it's not a metadata-only add.
- **M7** `is_held` is current-state (off `pulled_player_ids`), not birth; a held draft whose body
  was swapped out reads `is_held=false`. 0 held rows today → nil risk; re-run the held-count query
  at the P1 PAUSE.
- **M8** `swap_active_from_ondeck` returns OUT params consumed as a PostgREST array — append IN
  params only; never reorder/alter the OUT signature.
- **L1** §9 must also remove the `Enums.match_origin` registration + doc-comment and decide
  `DROP TYPE public.match_origin` after the column drop.
- **L2** Empty trail on legacy matches makes the timeline look broken — render an explicit
  empty-state keyed off `created_at < cutover` (chosen over seeding 541 synthetic `created` rows).
- **L3** 0 held rows → held paths ship unvalidated by data; add a held create→swap→complete case to
  the integration checklist.
- **L4** Give the new suite a dedicated id prefix (`MP-CLS-*` / `MP-BF-*` / `MP-MOV-*`); co-locate
  at `src/lib/match-provenance.ts` + `tests/unit/match-provenance.test.ts`.

### 14.E Decisions — LOCKED (user, 2026-06-17)

1. **Leaver/cancel/clear auditing + trail preservation → FULL IMMUTABLE AUDIT.** Add `player_left`
   + `cancelled` event types covering `checkout_player_cleanup_drafts`, `cancelMatchAction`,
   `clearOnDeckMatch`, `clearAllUnpublishedDrafts`. `match_events.match_id` uses
   **`ON DELETE SET NULL`** (not CASCADE) + `match_id_snapshot uuid` + `session_id_snapshot uuid`
   so the trail survives match-row deletion. `player_left` counts as a composition modification
   (`modification_count++`) since it changes the roster; `cancelled` is a lifecycle event (no count).
2. **`score_edit` / `revert` logging → BEST-EFFORT.** Logged from the server action (outside the
   row lock), explicitly excluded from the seq-under-lock guarantee. No new RPC. They never affect
   `modification_count`. The §7 "all writes go through RPCs" blanket claim is dropped.
3. **Backfill fidelity → ACCEPTED.** ~335 historical manual matches read `manual_clean`;
   `manual_modified` is accurate only going forward (no recovery signal exists). Birth-split
   (auto/manual/held) is accurate retroactively.

### 14.F Final migration sequencing (two files; supersedes §10)

- **Migration 1 (additive, idempotent, applied first):** `ADD COLUMN IF NOT EXISTS created_method,
  modification_count` (nullable) → backfill `WHERE created_method IS NULL` → `SET NOT NULL` +
  defaults → add generated `final_classification` → create `match_events` (match_id ON DELETE SET
  NULL + snapshots) + indexes + RLS → redefine all create/swap/fix-record/undo RPCs to write
  `created_method`, maintain `modification_count`, insert events, take `p_actor_id`/`p_actor_name`,
  add `FOR UPDATE` + `SET search_path`; add new undo RPCs + `player_left`/`cancelled` handling.
  **Keeps `origin` intact** (dual-state) so old app code keeps working until the new app deploys.
  **PAUSE before live apply.**
- **App deploy:** new types, badge → `final_classification`, `getMatchEvents`, server actions
  thread actor context.
- **Migration 2 (the drop, applied after app deploy):** teardown/rebuild the
  `v_match_history` → `v_session_leaderboard` → `v_alltime_leaderboard_mat` chain without `origin`,
  recreate `get_player_streaks`, `DROP COLUMN matches.origin`, `DROP TYPE match_origin`.
