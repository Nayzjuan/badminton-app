-- ============================================================
-- Migration: initial_schema
-- ============================================================
-- Bootstraps the full public schema so that all subsequent
-- incremental migrations can run against a clean local DB.
--
-- This migration represents the "ground truth" schema that was
-- originally created manually in the production Supabase project
-- before the migration system was introduced.
--
-- KEY DESIGN DECISIONS:
--
-- 1. Enums are created in their CURRENT (post-all-migrations) state.
--    The remove_upper_beginner migration (20260424) is guarded with
--    an existence check so it becomes a no-op here.
--
-- 2. match_origin enum is NOT created here — that is owned by
--    migration 20260502000000_match_origin_tracking which is patched
--    to use IF NOT EXISTS guards.
--
-- 3. Tables include ALL current columns. Later ADD COLUMN IF NOT
--    EXISTS calls in incremental migrations are no-ops. The one
--    plain ADD COLUMN (origin in match_origin_tracking) is also
--    patched to be idempotent.
--
-- 4. v_match_history is created here as a stub (no origin col)
--    so the leaderboard_views migration (20260417) can reference it.
--    The match_origin_tracking migration (20260502) replaces it
--    with CREATE OR REPLACE VIEW which is idempotent.
--
-- 5. Tables added entirely by incremental migrations are NOT
--    created here (push_subscriptions, session_wrapped_stats,
--    identity_migrations, player_rivalries, player_partnerships).
--    Those migrations use CREATE TABLE IF NOT EXISTS.
-- ============================================================

-- ── 1. Enum types ─────────────────────────────────────────────

-- skill_level: upper_beginner already removed (post 20260424 state)
CREATE TYPE public.skill_level AS ENUM (
  'beginner',
  'lower_intermediate',
  'intermediate',
  'upper_intermediate',
  'lower_advanced',
  'advanced'
);

CREATE TYPE public.court_status AS ENUM (
  'available',
  'in_use',
  'closed'
);

-- queue_status: includes 'drafted' (post 20260511 state).
-- The add_drafted_queue_status migration uses ADD VALUE IF NOT EXISTS.
CREATE TYPE public.queue_status AS ENUM (
  'waiting',
  'drafted',
  'on_deck',
  'playing',
  'left'
);

CREATE TYPE public.match_status AS ENUM (
  'pending',
  'in_progress',
  'completed',
  'cancelled'
);

CREATE TYPE public.scoring_format AS ENUM (
  'single',
  'best_of_3',
  'best_of_5'
);

-- NOTE: match_origin is NOT created here.
-- It is owned by 20260502000000_match_origin_tracking.sql
-- (patched to use IF NOT EXISTS).

-- ── 2. Helper trigger functions ───────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.touch_push_subscription_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Fires after a new session is inserted; auto-creates the organizer row.
CREATE OR REPLACE FUNCTION public.handle_new_session()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO session_organizers (session_id, user_id)
  VALUES (NEW.id, NEW.created_by);
  RETURN NEW;
END;
$$;

-- Fires after a new auth.users row is inserted; creates the profile.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, skill_level)
  VALUES (
    NEW.id,
    COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data->>'display_name'), ''), 'Player'),
    COALESCE(NEW.raw_user_meta_data->>'skill_level', 'beginner')::skill_level
  )
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        skill_level  = EXCLUDED.skill_level,
        updated_at   = NOW();
  RETURN NEW;
END;
$$;

-- ── 3. Base tables ────────────────────────────────────────────

-- profiles: referenced by all other tables via FK → must come first.
-- pin, vip_tag, vip_theme included (vip columns added by 20260424100000
-- using ADD COLUMN IF NOT EXISTS, so including them here is safe).
CREATE TABLE IF NOT EXISTS public.profiles (
  id           uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text        NOT NULL,
  skill_level  public.skill_level NOT NULL DEFAULT 'beginner',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  pin          text,
  vip_tag      text,
  vip_theme    text
);

CREATE INDEX IF NOT EXISTS idx_profiles_name ON public.profiles USING btree (display_name);

CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- sessions: is_auto_matchmaking_on and court_time_limit_minutes included
-- (court_time_limit added by 20260426000000 with IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS public.sessions (
  id                        uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text            NOT NULL,
  created_by                uuid            NOT NULL REFERENCES public.profiles(id),
  organizer_passcode         text,
  scoring                   public.scoring_format NOT NULL DEFAULT 'single',
  is_active                 boolean         NOT NULL DEFAULT true,
  created_at                timestamptz     NOT NULL DEFAULT now(),
  ended_at                  timestamptz,
  is_auto_matchmaking_on    boolean         NOT NULL DEFAULT true,
  court_time_limit_minutes  integer
);

CREATE INDEX IF NOT EXISTS idx_sessions_active
  ON public.sessions USING btree (is_active) WHERE (is_active = true);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_active_organizer_passcode
  ON public.sessions USING btree (organizer_passcode)
  WHERE ((is_active = true) AND (organizer_passcode IS NOT NULL));

-- Trigger: auto-insert session_organizers row on new session.
-- This is the production trigger; it fires AFTER INSERT.
CREATE TRIGGER on_session_created
  AFTER INSERT ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_session();

-- session_organizers: append-only, never DELETE.
CREATE TABLE IF NOT EXISTS public.session_organizers (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid        NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_session_organizers_session
  ON public.session_organizers USING btree (session_id);
CREATE INDEX IF NOT EXISTS idx_session_organizers_user
  ON public.session_organizers USING btree (user_id);

-- courts
CREATE TABLE IF NOT EXISTS public.courts (
  id         uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid              NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  name       text              NOT NULL,
  status     public.court_status NOT NULL DEFAULT 'available',
  created_at timestamptz       NOT NULL DEFAULT now(),
  UNIQUE (session_id, name)
);

CREATE INDEX IF NOT EXISTS idx_courts_session_status
  ON public.courts USING btree (session_id, status);

-- matches: origin and is_published columns are NOT included here.
--   origin     → added by 20260502000000_match_origin_tracking (patched)
--   is_published → added by 20260502100000_draft_mode_is_published (IF NOT EXISTS, safe)
-- sort_order included (was added early in production; no local migration for it).
CREATE TABLE IF NOT EXISTS public.matches (
  id            uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid              NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  court_id      uuid              REFERENCES public.courts(id) ON DELETE SET NULL,
  status        public.match_status NOT NULL DEFAULT 'pending',
  team_a_score  integer,
  team_b_score  integer,
  created_at    timestamptz       NOT NULL DEFAULT now(),
  started_at    timestamptz,
  completed_at  timestamptz,
  is_mixed_level boolean          NOT NULL DEFAULT false,
  sort_order    integer
);

CREATE INDEX IF NOT EXISTS idx_matches_session_status
  ON public.matches USING btree (session_id, status);
CREATE INDEX IF NOT EXISTS idx_matches_court
  ON public.matches USING btree (court_id)
  WHERE (status = ANY (ARRAY['pending'::match_status, 'in_progress'::match_status]));
CREATE INDEX IF NOT EXISTS idx_matches_sort_order
  ON public.matches USING btree (session_id, status, sort_order);
CREATE INDEX IF NOT EXISTS idx_matches_status_completed
  ON public.matches USING btree (id) WHERE (status = 'completed'::match_status);

-- match_players
CREATE TABLE IF NOT EXISTS public.match_players (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id  uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  team      char(1) NOT NULL,
  UNIQUE (match_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_match_players_match
  ON public.match_players USING btree (match_id);
CREATE INDEX IF NOT EXISTS idx_match_players_player
  ON public.match_players USING btree (player_id);
CREATE INDEX IF NOT EXISTS idx_match_players_match_team
  ON public.match_players USING btree (match_id, team, player_id);

-- match_games (multi-set scoring)
CREATE TABLE IF NOT EXISTS public.match_games (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id     uuid        NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  game_number  integer     NOT NULL,
  team_a_score integer     NOT NULL,
  team_b_score integer     NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, game_number)
);

CREATE INDEX IF NOT EXISTS idx_match_games_match
  ON public.match_games USING btree (match_id);

-- queue_entries
CREATE TABLE IF NOT EXISTS public.queue_entries (
  id          uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid             NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  player_id   uuid             NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  joined_at   timestamptz      NOT NULL DEFAULT now(),
  games_played integer         NOT NULL DEFAULT 0,
  status      public.queue_status NOT NULL DEFAULT 'waiting',
  position    integer,
  created_at  timestamptz      NOT NULL DEFAULT now(),
  is_paused   boolean          NOT NULL DEFAULT false,
  UNIQUE (session_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_queue_matchmaking
  ON public.queue_entries USING btree (session_id, status, games_played, joined_at)
  WHERE (status = 'waiting'::queue_status);
CREATE INDEX IF NOT EXISTS idx_queue_wait_time
  ON public.queue_entries USING btree (session_id, joined_at)
  WHERE (status = 'waiting'::queue_status);

-- ── 4. v_match_history stub ───────────────────────────────────
-- This stub allows leaderboard_views (20260417) to compile.
-- The match_origin_tracking migration (20260502) replaces it with
-- CREATE OR REPLACE VIEW which is idempotent.
-- NOTE: no `origin` column here — that's added by 20260502000000.
CREATE OR REPLACE VIEW public.v_match_history AS
  SELECT
    mp.player_id,
    m.session_id,
    m.id                                          AS match_id,
    m.court_id,
    c.name                                        AS court_name,
    mp.team,
    m.team_a_score,
    m.team_b_score,
    m.status                                      AS match_status,
    m.completed_at,
    ( SELECT array_agg(p2.display_name)
        FROM match_players mp2
        JOIN profiles p2 ON p2.id = mp2.player_id
       WHERE mp2.match_id = m.id
         AND mp2.team = mp.team
         AND mp2.player_id <> mp.player_id)       AS teammates,
    ( SELECT array_agg(p3.display_name)
        FROM match_players mp3
        JOIN profiles p3 ON p3.id = mp3.player_id
       WHERE mp3.match_id = m.id
         AND mp3.team <> mp.team)                 AS opponents
  FROM match_players mp
  JOIN matches m  ON m.id  = mp.match_id
  LEFT JOIN courts c ON c.id = m.court_id
 WHERE m.status = 'completed'::match_status
 ORDER BY m.completed_at DESC;

-- ── 5. auth.users → profiles trigger ─────────────────────────
-- Create the trigger on auth.users so new signups automatically
-- get a profiles row. Uses the handle_new_user() function above.
-- Wrapped in a DO block so it's idempotent on repeated runs.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'auth'
      AND c.relname = 'users'
      AND t.tgname = 'on_auth_user_created'
  ) THEN
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
  END IF;
END $$;
