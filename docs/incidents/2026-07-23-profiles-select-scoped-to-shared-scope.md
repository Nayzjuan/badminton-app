# 11.8 `profiles_select` scoped to shared scope — tenancy audit #8 (2026-07-23)

> Extracted from `APP_MANIFEST.md` §11.8 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


The last table in the schema whose SELECT policy had no tenancy dimension at all. `profiles_select` was:

```sql
CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated USING (true)
```

so any signed-in user — including a `signInAnonymously()` guest who had never joined a club — could
enumerate every display name, skill level and VIP tag on the platform, and the **unfiltered** `profiles`
postgres_changes subscription (`subscribeToProfiles`, §5) streamed every profile UPDATE platform-wide to
every connected browser. `pin` was already excluded by the column grants (`20260701000010`) and
`PUBLIC_PROFILE_COLUMNS`, so this was a roster leak, not a credential leak.

**The rationale recorded for `USING (true)` was wrong.** `20260722000002` documented it as "intentional and
load-bearing… the public leaderboard and Wrapped share pages read arbitrary profiles while logged out."
`profiles` has **no SELECT policy for `anon` at all**, so no logged-out read has ever passed through this
policy — those pages go through the service client (PR #38 moved the leaderboard reads there explicitly).
The policy only ever governed authenticated users, so tightening it could not break a logged-out path. The
comment is corrected in place; the `USING (true)` branch survives in that file only so a from-scratch replay
reproduces the historical baseline before `20260723200000` tightens it.

**The predicate** (`20260723200000_scope_profiles_select_to_shared_scope.sql`):

```sql
USING ( profiles.id = (select auth.uid()) OR public.can_read_profile(profiles.id) )
```

The self arm stays in the *policy*, not the helper: it is a bare primary-key equality, so the planner uses it
directly for the seven `.eq("id", user.id)` server-component reads (plus the two in `auth.ts` / `queue.ts`)
without entering the function at all.

`can_read_profile(uuid)` is STABLE SECURITY DEFINER (`search_path` pinned), and is the union of five arms in
short-circuit order. **SECURITY DEFINER is required**: `club_members`, `queue_entries`, `matches` and
`match_players` each carry their own RLS, and evaluating them as the caller would make profile visibility
depend transitively on four more policies. It reads no `profiles` row, so there is no recursion.

| # | Arm | The state it keeps working |
| - | --- | --- |
| 1 | shared **active** club | the arm that fires for essentially every read in a single-club deployment; two index lookups |
| 2 | target is **queued** in a session the caller can reach | **walk-ins** — an organizer can queue somebody who holds no `club_members` row until `/play/[sessionId]` enrolls them. Without it a walk-in's name renders blank for the whole room |
| 3 | target **played a match** in a session the caller can reach | ⚠️ **The motive previously written in this cell was false.** It said checkout DELETEs the queue row, citing `queue_delete_own` / `queue_delete_organizer` — those are DELETE *policies* (permissions), not code paths. Checkout **UPDATEs** the row to `status='left'` ([queue.ts:166](src/app/actions/queue.ts:166)), so it survives, and arm 2 carries **no status filter** — meaning arm 2 already covers players who left. Measured on prod 2026-08-13, per-session (the arms are per-session, so "has *some* queue row" is the wrong test): of **638** (player, session) pairs holding a completed match, **0** lack a `queue_entries` row in that same session — 192 distinct players, no exceptions. So arm 3 adds no visibility today. Keep it as **fail-safe depth, not because any known path needs it**: no application or hand-run path in this repo produces the arm-3-only state. ⚠️ An earlier draft of this cell claimed two paths did, and both were checked and neither does — `clearSessionData` deletes `match_players` and `matches` *before* `queue_entries` ([dev.ts:465-477](src/app/actions/dev.ts:465)), so arm 3 dies first rather than surviving; and the hand-run duplicate-merge fix reassigns `match_players` to the **winner** and then **moves the loser's `queue_entries` row to the winner too** (guarded by `NOT EXISTS` on a same-session winner row, [20260608:113-116](supabase/data-fixes/20260608_duplicate_name_data_fix.sql)) before deleting what is left and the loser's profile outright — so the winner ends up holding a queue row in every session where they gained match rows, which is precisely what forecloses the arm-3-only state. The only thing that reaches this state is the integration test, which manufactures it with a service-role DELETE. The real case for arm 3 is simply that it is the one arm that would survive a queue row being removed on its own. `useMatchHistory` / `useSessionCompletedPlayers` read these profiles |
| 4 | target **organizes** a session the caller can reach | **QR-delegated organizers** (`session_organizers`, no membership). Without it visibility inside one session is asymmetric: the delegate sees the room, the room cannot see the delegate |
| 5 | target **created** a session the caller can reach | not implied by #4 — production has one session whose creator has **no** `session_organizers` row, so `handle_new_session()` cannot be relied on |

Arms 2–4 are latent in production today (0 queued non-members, 0 played non-members, 0 membership-less
delegated organizers, verified read-only before writing the migration). Arm 5 is **not** latent — that one
session with a creator and no `session_organizers` row is live data. They are present so the policy does not
start failing silently the first time one of those supported states occurs.

**Two consequences worth knowing before changing any of this.**

- **Arm 2 must stay exactly as wide as the `queue_select` policy.**
  `v_queue_full_with_wait_time` is `security_invoker = true` and **INNER JOINs** `profiles`, and it is what
  `useOrganizerQueue` reads. Narrowing arm 2 below `queue_select` therefore makes the organizer's queue
  **drop rows** rather than render "Unknown" — a missing player, not a missing name. The migration carries
  the same warning inline next to the arm.
- **Arms 2–5 all gate on `session_access_level()`, which is membership/organizer-derived**, so a *reader*
  who is queued in or has played in a session but holds no active `club_members` row sees exactly one
  profile: their own. That is not a live regression — `requireClubMembership` bounces non-members to
  `/play`, and `src/app/play/[sessionId]/page.tsx` enrolls a queued walk-in before rendering — but note that
  the walk-in's *own* view depends on that enrol call, whose `ok: false` return is currently not checked.
  `queue_select` has the same shape (no "own row" arm), so such a reader could not read their own queue row
  either, before or after this change.

**Grants.** `service_role` is granted **first**, then `revoke execute … from public, anon, authenticated`,
then `grant execute … to authenticated` — the from-scratch replay trap from `20260722000004` (§7): on a
`proacl`-NULL function the revoke materialises `acldefault()` and strips `service_role` along with PUBLIC.
The helper is deliberately **narrower** than the six RLS helpers: it is not anon-executable, because unlike
the pure string parser in PR #40's `20260723100000` it reads tables, and an anon `/rest/v1/rpc/can_read_profile` would
be a membership oracle. The migration's closing `DO` block asserts the qual is no longer `true`, that it
names `can_read_profile`, that the policy is SELECT-only and `authenticated`-only, that **no** anon/PUBLIC
SELECT policy exists on `profiles` (one would fail closed without an anon grant), the grants in both
directions, that `session_access_level` still holds **both** its anon and authenticated grants, and that
`can_read_profile(gen_random_uuid())` and `can_read_profile(null)` each return exactly `false` — never NULL,
never raising.

**Realtime is unchanged on purpose.** `subscribeToProfiles` still subscribes with no `filter=`. It does not
need one: postgres_changes applies the SELECT policy per row at delivery time, so narrowing the policy
narrows the stream (verified with a live subscription — an outsider receives their own UPDATE and not a
stranger's). A server-side `filter=` cannot express "shared club" anyway.

**Cost, measured** against a synthetic dataset ~15× production (1001 profiles, 200 sessions, 48 000
`match_players`):

| Shape | Plan | Time |
| --- | --- | --- |
| own profile, `.eq("id", uid)` | Index Scan `profiles_pkey` | 0.05 ms |
| 40 profiles by id, shared club (**the hot path**) | Index Only Scan + filter | 4.18 ms |
| 40 profiles by id, no arm matches | Index Only Scan + filter | 162 ms |
| unbounded `select count(*)` | Seq Scan, 1001 evaluations | 1746 ms |

Only the first two are shapes the app emits: every RLS-bound read of `profiles` is `.eq("id", user.id)` or
`.in("id", ids)`, which PostgREST renders as `id = ANY(array[…])` — an index qual, so the policy runs on the
requested rows, not on the table. The two slow rows are both **denied** paths. **Do not benchmark this with
`id IN (SELECT …)`**: that plans as a hash semi-join and, because an RLS qual is not leakproof, the planner
applies it under a full seq scan *before* the join — 1001 helper calls for 40 rows, ~1.9 s. It is a
measurement artifact, not a shape any client produces.

**Tests.** `tests/integration/rls-edge-cases.test.ts` → `describe("profiles_select scope — finding #8")`:
the enumeration itself (`count(*) === 1` for an unrelated user), one case per arm, `is_active` respected,
the anon-RPC revoke, and own-profile. They sign users in **for real** — `makeProfile` now returns the
generated `email` and exports `TEST_USER_PASSWORD` — because `mockAuthAs` only fools the server actions, not
Postgres; RLS is only exercised by a genuine `authenticated` JWT. Every arm test pairs its positive
assertion with a `not.toContain(stranger.id)` control, so a pass cannot be explained by the very bug being
fixed.

---

