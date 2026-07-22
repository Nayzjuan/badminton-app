-- ============================================================
-- Extend the attempt limiter to cover the reconnect PIN oracle
-- ============================================================
-- The co-organizer passcode join got an atomic, fail-closed rate limiter
-- (20260721140000 / 20260721160000) to defend a 100,000-value space. Meanwhile
-- reconnectPlayer — which needs NO organizer rights at all — is completely
-- unthrottled over a 9,000-value PIN space:
--
--     reconnectPlayer(name, pin) -> profiles ilike name AND pin = ?
--                                -> migrate_player_identity(...)
--
-- Display names are readable to any authenticated user (profiles_select is
-- USING(true)) and are printed on the public /tv and leaderboard share pages,
-- so an attacker picks a name and walks 9,000 PINs to reach exactly the account
-- takeover the earlier migrations were written to prevent. Defending the 100k
-- door while leaving the 9k door open is the wrong asymmetry.
--
-- DELIBERATELY ADDITIVE. The obvious tidy-up — rename the table, replace
-- cojoin_record_and_check with one generic function — would drop objects that
-- the CURRENTLY DEPLOYED joinAsCoOrganizer calls, breaking co-organizer join
-- in the window before the next deploy. That is precisely the mistake
-- 20260721190000 documents (revoking a grant out from under live code took
-- Leave Session down). So: existing table and function are left untouched and
-- keep working; the new scope is added alongside.
-- ============================================================

-- 'cojoin' rows keep using user_id (the caller is authenticated).
-- 'reconnect' rows have no user — the caller is anonymous and can mint
-- identities freely — so they key on `subject`, the normalized display_name
-- BEING ATTACKED. Both scopes also key on IP.
alter table public.co_organizer_join_attempts
  add column if not exists scope   text not null default 'cojoin',
  add column if not exists subject text;

alter table public.co_organizer_join_attempts
  alter column user_id drop not null;

comment on table public.co_organizer_join_attempts is
  'Append-only log of credential-guessing attempts, for rate limiting. scope=''cojoin'' keys on user_id; scope=''reconnect'' keys on subject (normalized display_name). Service-role only: RLS on with no policies AND no grants.';

create index if not exists idx_cojoin_scope_subject_time
  on public.co_organizer_join_attempts (scope, subject, attempted_at desc);

-- ── Atomic, fail-closed check for the reconnect scope ────────
-- Same contract as cojoin_record_and_check: insert + count in ONE transaction
-- so concurrent invocations cannot all pass a sub-threshold read, and the
-- caller can DENY on any error rather than failing open. The attempt is
-- recorded PESSIMISTICALLY as a failure and flipped only once the PIN verifies,
-- so a legitimate reconnect does not consume the window.
create or replace function public.reconnect_record_and_check(
  p_subject     text,
  p_ip          text,
  p_window_min  int,
  p_subject_max int,
  p_ip_max      int
)
returns table (attempt_id uuid, over_subject_limit boolean, over_ip_limit boolean)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id            uuid;
  v_subject_fails bigint;
  v_ip_fails      bigint := 0;
  v_since         timestamptz := now() - make_interval(mins => p_window_min);
begin
  insert into public.co_organizer_join_attempts (scope, subject, ip, succeeded)
  values ('reconnect', p_subject, p_ip, false)
  returning id into v_id;

  select count(*) into v_subject_fails
    from public.co_organizer_join_attempts a
   where a.scope = 'reconnect'
     and a.subject = p_subject
     and a.succeeded = false
     and a.attempted_at >= v_since;

  if p_ip is not null then
    select count(*) into v_ip_fails
      from public.co_organizer_join_attempts a
     where a.scope = 'reconnect'
       and a.ip = p_ip
       and a.succeeded = false
       and a.attempted_at >= v_since;
  end if;

  -- Counts INCLUDE the row just inserted, hence ">" not ">=".
  return query select v_id, (v_subject_fails > p_subject_max), (v_ip_fails > p_ip_max);
end;
$function$;

-- Service-role only. A browser-callable limiter would let an attacker burn a
-- named victim's budget and lock them out of their own reconnect.
revoke execute on function
  public.reconnect_record_and_check(text, text, int, int, int)
  from public, anon, authenticated;

-- Flipping an attempt to succeeded, service-role only. reconnectPlayer runs
-- before the caller has any identity, so it cannot use a table UPDATE under
-- RLS — and the table has no grants at all.
create or replace function public.auth_attempt_mark_succeeded(p_attempt_id uuid)
returns void
language sql
security definer
set search_path to 'public', 'pg_temp'
as $function$
  update public.co_organizer_join_attempts set succeeded = true where id = p_attempt_id;
$function$;

revoke execute on function public.auth_attempt_mark_succeeded(uuid)
  from public, anon, authenticated;
