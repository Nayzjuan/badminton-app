# 11.6 Task #56 resolved — `search_path` hardening + remaining advisory triage (2026-07-02)

> Extracted from `APP_MANIFEST.md` §11.6 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


**Decision (user):** keep `v_alltime_leaderboard_mat`/legacy all-clubs `/leaderboard` behavior as-is — established,
intentional, no fix needed. `rls_enabled_no_policy` on `club_invites`/`clubs`/`player_renames` already accepted as
deny-all-by-design (no action). `auth_leaked_password_protection` (HaveIBeenPwned check) is a Supabase Auth
dashboard toggle, not reachable via migration/SQL — left as a manual to-do for the user, not chased further.
**CLOSED 2026-08-04 as WON'T DO** (user decision): the toggle is Pro-plan-gated and the org is on Free, and no
email+password credential exists to check anyway (Google OAuth + anonymous/PIN only). The advisor WARN is
accepted noise; re-open only on a Pro upgrade or if password sign-up is ever added.

**Fixed — `function_search_path_mutable` (20 functions):** `supabase/migrations/20260702000004_pin_search_path_hardening.sql`,
applied to prod. `ALTER FUNCTION ... SET search_path = public, pg_temp` on all 20 flagged functions (`is_club_member`,
`is_session_club_member`, `is_session_organizer`, `elevate_to_organizer`, `get_h2h_record`,
`compute_session_wrapped`, `migrate_player_identity`, `refresh_alltime_leaderboard`,
`refresh_cross_session_stats`, `get_alltime_snapshot_before`, `get_player_streaks`, `rejoin_queue`,
`toggle_auto_matchmaking`, `handle_new_session`, `set_updated_at`, `skill_level_to_int`,
`clear_all_unpublished_drafts`, `touch_push_subscription_updated_at`, `_fix_record_partnership_delta`,
`is_match_club_member`) — a pure config-parameter pin via `ALTER FUNCTION`, no `CREATE OR REPLACE`, zero risk of
logic drift since function bodies are untouched.

**Verified:** `pg_proc.proconfig` confirms `search_path=public, pg_temp` on all 20 live. `get_advisors` re-run —
`function_search_path_mutable` finding count now 0. Functional smoke: `skill_level_to_int`/`is_club_member`
still execute correctly post-change. Independent review: confirmed zero overloaded function names in `public`
(so no `ALTER FUNCTION` call could have targeted the wrong overload), diffed all 20 signatures 1:1 against
`pg_get_function_identity_arguments` on prod, checked every function body for unqualified cross-schema references
(none found — all `auth.*` calls are schema-qualified, everything else is `pg_catalog`/`public`). Verdict: **LGTM**.

**Task #56 is now fully closed** — every item from the original advisory triage is either fixed, already accepted
by design, or explicitly deferred to the user with a clear reason (dashboard-only setting).

