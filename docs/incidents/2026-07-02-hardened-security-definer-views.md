# 11.5 Hardened SECURITY DEFINER views (2026-07-02)

> Extracted from `APP_MANIFEST.md` §11.5 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


**Gap closed.** Supabase's security advisor flagged 5 views as `SECURITY DEFINER` (owner-privilege,
RLS-bypassing regardless of caller): `v_match_history`, `v_session_leaderboard`, `v_recent_pairings`,
`v_queue_with_wait_time`, `v_queue_full_with_wait_time`. The real risk wasn't the intentionally-public
single-session leaderboard share link — it was that anyone could query these views directly via PostgREST
with **zero filter** and dump every club's complete match history/leaderboard in one request, since RLS on
the underlying base tables never applies to a `SECURITY DEFINER` view.

**Fix — split by actual consumer.** `supabase/migrations/20260702000003_harden_security_definer_views.sql`:
- `v_recent_pairings`, `v_queue_with_wait_time`, `v_queue_full_with_wait_time` → `ALTER VIEW ... SET
  (security_invoker = true)`. Zero risk: every consumer is either a service-role client
  (`matchmaking-db.ts`, `matchmaking.ts::runEngineInternal`) or an RLS-scoped browser client already gated
  by club membership before it ever queries (`use-organizer-queue.ts`, behind `(full)/layout.tsx`'s
  `requireClubMembership()`). `v_recent_pairings` has zero call sites at all today.
- `v_match_history`, `v_session_leaderboard` → kept `SECURITY DEFINER` (the public share-link page needs the
  RLS bypass for genuinely logged-out visitors) but `REVOKE SELECT ... FROM anon, authenticated`, closing
  direct-dump access. Added `get_session_leaderboard_public(p_session_id uuid)` — a new `SECURITY DEFINER`
  RPC with a mandatory scoping param, mirroring the existing `is_club_member`/`is_session_club_member`
  pattern (a parameter can't be omitted the way a `.eq()` filter on a raw view can be).
  `src/app/actions/leaderboard.ts`'s two `v_session_leaderboard` call sites
  (`getSessionLeaderboard`/`getPlayerStats`) now call this RPC instead of `.from(...)`; `get_session_leaderboard_public`'s type added to `src/types/database.ts`'s `Functions` section.

**Side-effect bugfix, caught by re-review, not just a refactor.** `v_match_history` itself needed no
replacement RPC — its only two call sites (`src/app/actions/history.ts`'s `getMatchHistory`/
`getAllSessionsHistory`) were assumed service-role like `wrapped.ts`'s call site, but they actually used the
RLS-scoped `createServerSupabaseClient()`. The grant revoke above broke both in prod immediately (caught by
an independent review pass, not the original build). Fixed by switching both to `createServiceClient()`,
matching `wrapped.ts`'s existing pattern — safe because both functions already gate on `playerId ===
user.id` before querying.

**Verified:** `tsc`/lint/build clean. `get_advisors` (security) re-run post-fix — all 5
`security_definer_view` findings gone. Live-verified `/leaderboard/[sessionId]` still renders full real data
for a genuinely logged-out browser session via the new RPC. Live-verified the dump vector is closed:
`set role anon; select * from v_session_leaderboard` and `set role authenticated; select * from
v_match_history` both now return `permission denied`. Independent review: first pass caught the
`history.ts` regression (Needs fixes); re-review after the fix returned **LGTM**.

**Known follow-up, not yet actioned (needs a scope decision, not a technical blocker):**
`v_alltime_leaderboard_mat` (materialized view) grants full privileges to `anon`/`authenticated` via
`pg_class.relacl` (inherited default privileges, same pattern noted in §11.3) and contains `club_id`-tagged
rows spanning every club. `getAllTimeLeaderboard()` (`leaderboard.ts`) applies `.eq("club_id", clubId)`
client-side only when a `clubSlug` is passed — the legacy root `/leaderboard` route intentionally passes
none, showing an all-clubs combined board by design (pre-multi-tenant behavior, kept for backward compat).
Whether an all-clubs public leaderboard should still exist post-multi-tenant is a product decision, not
purely a security bug — flagged for the user rather than silently changed. Materialized views also can't
carry RLS policies in Postgres, so if the decision is "club-scoped only," the fix mirrors this section's
pattern: revoke direct grants, add a mandatory-`p_club_id` RPC (`get_alltime_snapshot_before` already
exists as the point-in-time-slice sibling and could serve as the exact style template).

