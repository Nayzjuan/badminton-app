# PENDING WORK — resume after the 2026-07-23 live session

Handoff file. Everything below was paused deliberately so that nothing changed on production
before the afternoon session. **Production was verified healthy and untouched at the time of
writing** — see [Appendix A](#appendix-a--verified-prod-state-2026-07-23) for the object-by-object
snapshot, so the next session does not have to re-derive it.

- **Prod project:** `usxftpexoimletqmrggb`
- **Live deployment:** `dpl_EhWSHP3T…`, `READY`, commit `5e5fa88` (PR #39 merge)
- **Only open PR:** [#40](https://github.com/Nayzjuan/badminton-app/pull/40) — green, `MERGEABLE/CLEAN`, head `d7bcfc2`, branch `fix/tenancy-revoke-anon-mutating-rpcs`
- **Full audit context:** [TENANCY_AUDIT_2026-07-21.md](TENANCY_AUDIT_2026-07-21.md)

> ⚠️ **Migrations in this project are applied by hand.** There is no deploy automation for the
> database. Merging a PR ships TypeScript only. Prod's migration stamps also drift from the repo
> filenames (prod stamps `20260722165729 lock_leaderboard_reads_to_service_role` where the repo
> file is `20260722010001_…`), so **never compare by version number — compare by name suffix, and
> ultimately by querying the catalog.**

---

## 0. Resume here — the exact next sequence

Do these four steps in this order, nothing interleaved:

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
**§2.2 (PR4b, finding #8) is the only audit item still unbuilt.**

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

**Status: code complete, reviewed (verdict *Minor issues*, all closed), held unmerged.**
Branch `fix/tenancy-realtime-private-broadcast`.

| File | Change |
|---|---|
| `supabase/migrations/20260723100000_scope_session_events_broadcast_to_members.sql` | new — SELECT-only policy on `realtime.messages` + non-throwing topic parser |
| `src/lib/broadcast.ts` | every emitted message carries `private: true` |
| `src/lib/realtime.ts` | join with `{ config: { private: true } }`, deferred behind `whenRealtimeAuthReady()`, optional `onStatus` |
| `src/hooks/use-organizer-broadcast.ts` | comment only — why `onStatus` is not wired |
| `tests/unit/realtime-private-broadcast.test.ts` | new — 6 tests pinning both halves + the JWT ordering |
| `APP_MANIFEST.md`, `MEMORY.md` | documented, incl. reversing the old "no JWT needed" claim at `APP_MANIFEST.md:74` |

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
2. **Smoke-test the `realtime:` topic prefix under `private: true`.** `broadcast.ts` posts to
   `realtime:session-events:{id}`, which the local CLI Realtime image delivers to *nobody*, so the
   private path cannot be exercised end-to-end locally; prod evidently normalises the prefix, since
   it delivers these events today. Immediately after deploy: two organizer boards on one session →
   flip auto-matchmaking → the co-organizer's toggle must move; then close the session → a player
   must land on Wrapped. **Do not "fix" the prefix on a local repro alone.**

`create policy` on prod's `realtime.messages` fails loudly with `42501` if `postgres` lacks
ownership there — it will not fail silently.

### 2.2 ❌ PR4b — tighten `profiles_select` (finding #8)

**Status: not started.** Groundwork done 2026-07-23; it changed the shape of the fix twice.

- **`anon` has no SELECT policy on `profiles` at all.** `profiles_select` is `TO authenticated
  USING (true)`. So the rationale recorded in `20260722000002_declare_rls_baseline.sql:175-184`
  ("load-bearing for logged-out public leaderboard/Wrapped reads") is **stale** — those reads moved
  to the service client in PR #38 and cannot be going through RLS. **Correct that comment as part
  of PR4b.** Tightening cannot break any logged-out path; blast radius is authenticated users only.
- **A naive shared-club `EXISTS` would be wrong.** `session_access_level` grants `'organizer'` via a
  `session_organizers` row **without** club membership — that is how QR-invite delegation works. A
  club-only predicate renders a delegated organizer's roster as blank names. The `'member'` arm
  *does* require active club membership, so ordinary players are unaffected.
- **Candidate predicate:** `id = auth.uid()` OR shared-active-club OR shares-an-accessible-session.
  Both helpers `STABLE SECURITY DEFINER`, `search_path`-pinned. Needs an `EXPLAIN` pass —
  `profiles` is read on every enriched-match fetch — and probably
  `club_members (player_id, club_id) WHERE is_active`.
- RLS-bound read sites to re-verify: `use-enriched-matches.ts:128`,
  `use-session-completed-players.ts:95`, `use-player-match.ts:178`, `use-match-history.ts:64`,
  `use-organizer-queue.ts:125`, `matchmaking-db.ts:499`, `dup-name.ts:45`. Everything under
  `src/app/actions/` uses the service client and is unaffected.
- Fixes the unfiltered `profiles` realtime firehose (`src/lib/realtime.ts`) at the same time.
- Tests: RLS assertions via `withTx` + `set local role authenticated`.
- While in there: drop the redundant `club_members` partial index.

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

## 3. Follow-up bracket migration (do **after** #40 has deployed)

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

---

## 5. Banked reviewer minors (from PR #40's review rounds — non-blocking)

- Redundant `sessions` re-read on the organizer shim.
- `role = "member"` equivalent-mutant coverage gap in the tests.
- Relocate `allMatchesInSession` from the `"use server"` module into `src/lib/` so it can be
  imported directly. It is currently kept **non-exported** on purpose (an export would become a
  dispatchable endpoint) and is tested via a source-text guard — moving it would let the test import
  the real thing.

---

## 6. Deferred DB-optimization items (from `DB_OPTIMIZATION_AUDIT.md`, executed 2026-07-18)

Four structural items were deferred with execution-ready designs. ⚠️ The workflow output file that
held the full designs (`wa6ffz6k1.output`) is session-scoped and **no longer exists** — the
summaries in `MEMORY.md` (line 446) are now the source of truth, and the designs will need
re-deriving.

| Item | Note |
|---|---|
| `#7` engine per-slot diversity 9→3 | Needs 8 engine-test remaps + deriver equivalence tests |
| `compute_session_wrapped` CTE hoist | 44 KB function, rare session-close path, load-bearing award order |
| `#2` page-level realtime channel-owner | **Needs human 2-device live smoke** — not autonomous |
| `match_players.session_id` denormalization | **Needs human live testing** — the filtered-subscription DELETE / replica-identity trap |

Gotcha to remember: `matches` is `REPLICA IDENTITY DEFAULT`, so realtime `payload.old` carries only
the PK.

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
