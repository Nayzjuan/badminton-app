-- ============================================================
-- Per-session Auto-Publish mode
-- ============================================================
-- Adds a session-level toggle that controls whether engine-generated
-- matches skip the manual organizer "publish" gate.
--
--   auto_publish = false (default):  engine writes is_published=false
--                                    → matches land as DRAFTS for organizer review
--   auto_publish = true:             engine writes is_published=true
--                                    → matches go STRAIGHT to On Deck (no review)
--
-- Additive + backward-compatible: NOT NULL DEFAULT false means every existing
-- session keeps today's draft-review behavior. The currently-deployed app does
-- not read this column, so applying this migration ahead of the code deploy is
-- safe (no read/write of auto_publish until the new build ships).
--
-- The create_match_with_players RPC already accepts p_is_published and, when
-- p_is_on_deck=true AND p_is_published=true, promotes the roster to 'on_deck'.
-- No RPC change is required for the normal (waiting-pool) path.
-- ============================================================

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS auto_publish boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.sessions.auto_publish IS
  'Auto-publish mode. When true, engine-generated matches skip the draft gate and go straight to On Deck (is_published=true). Default false = manual review (draft) mode.';
