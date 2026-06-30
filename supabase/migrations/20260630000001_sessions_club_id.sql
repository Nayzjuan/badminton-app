-- ============================================================
-- Multi-Tenant Phase 0 — Migration 2: sessions.club_id
-- ============================================================
-- 1. Create the fixed "Legacy" club that absorbs all pre-existing data.
-- 2. Add sessions.club_id (nullable first) with a TEMPORARY DEFAULT = legacy
--    club, so the currently-deployed (club-unaware) app keeps creating
--    sessions without error during the transition window.
-- 3. Backfill existing sessions; verify zero NULLs; SET NOT NULL.
--
-- WHY THE DEFAULT (correction discovered during Phase 0 build):
--   sessions.club_id is NOT NULL with no app-supplied value yet — the live
--   createSession path inserts no club_id. Without a column DEFAULT, the first
--   new session created by the still-deployed old app would fail the NOT NULL
--   constraint, breaking the "all existing functionality works unchanged"
--   gate. The DEFAULT keeps that gate true. It is TEMPORARY and is dropped in
--   a later phase once createSession passes club_id explicitly
--   (see MULTI_TENANT_PLAN.md §8 Phase 2 + Decision Log).
--
-- Idempotent. BUILD ONLY — not applied to production yet.
-- ============================================================

-- ---- 1. Legacy club (fixed id so it can serve as a column DEFAULT) ----
-- created_by = the most prolific session creator (de-facto main organizer),
-- falling back to the oldest profile. Guarded so it only runs when at least
-- one profile exists (a valid created_by is required by the FK).
INSERT INTO public.clubs (id, name, slug, created_by, is_active)
SELECT
  '00000000-0000-0000-0000-000000000001'::uuid,
  'Legacy',
  'legacy',
  COALESCE(
    (SELECT created_by FROM public.sessions GROUP BY created_by ORDER BY count(*) DESC LIMIT 1),
    (SELECT id FROM public.profiles ORDER BY created_at LIMIT 1)
  ),
  true
WHERE EXISTS (SELECT 1 FROM public.profiles)
ON CONFLICT (id) DO NOTHING;

-- ---- 2. Add column (nullable) with the transition DEFAULT ----
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS club_id uuid
    REFERENCES public.clubs(id) ON DELETE RESTRICT
    DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;

-- ---- 3. Backfill any remaining NULLs, then enforce NOT NULL ----
UPDATE public.sessions
  SET club_id = '00000000-0000-0000-0000-000000000001'::uuid
  WHERE club_id IS NULL;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.sessions WHERE club_id IS NULL) = 0 THEN
    ALTER TABLE public.sessions ALTER COLUMN club_id SET NOT NULL;
  ELSE
    RAISE EXCEPTION 'sessions.club_id backfill incomplete — NULLs remain';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sessions_club_id ON public.sessions (club_id);

COMMENT ON COLUMN public.sessions.club_id IS
  'Owning club (tenant). DEFAULT points to the Legacy club and is temporary — dropped once createSession is club-aware (MULTI_TENANT_PLAN §8).';
