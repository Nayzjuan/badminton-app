-- ============================================================
-- READ-ONLY diagnose — Stelle PIN reconnect 23503 / 23505
-- ============================================================
-- ⚠ DO NOT treat this as the fix. Stelle's PIN already matches; migrate
--   then dies. Apply 20261105000000_migrate_identity_reconnect_fkeys.sql
--   on usxftpexoimletqmrggb, then retry PIN reconnect.
--
-- This query only shows why her row would 23503 (no-CASCADE FKs) or
-- 23505 (leftover organizer tombstone from the 2026-08-16 migrate).
-- ============================================================

SELECT
  p.id,
  p.display_name,
  p.needs_rename,
  p.needs_name_confirm,
  p.updated_at,
  exists(SELECT 1 FROM identity_migrations m WHERE m.old_id = p.id) AS is_migration_old,
  exists(SELECT 1 FROM identity_migrations m WHERE m.new_id = p.id) AS is_migration_new,
  (SELECT count(*) FROM club_members cm WHERE cm.player_id = p.id) AS memberships,
  (SELECT count(*) FROM club_members cm WHERE cm.invited_by = p.id) AS invited_by,
  (SELECT count(*) FROM clubs c WHERE c.created_by = p.id) AS clubs_created,
  (SELECT count(*) FROM club_invites i WHERE i.created_by = p.id) AS invites_created,
  (SELECT count(*) FROM club_invites i WHERE i.consumed_by = p.id) AS invites_consumed,
  (SELECT count(*) FROM sessions s WHERE s.created_by = p.id AND s.is_active) AS active_sessions_hosted
FROM public.profiles p
WHERE lower(btrim(regexp_replace(p.display_name, E'[ \t]+', ' ', 'g'))) = 'stelle'
ORDER BY p.updated_at DESC;
