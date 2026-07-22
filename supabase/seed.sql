-- ============================================================
-- Local / CI seed — the bootstrap rows a fresh database needs
-- ============================================================
-- Runs on `supabase db reset` (and `supabase start`) only. Never runs against
-- production; this file is not a migration.
--
-- WHY THIS EXISTS.
-- 20260630000001_sessions_club_id.sql creates the default club, but guarded:
--
--     INSERT INTO public.clubs (id, name, slug, created_by, is_active)
--     SELECT '00000000-...-0001', 'Legacy', 'legacy', <a real profile>, true
--     WHERE EXISTS (SELECT 1 FROM public.profiles);
--
-- The guard is correct — clubs.created_by is NOT NULL REFERENCES profiles(id),
-- so it cannot run without a profile to point at. On production profiles
-- already existed, so the club was created and nobody noticed the dependency.
-- On a database built from migrations alone there are no profiles, the guard
-- skips, and the club never exists — while sessions.club_id DEFAULTs to that
-- exact id with a NOT NULL foreign key. Every session insert then dies with
-- `violates foreign key constraint "sessions_club_id_fkey"`, which is what 27
-- of the integration failures were.
--
-- The fix belongs here rather than in a migration: production already has these
-- rows, and a migration that invented an organizer profile would be writing
-- fake data into a live database.
--
-- WHY THE ZERO UUID.
-- tests/integration/helpers/truncate.ts wipes tables with
-- `.delete().neq('id', ZERO_UUID)`, so the all-zeros id is the one row that
-- survives cleanup between tests. The bootstrap profile therefore lives at that
-- id and outlives every truncation, which keeps clubs.created_by satisfiable —
-- without it, wiping profiles would be BLOCKED by that FK (no ON DELETE
-- clause), silently leaving profiles behind and poisoning later tests.
-- `clubs` itself is not in the truncate list, so the club persists too.
-- ============================================================

-- ── Bootstrap auth user ─────────────────────────────────────
-- profiles.id references auth.users(id), so the auth row comes first.
-- The handle_new_user trigger creates the matching profile from this metadata.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated',
  'bootstrap@integration.test',
  '$2a$10$PsMjTPqM8Q2vJZ0hV3nUKuKq0hDqQe0hVJ0hV3nUKuKq0hDqQe0hV',
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"Seed Bootstrap","skill_level":"intermediate"}'::jsonb,
  '', '', '', ''
)
on conflict (id) do nothing;

-- Safety net in case the trigger did not fire or did not populate the row.
insert into public.profiles (id, display_name, skill_level)
values ('00000000-0000-0000-0000-000000000000', 'Seed Bootstrap', 'intermediate')
on conflict (id) do nothing;

-- ── Default club ────────────────────────────────────────────
-- Fixed id because sessions.club_id uses it as a column DEFAULT.
insert into public.clubs (id, name, slug, created_by, is_active)
values (
  '00000000-0000-0000-0000-000000000001',
  'Legacy', 'legacy',
  '00000000-0000-0000-0000-000000000000',
  true
)
on conflict (id) do nothing;

-- ── Fail loudly if the bootstrap did not take ───────────────
-- Without this, a broken seed surfaces as 27 confusing FK errors in unrelated
-- tests instead of one clear message here.
do $$
begin
  if not exists (select 1 from public.profiles where id = '00000000-0000-0000-0000-000000000000') then
    raise exception 'seed: bootstrap profile missing';
  end if;
  if not exists (select 1 from public.clubs where id = '00000000-0000-0000-0000-000000000001') then
    raise exception 'seed: default club missing — sessions.club_id DEFAULT would dangle';
  end if;
end $$;
