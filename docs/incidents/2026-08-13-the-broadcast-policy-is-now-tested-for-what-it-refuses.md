# 3.35 The broadcast policy is now tested for what it REFUSES (2026-08-13)

> Extracted from `APP_MANIFEST.md` §3.35 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


**Files:** `tests/integration/realtime-broadcast-rls.test.ts` (new, Suite RB, 8 tests). No production code changed — this closes a **coverage** gap, not a defect.

**The gap.** Tenancy audit finding #7 (§ Broadcast System, migration `20260723100000`) shipped 2026-07-24 (PR #41, `4bc5cfc`; the migration filename carries its 07-23 authoring date), and everything written for it tested the *client* side: `realtime-private-broadcast.test.ts` (RPB-1…7) mocks supabase-js and asserts the app **declares** `private: true` and builds the right topic string, and `[R-1]` proves a second organizer **receives** the event. Both are positive paths. Nothing asserted the half the finding was actually about — that a signed-in stranger is **refused**. A policy that had been dropped, or narrowed to `using (extension = 'broadcast')`, would have left every one of those tests green while the topic leaked club-wide again.

**Why this is testable in SQL at all.** Realtime Authorization is not a bespoke check. To decide a channel join, Realtime opens a transaction, sets the caller's role and JWT claims, sets `realtime.topic` to the topic being joined, and asks Postgres whether the caller can `SELECT` from `realtime.messages` — and, for the write half, whether an `INSERT` survives. Suite RB reproduces exactly that against local Supabase, so it runs the real policy, the real `realtime_topic_session_id()` and the real `session_access_level()` over real rows. The two things it does **not** cover are stated in its header: the WebSocket layer (that is `[R-1]`'s job) and the project-wide "Allow public access" toggle, which has no SQL surface.

**Every test is killed by a mutant.** Four mutated policy sets were applied to the local stack and the suite re-run against each:

| Mutation | Tests that fail |
|---|---|
| **M1** replace the predicate with `using (extension = 'broadcast')`, still `for select to authenticated` — private but unscoped | RB-3 RB-4 RB-5 RB-7 |
| **M2** add `for all to authenticated using (true) with check (true)` — the forgery hole | RB-3 RB-4 RB-5 RB-7 RB-8 |
| **M3** drop the policy entirely — fail-closed | RB-1 RB-2 RB-4 RB-5 |
| **M4** add `for select to anon using (extension = 'broadcast')` | RB-6 |

M2 kills the four reads as well because a permissive `ALL` policy is OR-ed into `SELECT`. M3 kills RB-4 and RB-5 through their **positive** halves — RB-4's own-club control and RB-5's before-deactivation read — not their negative ones.

⚠️ **RB-6 is a pin, not a discriminator against M1–M3** — `anon` is refused under all three, so only M4 can kill it. It earns its place anyway: `20260723100000` warns that adding an anon arm silently requires putting back the `anon` EXECUTE grant on `realtime_topic_session_id()` that the same migration deliberately revokes. The `to authenticated` on M2 is load-bearing: without it the policy applies to `PUBLIC`, which includes `anon`, and RB-6 would fail too — making the table above wrong. The verbatim DDL lives in the test file header; re-derive the table if you change a mutant.

**Two facts worth keeping.** (1) The forgery half (RB-8) is closed by the **empty policy set**, not by a missing GRANT — `anon` and `authenticated` both hold `INSERT` on `realtime.messages`. ⚠️ SQLSTATE `42501` alone cannot tell those apart: it is `ERRCODE_INSUFFICIENT_PRIVILEGE`, raised identically for a missing table GRANT and for an RLS deny. RB-8 therefore asserts all three — `has_table_privilege` is true, the insert failed, and the message names row-level security — so a migration that swapped one closure for the other could not pass silently. (2) The policy predicate on production hashes byte-identically to the local one it was tested against (`md5(pg_get_expr(polqual, …))` = `b71440dd…`, single SELECT policy, no INSERT/ALL policy on either), which is what lets a local suite speak for prod.

---

