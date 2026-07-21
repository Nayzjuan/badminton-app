-- ============================================================
-- Revoke direct INSERT on session_organizers + one more ungated RPC
-- ============================================================
-- session_organizers_insert is WITH CHECK (is_session_organizer(session_id)) —
-- it constrains the SESSION but says nothing about the NEW row's user_id. With
-- the default table-wide INSERT grant, any organizer of S could POST
--     { session_id: S, user_id: <anyone> }
-- and permanently install a third party as co-organizer. It is not a way IN
-- (you must already organize S), but it turns a transient co-organizer
-- compromise — e.g. a guessed passcode — into durable persistence that survives
-- rotating the passcode. Same "authorize on A, operate on B" shape this branch
-- exists to remove.
--
-- Safe to revoke: the ONLY session_organizers INSERT in src/ is
-- joinAsCoOrganizer (sessions.ts), which uses the service client. The
-- handle_new_session trigger also inserts here, but trigger functions run as
-- their SECURITY DEFINER owner, so a role revoke does not affect them.
--
-- checkout_player_cleanup_drafts is the same shape as
-- remove_player_from_queue_organizer (already revoked in 20260721180000):
-- SECURITY DEFINER, caller-supplied session + player ids, zero authorization in
-- the body, and it deletes match_players rows / cancels drafts. It was still
-- PUBLIC-executable. Its only caller is queue.ts on the service client.
--
-- NOTE the lesson from 20260721190000: before revoking anything, check the
-- ROLE the calling code actually uses. "It's in a server action" does NOT mean
-- "it uses the service client" — checkoutPlayer was a server action writing on
-- the user-context client, and revoking its grant took Leave Session down.
-- Both revokes below were verified caller-by-caller first.
-- ============================================================

revoke insert on public.session_organizers from anon, authenticated;

revoke execute on function public.checkout_player_cleanup_drafts(uuid, uuid)
  from public, anon, authenticated;
