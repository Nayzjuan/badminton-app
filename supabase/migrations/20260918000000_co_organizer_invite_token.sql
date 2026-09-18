-- ============================================================
-- Co-organizer invite token (QR admit, distinct from player /j/ and
-- from the spoken organizer_passcode)
-- ============================================================
-- A session UUID is already public on the player share URL. Encoding it
-- as the co-organizer admit secret would let anyone with Share Session
-- become an organizer (tenancy audit #5 class). The spoken passcode stays
-- for typed join. This column is a separate high-entropy secret:
--   • minted at createSession (and lazily for existing live rows)
--   • shown only to isSessionOrganizer
--   • redeemed on public /o/[token]
--   • invalid once the session is no longer live
--
-- Column lockdown mirrors organizer_passcode (20260701000009): revoke
-- SELECT from anon/authenticated so a browser client cannot read it.
-- Service role keeps full access.
--
-- Realtime: sessions is published with an EXPLICIT column list
-- (20260701000006). A new column is NOT replicated until added to that
-- list on purpose. Do not add this one.
--
-- GRANT SELECT on this column is deliberately omitted. Client queries
-- must not filter on it (Postgres requires SELECT on columns used in
-- WHERE — see is_hidden / 20260721101500). Lookups go through the
-- service role in redeemCoOrganizerInvite / getOrCreateCoOrganizerInvite.
-- ============================================================

alter table public.sessions
  add column if not exists co_organizer_invite_token text;

create unique index if not exists sessions_co_organizer_invite_token_uidx
  on public.sessions (co_organizer_invite_token)
  where co_organizer_invite_token is not null;

revoke select (co_organizer_invite_token) on public.sessions from authenticated, anon;

-- Atomic admit: lock the session, refuse close-in-flight / hidden / closed,
-- then idempotent session_organizers insert. Service-role only — the column
-- is not granted to anon/authenticated, and INSERT on session_organizers was
-- revoked from those roles in 20260721200000.
create or replace function public.admit_session_organizer(
  p_session_id uuid,
  p_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1
    from public.sessions
   where id = p_session_id
     and is_active = true
     and ended_at is null
     and is_hidden = false
   for update;
  if not found then
    return false;
  end if;

  insert into public.session_organizers (session_id, user_id)
  values (p_session_id, p_user_id)
  on conflict (session_id, user_id) do nothing;

  return true;
end;
$$;

grant execute on function public.admit_session_organizer(uuid, uuid) to service_role;
revoke execute on function public.admit_session_organizer(uuid, uuid) from public, anon, authenticated;
