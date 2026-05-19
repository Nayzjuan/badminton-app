-- ============================================================
-- TOTAL HARD RESET — Chillax Badminton
-- Drafted: 2026-04-24
-- ============================================================
-- WARNING: This is irreversible. Every user, session, match,
-- and queue entry will be permanently deleted.
-- Run ONLY in the Supabase Dashboard SQL Editor (postgres role).
-- ============================================================

-- ── Step 1: Wipe all public tables ───────────────────────────
TRUNCATE TABLE
  public.match_games,
  public.match_players,
  public.matches,
  public.queue_entries,
  public.session_wrapped_stats,
  public.session_organizers,
  public.courts,
  public.sessions,
  public.push_subscriptions,
  public.profiles
CASCADE;

-- ── Step 2: Wipe Supabase auth users ─────────────────────────
DELETE FROM auth.users;

-- ── Verify — every count should be 0 ─────────────────────────
SELECT 'profiles'               AS tbl, COUNT(*) AS rows FROM public.profiles
UNION ALL SELECT 'sessions',               COUNT(*) FROM public.sessions
UNION ALL SELECT 'courts',                COUNT(*) FROM public.courts
UNION ALL SELECT 'queue_entries',         COUNT(*) FROM public.queue_entries
UNION ALL SELECT 'matches',              COUNT(*) FROM public.matches
UNION ALL SELECT 'match_players',        COUNT(*) FROM public.match_players
UNION ALL SELECT 'session_organizers',   COUNT(*) FROM public.session_organizers
UNION ALL SELECT 'push_subscriptions',   COUNT(*) FROM public.push_subscriptions
UNION ALL SELECT 'auth.users',           COUNT(*) FROM auth.users
ORDER BY tbl;
