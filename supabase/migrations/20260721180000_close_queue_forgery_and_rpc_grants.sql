-- ============================================================
-- Close the two routes that forge the queue row isPlayerInSessionScope trusts
-- ============================================================
-- A re-review of the takeover-chain fix found that gate #1
-- (isPlayerInSessionScope: "the PIN/skill target must have a queue_entries row
-- for THIS session") rests on a premise prod contradicted by TWO independent
-- routes. Both are closed here; verified against prod before writing.
--
-- ROUTE 1 — join_queue(p_session_id, p_player_id) is SECURITY DEFINER, its ACL
--   carries a bare "=X/postgres" (a grant to PUBLIC), and its body inserts a
--   queue_entries row for an ARBITRARY p_player_id with no auth.uid() check and
--   no organizer check. So an actor who organizes session S — a passcode
--   co-organizer, or any club owner/admin — could POST /rest/v1/rpc/join_queue
--   {S, VICTIM} with the PUBLIC anon key to manufacture the very row the guard
--   looks for, then read that victim's PIN. Worse, it is callable
--   unauthenticated, so anyone could inject arbitrary players into any session.
--   Its only caller is the service-role client (queue.ts:309), which is
--   unaffected by a role revoke.
--
-- ROUTE 2 — the queue_update_organizer policy is
--       USING (is_session_organizer(session_id))  WITH CHECK  <absent>
--   and Postgres reuses USING as the NEW-row check when WITH CHECK is absent.
--   That expression constrains nothing about player_id, and anon/authenticated
--   hold a table-wide UPDATE grant, so an organizer could join their own
--   session legitimately and then PATCH their own row's player_id to the
--   victim's id — again manufacturing the row the guard trusts.
--   Every browser-context touch of queue_entries in src/ is a SELECT; all
--   writes go through server actions on the service client, so revoking UPDATE
--   from anon/authenticated costs no legitimate path. (A column-level revoke
--   would have been a no-op while the table-wide grant stood — the same trap
--   20260701000010 documents.)
--
-- Also closed here, same class (SECURITY DEFINER + PUBLIC EXECUTE, service-role
-- callers only):
--   * remove_player_from_queue_organizer — no authorization in the body at all;
--     an unauthenticated caller who knows a session UUID (published on the
--     public /tv/[id] page and in QR codes) could evict players, strip pending
--     match rosters and cancel matches mid-session.
--   * publish_match / publish_all_drafts — they authorize on a CALLER-SUPPLIED
--     p_user_id rather than auth.uid(): the exact authorize-on-A/operate-on-B
--     pattern this whole branch exists to remove.
--   * rejoin_queue — no callers left in src/ at all.
--   * migrate_player_identity — currently blocked by RLS (it is SECURITY
--     INVOKER and identity_migrations has no INSERT policy), but it is the
--     highest-value function in the schema and its safety should not rest on
--     an incidental margin.
-- ============================================================

revoke execute on function public.join_queue(uuid, uuid)
  from public, anon, authenticated;

revoke update on public.queue_entries from anon, authenticated;

revoke execute on function public.remove_player_from_queue_organizer(uuid, uuid)
  from public, anon, authenticated;

revoke execute on function public.publish_match(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.publish_all_drafts(uuid, uuid)
  from public, anon, authenticated;

revoke execute on function public.rejoin_queue(uuid)
  from public, anon, authenticated;

revoke execute on function public.migrate_player_identity(uuid, uuid)
  from public, anon, authenticated;

-- The attempts log is documented as service-role-only and RLS already denies
-- every row (RLS on, zero policies), but it still carried Supabase's default
-- table-wide grants. Make the grant match the stated contract.
revoke all on public.co_organizer_join_attempts from anon, authenticated;
