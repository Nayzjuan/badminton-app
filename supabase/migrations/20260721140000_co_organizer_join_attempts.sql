-- ============================================================
-- co_organizer_join_attempts — rate-limit backing for joinAsCoOrganizer
-- ============================================================
-- joinAsCoOrganizer searches ALL active sessions by organizer_passcode. Even
-- with the passcode entropy raised to ~100k combinations, an unthrottled
-- endpoint can be walked, and a hit grants full co-organizer rights to a
-- session. This table records each attempt so the action can lock out a
-- caller (by user_id and by client IP) after too many failures in a window.
--
-- Service-role only: RLS is ON with NO policies, so anon/authenticated can
-- neither read nor write it. Only the server action (service client) touches
-- it. Appended-to on every attempt; a periodic prune is unnecessary at this
-- volume but the window query only ever scans recent rows via the index.
-- ============================================================

create table if not exists public.co_organizer_join_attempts (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null,
  ip           text,
  succeeded    boolean     not null default false,
  attempted_at timestamptz not null default now()
);

comment on table public.co_organizer_join_attempts is
  'Append-only log of co-organizer passcode-join attempts, for rate limiting. Service-role only (RLS on, no policies).';

-- Window queries filter by user_id or ip AND attempted_at >= now()-interval,
-- counting only failures. A composite index on (attempted_at) plus the two
-- identifiers keeps the lookback cheap.
create index if not exists idx_cojoin_user_time
  on public.co_organizer_join_attempts (user_id, attempted_at desc);
create index if not exists idx_cojoin_ip_time
  on public.co_organizer_join_attempts (ip, attempted_at desc);

alter table public.co_organizer_join_attempts enable row level security;
-- No policies on purpose: deny-all for anon/authenticated; only the service
-- role (which bypasses RLS) reads/writes it from the server action.
