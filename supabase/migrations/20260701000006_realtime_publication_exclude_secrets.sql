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
-- ============================================================

ALTER PUBLICATION supabase_realtime DROP TABLE public.profiles;
ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles
  (id, display_name, skill_level, created_at, updated_at, vip_tag, vip_theme, needs_rename, collided_name, flagged_at);

ALTER PUBLICATION supabase_realtime DROP TABLE public.sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.sessions
  (id, name, created_by, scoring, is_active, created_at, ended_at, is_auto_matchmaking_on, court_time_limit_minutes, max_auto_drafts_override, auto_publish, club_id);
