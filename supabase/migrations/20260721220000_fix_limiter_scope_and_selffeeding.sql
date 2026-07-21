-- ============================================================
-- Limiter fixes: scope the counters, and stop the window self-feeding
-- ============================================================
-- Three defects found reviewing 20260721210000, two of them live in prod.
--
-- (1) CROSS-SCOPE CONTAMINATION (live). cojoin_record_and_check's IP arm counted
--     EVERY failed row for an IP with no scope predicate, while
--     reconnect_record_and_check correctly filtered scope='reconnect'. So the
--     contamination ran one way: failed reconnects burned the co-organizer IP
--     budget. ~70 anonymous reconnect attempts in 15 minutes would lock
--     co-organizer join for an entire single-NAT venue. Fixed by adding the
--     scope predicate to both counters and writing scope explicitly on insert.
--     CREATE OR REPLACE keeps the signature and return shape identical, so the
--     currently-deployed joinAsCoOrganizer keeps working through the replace.
--
-- (2) SELF-FEEDING LOCKOUT. Both functions INSERTed unconditionally and then
--     counted, so a REJECTED attempt still added a failure row. The window
--     therefore never drained while an attacker kept poking. For the reconnect
--     scope that is an account-denial primitive against a NAMED victim —
--     display names are printed on the public /tv and leaderboard pages, and
--     for an anonymous-auth account name+PIN reconnect IS the account, with no
--     email reset behind it. ~11 requests then one per minute would lock a
--     chosen player out of their own account indefinitely.
--     Fixed: count FIRST, and when already over the limit return the verdict
--     WITHOUT recording anything. The window now drains 15 minutes after the
--     last attempt that actually reached the credential check.
--
-- (3) HORIZONTAL SPRAY. A per-name budget does nothing against "fix one PIN,
--     try every name" — names are enumerable from the public board, so each
--     name costs exactly one attempt. reconnect_record_and_check gains a third,
--     scope-wide velocity ceiling counted in the same transaction. (The real
--     root cause is 4-digit PIN entropy; this bounds exploitation of it.)
-- ============================================================

-- ── cojoin: add the scope predicate + stop self-feeding ──────
-- Signature and return shape unchanged on purpose (deployed code calls this).
create or replace function public.cojoin_record_and_check(
  p_user_id    uuid,
  p_ip         text,
  p_window_min int,
  p_user_max   int,
  p_ip_max     int
)
returns table (attempt_id uuid, over_user_limit boolean, over_ip_limit boolean)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id         uuid;
  v_user_fails bigint;
  v_ip_fails   bigint := 0;
  v_since      timestamptz := now() - make_interval(mins => p_window_min);
begin
  select count(*) into v_user_fails
    from public.co_organizer_join_attempts a
   where a.scope = 'cojoin'
     and a.user_id = p_user_id
     and a.succeeded = false
     and a.attempted_at >= v_since;

  if p_ip is not null then
    select count(*) into v_ip_fails
      from public.co_organizer_join_attempts a
     where a.scope = 'cojoin'
       and a.ip = p_ip
       and a.succeeded = false
       and a.attempted_at >= v_since;
  end if;

  -- Already over: deny WITHOUT recording, so the window can drain.
  if v_user_fails >= p_user_max or v_ip_fails >= p_ip_max then
    return query select null::uuid, (v_user_fails >= p_user_max), (v_ip_fails >= p_ip_max);
    return;
  end if;

  insert into public.co_organizer_join_attempts (scope, user_id, ip, succeeded)
  values ('cojoin', p_user_id, p_ip, false)
  returning id into v_id;

  return query select v_id, false, false;
end;
$function$;

revoke execute on function
  public.cojoin_record_and_check(uuid, text, int, int, int)
  from public, anon, authenticated;

-- ── reconnect: scope predicate, no self-feeding, + global ceiling ──
-- Signature CHANGES (adds p_global_max). Safe: no deployed build calls this
-- yet — it ships in the same PR as its only caller.
drop function if exists public.reconnect_record_and_check(text, text, int, int, int);

create or replace function public.reconnect_record_and_check(
  p_subject     text,
  p_ip          text,
  p_window_min  int,
  p_subject_max int,
  p_ip_max      int,
  p_global_max  int
)
returns table (
  attempt_id         uuid,
  over_subject_limit boolean,
  over_ip_limit      boolean,
  over_global_limit  boolean
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id            uuid;
  v_subject_fails bigint;
  v_ip_fails      bigint := 0;
  v_global_fails  bigint;
  v_since         timestamptz := now() - make_interval(mins => p_window_min);
begin
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

  -- Scope-wide ceiling: catches horizontal spraying (one PIN, every name),
  -- which neither the per-name nor the per-IP arm constrains.
  select count(*) into v_global_fails
    from public.co_organizer_join_attempts a
   where a.scope = 'reconnect'
     and a.succeeded = false
     and a.attempted_at >= v_since;

  if v_subject_fails >= p_subject_max
     or v_ip_fails >= p_ip_max
     or v_global_fails >= p_global_max then
    return query select null::uuid,
                        (v_subject_fails >= p_subject_max),
                        (v_ip_fails >= p_ip_max),
                        (v_global_fails >= p_global_max);
    return;
  end if;

  insert into public.co_organizer_join_attempts (scope, subject, ip, succeeded)
  values ('reconnect', p_subject, p_ip, false)
  returning id into v_id;

  return query select v_id, false, false, false;
end;
$function$;

revoke execute on function
  public.reconnect_record_and_check(text, text, int, int, int, int)
  from public, anon, authenticated;
