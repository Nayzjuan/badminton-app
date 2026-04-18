-- ============================================================
-- push_subscriptions table
-- ============================================================
-- Stores Web Push API subscriptions so the server can deliver
-- Pocket Ping notifications to players even when the app is
-- in the background or the screen is locked.
--
-- One row per (user_id, endpoint) pair.  A single user can have
-- multiple active subscriptions (different browsers / devices).
--
-- RLS: users can only read/write their OWN rows.  The server-side
-- `sendPlayerNotification` action uses the service-role client
-- so it can read any user's subscriptions without RLS.
-- ============================================================

create table if not exists push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,

  -- Web Push subscription object fields
  endpoint    text not null,
  p256dh      text not null,   -- Public key for payload encryption
  auth_key    text not null,   -- Auth secret for payload encryption

  -- Metadata
  user_agent  text,            -- Browser/device identifier (optional, for debugging)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- Prevent duplicate registrations for the same endpoint
  unique (user_id, endpoint)
);

-- ── Indexes ──────────────────────────────────────────────────
-- Fast lookup when sending notifications to a specific user.
create index if not exists push_subscriptions_user_id_idx
  on push_subscriptions (user_id);

-- ── Row Level Security ────────────────────────────────────────
alter table push_subscriptions enable row level security;

-- Users can INSERT their own subscriptions.
create policy "push_subscriptions_insert_own"
  on push_subscriptions for insert
  to authenticated
  with check (user_id = auth.uid());

-- Users can SELECT their own subscriptions (so they can check
-- if they're already registered and avoid duplicate enrollment).
create policy "push_subscriptions_select_own"
  on push_subscriptions for select
  to authenticated
  using (user_id = auth.uid());

-- Users can DELETE their own subscriptions (unsubscribe).
create policy "push_subscriptions_delete_own"
  on push_subscriptions for delete
  to authenticated
  using (user_id = auth.uid());

-- Users can UPDATE their own subscriptions (refresh expired sub).
create policy "push_subscriptions_update_own"
  on push_subscriptions for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ── updated_at trigger ────────────────────────────────────────
create or replace function touch_push_subscription_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger push_subscriptions_updated_at
  before update on push_subscriptions
  for each row execute function touch_push_subscription_updated_at();
