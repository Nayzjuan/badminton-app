-- ============================================================
-- Scope the session-events broadcast channel to session members
-- ============================================================
-- Tenancy audit 2026-07-21, finding #7. `session-events:{sessionId}` is a
-- PUBLIC Realtime Broadcast topic. Public topics skip authorization entirely:
-- Realtime never consults `realtime.messages` for them. Anyone holding the
-- (publishable, client-side) anon key and a session UUID can therefore
--
--   • RECEIVE every organizer event for a session in a club they do not
--     belong to — including `organizer_intervention.actorName` and
--     `cap_saturation.anchorPlayerName`, which are real member display names;
--   • SEND on the same topic. This is the worse half and was not in the
--     original finding: `channel.send({type:'broadcast', event:'session_closed'})`
--     from any browser console redirects every player in that session to their
--     Wrapped page. `auto_publish_toggled` and `draft_cap_phase` are equally
--     forgeable — 'clearing' locks every organizer's screen behind the overlay
--     until a 'done' arrives.
--
-- The fix is Realtime Authorization: the client joins with `private: true`,
-- the server marks each emitted message private, and this policy decides who
-- may join. There is no INSERT policy here, deliberately — every legitimate
-- emit comes from the server over the REST endpoint with the service-role key,
-- which bypasses RLS. With no INSERT policy no browser can send at all, which
-- is what closes the forgery half.
--
-- ── ORDER OF OPERATIONS (load-bearing) ──────────────────────
-- `realtime.messages` ships with RLS ENABLED and ZERO policies, so it is
-- deny-all until this migration lands. Flipping the client to `private: true`
-- before it is applied does not degrade — it fails closed, and every client
-- gets CHANNEL_ERROR instead of session events. THIS MIGRATION MUST BE APPLIED
-- BEFORE THE CODE THAT ACCOMPANIES IT DEPLOYS. Applying it early is harmless:
-- until the deploy, the topic is still public and the policy is never consulted.
--
-- Deploy caveat, stated so it is not discovered live: a browser tab loaded
-- from the OLD bundle holds a public channel while the NEW server marks its
-- messages private, and private messages are not delivered to public
-- subscribers. Those tabs stop receiving session events until they reload.
-- Deploy between sessions, not during one.
--
-- ── WHY THIS PREDICATE CANNOT LOCK ANYONE OUT ───────────────
-- The gate is `session_access_level(<topic session id>) IS NOT NULL` — the
-- exact predicate already carried by `courts_select` and `queue_select`:
--
--     courts_select :: (session_access_level(session_id) IS NOT NULL)
--     queue_select  :: (session_access_level(session_id) IS NOT NULL)
--
-- So the receiving set is unchanged from the set that can already read the
-- board. Anyone this policy denies sees an empty court list and an empty queue
-- today; there is no user who currently works and stops working.
--
-- It is deliberately NOT `= 'organizer'`. `session-events` is a shared topic:
-- src/components/player/player-dashboard.tsx subscribes ordinary players to it
-- (organizer_intervention drives their "your match was cancelled" toast).
-- Gating on 'organizer' would silently break every player-side toast.
--
-- ── REMAINING GAP (project setting, not SQL) ────────────────
-- Supabase enforces private channels per-channel. To stop a hand-rolled client
-- from opening this topic as a PUBLIC channel, 'Allow public access' must also
-- be turned off in the project's Realtime settings. That is a dashboard toggle
-- with a project-wide blast radius — every other channel in this app
-- (postgres_changes on courts/matches/queue_entries/profiles) is public today
-- and would need `private: true` plus its own policy first. It is tracked
-- separately; marking the messages private already stops delivery to public
-- subscribers, which is what removes the passive eavesdropping path.
-- ============================================================

-- ── Topic → session id, total and non-throwing ──────────────
-- Postgres does not guarantee short-circuit evaluation of AND, so a bare
-- `substring(topic)::uuid` guarded by a preceding LIKE can still be evaluated
-- against a malformed topic and raise 22P02 — inside a policy that is a failed
-- channel join with an opaque error. This returns NULL for anything that is
-- not exactly `session-events:<uuid>`, and NULL feeds session_access_level(),
-- which returns NULL for a session that does not exist, which denies.
create or replace function public.realtime_topic_session_id(p_topic text)
returns uuid
language plpgsql
immutable
set search_path to 'pg_catalog', 'pg_temp'
as $fn$
begin
  if p_topic is null then
    return null;
  end if;

  if p_topic !~* '^session-events:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;

  return substring(p_topic from 16)::uuid;
exception
  when others then
    return null;
end;
$fn$;

comment on function public.realtime_topic_session_id(text) is
  'Extracts the session UUID from a `session-events:<uuid>` Realtime topic. Returns NULL for any other topic shape. Used by the realtime.messages RLS policy, which must never raise.';

-- RLS policies are evaluated as the CALLING role, so the policy on
-- realtime.messages needs this executable by anon and authenticated — the same
-- reason session_access_level() and the other five RLS helpers carry those
-- grants. service_role first, per the from-scratch replay trap documented in
-- 20260722000004: on a proacl-NULL function `revoke ... from public`
-- materialises the default ACL and strips service_role along with PUBLIC.
grant execute on function public.realtime_topic_session_id(text)
  to service_role, anon, authenticated;

-- ── The join policy ─────────────────────────────────────────
-- `to authenticated` covers every real user of this app: players sign in with
-- signInAnonymously(), which still issues a role=authenticated JWT. A caller
-- with no JWT at all is `anon`, gets NULL from auth.uid(), and would be denied
-- by session_access_level() anyway.
drop policy if exists session_events_broadcast_read on realtime.messages;

create policy session_events_broadcast_read on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and public.session_access_level(
          public.realtime_topic_session_id((select realtime.topic()))
        ) is not null
  );

-- ── Assert the end state ────────────────────────────────────
-- Same rationale as 20260722000002: a silent no-op would hand back a database
-- that looks hardened and is not. Stop the replay instead.
do $$
declare
  v_sid uuid := '11111111-2222-3333-4444-555555555555';
begin
  -- Parser: exactly one accepted shape, everything else NULL.
  if public.realtime_topic_session_id('session-events:' || v_sid::text) is distinct from v_sid then
    raise exception 'realtime_topic_session_id failed to parse a well-formed session-events topic';
  end if;

  if public.realtime_topic_session_id('session-events:not-a-uuid') is not null
     or public.realtime_topic_session_id('courts:' || v_sid::text) is not null
     or public.realtime_topic_session_id('session-events:') is not null
     or public.realtime_topic_session_id('') is not null
     or public.realtime_topic_session_id(null) is not null then
    raise exception 'realtime_topic_session_id returned non-NULL for a topic it must reject';
  end if;

  -- The policy exists, is SELECT-only, and there is still no INSERT policy —
  -- an INSERT policy would re-open client-side broadcast forgery.
  if not exists (
    select 1 from pg_policies
     where schemaname = 'realtime' and tablename = 'messages'
       and policyname = 'session_events_broadcast_read' and cmd = 'SELECT'
  ) then
    raise exception 'session_events_broadcast_read policy missing from realtime.messages';
  end if;

  if exists (
    select 1 from pg_policies
     where schemaname = 'realtime' and tablename = 'messages' and cmd = 'INSERT'
  ) then
    raise exception 'an INSERT policy on realtime.messages would let browsers forge session events';
  end if;

  -- The hard constraint this migration must not break: session_access_level is
  -- invoked by policies as anon AND as authenticated. Losing either grant takes
  -- the whole app down, and the schema-parity sweep cannot catch it because it
  -- filters provolatile = 'v' and this function is STABLE.
  if not (
    has_function_privilege('anon',          'public.session_access_level(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.session_access_level(uuid)', 'execute')
    and has_function_privilege('anon',          'public.realtime_topic_session_id(text)', 'execute')
    and has_function_privilege('authenticated', 'public.realtime_topic_session_id(text)', 'execute')
  ) then
    raise exception 'RLS helper EXECUTE grants are incomplete — the broadcast policy would fail closed';
  end if;
end $$;
