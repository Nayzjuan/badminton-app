-- ============================================================
-- Demote the scope-wide spray arm from a denial to an alert
-- ============================================================
-- 20260721220000 added `p_global_max` as a HARD scope-wide denial: once 300
-- failed reconnects were logged in the window, reconnect_record_and_check
-- returned over_global_limit to EVERY caller. Review of that migration showed
-- it is a cheap unauthenticated denial-of-service on login itself:
--
--   * 300 failures / 15 min is 0.33 rps.
--   * The per-name arm (10) forces ≥30 distinct names — enumerable from the
--     public /tv and leaderboard pages, as 220000's own header points out.
--   * The per-IP arm (60) forces ≥5 source IPs.
--   * It holds indefinitely: blocked attempts are no longer recorded, so rows
--     age out one at a time and the attacker simply re-fills the gap.
--
-- For an anonymous-auth player reconnect IS the account — there is no email
-- reset behind it — so that denies login to the entire user base. It also
-- contradicts the reasoning already documented on RECONNECT_MAX_FAILED_IP,
-- where the IP budget was deliberately loosened to 60 because a tight cap
-- "would let one person lock out reconnect for the whole venue". A global cap
-- lets one person lock out reconnect for the whole platform.
--
-- Distributed spray is a real risk, but a shared counter is the wrong instrument
-- for it: the cost of a false positive is total, and an attacker chooses when to
-- trigger it. So the count stays — it is a genuinely useful detection signal —
-- but it is now ADVISORY. The caller logs it and proceeds. Denial remains keyed
-- on the two arms whose blast radius is bounded: the name being attacked, and
-- the source IP. That leaves distributed spray bounded at 60 failures per IP,
-- which is exactly the risk this branch already accepted before the global arm
-- was added — no worse than the reviewed baseline, and without the kill switch.
-- ============================================================

-- Return type changes, so replace rather than CREATE OR REPLACE. Safe: the only
-- caller ships in this same unmerged branch (main has no limiter on reconnect).
drop function if exists public.reconnect_record_and_check(text, text, int, int, int, int);

create or replace function public.reconnect_record_and_check(
  p_subject        text,
  p_ip             text,
  p_window_min     int,
  p_subject_max    int,
  p_ip_max         int,
  -- Advisory only. Crossing it sets spray_suspected; it NEVER denies.
  p_spray_alert_at int
)
returns table (
  attempt_id         uuid,
  over_subject_limit boolean,
  over_ip_limit      boolean,
  spray_suspected    boolean
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id            uuid;
  v_subject_fails bigint;
  v_ip_fails      bigint := 0;
  v_scope_fails   bigint;
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

  -- Detection signal for horizontal spraying (one PIN, every name), which
  -- neither keyed arm sees. Reported, never enforced.
  select count(*) into v_scope_fails
    from public.co_organizer_join_attempts a
   where a.scope = 'reconnect'
     and a.succeeded = false
     and a.attempted_at >= v_since;

  -- Deny only on the bounded arms. Already over: return the verdict WITHOUT
  -- recording, so the window can actually drain (see 220000).
  if v_subject_fails >= p_subject_max or v_ip_fails >= p_ip_max then
    return query select null::uuid,
                        (v_subject_fails >= p_subject_max),
                        (v_ip_fails >= p_ip_max),
                        (v_scope_fails >= p_spray_alert_at);
    return;
  end if;

  insert into public.co_organizer_join_attempts (scope, subject, ip, succeeded)
  values ('reconnect', p_subject, p_ip, false)
  returning id into v_id;

  return query select v_id, false, false, (v_scope_fails >= p_spray_alert_at);
end;
$function$;

revoke execute on function
  public.reconnect_record_and_check(text, text, int, int, int, int)
  from public, anon, authenticated;

-- The scope-wide count has no usable index: idx_cojoin_scope_subject_time is
-- (scope, subject, attempted_at) and cannot serve a query that constrains
-- attempted_at with subject unbound. The table is append-only with no pruning,
-- so that scan degrades precisely under the traffic this count exists to spot.
create index if not exists idx_cojoin_reconnect_fails_time
  on public.co_organizer_join_attempts (attempted_at desc)
  where scope = 'reconnect' and succeeded = false;
