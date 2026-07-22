-- ============================================================
-- sessions.is_hidden — keep infrastructure sessions out of human lists
-- ============================================================
-- The "🤖 E2E SANDBOX — DO NOT JOIN" session lives in the CHILLAX club (it is
-- the only club), so it surfaces in every session list the app renders:
--
--   1. /c/[slug]/organizer          — as an ACTIVE session, at the top of the
--                                     page, WITH its organizer_passcode shown
--   2. the organizer dashboard's session switcher
--   3. /play                        — every PLAYER in the club sees it
--
-- Its name is literally an instruction to humans not to touch it, which is a
-- workaround for it being visible at all. This column makes "not for humans"
-- a property of the row instead of a plea in its title.
--
-- Deliberately generic (is_hidden, not is_sandbox): any future infrastructure
-- or staging session gets the same treatment without another migration.
-- ============================================================

alter table public.sessions
  add column if not exists is_hidden boolean not null default false;

comment on column public.sessions.is_hidden is
  'True for infrastructure sessions (E2E sandbox, staging) that must never appear in a human-facing session list. Rows remain fully readable by id — hiding is a listing concern, not an access-control one.';

-- ── The grant is REQUIRED, not hygiene ────────────────────────
-- 20260701000010 revoked the table-wide SELECT on sessions and re-granted it
-- against an EXPLICIT column list (that is how organizer_passcode is kept from
-- anon/authenticated). Postgres requires SELECT privilege on every column
-- referenced in a query — including one used only in a WHERE clause. Without
-- this line, the two authenticated-client reads that now filter on is_hidden
-- (/play and the session switcher) would fail outright with
-- "permission denied for table sessions".
grant select (is_hidden) on public.sessions to authenticated, anon;

-- ── Backfill ──────────────────────────────────────────────────
-- Matched on the same name prefix that tests/helpers/teardown.ts already
-- treats as a safety invariant (it refuses to reset a session whose name does
-- not start with it), so this cannot hide a real club night.
update public.sessions
set is_hidden = true
where name like '🤖 E2E SANDBOX%';
