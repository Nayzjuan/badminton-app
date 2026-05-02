-- ============================================================
-- Migration: Draft Mode — is_published column on matches
-- ============================================================
-- Auto-generated matches (from the matchmaking engine) start as
-- drafts (is_published = false) so they are hidden from players
-- and the TV view until the organizer explicitly publishes them.
--
-- Manual matches (created by the organizer) bypass draft review
-- and are inserted with is_published = true via the server action.
--
-- The create_match_with_players RPC does NOT include is_published
-- in its INSERT — it relies on this DEFAULT false so engine-created
-- matches automatically become drafts without any RPC changes.
--
-- Three query firewalls enforce visibility:
--   1. use-session-data.ts  — player view filters is_published=true for pending
--   2. tv.ts                — TV view filters is_published=true for pending
--   3. promoteOnDeckMatchInternal — promotion only promotes published matches
-- ============================================================

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT false;

-- Backfill: all existing matches (including completed/cancelled) are
-- treated as published so historical data is unaffected.
UPDATE public.matches
SET    is_published = true
WHERE  is_published = false;

-- Partial index — only on pending matches, which is the subset that
-- needs fast published/draft filtering.
CREATE INDEX IF NOT EXISTS idx_matches_session_published
  ON public.matches (session_id, status, is_published)
  WHERE status = 'pending';
