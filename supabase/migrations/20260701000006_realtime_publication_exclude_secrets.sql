-- ============================================================
-- Exclude authentication secrets from the realtime publication
-- ============================================================
-- profiles.pin (the 4-digit reconnect PIN looked up in reconnectPlayer())
-- and sessions.organizer_passcode (looked up in joinAsCoOrganizer()) are
-- real authentication credentials. Both tables were in supabase_realtime
-- with ALL columns, and neither is protected in a way that stops the
-- secret from riding along on postgres_changes:
--   - profiles has no RLS at all, and subscribeToProfiles() (realtime.ts)
--     subscribes with no filter — every profile UPDATE broadcasts the
--     full row, including `pin`, to every subscribed client in the app,
--     across every club, in normal usage (not just a crafted attack).
--   - sessions has RLS, but the sessions_select policy intentionally
--     allows any authenticated user to read any session row (see
--     organizer/page.tsx) — so RLS being enabled provides no column-level
--     protection for organizer_passcode; a raw client subscribing to
--     postgres_changes on `sessions` (no app hook does this today, but
--     nothing stops one) would receive it in full.
--
-- Fix: narrow each table's column list in the publication so the secret
-- column is never replicated to Realtime at all. This only affects the
-- WAL-fed replication stream that feeds postgres_changes — PostgREST /
-- supabase-js `.select()` queries are a completely separate code path
-- and are unaffected (existing reads of `pin` / `organizer_passcode` via
-- server actions keep working exactly as before).
--
-- Using DROP TABLE + ADD TABLE (not SET TABLE) deliberately: ALTER
-- PUBLICATION ... SET TABLE replaces the *entire* table list for the
-- publication, which would silently drop every other table (matches,
-- queue_entries, courts, etc.) from realtime. DROP + ADD only touches
-- the named table.
--
-- ── AMENDED 2026-07-22: made replay-safe ────────────────────
-- The DROPs were originally unguarded, which was correct against production
-- (where both tables had been added to supabase_realtime through the Supabase
-- dashboard) but fails on ANY database built from migrations alone:
--
--   ERROR: relation "profiles" is not part of the publication (SQLSTATE 42704)
--
-- Every Supabase preview branch replays from zero, so this aborted the branch
-- build and took the Vitest Integration job down with it — on every PR and on
-- main. The integration suite had not actually run for some time; the job was
-- dying in DB setup before a single test executed.
--
-- The statements below now converge to the intended state from EITHER starting
-- point. See 20260722000000, which declares the publication's full membership
-- so a from-scratch database matches production instead of merely not erroring.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_rel pr
      JOIN pg_publication p ON p.oid = pr.prpubid
      JOIN pg_class c       ON c.oid = pr.prrelid
      JOIN pg_namespace n   ON n.oid = c.relnamespace
     WHERE p.pubname = 'supabase_realtime'
       AND n.nspname = 'public' AND c.relname = 'profiles'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.profiles;
  END IF;
END $$;

ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles
  (id, display_name, skill_level, created_at, updated_at, vip_tag, vip_theme, needs_rename, collided_name, flagged_at);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_rel pr
      JOIN pg_publication p ON p.oid = pr.prpubid
      JOIN pg_class c       ON c.oid = pr.prrelid
      JOIN pg_namespace n   ON n.oid = c.relnamespace
     WHERE p.pubname = 'supabase_realtime'
       AND n.nspname = 'public' AND c.relname = 'sessions'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.sessions;
  END IF;
END $$;

ALTER PUBLICATION supabase_realtime ADD TABLE public.sessions
  (id, name, created_by, scoring, is_active, created_at, ended_at, is_auto_matchmaking_on, court_time_limit_minutes, max_auto_drafts_override, auto_publish, club_id);
