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

## 🚧 IN FLIGHT — process overhaul, 2026-08-19

Branch `test/verification-gaps`. **Not on any remote.** `git branch -r --contains` is empty for
every commit below, and `git ls-remote --heads origin` does not list the branch — the same
shape as the container-local loss of 2026-07. Push or PR before doing anything else.

- `c9c1295` — verification-gap tests (1,834 insertions) **and**
  `supabase/migrations/20260818120000_lock_queue_status_events_grants.sql`. That migration is
  **already applied to prod** (stamp `20260819011750`), so prod holds an object whose only
  source record is this un-pushed commit.
- `a2ecd02` — P0: `closeSession` no longer strands an open session when the Wrapped pre-compute
  hangs. `runCloseRpc` wraps both RPCs in `withTimeout(3_000)`; `is_active` flips regardless.
  Pinned by `tests/unit/close-session-timeout.test.ts` (CST-1…4).
- `75ba680` + `5dcbcac` — the governance changes tabulated below.
- `baf2f79` + `3423036` — the review gate's two findings, fixed in one round.
  (a) `refresh_cross_session_stats` and `compute_session_wrapped` take **different** advisory
  locks, so the `await` was the only thing ordering them: a timed-out ledger refresh let compute
  snapshot cross-session awards that omit the session being closed, and the close still reported
  `wrappedReady`. Rows are still written — a missing `session_wrapped_stats` row replays the intro
  forever and `fixPlayerRecord` is the only other compute call site — but the close no longer
  claims they are ready, so the watcher routes to the club lobby. CST-5 (verified failing with the
  guard disabled). (b) Suite MTC's `createdObjects` anchored its schema qualifier to `public`, so
  any other schema bound the name capture to the **schema**: `create table private.audit_log`
  yielded `private`, which matches the corpus trivially. MTC-4.

**Why the overhaul:** feature and bug-fix work had slowed to the point where review round 3+ was
still finding "mistakes". The cause was not the code. Two uncapped rules — the review gate
(unbounded rounds, no scope filter) and the autopilot memory mandate (unbounded document growth)
— turned every task into a prose-review loop with no adjudicator. Code review converges because
a compiler and a test suite settle disputes; prose review does not, and each correction enlarges
the diff the next round reviews. Changes made:

| Change | Where |
|---|---|
| Review gate: **every finding is fixed at every severity**, re-review capped at 2 rounds, scoped to `*.ts,*.tsx,*.sql` | `CLAUDE.md`, `.claude/settings.json` |
| Leftovers after round 2 are handed over **with a reason** from a closed list of five, never as a bare list | `CLAUDE.md`, `HANDOFF.md` |
| `npm run test:unit` added to mandatory validation + a clean-worktree check | `CLAUDE.md`, `.husky/pre-push` |
| Writing rules: no counts in prose, no line numbers, markdown formatting is not a defect | `CLAUDE.md` |
| Read-first mandate replaced by a bounded `DOC_INDEX.md` (~25k token budget) | `CLAUDE.md`, `HANDOFF.md` |
| CI `paths-ignore` for docs + `concurrency` cancel-in-progress | `.github/workflows/*.yml` |
| MEMORY.md capped at 40 KB, APP_MANIFEST warned at 300 KB | `.husky/pre-commit` |
| 23 stale root plans archived; history and reference split out of MEMORY.md | `docs/archive/`, `docs/reference/` |

---

## 🧪 VERIFICATION GAPS CLOSED — 2026-08-18. Branch `test/verification-gaps` (not yet merged).

**Why:** the cross-court publish path shipped dead for four days (§3.41) and three migrations in four days created objects **no test referenced even once**. Both are the same defect: nothing enforced that a shipped object was ever exercised.

**The defect this uncovered — `queue_status_events` (20260815) granted nobody anything.** RLS was enabled with no policy and the comment claimed "only the service role (which bypasses RLS) can read it". ACLs and RLS are independent gates and the ACL is checked first, so what shipped was whatever `ALTER DEFAULT PRIVILEGES` was in force — and **prod and local disagree**: `FOR ROLE postgres IN SCHEMA public` is `arwdDxtm` on prod, `Dxtm` locally. One grant-less `CREATE TABLE`, two opposite defects:

- **local / CI**: no SELECT for anyone → trail written correctly (trigger is SECURITY DEFINER) and unreadable by everything. `permission denied` before RLS is consulted.
- **prod**: `anon` + `authenticated` got SELECT/INSERT/UPDATE/DELETE/TRUNCATE on an audit table. RLS-with-no-policy is the only thing stopping it — real, but one `CREATE POLICY` from not being.

**`20260818120000_lock_queue_status_events_grants.sql`** — `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`, then `GRANT SELECT, DELETE TO service_role`. INSERT/UPDATE/TRUNCATE withheld so no API caller (or leaked service key) can forge a transition or drop the trail. ⚠️ **APPLIED LOCAL ONLY — NOT ON PROD.** Migrations are applied by hand here; merging ships no schema. Verify by stamp, never by build.

🪤 **The first draft of that fix had the bug it was fixing, and QSA-10 was green through it.** It copied the sibling's `FROM PUBLIC, anon, authenticated` and omitted `service_role`. A REVOKE only touches roles it names, and `GRANT SELECT, DELETE` is a no-op against a role already holding `arwdDxtm` — so on **prod** the "withheld" INSERT/UPDATE would still have been held. The sibling is fine with three roles only because it ends `GRANT ALL TO service_role`: it wants the default. **Name the role whenever the intent is narrower than the default.** QSA-10's `ins:false, upd:false` couldn't see it because the *local* default (`Dxtm`) already withholds them — the test was agreeing with the environment, not the migration. `TRUNCATE` is the discriminator: the default grants it in both environments, so only an explicit REVOKE removes it (measured: `service_role=rdDxtm` → `rd`). **An assertion that a privilege is ABSENT proves nothing unless the environment would otherwise grant it** — pick the privilege the default hands out. Mutant M19.

**Five gates added:** whole-schema `service_role` SELECT sweep in `schema-parity` (one new case; the file is 32 total. No `relacl IS NOT NULL` filter — a NULL ACL is the owner-only default, the case most worth catching); **Suite MTC** `tests/unit/migration-test-coverage.test.ts` (every migrated table/view/function must be *named* by a non-comment test line; ratcheting exemption lists); **Suite QSA** 11 cases + 8 measured mutants; **XC-4** (a held draft rests, ripens and actually publishes — §3.41's lifecycle half); **CI now runs `tsc --noEmit` + `npm run lint`**, which CLAUDE.md mandated and nothing executed.

**E2E prod-leak fixed before it leaked:** `queue_status_events` has no FK to `queue_entries`, exactly like `match_events` (which leaked 171 rows into a prod table in 2026). Both `teardown.ts` paths now delete it and `validate-cleanup.mts` counts it. Prod held 29 rows, all from the 08/16 manual close — zero from E2E.

**Banked:** a review agent's claims need checking too — it reported the prod ACL as the *local* one and I only found the two-environment split by querying prod directly. My own first drafts of the M12 and M18 blast radii were both **narrower than measured** (M18: predicted 4 cases, actually kills 8). Predicting a mutant's reach is the same error as trusting a migration's comment about who can read a table.

**Also banked:** Suite MTC's corpus first counted **every** `.ts` under `tests/`, so a table was "covered" by its own line in `helpers/truncate.ts` — the routine first step for any new table would have satisfied the gate meant to catch it. Narrowing to `*.test.ts(x)` / `*.spec.ts` immediately exposed three tables named nowhere else: `club_invites`, `co_organizer_join_attempts`, `match_games` (now grandfathered). **A coverage gate whose corpus includes bookkeeping files measures bookkeeping.**

**Review gate — five rounds:** Needs fixes ×4 → **round 5 "Minor issues"**, every item fixed rather than logged. Round 2 found my own migration reproducing the bug it fixed (`REVOKE` omitted `service_role`); round 4 found the MEMORY migration-queue banner still claiming repo↔prod agreement and the CI note naming the job *key* instead of the required-check *context*. Round 5's three were all the same class this branch polices — **prose that is checkable and wrong**: a quote in §3.44 A attributed to §7's "Forward hazard" note when it belongs to the "Landing order matters" paragraph after it; `emergency-cleanup.ts` claiming its own short-circuit "is how `match_events` reached 171 rows" when that leak was the *automatic* teardown's (this script never touched them); and `teardown.ts` step 6b justifying its position with "doing it last also sweeps whatever `repairSandboxState` generated" when `resetSandboxSession` never calls `repairSandboxState` and three steps follow 6b. All three effects were right and all three *reasons* were wrong — the exact failure mode of [[comments-that-explain-why-rot]], committed while documenting it.

**Next:** merge. ✅ `20260818120000` is **already on prod** (stamp `20260819011750`, applied 2026-08-19) — the REVOKE was the half that mattered there, and prod's `relacl` went `{postgres=arwdDxtm, anon=arwdDxtm, authenticated=arwdDxtm, service_role=arwdDxtm}` → `{postgres=arwdDxtm, service_role=rd}`, i.e. anon genuinely held full DML on the audit trail until that apply. Prod was never the unreadable half; local was. `truncateTracked()` hard-couples **24 of 27** integration files to it — `auth.real`, `draft-cap-override` and `schema-parity` don't call it, so those three stay green on a stale DB and are not evidence it landed. Also: the CI job's **display name** changed `Vitest` → `Types, Lint, Vitest` (the YAML key went `vitest` → `checks`, but a required-status-check context is the job's `name:`, not its key). Any branch-protection rule pinned to `Vitest` is now pinned to a context that never reports. 🚨 **But there is no such rule and there cannot be one:** the repo is private on a free plan, so branch protection and rulesets are unavailable — both `gh api` endpoints answered `403 "Upgrade to GitHub Pro or make this repository public"` on 2026-08-19. **Nothing on GitHub gates a merge here today, and nothing can until the repo goes public or the plan changes.** The renamed context matters when that changes, not before. So the gate moved to where it can exist: **`.husky/pre-push`** (new) runs `tsc --noEmit` + `lint` + unit, in CI's order, ~17s, and refuses the push. Integration is excluded (needs local Supabase) and E2E is excluded (**it targets prod**). 🪤 A local hook is not a merge gate — `--no-verify` skips it and it binds one machine.

---

## 🚨 08/15 SATURDAY CLOSE HUNG ON WRAPPED — 2026-08-17.

**Prod recovery (done):** session `3367d4c6-6838-4cf7-8abe-5f5c3143dd1e` ("08/15 Saturday Session") closed at `2026-08-16 18:24:09 UTC`. `refresh_cross_session_stats` + `compute_session_wrapped` ran as postgres (both returned immediately), then `is_active=false`, 29 leftover `waiting` → `left` (37 left total), 4 courts `closed`, 54 completed / 5 cancelled unchanged. **37 Wrapped rows** (min 3 / max 7 games). `session_closed` broadcast 202.

**Cause:** `closeSession` awaited the two Wrapped RPCs *before* flipping `is_active`. PostgREST never returned (Warp timeout-manager kills ~60 s apart, 01:29–01:33 PHT 08/17). Edge logs show **zero** completed `/rpc/compute_session_wrapped` or `/rpc/refresh_cross_session_stats` in 24 h. Same RPCs via MCP postgres: sub-second. Organizer toast: "Failed to close session. Please try again." Stelle identity migration at 17:28:34 UTC was coincidental, not the blocker.

**Code fix (this branch):** `runCloseRpc` races each RPC against `CLOSE_WRAPPED_RPC_MS = 3_000`. Timeout / throw / error → log, continue, flip anyway, `wrappedReady=false`. No retry on timeout or `57014`/`55P03`. Abandoned fetch gets `void pending.catch(() => {})` so a later Warp-kill is not an unhandledRejection. Pinned CST-1…4 in `tests/unit/close-session-timeout.test.ts`.

**Review (Minor issues, addressed):** unhandled late reject; CST-1 now asserts no compute retry + 3s bound.

**Next:** merge + deploy TypeScript only (no migration). Until then the UI close path can still hang on a PostgREST stall.

---

## ⚖️ LOPSIDED TEAM SPLITS BANNED — 2026-08-17. Shipped `24fcc7a` (#73).

The 07/30 balance gate stopped *preferring* INT+INT vs BEG+BEG; it still emitted that split as a stall-break. Ban: `snakeDraft` never returns a lopsided split (`gap > minGap + SKILL_VARIANCE_MAX`). When every mixed pairing is at the partnership cap, it seats mixed anyway (`usedCapOverride`) after Fix B tries another body. `rotatedDraft` drops lopsided from the cycle but still returns `null` so Tier-3 can expand the window. Preview / Tier-1/2 treat `usedCapOverride` like `null`. Last-resort accepts it.

**Accepted hole:** mixed seating may exceed `MAX_PARTNERSHIP_REPEATS` when no other body exists. Organizer-created lopsided matches unchanged. Gap ≤ minGap+2 (H-2 4/3/3/2) is still allowed.

**Review (Minor issues):** `simRunAlgorithm` still treats `usedCapOverride` as a stall on every path (incl. last-resort) so the 30-player "never exceed cap" invariant holds. Production last-resort is covered by MC-new-2. Preview / CCO-11 comments and assertion tightened.
---

## ✅ MIGRATION QUEUE — EMPTY as of 2026-08-19. Repo and prod agree.

**Migrations in this project are applied BY HAND. There is no deploy automation for the database.
Merging a PR ships TypeScript only.** **Every new migration must be
added to this table with its prod stamp** — the stamps drift from the filenames, and this table is
the only place that records the mapping.

| Applied | Stamp |
|---|---|
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

Triaged out of the retired 45 KB "STANDING TO-DO" on 2026-08-19. The reasoning behind each —
including every superseded framing — is in `docs/archive/MEMORY_HISTORY.md`, Part 2. **Do not
re-import that reasoning here.** If an item closes, delete it from this list.

**1. Live-session watch: do held cross-court drafts complete their lifecycle?**
Cross-court generation works — the 08/15 session created 12 held drafts — but only **2** reached a
court, and the publish path that blocked the other 10 was fixed after the fact (PR #68 →
`main` `61e942b`, migration stamp `20260816024129`). Nothing has re-measured it since. Watch, in
one live session with auto-matchmaking ON:
  - (a) created → published → on court, against the **12 → 2** baseline;
  - (b) whether any hold outlives `CROSS_COURT_MAX_HOLD_MINUTES = 15`. The cancel is event-driven
    off match end/cancel, **not a timer**, so a court that goes quiet strands its hold.
  - (c) fold in the first real `closeSession()` exercise of
    `refresh_cross_session_stats` (migration `20260812100000`, stamp `20260812144342`). Every
    production invocation so far has been manual; no session has closed since it was applied.

**2. Drop the two pre-rebuild backup tables — on or after 2026-09-12.**
```sql
drop table if exists public.player_rivalries_prerebuild_20260812;
drop table if exists public.player_partnerships_prerebuild_20260812;
```
They are the only evidence trail for the three disclosed badge revocations of 2026-08-12, which is
why they were kept. ⚠️ Both are **untracked DB objects** — no migration file exists for them or for
the RLS-enable applied to them — so they will not appear in any `supabase db diff`. The expiry date
above is the only thing that closes that drift.

**3. The cross-session stats ledger has no as-of date.**
Replaying an old session counts later results as pre-tonight history. Separate defect from the
under-count that was fixed on 2026-08-12; the rebuild does not touch it.

**4. Optional hardening: project-wide Realtime "Allow public access" OFF.**
Requires every `postgres_changes` channel to be private first — a scoped project of its own, not a
toggle. This is the single remaining open item from the 2026-07-21 tenancy audit.

**6. `closeSession`'s 3s ceiling is per-RPC, not per-phase.**
`withTimeout(…, 3_000)` wraps each call, so the worst case before `is_active` flips is refresh 3s +
compute 3s + 600 ms backoff + retry 3s ≈ 9.6s. No route in the repo sets `maxDuration`, so the
platform default is the real ceiling and nothing pins it. Fix if it ever bites: one phase deadline
shared by all three calls (compute `deadline = start + 3_000` once, pass the remainder). Raised by
the review gate on 2026-08-19 and accepted as-is — the 08/15 incident was an *unbounded* wait, and
9.6s is bounded. 🪤 `CloseRpcOutcome`'s `"failed" → retry → ok` transition is still unasserted:
CST-1…CST-5 cover hang, throw, success, 57014-no-retry, and the ledger guard, but never a first
failure that the retry rescues.

**5. Cleanup: stale remote branches whose PRs are all merged.** Keep `main`,
`backup/main-pre-cleanup-20260713` (a deliberate safety branch — **do not delete it**) and whatever
is currently in flight. Re-derive the list rather than trusting a number here:

```
git ls-remote --heads origin | sed 's#.*refs/heads/##' > /tmp/heads.txt
gh pr list --state all --limit 100 --json number,state,headRefName > /tmp/prs.json
```
then keep only heads whose `headRefName` has a `MERGED` PR and no `OPEN` one. Re-run on
2026-08-19 after a `git fetch --prune`: every non-kept head had a merged PR and none were
ambiguous. 🪤 `git branch -r --merged origin/main` misses most of them — `--merged` asks whether a
tip is an ancestor of `main`, which is never true for a **squash**-merged branch. Classify with
`gh pr list --state all`, never with `--merged` alone.

---

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
