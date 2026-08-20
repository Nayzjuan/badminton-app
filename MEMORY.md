# MEMORY.md — current state

<!-- CURRENT STATE ONLY. Hard-capped at 40 KB by .husky/pre-commit. -->
<!-- Closed history:      docs/archive/MEMORY_HISTORY.md  (search it, never read it whole) -->
<!-- Durable reference:   docs/reference/ARCHITECTURE_QUICKREF.md -->
<!-- How the app works:   APP_MANIFEST.md  (via DOC_INDEX.md — do not read end-to-end) -->

**Rules for this file** (full version in `CLAUDE.md`):

- Append at most ~15 lines per task, at the top, under a new `##` heading.
- When an item closes, **move it to `docs/archive/MEMORY_HISTORY.md`** — do not leave it here
  with a ✅ stamp. A file of closed items is not a memory, it is a graveyard, and it cost this
  project a context window.
- Never write a head SHA or a "nothing is in flight" claim here. Both are falsified by the
  commit that lands them.
- A dated incident write-up belongs in `docs/incidents/YYYY-MM-DD-slug.md`, not here.

---

## 🔒 STANDING CONSTRAINTS — carried forward, not history

Narrative for each is in `docs/archive/MEMORY_HISTORY.md` (grep the phrase). These are here because
they bind the *next* change, not because they record a past one.

- **Nothing on GitHub gates a merge here, and nothing can.** Private repo on a free plan; branch
  protection and rulesets both answer `403 "Upgrade to GitHub Pro or make this repository public"`.
  `.husky/pre-push` (tsc + lint + unit, in CI's order) is the only gate — and 🪤 **a local hook is
  not a merge gate**: `--no-verify` skips it and it binds one machine.
- **`ALTER DEFAULT PRIVILEGES` differs between prod and local.** `FOR ROLE postgres IN SCHEMA public`
  is `arwdDxtm` on prod, `Dxtm` locally, so a `CREATE TABLE` carrying no explicit grants ships **two
  different ACLs**. Name every role whenever the intent is narrower than the default.
- 🪤 **An assertion that a privilege is ABSENT proves nothing unless the environment would otherwise
  grant it** — otherwise the test agrees with the environment rather than with the migration.
- 🪤 **A fix for a class is the likeliest place the next instance of it hides.** After fixing the
  flagged sites, grep for the shape.
- 🪤 **A green sibling run is not a passing test.** One SHA can produce a failing push-event run and a
  passing pull_request run. Per-run `headSha` + per-run conclusion, never the badge.
- ⚖️ **Held-draft readiness is best-effort ON PURPOSE — do not "close the gap" with a retry.**
  `recomputeHeldReadiness` logs a failed stamp and leaves it for the next lifecycle event; the engine
  heartbeat makes that dense. A transient 502 there is expected. See APP_MANIFEST, *Cross-Court
  Diversity Drafting (held drafts)* → "A failed read is never an answer".

---

## 🗂️ MIGRATION LEDGER — applied migrations and their prod stamps

**Migrations in this project are applied BY HAND. There is no deploy automation for the database.
Merging a PR ships TypeScript only.** **Every new migration must be
added to this table with its prod stamp** — the stamps drift from the filenames, and this table is
the only place that records the mapping.

To ask what is unapplied, query the catalog — `list_migrations`, or
`select name from supabase_migrations.schema_migrations` — and compare **by name suffix**.
🪤 **A bare set-difference against `ls supabase/migrations/` overstates the gap in both directions**
and must not be read as drift. **Every differing name was reconciled file-by-file against a prod
catalog snapshot on 2026-08-20 — see `docs/reference/MIGRATION_RECONCILIATION.md`, which
dispositions all of them.** The result: **zero unapplied migrations, zero drift.** They split into
bootstrap declarations of objects prod already had (`initial_schema`, `declare_*`,
`create_dashboard_authored_view`) that must never be applied; files renamed *after* they were
applied, so prod holds the older name (`scope_match_players_insert` in the repo is
`scope_match_players_insert_to_session_organizer` on prod); early hand-applied fixes since
superseded by a whole-body `CREATE OR REPLACE`; and two stopgaps applied then reversed.
Resolve a suspected gap file by file, never by count — and check that doc before re-deriving it.

| Applied | Stamp |
|---|---|
| `20260821000000_prior_sessions_exclude_hidden` | `20260821000000` |
| `20260820000000_wrapped_reads_the_ledger_as_of_this_session` | `20260820000000` |
| `20260818120000_lock_queue_status_events_grants` | `20260819011750` |
| `20260818000000_session_notifications` | `20260816065517` |
| `20260817000000_queue_leave_notices` | `20260816052740` |
| `20260810000000_declare_compute_session_wrapped` | `20260810151122` |
| `20260810000001_extend_draft_firewall_to_match_players` | `20260810151355` |
| `20260811000000_one_time_milestone_awards` | `20260810173410` |
| `20260811000001_repair_duplicate_milestone_awards` | `20260810173605` |
| `20260812000000_clear_on_deck_never_unseats_a_playing_body` | `20260812092029` |
| `20260812100000_refresh_cross_session_stats_absolute_rebuild` | `20260812144342` |
| `20260815000000_queue_status_audit` | `20260815133945` |
| `20260816000000_publish_never_touches_an_unready_held_draft` | `20260816024129` |

⚠️ **`20260818000000` — applied to prod 2026-08-16, verified.** Stamp `20260816065517` (MCP name `session_notifications`).
Table `session_notifications` exists, RLS on, 0 rows. Indexes: pkey, `session_created`, pending-correction unique, pause-bucket unique. Policy: `session_notifications_player_select_own` (SELECT, `kind = score_correction AND subject_player_id = auth.uid()`). Table grants: `authenticated=SELECT` only; `service_role=ALL`; no `anon`.
`resolve_score_correction` `SECURITY DEFINER`, ACL exactly `{postgres=X/postgres,service_role=X/postgres}`, `anon_exec=false`, `auth_exec=false`, `service_exec=true`. `prosrc` 2022 B, md5 `69db9f321ebad474c17ea2ba57512f55` (em dash in the revert error string survived). Do not DROP.

⚠️ **`20260817000000` — applied to prod 2026-08-16, verified.** Stamp `20260816052740`.
`paused_at` column on `queue_entries`; `v_queue_full_with_wait_time` trailing column +
`security_invoker=true` still set; `checkout_player_cleanup_drafts` CREATE OR REPLACE, ACL still
exactly `postgres=X/postgres | service_role=X/postgres`, `SECURITY DEFINER`. Backfill: 3 live
paused rows stamped, 0 missing.

⚠️ **`20260816000000` — applied to prod 2026-08-16, verified.** `CREATE OR REPLACE` on
**`publish_match`** (new `HELD_NOT_READY` return, checked **before** the left-player and conflict
predicates) and **`publish_all_drafts`** (unready held drafts dropped from `v_all_draft_ids` rather
than skipped in the loop, so they never land in `skipped_count`). Post-apply on prod, measured:
`publish_match` md5 `329540501beb…` → `a58ff60e1fd8…` (1852 → 2329 B), `publish_all_drafts` md5
`aba72b630dc0…` → `73d08a902e7c…` (2771 → 3133 B); both still `SECURITY DEFINER`; both ACLs still
exactly `postgres=X/postgres | service_role=X/postgres` — **no PUBLIC, anon or authenticated grant**.
Return ordering re-verified positionally after apply: `HELD_NOT_READY` < `HAS_LEFT_PLAYERS` <
`CONFLICT`. Pre-apply the two prod bodies were confirmed **clean pre-fix baselines** (no `v_is_held`,
no ready clause), so the new version is a strict superset, and both open sessions had **0 live
matches and 0 held drafts** at the time — nothing in flight was disturbed.
🪤 **Those md5s and byte counts are of `pg_get_functiondef(oid)`, NOT `prosrc`.** The same two bodies
measure **2126** and **2941** via `prosrc`, so anyone re-verifying with the other function gets a
mismatch and reads it as drift. State which one you measured, every time.
**To roll back**, restore the pre-fix bodies from `20260717165546_fix_drafted_branch_and_publish_predicates`
— that is the migration this one supersedes, it is in the repo, and it is the only durable source. (A
reconstruction was also written to this session's scratchpad, but scratchpads are reaped; do not cite
that path as if it were an artefact.) ⚠️ **Both are `CREATE OR REPLACE` with unchanged signatures on purpose** — DROP+CREATE
resets the ACL to `EXECUTE TO PUBLIC` and undoes `20260721180000` / `20260722000004`. 🪤 The
TypeScript half degrades safely without the SQL (the UI stops offering Publish on an unready hold and
both actions' snapshot filters exclude it), which is exactly what makes "did the migration land?" easy
to stop asking — the organizer cannot reach the old `CONFLICT` path by the ordinary route, but the
RPCs themselves would stay unguarded against a stale client or a direct call. That is why
`tests/unit/publish-held-guard.test.ts` pins the JS fallbacks to the same rule as the SQL.

⚠️ **`apply_migration` strips non-ASCII from stored function bodies.** The `── section ──` rules this
repo decorates SQL with are safe in a migration *header* (never stored) but not inside a function
body: the two in-body rules in `20260812100000` came back as plain `-- player_rivalries`, leaving
prod's `prosrc` **253 bytes shorter than the repo file** while every SQL line stayed byte-identical.
Cosmetic, but it silently defeats the md5-equality check `20260810000000` uses to *prove* a body
matches. Both lines are now written the way prod stores them; the body is byte-identical again —
**6412 bytes, md5 `2cdfc65fd399c295f26425b388aa0bb8`**, verified against `btrim(prosrc, E'\n')`.
Keep in-body comments ASCII.

| File | What it does | Risk if left unapplied | Risk of applying |
|---|---|---|---|
| ~~`supabase/migrations/20260810000000_declare_compute_session_wrapped.sql`~~ | Declares `compute_session_wrapped` exactly as prod defines it (verbatim `pg_get_functiondef` capture, md5 `ec5c724c4fd8705449d0fd014d57b82d`) | ✅ **APPLIED 2026-08-10**, stamp `20260810151122` | Was a **proven** strict no-op: an md5 convergence guard was embedded in the applied file, and the post-apply md5 is still `ec5c724c…` — byte-identical body, ACL untouched |
| ~~`supabase/migrations/20260810000001_extend_draft_firewall_to_match_players.sql`~~ | Folds the draft-firewall CASE into `has_match_access`, closing audit finding **#11** | ✅ **APPLIED 2026-08-10**, stamp `20260810151355` — **#11 is CLOSED** | Applied after the code deploy reached READY. 4-check `DO $$` block passed; both dependent policies provably untouched. Verified functionally through real `authenticated`/`anon` roles. Zero existing rows lost visibility (every prod match is `completed`/`cancelled`). Revert **only** via `supabase/rollbacks/20260810000001_rollback_has_match_access.sql` — never `DROP FUNCTION` |
| ~~`supabase/migrations/20260811000000_one_time_milestone_awards.sql`~~ | Makes the six all-time-threshold awards one-time per player via a `_prior_awards` ledger; also stops a recompute from deleting the club's `first_to_100` holder (APP_MANIFEST §3.7.1) | ✅ **APPLIED 2026-08-11**, stamp `20260810173410` | Applied via `--apply-sql` (below). Post-apply verified: live `md5(prosrc)` = `e3689008fe20a015421a0c69afc49375` = the repo file's body byte-for-byte, 49438 B, 7 gates present, advisory lock present, ACL still exactly `postgres=X*/postgres,service_role=X/postgres`, `SECURITY DEFINER` + `search_path` intact |
| ~~`supabase/migrations/20260811000001_repair_duplicate_milestone_awards.sql`~~ | Strips the 188 historical duplicate grants the RPC fix cannot reach | ✅ **APPLIED 2026-08-11**, stamp `20260810173605` | Rewrote **128 real, player-visible wraps**. Outcome matched the dry-run exactly: 252 grants → **64**, 188 revoked, 48 dup groups → **0**, **0 wraps emptied**, 0 orphaned `award_data` keys across all 638 wraps. Every slug now has `grants == distinct players`. See the applied-form note below |
| ~~`supabase/migrations/20260812000000_clear_on_deck_never_unseats_a_playing_body.sql`~~ | `CREATE OR REPLACE clear_on_deck_match_atomic` — narrows its `match_players` delete so it can only touch bodies whose match is still on deck. Without it the P5 hold-age cancel unseats a body that is **mid-game** on another court | ✅ **APPLIED 2026-08-12**, stamp `20260812092029` | This one is a **hard prerequisite for P5, not an optional companion**: unapplied, cross-court produces **zero** matches, i.e. it re-ships the feature dead. Injection-verified after apply (Suite J). Function-body-only change; no table, column, policy or grant touched |

**Order:** ~~`20260810000000` first (it is inert), then `20260810000001`,~~ **← both done 2026-08-10** —
~~then `20260811000000`, then `20260811000001`.~~ **← both done 2026-08-11, in that order.** The last
two were **strictly ordered** for a reason worth keeping: the repair leaves the DB in a state the new
RPC agrees with on every subsequent recompute, but running the repair while the OLD function is still
installed means the next session close re-adds duplicates for everyone who plays.

### 🔧 How the two `20260811*` were actually applied — read before re-running either

There is no `psql`, no Supabase CLI and no DB URL on this host; the **only** channel is the Supabase
MCP. That forced two deliberate deviations from the repo files. Both are safe, but they are not
what the files say:

1. **`20260811000000` was applied by server-side reconstruction, not by shipping the body.**
   `python3 scripts/gen-one-time-milestone-awards-migration.py --apply-sql <path>` emits the
   mutating twin of `--verify-sql`: it reads prod's own `pg_proc.prosrc`, replays the 10 anchored
   `replace()` calls **on the server**, asserts each anchor matched exactly once, asserts the rebuilt
   `md5` equals `e3689008fe20a015421a0c69afc49375`, and only then issues the `CREATE OR REPLACE`.
   Any failed check raises *before* the DDL, so a bad run applies nothing. It short-circuits if the
   body is already at the target md5, so it is idempotent. **Why:** the alternative was reproducing
   49 KB of plpgsql character-perfect by hand, where a silent slip still compiles. This makes
   byte-correctness a *proven precondition* instead of a hope.
2. **`20260811000001` was applied as ONE `DO $repair$` block**, not as the file's
   `begin;…commit;` + `_emptied_wraps` temp table. Same logic, same ordering, same fallback payload;
   the temp table became a `uuid[]` local and the post-conditions moved *inside* the block so a bad
   result rolls the whole repair back. **Why:** it makes atomicity independent of how the runner
   batches statements, which the file's form does not guarantee through an MCP.

⚠️ **The repo files are still the reviewed, human-readable artifacts and are what a `psql` apply
should use.** The applied forms are equivalent, not identical — if you ever diff prod against the
files, expect the function body to match exactly and the repair to have left no trace beyond its data.

✅ **The `20260810000001` post-apply checks were run and passed.** Its 4-check `DO $$` block passed at
apply time, and the helper was then verified *functionally* — not just structurally — inside a
rolled-back transaction against prod, reading `match_players` back through real `authenticated` and
`anon` roles with real JWT claims:

| actor | pending+unpublished | pending+published | completed | in_progress | orphan `match_id` |
|---|---|---|---|---|---|
| plain member | **false** ← the only change | true | true | true | NULL → deny |
| organizer | true | true | true | true | NULL → deny |
| anon | false | false | false | false | NULL → deny |

End-to-end `SELECT`: member 6 of 8 roster rows, organizer 8, anon 0. Rolled back clean.

**The `use-player-match.ts` `queue_entries` subscription is now load-bearing — do not remove it.**
Once the firewall hides a draft's `match_players` rows from the very player it reserves, the
`queue_entries` flip to `'drafted'` is the *only* event that still reaches them.

> 🔒 ~~**ORDER LOCK: deploy the code BEFORE applying `20260810000001`.**~~ **Satisfied 2026-08-10** —
> the code deploy (merge `23ced21`) reached Vercel READY before the migration ran. Kept here because
> the same lock applies to any future revert: you must revert the *migration* first, never the code
> first, or a drafted player loses every signal.

> ⚠️ Prod migration stamps drift from repo filenames. **Never compare by version number — compare
> by name suffix, and ultimately by querying the catalog.**

---


---

## 📋 OPEN ITEMS

Triaged out of the retired 45 KB "STANDING TO-DO" on 2026-08-19, worked down on
2026-08-20. The reasoning behind each — including every superseded framing — is in
`docs/archive/MEMORY_HISTORY.md`, Part 2. **Do not re-import that reasoning here.** If an item
closes, delete it from this list; if it closes by DECISION rather than by a fix, archive the
decision with its reason first, or the next session re-opens it as a gap.

**1. Drop the two pre-rebuild backup tables — on or after 2026-09-12.**
```sql
drop table if exists public.player_rivalries_prerebuild_20260812;
drop table if exists public.player_partnerships_prerebuild_20260812;
```
They are the only evidence trail for the three disclosed badge revocations of 2026-08-12, which is
why they were kept. ⚠️ Both are **untracked DB objects** — no migration file exists for them or for
the RLS-enable applied to them — so they will not appear in any `supabase db diff`. The expiry date
above is the only thing that closes that drift. ⚖️ An early drop was **raised and DECLINED on
2026-08-20** — the user chose to keep the full retention window. Reason: the drop is irreversible,
the tables cost nothing to keep (idle, no `anon`/`authenticated` grants, RLS enabled as fail-closed
insurance), and three more weeks of an evidence trail is cheaper than not having one if a revoked
badge is ever disputed. **Do not re-raise this before 2026-09-12.**

**2. Stamp `20260702000008_club_member_guard_hierarchy_recheck` into prod's ledger — NEEDS A DECISION.**
The migration **is applied** (both `club_member_deactivate` and `club_member_set_role` carry
`p_expected_role` and the `role_changed` branch on prod; the app half is deployed and calls them
that way), but **no row in `supabase_migrations.schema_migrations` records it** — it was
hand-applied outside the ledger. So `list_migrations` under-reports, and a future session reading
it will believe the guard is missing. Inserting the stamp is a **production write**, hence a human
call. Re-applying the file instead is also safe (`DROP … IF EXISTS` + `CREATE` throughout) but
churns two SECURITY DEFINER functions for a bookkeeping fix. Evidence and the verification query:
`docs/reference/MIGRATION_RECONCILIATION.md` § "The one real gap".
The *shape* is no longer at risk either way: Suite G's "the club-member guards still carry the
hierarchy recheck" pins both `regprocedure` signatures and asserts `role_changed` +
`pg_advisory_xact_lock` in both bodies — deleting the migration file leaves the function NAMES in
place (`20260702000000` creates them), so the older `functionExists` checks would have stayed
green. Only the ledger row is still open.

## 📚 Where everything else lives

| Looking for | Read |
|---|---|
| How a feature works today | `DOC_INDEX.md` → the named `APP_MANIFEST.md` section |
| Schema, enums, row types | `src/types/database.ts` (source of truth) |
| Stack, patterns, engine, gotchas, file map | `docs/reference/ARCHITECTURE_QUICKREF.md` |
| Why a past decision was made | `docs/archive/MEMORY_HISTORY.md` (grep it) |
| A dated incident | `docs/incidents/` |
| Retired plans for shipped features | `docs/archive/` |
| Onboarding a new session | `HANDOFF.md`, then `CLAUDE.md` |
