-- ============================================================
-- Fix 20260701000009: table-wide SELECT grant defeated the column revoke
-- ============================================================
-- 20260701000009 ran `revoke select (pin) on profiles from authenticated,
-- anon` (and the equivalent for sessions.organizer_passcode), then applied
-- to prod. Re-verifying via has_column_privilege() immediately after showed
-- it had NO effect: both roles could still select the secret column.
--
-- Root cause: authenticated/anon already hold a TABLE-WIDE `GRANT SELECT ON
-- profiles/sessions` (no column list). Postgres checks table-level and
-- column-level ACLs independently when deciding whether a SELECT is
-- allowed — a table-wide grant on its own is sufficient to read every
-- column, so a column-specific REVOKE against a role that also holds the
-- table-wide grant is a no-op. To actually restrict one column you must
-- revoke the table-wide grant and re-grant SELECT scoped to an explicit
-- column list.
--
-- profiles' safe list mirrors PUBLIC_PROFILE_COLUMNS (src/types/database.ts),
-- already the projection every client-facing read uses. sessions' safe list
-- is every column except organizer_passcode.
-- ============================================================

revoke select on public.profiles from authenticated, anon;
grant select (
  id, display_name, skill_level, vip_tag, vip_theme,
  needs_rename, collided_name, flagged_at, created_at, updated_at
) on public.profiles to authenticated, anon;

revoke select on public.sessions from authenticated, anon;
grant select (
  id, name, created_by, scoring, is_active, created_at, ended_at,
  is_auto_matchmaking_on, court_time_limit_minutes,
  max_auto_drafts_override, auto_publish, club_id
) on public.sessions to authenticated, anon;
