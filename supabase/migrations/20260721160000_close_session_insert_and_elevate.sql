-- ============================================================
-- Close the two DB-layer bypasses of the createSession / co-organizer fixes
-- ============================================================
-- Hardening createSession + joinAsCoOrganizer in the server-action layer was
-- necessary but NOT sufficient: both privileges were still reachable one layer
-- down, straight from the browser via PostgREST. An adversarial review of that
-- change found both; verified against prod before writing this.
--
-- (1) DIRECT SESSION INSERT.  anon/authenticated hold Supabase's default
--     table-wide INSERT on public.sessions, and the only INSERT policy is
--         sessions_insert  WITH CHECK (created_by = (select auth.uid()))
--     — no club condition — while sessions.club_id DEFAULTs to CHILLAX and the
--     AFTER INSERT trigger on_session_created -> handle_new_session() writes a
--     session_organizers row for created_by. So any authenticated user
--     (signInAnonymously is a live path) could POST /rest/v1/sessions and mint
--     themselves a real organizer session in the founding club, bypassing
--     createSession's new club-admin gate entirely.
--
--     Fix: revoke the INSERT grant. No client code inserts sessions — the only
--     writer is createSession, which uses the service-role client and is
--     therefore unaffected. This is preferred over tightening the policy
--     because there is no SQL-side is_club_admin() to call from a WITH CHECK.
--
-- (2) elevate_to_organizer(uuid, text).  A SECURITY DEFINER RPC that does the
--     same thing joinAsCoOrganizer does — exact passcode match then INSERT INTO
--     session_organizers — with no attempt logging and no lockout, so it walks
--     straight around the new rate limiter. Its ACL is
--         {=X/postgres, postgres=X/postgres, anon=X/postgres, authenticated=X/...}
--     and that leading bare "=X" is a grant to PUBLIC, so revoking only
--     anon+authenticated would NOT close it.
--
--     It has no callers left in src/ (only a dead Database["Functions"] entry
--     and a stale comment). The integration suite calls it as superuser over a
--     raw pg connection, which a role revoke does not affect.
-- ============================================================

revoke insert on public.sessions from anon, authenticated;

revoke execute on function public.elevate_to_organizer(uuid, text)
  from public, anon, authenticated;

-- ── Atomic, fail-closed rate limiting for joinAsCoOrganizer ──
-- The first cut of the limiter read a count and then inserted the attempt in a
-- separate round trip: concurrent serverless invocations could all observe a
-- sub-threshold count and pass together, and a failed insert was swallowed,
-- silently disabling the limiter (fail-OPEN). This does the insert and the
-- count in ONE transaction and returns the verdict, so the caller can deny on
-- any error instead.
--
-- The attempt is recorded PESSIMISTICALLY as a failure; the caller flips
-- succeeded=true only after a passcode actually matches and the join lands, so
-- a legitimate join does not accumulate against the window.
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
  insert into public.co_organizer_join_attempts (user_id, ip, succeeded)
  values (p_user_id, p_ip, false)
  returning id into v_id;

  select count(*) into v_user_fails
    from public.co_organizer_join_attempts a
   where a.user_id = p_user_id
     and a.succeeded = false
     and a.attempted_at >= v_since;

  if p_ip is not null then
    select count(*) into v_ip_fails
      from public.co_organizer_join_attempts a
     where a.ip = p_ip
       and a.succeeded = false
       and a.attempted_at >= v_since;
  end if;

  -- Counts INCLUDE the row just inserted, hence ">" not ">=".
  return query select v_id, (v_user_fails > p_user_max), (v_ip_fails > p_ip_max);
end;
$function$;

-- Service-role only: the server action is the only legitimate caller, and a
-- browser-callable limiter would let an attacker burn someone else's budget.
revoke execute on function
  public.cojoin_record_and_check(uuid, text, int, int, int)
  from public, anon, authenticated;
