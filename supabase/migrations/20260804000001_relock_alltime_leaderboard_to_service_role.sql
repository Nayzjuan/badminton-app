-- Re-lock v_alltime_leaderboard_mat to service_role.
--
-- History: 20260804000000 was applied to production WITHOUT the trailing
-- revokes (they were added to that file only after this was caught). The
-- recreate therefore picked up this project's ALTER DEFAULT PRIVILEGES and
-- briefly granted anon + authenticated full privileges on the matview,
-- undoing 20260722010001_lock_leaderboard_reads_to_service_role.sql. This
-- migration is what actually closed that on production.
--
-- 20260804000000 is now self-contained, so on a from-scratch database these
-- revokes are redundant — and harmless, since REVOKE on an already-revoked
-- privilege is a no-op. Kept so the repo's migration list matches the stamps
-- that were really applied to production.
--
-- Post-state, verified via pg_class.relacl:
--   {postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}

revoke all on public.v_alltime_leaderboard_mat from anon;
revoke all on public.v_alltime_leaderboard_mat from authenticated;
