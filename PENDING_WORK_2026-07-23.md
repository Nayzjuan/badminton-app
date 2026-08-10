# PENDING WORK — resume after the 2026-07-23 live session

Handoff file. Everything below was paused deliberately so that nothing changed on production
before the afternoon session. **Production was verified healthy and untouched at the time of
writing** — see [Appendix A](#appendix-a--verified-prod-state-2026-07-23) for the object-by-object
snapshot, so the next session does not have to re-derive it.

- **Prod project:** `usxftpexoimletqmrggb`
- **Live deployment (as of 2026-07-23):** `dpl_EhWSHP3T…`, `READY`, commit `5e5fa88` (PR #39 merge).
  ~~Only open PR: #40~~ — merged as `fdeb5e3`. **Everything in §0–§3 has since shipped and been
  applied; see the status line on each section. `main` is well past `5e5fa88` (latest verified deploy
  `dpl_Bnqy3QVqKnEE8XCJZNHv3iftcgTi`, PR #51 `e8e76bd`).** The only item still genuinely open in this
  file is §2.3.
- **Full audit context:** [TENANCY_AUDIT_2026-07-21.md](TENANCY_AUDIT_2026-07-21.md)

> ⚠️ **Migrations in this project are applied by hand.** There is no deploy automation for the
> database. Merging a PR ships TypeScript only. Prod's migration stamps also drift from the repo
> filenames (prod stamps `20260722165729 lock_leaderboard_reads_to_service_role` where the repo
> file is `20260722010001_…`), so **never compare by version number — compare by name suffix, and
> ultimately by querying the catalog.**

---

## 0. ✅ Resume here — the exact next sequence (ALL SEVEN STEPS DONE)

**Closed 2026-07-24.** Kept for the ordering rationale, not as a to-do list. Prod stamps:
`20260723000000` → `20260724050312`, `20260723000001` → `20260724050436`,
`20260723100000` → `20260724050234` (compare by name suffix, not version). PRs
[#40](https://github.com/nayzjuan/badminton-app/pull/40) (`fdeb5e3`) and
[#41](https://github.com/nayzjuan/badminton-app/pull/41) (`4bc5cfc`) merged.

Do these **seven** steps in this order, nothing interleaved (the table below has seven rows; an earlier draft
of this line said "four" and was never updated as the runbook grew — all seven are now done, see the ✅ heading):

| # | Step | Where |
|---|------|-------|
| 1 | Apply `20260723000000_revoke_anon_execute_on_mutating_rpcs.sql` | Supabase SQL editor / `apply_migration` |
| 2 | Apply `20260723000001_bind_live_swaps_to_session.sql` | Supabase SQL editor / `apply_migration` |
| 3 | Merge PR #40 → Vercel auto-deploys `main` | GitHub |
| 4 | Run the post-apply verification queries in §1.4 | Supabase SQL editor |

Then **PR4a** (§2.1), which is already built, reviewed and waiting:

| # | Step | Where |
|---|------|-------|
| 5 | Apply `20260723100000_scope_session_events_broadcast_to_members.sql` | Supabase SQL editor / `apply_migration` |
| 6 | Merge PR4a → Vercel auto-deploys | GitHub |
| 7 | Smoke-test the broadcast path per §2.1 (co-organizer toggle, then session close → Wrapped) | Two browsers, one session |

Steps 5 and 6 are order-locked and must not straddle a live session — see §2.1.

> ~~§2.2 (PR4b, finding #8) is the only audit item still unbuilt.~~ **Every audit item in §0–§2.2 is
> now shipped AND applied to prod. §2.3 (`session_closed` has no fallback path) is the only open
> follow-up left in this file.** Reconciled object-by-object against prod 2026-08-04.

---

## 1. 🔴 PR #40 — the unauthenticated-write hole (audit finding #10)

### 1.1 What is still open on prod right now

**16 mutating `SECURITY DEFINER` RPCs hold `anon` EXECUTE.** PostgREST exposes every function in
`public` to whichever role holds EXECUTE, and `SECURITY DEFINER` means RLS never applies — so these
are reachable over HTTP with nothing but the public anon key from the JS bundle and **no login at
all**. Confirmed still live today (query in Appendix A). Reachable capabilities: match forgery,
live-roster rewrites, wiping unpublished drafts, audit-event forgery, stats poisoning.

Verified-live list (this is exactly the set `20260723000000` revokes):

```
clear_all_unpublished_drafts        record_match_event              swap_match_players
clear_on_deck_match_atomic          refresh_alltime_leaderboard     swap_player_in_active_match
compute_session_wrapped             refresh_cross_session_stats     swap_player_in_match
create_held_cross_court_match       revert_match_to_active          swap_teams_in_active_match
create_match_with_players           swap_active_from_ondeck         undo_swap_active_from_ondeck
fix_record_swap_player
```

Stacked on top: the four live-swap RPCs authorize on `sessionId` but mutate a separately
client-supplied `matchId` — authorize-on-A / operate-on-B. `20260723000001` binds them.

> 🎁 Bonus: `refresh_alltime_leaderboard()` is in that list, which means **#40 also closes PR #38's
> knowingly-deferred PUBLIC-EXECUTE residual.** No separate ticket needed.

### 1.2 The apply order, and why it is the only valid one

**`20260723000000` → `20260723000001` → merge/deploy.**

- **`…0001` before the deploy:** the new client sends `p_session_id`. The pre-migration 7-arg
  function answers `PGRST202`, which breaks **every team flip** and every `team_swap` undo.
- **`…0000` before `…0001`:** `…0000` acts on `swap_teams_in_active_match`, which `…0001` DROPs and
  re-CREATEs with an extra parameter. Naming a stale argument list is `42883`, and because `…0000`
  is a single transaction that error rolls back **all 16 revokes** and leaves the hole open behind
  an error that looks unrelated. (Mitigated: the function is addressed by OID via a `DO` loop with a
  zero-iteration guard. Go in order anyway.)
- **Do not read step 1 as "order-free."** It is order-free *in isolation* — no browser code calls
  the 16 — but that is transitively false: 2 must precede 3, and 1 must precede 2, therefore 1 must
  precede 3.
- Out-of-order is **loud, not silent**: `…0001`'s assertion 5a sweeps every volatile SECDEF
  non-trigger function in `public` for anon/authenticated EXECUTE and raises. Running it first means
  "migration 2 rolls back," not "silent damage." Recovery is: apply `…0000`, re-run `…0001`.

### 1.3 Safety properties worth knowing before you start

- **Both migrations are re-runnable.** `…0001`'s DROP names *both* shapes (the 7-arg pre-migration
  one and the 8-arg one it creates), so a second run replaces rather than failing `42723`. Verified
  by applying it three times in a row against a from-scratch DB: `EXIT=0` each time, one function,
  8-arg signature, `anon=f auth=f svc=t`.
- **The window between step 2 and step 3 is safe.** `p_session_id` is declared with a DEFAULT, and
  PostgREST accepts an argument-name *subset* so long as every parameter without a default is
  covered — so the still-deployed old code's 7-arg call resolves fine against the new 8-arg
  function. This is the whole reason the parameter is optional. (See §3.)
- **Two things must NOT be revoked**, and both are asserted inside the migrations:
  - `lookup_active_session(uuid)` keeps **anon** EXECUTE — it is the public join path.
  - The six RLS helpers (`is_club_member`, `session_access_level`, `has_match_access`,
    `is_session_organizer`, `is_match_club_member`, `is_session_club_member`) keep EXECUTE for
    **both** `anon` and `authenticated` — RLS policies invoke them as the *calling* role, so
    revoking either takes the whole app down. The schema-parity catalog sweep cannot catch this
    because it filters `provolatile = 'v'` and these are STABLE.
- **The revoke trap:** every `revoke execute … from public` must be paired with an explicit
  `grant execute … to service_role`, **grant first** — on a proacl-NULL function the revoke
  materialises `acldefault('f', owner)` and strips `service_role` too. Both migrations do this and
  assert it.

### 1.4 Post-apply verification (paste into the SQL editor)

```sql
-- 1) MUST return zero rows. Any row = a browser role can still execute a mutator.
select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as leaked
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef and p.provolatile = 'v'
  and p.prorettype <> 'trigger'::regtype
  and (has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('authenticated', p.oid, 'execute'));

-- 2) MUST be true — the public join path.
select has_function_privilege('anon', 'public.lookup_active_session(uuid)'::regprocedure, 'execute');

-- 3) MUST all be true, for BOTH roles — the RLS helpers.
select p.oid::regprocedure::text as helper,
       has_function_privilege('anon', p.oid, 'execute')          as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as auth
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('is_club_member','session_access_level','has_match_access',
                    'is_session_organizer','is_match_club_member','is_session_club_member');

-- 4) MUST show the 8-arg shape, anon=f auth=f svc=t.
select pg_get_function_identity_arguments(p.oid) as args,
       has_function_privilege('anon', p.oid, 'execute')          as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as auth,
       has_function_privilege('service_role', p.oid, 'execute')  as svc
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'swap_teams_in_active_match';
```

Then smoke-test in the browser as an organizer: **flip a team**, then **undo it**. That is the one
path both migrations touch.

### 1.5 What is in the PR

Code + tests + docs, all validated: `tsc --noEmit` 0 · eslint 0 · unit **876 passed / 1 skipped**
across 49 files · integration **236 passed** across 21 files on a from-scratch `supabase db reset`
replay · anon `curl` returns `42501` on the revoked functions and `200` on `lookup_active_session` ·
4 SQL + 12 TS mutants all killed. CI: 9/9 green.

---

## 2. 🟡 PR4 — realtime tenancy hardening (audit findings #7 + #8)

Split into **PR4a (#7, DONE, held unmerged)** and **PR4b (#8, not started)**.

### 2.1 ✅ PR4a — private `session-events` broadcast (finding #7)

**Status: code complete, reviewed three times (verdict *Minor issues* each pass), held unmerged.**
Branch `fix/tenancy-realtime-private-broadcast`. Every finding was either **fixed** or **declined with
the reasoning recorded inline** — the one declined is `onStatus` (§2.3 below), which was a deliberate
call, not an oversight.

| File | Change |
|---|---|
| `supabase/migrations/20260723100000_scope_session_events_broadcast_to_members.sql` | new — SELECT-only policy on `realtime.messages` + non-throwing topic parser |
| `src/lib/broadcast.ts` | every emitted message carries `private: true` |
| `src/lib/realtime.ts` | join with `{ config: { private: true } }`, deferred behind `whenRealtimeAuthReady()`, optional `onStatus` |
| `src/hooks/use-organizer-broadcast.ts` | comment only — why `onStatus` is not wired |
| `tests/unit/realtime-private-broadcast.test.ts` | new — 6 tests pinning both halves + the JWT ordering |
| `APP_MANIFEST.md`, `MEMORY.md` | documented, incl. reversing the old "no JWT needed" claim in the Realtime JWT-before-join bullet (`APP_MANIFEST.md:76`) |

The audit understated #7: the public topic was also **writable**, so any browser could forge
`session_closed` (redirects every player to Wrapped) or `draft_cap_phase: 'clearing'` (freezes every
organizer behind the lockout overlay). Omitting an INSERT policy closes it — the server emits with
the service-role key, which bypasses RLS.

**Verified on a virgin DB after a full `supabase db reset`:** member/private → `SUBSCRIBED` and
receives; outsider/private → `CHANNEL_ERROR("Unauthorized: You do not have permissions to read from
this Channel topic: …")`; anon/public → `SUBSCRIBED` but receives only the public copy, never the
private one.

**⚠️ Two prerequisites before merge — both are ways this dies silently:**

1. **Apply `20260723100000` BEFORE the deploy.** `realtime.messages` is RLS-enabled with **zero**
   policies ⇒ deny-all. Applying early is harmless (the topic is still public and the policy is
   never consulted); applying late means every client gets `CHANNEL_ERROR` instead of session
   events. Old tabs holding a public channel stop receiving until reload — **deploy between
   sessions.**
2. ~~**Smoke-test the `realtime:` topic prefix under `private: true`.**~~ **RESOLVED 2026-08-04 —
   the prefix was a genuine bug.** This item asserted prod "normalises the prefix, since it delivers
   these events today" and warned against fixing it from a local repro. Both halves were wrong: the
   local CLI image behaved exactly like prod, and the events only *looked* delivered because
   `use-organizer-session.ts` polls every 15s, masking the two toggle events. The other three
   (`session_closed`, `cap_saturation`, `organizer_intervention`) had no fallback
   and were dead. `broadcast.ts` now posts the unprefixed `session-events:{id}`. See APP_MANIFEST
   §3.27. The follow-on `draft_cap_phase` defect (emit ran in the browser, no service-role key,
   bailed at the guard — co-organizer lockout overlay dead) is **also CLOSED**: moved to the
   `applyDraftCapOverride` server action, shipped in PR #51 (`e8e76bd`) and **verified against
   production** by [R-5] on 2026-08-04. See APP_MANIFEST §3.28.

`create policy` on prod's `realtime.messages` fails loudly with `42501` if `postgres` lacks
ownership there — it will not fail silently.

### 2.2 ✅ PR4b — tighten `profiles_select` (finding #8)

**Status: SHIPPED, APPLIED, VERIFIED. Closed 2026-07-24; reconciled line-by-line against prod
2026-08-04** (the "not started" this section used to claim was wrong by ten days).
Migration `20260723200000_scope_profiles_select_to_shared_scope.sql`, merged as `ba49fa2`
(PR [#43](https://github.com/nayzjuan/badminton-app/pull/43)), applied to prod under stamp
`20260724050127` — name suffix matches, version numbers drift, compare by name.

**Live on prod, read-only verified:**

```
profiles_select | {authenticated} | SELECT
  | ((id = ( SELECT auth.uid() AS uid)) OR can_read_profile(id))
```

`public.can_read_profile(uuid)` is `STABLE SECURITY DEFINER` with `search_path` pinned to
`public, pg_temp`, five arms in the documented order (shared active club · queued in a reachable
session · played a match in one · organizes one · created one). ACL is
`postgres | service_role | authenticated` — **no anon, no PUBLIC**, exactly what the migration's `DO`
block asserts. The stored body is byte-identical to the repo file once comments are normalized away.

> **Known cosmetic drift — do NOT re-apply.** Prod's stored copy carries the short one-line arm-2
> comment; the repo file carries the longer "LOAD-BEARING … Change both or neither" block added in a
> later review round. Prod was applied from a pre-final draft. Comments are not semantics; a
> `pg_get_functiondef` vs. repo-text diff will show this forever and it is not drift worth chasing.

**Side-items, individually reconciled:**

- **Stale baseline comment — DONE.** `20260722000002_declare_rls_baseline.sql` now carries a
  `NOTE (corrected 2026-07-23)` block at `:176-186` (the old citation `:175-184` had shifted),
  landed by `ba49fa2`, plus a full "THE COMMENT THIS REPLACES WAS WRONG" section in
  `20260723200000`. The same stale rationale survived in two more places and was corrected
  2026-08-04: `APP_MANIFEST.md` (historical-audit bullet) and repo `MEMORY.md` §"MULTI-TENANT
  SECURITY AUDIT" item 1. General rule this establishes: **never edit an applied migration's DDL.**
  Editing its *comment* is acceptable only for a declare-the-baseline migration, where the comment
  sits outside the `EXECUTE $ddl$…$ddl$` string so zero applied bytes change; the durable
  correction belongs in the superseding migration and in `APP_MANIFEST.md`.
- **Realtime `profiles` firehose — CLOSED, at the policy layer.** `subscribeToProfiles`
  (`src/lib/realtime.ts:352-381`) is still deliberately unfiltered, and that is correct.
  `postgres_changes` evaluates the SELECT policy per row at delivery under the role bound at join
  time (`realtime.ts` header + `whenRealtimeAuthReady`), so narrowing the policy narrowed the
  stream — `20260723200000` says exactly this under "DELIBERATELY NOT DONE HERE". A client `filter`
  is not expressible ("shared club" is not a single-column predicate) and an `id=in.(…)`
  approximation would churn channels on every queue mutation against the `REALTIME_CHANNEL_COUNT`
  budget. Mounted by `use-organizer-queue.ts` and `use-session-data.ts`. **Leave as-is** — the
  reasoning is now inline in the function's doc comment so this does not get "fixed" later.
- **`club_members` index — the original item was mis-worded; there is NOTHING to drop under that
  description.** The only *partial* index on `club_members` is `idx_club_members_invited_by`
  `(invited_by) WHERE invited_by IS NOT NULL`, which is the sole cover for FK
  `club_members_invited_by_fkey` (`20260717171328:67`) — dropping it re-opens an
  `unindexed_foreign_keys` advisor finding. **Keep it.** The genuinely redundant index is the
  *non-partial* `idx_club_members_club_id (club_id)`, a strict leading prefix of the UNIQUE
  constraint index `club_members_club_id_player_id_key (club_id, player_id)`; since the composite
  backs a constraint it can never be dropped out from under it. **Deliberately NOT executed:**
  16 KB across 196 rows, correctness-neutral, and because migrations here are hand-applied,
  committing the file would assert a repo state prod does not have until someone runs it. Not worth
  a drift window. (Precedent for the shape, if it is ever picked up:
  `20260717172335_drop_dead_and_redundant_indexes.sql:13-14` — *"Ledger tables: PK is (club_id,
  player_id, {rival,partner}_id), so club_id-only …"* — noting the analogy is imperfect, since
  `club_members`' PK is `(id)` and the cover is a UNIQUE constraint rather than the PK. Supabase's
  advisor does not flag it: `duplicate_index` needs byte-identical definitions, `unused_index` needs
  `idx_scan = 0` and this has 283.)

**RLS-bound read sites — re-verified 2026-08-04.** Three line numbers had drifted, two entries were
never RLS-bound at all, and two of the highest-traffic reads were missing:

| Site | Then | Now | Notes |
|---|---|---|---|
| `use-enriched-matches.ts` | :128 | **:141** | browser client (injected) |
| `use-session-completed-players.ts` | :95 | :95 | browser client |
| `use-player-match.ts` | :178 | **:214** | browser client |
| `use-match-history.ts` | :64 | :64 | browser client |
| `use-organizer-queue.ts` | :125 | **:146** | browser client |
| `matchmaking-db.ts:499` | listed | **remove — service role**, not RLS-bound | caller `matchmaking.ts` |
| `dup-name.ts:45` | listed | **remove — service role**, not RLS-bound | `import "server-only"` |
| — missing — | — | **`use-organizer-queue.ts:90`** | `v_queue_full_with_wait_time`, `security_invoker=true`, INNER JOIN on `profiles` |
| — missing — | — | **`use-session-data.ts:123`** | embedded `profile:profiles(PUBLIC_PROFILE_COLUMNS)` |
| — missing — | — | **`leaderboard.ts:182` (`buildVipMap`)** | server *user* client — RLS-bound |

⚠️ The old summary "all use `.eq("id", uid)` or `.in("id", ids)`" is **false for the two additions**.
`v_queue_full_with_wait_time` is `security_invoker` over a plain `queue_entries ⋈ profiles` INNER
JOIN, so the organizer board's entire queue **row set** — not just the display names — is gated by
`profiles_select`. If arm 2 or `session_access_level` is ever narrowed further, that board silently
**drops rows** rather than showing "Unknown"; `20260723200000:161` flags the same predicate as
LOAD-BEARING for exactly this reason. `buildVipMap` stays whole via arm 3 (every board id comes from
`v_alltime_leaderboard_mat`, built from completed matches) and degrades to a plain name, never a
blank. Everything else under `src/app/actions/` uses the service client and is unaffected.

**Tests.** `tests/integration/rls-edge-cases.test.ts` → `describe("profiles_select scope — finding
#8")`, 10 cases: one per arm (each paired with a `not.toContain(stranger.id)` control), plus
`is_active` respect, own-profile read, the platform-wide-enumeration control, and the anon
`/rest/v1/rpc/can_read_profile` revoke. Users are signed in **for real** — `mockAuthAs` only fools
server actions, not Postgres.

**Docs.** `APP_MANIFEST.md` §11.8.

### 2.3 Follow-up — `session_closed` has no fallback path

Not a regression, but PR4a adds a new way to hit it (an *authorization*-refused join), so it is
worth recording. The broadcast channel is the **only** mechanism that moves a player to Wrapped:
`useSessionData` fetches `courts` and `queue_entries`, never the session row, so a player whose
channel never joins simply sits on a dead dashboard. A fallback needs a new player-facing server
action that reports session status, polled slowly (or folded into `useVisibilityRefresh`).
Deliberately **not** bundled into a security PR. A user-visible toast is the wrong fix — transient
`CHANNEL_ERROR`/`TIMED_OUT` is normal on gym wifi and Realtime reconnects on its own.

### 2.4 Reversed from the original PR4 spec — do NOT strip display names

The old item 3 ("send ids only, let clients resolve names") is **dropped**. Once the channel is
private and gated on `session_access_level(...) IS NOT NULL`, the recipient set is exactly the set
already entitled to see those names in the roster. Stripping them buys no security and is pure
regression risk to the co-organizer intervention toast and the cap-saturation banner.

---

## 3. ✅ Follow-up bracket migration (do **after** #40 has deployed) — DONE

**Shipped as `20260724000000_reject_null_session_in_swap_teams.sql`, PR
[#45](https://github.com/nayzjuan/badminton-app/pull/45) (`52e30b1`), applied to prod under stamp
`20260724054744`.** Kept for the reasoning below.

Once PR #40 is merged **and** the deploy is live, add a migration that makes
`swap_teams_in_active_match.p_session_id` **NULL-rejecting**.

It cannot be done in `20260723000001` itself: the parameter has to stay optional across the
apply→deploy window so the still-running old 7-arg client keeps resolving (§1.3). Once every client
sends it, the DEFAULT is dead weight and should become a hard guard.

Use `IS DISTINCT FROM` / an explicit `IS NULL` raise — **not** `!=`. In plpgsql `NULL != 'x'` is
NULL, and a NULL `IF` condition is treated as false, so a naive guard falls *through*.

---

## 4. Known residuals — accepted, not bugs to chase

| Item | Status |
|---|---|
| Named session board readable by anon for an **already-known** session UUID (`getSessionLeaderboard`) | **Accepted** — this is the share-link contract |
| `get_monthly_leaderboard` holds anon EXECUTE | **Not an issue** — it is invoker-rights, so it correctly returns `[]` to anon. An earlier agent claim that this was a hole was a false positive |
| `refresh_alltime_leaderboard()` PUBLIC EXECUTE | **Closed by PR #40** (§1.1) — no longer a residual |
| `isSessionOrganizer(userId, sessionId)` is a boolean oracle | Pre-existing, structural: every export of a `"use server"` module is a public HTTP endpoint. Not widened by any recent PR. Fixing it means moving the helper out of the action module |
| Audit finding **#9** — `match_players` DELETE metadata leak | ⚪ **LOW, optional, defer or accept.** WALRUS skips RLS on DELETE, but the table is REPLICA IDENTITY DEFAULT with PK `id` only, so the payload is an opaque UUID — no player, match, or team. Optional fix: drive roster refresh off the already-subscribed `matches` stream and drop `match_players` from the publication |
| Audit finding **#11** — draft firewall covers `matches` but not `match_players` | 🟡 **NEW 2026-08-04, not accepted — filed for triage.** Any club member can read (and is pushed, live) the full named roster of an unpublished draft. Fix = fold the firewall into `has_match_access`; blast radius is exactly `match_players_select` + `match_games_select`. See the audit's §2 #11 and §4 item 7 |
| **Anon TV realtime is dead for every event the board renders from — the 15 s poll is load-bearing** | 🟢 **Accepted, but know it.** An anonymous `/tv/{id}` viewer receives **no INSERT and no UPDATE** on either of its channels: `postgres_changes` re-checks each table's SELECT policy per row, and every branch of `session_access_level` tests `auth.uid()` → NULL for anon. That is every event the board actually renders from — a score change, a court call and a new draft are all INSERT/UPDATE. (Realtime does not apply RLS to **DELETE**, so those still arrive; they carry only the PK and the hook refetches blindly, so a cleared draft can nudge an anon board incidentally. Not part of the 2026-08-04 prod verification, and not something to rely on.) The board can therefore lag **up to 15 s** on the shared screen. A signed-in viewer (an organizer casting) does get the realtime path, which is why this never showed up in testing. Making it work for anon means widening an RLS policy to the anon role — deliberately not done. Written up in full at `src/hooks/use-tv-board.ts:20-52` |

---

## 5. Banked reviewer minors (from PR #40's review rounds — non-blocking)

- Redundant `sessions` re-read on the organizer shim.
- `role = "member"` equivalent-mutant coverage gap in the tests.
- Relocate `allMatchesInSession` from the `"use server"` module into `src/lib/` so it can be
  imported directly. It is currently kept **non-exported** on purpose (an export would become a
  dispatchable endpoint) and is tested via a source-text guard — moving it would let the test import
  the real thing.

---

## 6. Deferred DB-optimization items (from `DB_OPTIMIZATION_AUDIT.md`, executed 2026-07-18) — ALL FOUR RESOLVED 2026-08-04

The four deferred items were re-derived from scratch (the original workflow output file
`wa6ffz6k1.output` was session-scoped and is gone). **One shipped; three are declined with the
reasoning banked below so nobody re-derives them.** Only one was blocked on live testing; the other
two were blocked on their designs being wrong.

| Item | Verdict |
|---|---|
| `#7` engine per-slot diversity 9→3 | ✅ **SHIPPED** — see 6.1 |
| `compute_session_wrapped` CTE hoist | ❌ **WON'T DO** — see 6.2 (plus one human-gated ticket that is worth doing on its own) |
| `#2` page-level realtime channel-owner mux | ❌ **NO-GO** — see 6.3, with revisit preconditions |
| `match_players.session_id` denormalization | ❌ **DECLINED** — see 6.4 |

Gotcha that recurs across 6.3 and 6.4: `matches` and `match_players` are both
`REPLICA IDENTITY DEFAULT`, so realtime `payload.old` carries **only the PK**.

### 6.1 ✅ `#7` — engine per-slot diversity fetches (SHIPPED)

`fetchRecentRosters` (2 queries) + `fetchPartnershipCounts` (2) + `buildOverlapMap` (3) were three
helpers issuing **seven** queries per engine slot, all re-reading overlapping slices of the same two
tables. With `fetchActivePool`'s separate read of `v_queue_with_wait_time` — a different table, left
as-is — the slot's read phase was **eight** queries deep. They are now **one**
`fetchSessionMatchSnapshot` (2 queries, run concurrently with `fetchActivePool`'s 1) plus three pure
derivations — `deriveRecentRosters`, `derivePairCounts`, `deriveOverlapMap`.

- **Per slot: 8 queries / depth 8 → 3 queries / depth 2.** Counting the commit RPC, 9 requests → 4.
  A maximum burst is 6 slots (`MAX_AUTO_DRAFTS_XLARGE`, 30+ waiting; the organizer
  override is a ceiling and can only lower it), so the deepest burst drops 54 → 24.
- **Fails CLOSED.** `SESSION_MATCH_SNAPSHOT_CEILING = 200` (prod's busiest session ever: 56). A
  query error or a session over the ceiling returns `{ ok: false }` and the engine **stops the
  burst** rather than drafting against empty history — with no history every repeat reads as a
  fresh pairing, so it would emit exactly the duplicate rosters the caps exist to prevent.
- **Ordering stayed in SQL** (`created_at DESC, id DESC`); nothing sorts timestamps in JS. The
  `id DESC` tiebreak is load-bearing, not decoration: one burst writes one `created_at` for every
  row it commits, so ties are the NORM here and `created_at DESC` alone left "the 5 most recent
  matches" non-deterministic.
- **Fixed a latent bug in passing.** The old `buildOverlapMap` pulled the anchor's `match_players`
  rows **globally** — across every session they had ever played — under an unordered `.limit(200)`,
  then intersected with the session. A heavy regular past 200 lifetime rows could have this
  session's matches truncated away by unrelated sessions, and the engine would read a genuine
  repeat as fresh.
- **Verification:** a temporary differential harness proved the merge equivalent to the three
  deleted helpers across 7 fixture shapes (0/1/4/9/14/27/56 matches), then was deleted with them.
  Its permanent replacement is `tests/unit/matchmaking-snapshot.test.ts` (22 tests) plus
  `ENG-SNAP-1/2` in the engine suite. Both were mutation-checked: ceiling `>`→`>=`, dropping the
  `id DESC` tiebreak, widening `ANTI_REPEAT_LOOKBACK`, and fail-closed→fail-open each fail exactly
  the intended test.
- **Trap for future editors — `ME-new-1` was vacuous TWICE, for two unrelated reasons.**
  1. _FIFO drift._ After the merge its carefully seeded partnership history landed on a mock slot
     nothing read any more. The engine suite's mocks are order-dependent and the snapshot
     short-circuits on an empty `matches` response, so a non-empty history fixture must be paired
     with the `match_players` response that follows it. Fixed by re-indexing.
  2. _Unreachable premise._ Its fixture had **3** waiting players, but `runEngineInternal` breaks
     at `pool.length < PLAYERS_PER_MATCH` (`matchmaking.ts:503`) **before** `derivePairCounts`,
     `deriveOverlapMap` or `runAlgorithm` run — so `capSaturation`, the test's entire subject, was
     structurally unreachable and the assertions were being satisfied by the player-shortage abort.
     The first round of fixes ("it now pins `queriedTables` + `rpc` not-called") did not cure this:
     both of those pins hold just as well on the abort path. Caught by the review gate.
  Fixed properly: the fixture is now 4 players with p0 partnered to each of p1/p2/p3 exactly twice
  (six matches), so the anchor's candidate list empties on the cap and `runAlgorithm` is genuinely
  reached. `@/lib/broadcast` is mocked and the test asserts **`broadcastCapSaturation` was called
  once with the anchor** — a positive assertion, which is the only kind that cannot go vacuous.
  (I first justified that mock as a credential-safety measure — "Vitest loads `.env.test`, which
  holds the real service-role key, so an unmocked path would POST at prod". **That was wrong**, and
  the round-2 review caught it. Probed on Vitest 4.1.5: `vitest.config.ts` declares no `env` key and
  loads no dotenv, Vite surfaces only `VITE_`-prefixed vars, so both names are UNSET under
  `vitest run` and `postBroadcast` would hit its missing-env guard. The mock is about determinism.
  It only becomes a safety control if someone later wires dotenv into the unit config.)

### 6.2 ❌ `compute_session_wrapped` CTE hoist — WON'T DO

The audit line justified this with "236.5 ms". That number does not mean what it was used to mean.

- **236.5 ms is a `pg_stat_statements` MEAN over 44 calls** — min 68.2, max 827.3, sd 121.9. A
  standard deviation half the size of the mean is not a stable baseline to optimize against; the
  spread is dominated by cold cache and session size, not by the CTE shape.
- **The honest saving is ~2–12%**, i.e. **≈15–25 ms warm**. At the observed call rate that is
  **≈2 seconds of DB CPU per year**. The `array_remove` calls that motivated it are **9 calls across
  7 lines**, not a hot loop.
- **The regression oracle is invalid.** The obvious check — "re-run the new function over the 621
  stored `session_wrapped` rows and diff" — cannot work: **419 of those rows predate the deuce
  `>= 30` change and 130 predate the first-to-100 hardening.** Most stored rows disagree with
  *current* correct behaviour, so a diff would be noise, and there is no other oracle for a
  44 KB function whose award ordering is load-bearing.

A rewrite with no trustworthy regression test, buying 2 s of CPU a year, on the session-close path
users actually watch, is a bad trade. **Not doing it.**

**⚠️ Worth doing on its own — human-gated, unrelated to the optimization:** prod's
`compute_session_wrapped` is **44,706 bytes and exists in NO repo file.** It is un-versioned
production logic. Snapshot it into the repo:

- Use `pg_get_functiondef(oid)`. **Never `prosrc`** — that is the body only, so a
  `CREATE OR REPLACE` rebuilt from it would silently drop `SECURITY DEFINER` and
  `SET search_path` (they live in `proconfig`, not the body). This is the failure mode that
  turns a "just re-save it" into a privilege-escalation surface.
- Any future re-apply must assert `prosecdef` and `proconfig` afterwards, and re-assert the grants
  from `20260723000000:147-148`.
- Do not describe this as zero-risk. It is a DDL touch on a `SECURITY DEFINER` function.

### 6.3 ❌ `#2` page-level realtime channel-owner mux — NO-GO

The idea: one page-level channel owner instead of per-hook channels. It is not blocked on live
testing — the design is unsafe as written, and the premise it rested on was measured wrong.

**Census correction — the headline saving was computed off a number nobody can compute statically,
and the fix is to stop quoting one.** The original design asserted a flat channel count. My first
correction asserted a different flat count. Both were wrong for the same reason, so the number is
struck rather than replaced:

- **The count is surface- and tab-dependent, not global.** `MatchHistory` is not mounted at rest
  (`my-status-tab.tsx:59` defaults to `"queue"`), so its `matches` channel does not exist until the
  player opens that tab. Any census that does not name the surface AND the mounted tab is fiction.
- **Call sites are not channels.** `supabase.channel(topic)` dedupes by topic, and the topic is
  `{prefix}:{table}:{sessionId}` — so the real count is the number of distinct `(prefix, table)`
  pairs live on that surface, not the 24 `subscribeToX(` call sites in `src/`. Counting call sites
  over-counts (most are never co-mounted); ignoring prefixes under-counts (the same table is opened
  under `"session-data"`, `"alerts-matches"`, `"tv"`, `"leaderboard"`, `"player-history"`,
  `"org-history"` and the un-prefixed default, which are seven distinct channels, not one).

This is precondition 2 below, restated: the saving must come from telemetry on a named surface, not
from arithmetic over the source tree. The NO-GO verdict does not rest on the census — it rests on
the three unmodelled Supabase behaviours immediately below, each of which is independently fatal.

**Why it is unsafe as written** — three Supabase behaviours the design did not model:

1. `supabase.channel(topic)` **dedupes by topic.** Two hooks asking for the same topic get the
   same channel object, so a naive mux silently shares state between unrelated consumers.
2. `REALTIME_CHANNEL_COUNT = 5` (`use-organizer-session.ts:48`) is an **exact-equality** check. Any
   dedup at all makes the count fall short and pegs the organizer's "live" indicator to
   **disconnected forever** — a visible, permanent regression from an invisible refactor.
3. `on()` **throws after `subscribe()`**, and a closed channel must be evicted rather than reused,
   so late-mounting hooks cannot attach to an already-subscribed shared channel.

**Revisit preconditions — all five, or don't reopen it:**

1. §B (the shared `trailingDebounce`) is shipped **and re-measured**. It already removed the
   fan-out cost this refactor was blamed for; without a fresh measurement there is no known
   problem left to solve. Four of the five `subscribeToMatchPlayers` call sites now share a
   debouncer with their `matches` subscription (`use-session-data`, `use-organizer-matches`,
   `use-player-match`, `use-tv-board`); `use-match-alerts` deliberately does not, because its
   ref resets are ordering-critical and only its `bootstrap()` re-seed is debounced.
2. Real telemetry on concurrency and events-per-row, **on a named surface** — the census was
   computed wrong twice, so no more arithmetic off the source tree.
3. A test fake that models `channel(topic)` dedupe, the `isClosed()` subscribe gate, **and** the
   post-`subscribe()` `on()` throw. Without it the failure modes above are untestable.
4. An explicit `CHANNEL_ERROR` evict-and-rebuild policy.
5. CLAUDE.md guardrail 3.3 rewritten — it currently mandates the per-hook pattern this would
   replace, so shipping the mux without amending the guardrail leaves the repo self-contradictory.

### 6.4 ❌ `match_players.session_id` denormalization — DECLINED

Recorded in full at `src/lib/realtime.ts:180-209`, next to the subscription it would have changed.
Short version:

- **It would suppress no measured traffic.** `postgres_changes` re-checks `match_players_select` →
  `has_match_access` → `session_access_level` per row, so cross-**club** events are already
  suppressed server-side. A `session_id` filter's entire remaining job is
  cross-session-within-a-club, of which prod has had **zero across 27 sessions**.
- **It could not cover DELETE anyway.** Filters match the **OLD** row on a DELETE, and this table is
  `REPLICA IDENTITY DEFAULT`, so `old` carries only the PK — a `session_id` filter silently drops
  every DELETE. Fixing that needs `REPLICA IDENTITY FULL`: a permanent WAL cost on a hot table, to
  buy a filter that suppresses nothing.
- The cost this binding was blamed for was a **client** problem. Each draft is 1 `matches` row + 4
  `match_players` rows, so the deepest clear-then-regenerate (`MAX_AUTO_DRAFTS_XLARGE` = 6)
  **delivers ~54 events**: 24 `match_players` DELETEs on the clear (unfiltered channel, and
  Realtime skips RLS on DELETE), then 6 + 24 INSERTs on the rebuild. The 6 `matches` DELETEs are
  dropped by `subscribeToTable`'s `session_id` filter — same PK-only OLD-row mechanic as the bullet
  above, which is the one case where it helps. Every delivered event used to trigger its own
  refetch. Fixed caller-side at four of the five call sites by sharing a `trailingDebounce` with
  the caller's `matches` subscription, so a match INSERT and its four `match_players` INSERTs
  collapse into one refetch. `use-match-alerts` is the deliberate exception (see §6.3 precondition
  1).

Revisit only if a second club goes live **and** two sessions run concurrently in one of them.

---

## 7. Housekeeping

- **Working tree is dirty** with pre-existing untracked docs and scratch files:
  `CODE_REVIEW_8207092_4e2419a.md`, `DIGITAL_TWIN_ANALYSIS.md`, `INDEPENDENT_REVIEW_2026-06-02.md`,
  `ORGANIZER_PLAYER_HISTORY_PLAN.md`, `PLAN_REVIEW_FINAL.md`, `PLAN_REVIEW_ROUND_2.md`,
  `REPEAT_PAIRING_PLAN.md`, `REVIEW_OF_FIXES_2026-06-02.md`, `marketing-site/{plan,todo}.md`,
  four `preview-*.html`, three `scripts/simulate-*.ts`. Decide: commit, `.gitignore`, or delete.
- `.claude/launch.json` and `digital-twin/src/data/manifest.json` are **modified and deliberately
  kept out of commits.** Keep doing that.
- **Three live git worktrees** under `.claude/worktrees/` (`intelligent-johnson-74dcbb`,
  `laughing-kilby-f91353`, `practical-brattain-a94aca`) plus ~25 stale local branches, many hundreds
  of commits behind `main` with deleted remotes. Worth a prune.
- Local `main` is 3 commits behind `origin/main` — `git pull` before branching anything new.
- **No local `psql` binary.** Use `docker exec supabase_db_badminton-app psql -U postgres -d postgres`.

---

## Appendix A — verified prod state 2026-07-23

Read-only catalog queries against `usxftpexoimletqmrggb`. Nothing was mutated.

**✅ Green — everything the deployed code depends on:**

| Feature | Object | Result |
|---|---|---|
| Public join via QR/link | `lookup_active_session(uuid)` | anon ✅ |
| Win streaks on the board | `get_session_player_streaks(uuid)` | exists, authenticated ✅ |
| Leaderboard lockdown | `get_player_streaks(uuid,uuid)` | anon=f auth=f svc=t ✅ |
| Leaderboard lockdown | `get_alltime_snapshot_before(timestamptz,uuid)` | anon=f auth=f svc=t ✅ |
| Leaderboard lockdown | `get_session_leaderboard_public(uuid)` | anon=f auth=f svc=t ✅ |
| Anon stats dump | `v_alltime_leaderboard_mat` | anon=f auth=f svc=t ✅ |
| Player reconnect (PIN) | `reconnect_record_and_check(...)` | service_role ✅ |
| Co-organizer join | `cojoin_record_and_check(...)` | service_role ✅ |
| Auth bookkeeping | `auth_attempt_mark_succeeded(uuid)` | service_role ✅ |
| Session lists render | `sessions.is_hidden` SELECT grant | granted ✅ |
| Organizer passcode secrecy | `sessions.organizer_passcode` | anon=f auth=f ✅ |
| Rate-limit store | `co_organizer_join_attempts` | exists, RLS on, svc INSERT ✅ |

⇒ **PR #38 and PR #39 are fully applied and deployed.** Both of #38's bracketing migrations landed
(prod stamps `20260722165217 add_session_scoped_streaks_rpc` and
`20260722165729 lock_leaderboard_reads_to_service_role`).

**🔴 Red — still open, needs PR #40:**

- 16 volatile SECDEF non-trigger functions in `public` still hold `anon` EXECUTE (full list §1.1).
- `swap_teams_in_active_match` is still the **7-arg** pre-migration shape.

**🟡 Amber — needs PR4:**

- `realtime.messages`: `rls = true`, **0 policies**.
- `profiles_select`: `USING (true)`.

**Repo migrations with no prod stamp**, after filtering the name-variant false positives
(prod re-stamps under different names): `20260721240000_grant_limiter_execute_to_service_role` and
the five `20260722000000`–`20260722000004` `declare_*` files. **All six are replay-parity no-ops by
construction** — they describe realtime publication membership, `v_recent_pairings`, the RLS
baseline, table grants and function EXECUTE grants that prod already has because they were authored
in the dashboard and never written as migrations. The one that could plausibly have mattered
(`grant_limiter_execute_to_service_role`) was verified empirically rather than taken on trust: all
three limiter functions already carry `service_role` EXECUTE on prod. Plus the two unapplied #40
files, which are the subject of §1.
