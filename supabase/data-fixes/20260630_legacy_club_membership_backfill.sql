-- ============================================================
-- Data fix: Legacy club membership backfill (2026-06-30)
-- ============================================================
-- Multi-tenant Phase 2 prerequisite. After Phase 0, all pre-existing sessions
-- were absorbed into the Legacy club (slug='legacy'), but the existing ~150
-- players have NO club_members row there. Once club routes are membership-gated
-- and old paths redirect into them, every existing player would be bounced to
-- /clubs — locked out of their own sessions.
--
-- This enrolls everyone who participated in a Legacy session:
--   • owner  — the Legacy club's creator (clubs.created_by)
--   • admin  — anyone who created a Legacy session OR is a session_organizer
--   • member — anyone who queued or played in a Legacy session
--
-- Idempotent (ON CONFLICT). Role precedence owner > admin > member is enforced
-- by step order + ON CONFLICT DO NOTHING (later, lower-rank steps never
-- downgrade an already-assigned higher role). Hand-applied once on prod.
-- ============================================================

-- 1) Owner — the Legacy club's creator.
INSERT INTO public.club_members (club_id, player_id, role)
SELECT c.id, c.created_by, 'owner'
FROM public.clubs c
WHERE c.slug = 'legacy'
  AND c.created_by IN (SELECT id FROM public.profiles)
ON CONFLICT (club_id, player_id) DO UPDATE SET role = 'owner', is_active = true;

-- 2) Admins — Legacy session creators + session_organizers.
WITH legacy AS (SELECT id AS club_id FROM public.clubs WHERE slug = 'legacy'),
organizers AS (
  SELECT DISTINCT s.created_by AS player_id
  FROM public.sessions s, legacy l
  WHERE s.club_id = l.club_id
  UNION
  SELECT DISTINCT so.user_id
  FROM public.session_organizers so
    JOIN public.sessions s ON s.id = so.session_id, legacy l
  WHERE s.club_id = l.club_id
)
INSERT INTO public.club_members (club_id, player_id, role)
SELECT (SELECT club_id FROM legacy), o.player_id, 'admin'
FROM organizers o
WHERE o.player_id IN (SELECT id FROM public.profiles)
ON CONFLICT (club_id, player_id) DO NOTHING; -- never downgrade the owner

-- 3) Members — anyone who queued or played in a Legacy session.
WITH legacy AS (SELECT id AS club_id FROM public.clubs WHERE slug = 'legacy'),
participants AS (
  SELECT DISTINCT qe.player_id
  FROM public.queue_entries qe
    JOIN public.sessions s ON s.id = qe.session_id, legacy l
  WHERE s.club_id = l.club_id
  UNION
  SELECT DISTINCT mp.player_id
  FROM public.match_players mp
    JOIN public.matches m ON m.id = mp.match_id
    JOIN public.sessions s ON s.id = m.session_id, legacy l
  WHERE s.club_id = l.club_id
)
INSERT INTO public.club_members (club_id, player_id, role)
SELECT (SELECT club_id FROM legacy), p.player_id, 'member'
FROM participants p
WHERE p.player_id IN (SELECT id FROM public.profiles)
ON CONFLICT (club_id, player_id) DO NOTHING; -- never downgrade owner/admin
