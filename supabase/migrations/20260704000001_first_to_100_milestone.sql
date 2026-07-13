-- ============================================================
-- "First to 100" milestone award
-- ============================================================
-- Century Club (century_club) fires for EVERY player who reaches
-- 100+ all-time games, every session after they cross it — it's a
-- personal milestone, not a club-wide honor. This adds a genuinely
-- one-time, club-scoped award: whoever is the FIRST player in a
-- club to ever reach 100 all-time games keeps that title forever;
-- nobody else can ever earn it in that club.
--
-- club_milestones is a tiny append-only ledger. The UNIQUE
-- (club_id, milestone) constraint is the concurrency-safety
-- mechanism: claiming the milestone is a single atomic
-- `INSERT ... ON CONFLICT DO NOTHING`, so two sessions in the same
-- club closing at nearly the same moment can never both "win" it.
--
-- Backfill: at least one player (in the live data, exactly one) has
-- already reached 100 all-time games before this feature shipped.
-- Rather than arbitrarily awarding whoever crosses next, this
-- migration reconstructs the TRUE historical first crossing per
-- club from real match history (cumulative completed-match count
-- per player, ordered by completed_at) and seeds club_milestones
-- with that result, so the right player gets credit.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.club_milestones (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id      uuid NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  milestone    text NOT NULL,
  player_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- The session in which the milestone was achieved. ON DELETE SET NULL
  -- (not CASCADE) — a session being pruned should never erase the
  -- historical fact that the milestone was earned.
  session_id   uuid REFERENCES sessions(id) ON DELETE SET NULL,
  achieved_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (club_id, milestone)
);

-- Deny-all to anon/authenticated: RLS enabled with zero policies defined,
-- so every role except service-role (which bypasses RLS entirely) is
-- denied by default. This table is written and read exclusively from
-- inside compute_session_wrapped() via the service-role client.
ALTER TABLE public.club_milestones ENABLE ROW LEVEL SECURITY;

-- ── Backfill: reconstruct the true historical "first to 100" per club ──
WITH club_matches AS (
  SELECT s.club_id, m.id AS match_id, m.completed_at, mp.player_id
  FROM matches m
  JOIN sessions s ON s.id = m.session_id
  JOIN match_players mp ON mp.match_id = m.id
  WHERE m.status = 'completed' AND m.completed_at IS NOT NULL
),
cumulative AS (
  SELECT
    club_id, player_id, match_id, completed_at,
    ROW_NUMBER() OVER (PARTITION BY club_id, player_id ORDER BY completed_at, match_id) AS game_num
  FROM club_matches
),
crossings AS (
  -- The exact match at which each player's 100th completed game (in this club) landed.
  SELECT club_id, player_id, match_id AS crossing_match_id, completed_at AS crossed_at
  FROM cumulative
  WHERE game_num = 100
),
first_per_club AS (
  -- Earliest crossing wins per club; match_id as a deterministic tiebreaker.
  SELECT DISTINCT ON (club_id) club_id, player_id, crossing_match_id, crossed_at
  FROM crossings
  ORDER BY club_id, crossed_at ASC, crossing_match_id ASC
)
INSERT INTO club_milestones (club_id, milestone, player_id, session_id, achieved_at)
SELECT fpc.club_id, 'first_to_100_games', fpc.player_id, m.session_id, fpc.crossed_at
FROM first_per_club fpc
JOIN matches m ON m.id = fpc.crossing_match_id
ON CONFLICT (club_id, milestone) DO NOTHING;

-- ── Wire the award into compute_session_wrapped() ──────────────────
-- Same technique as the deuce-magnet migration: fetch the live function
-- body and apply verified, scoped text substitutions rather than
-- retyping the ~12KB function by hand. Each substitution aborts loudly
-- if its anchor text doesn't occur exactly once, so this migration can
-- never silently no-op or corrupt the function if its shape has changed.
DO $$
DECLARE
  v_def text;
  v_search_decl text := 'v_first_match_id uuid:=NULL; v_last_match_id uuid:=NULL; v_club_id uuid:=NULL;';
  v_replace_decl text := 'v_first_match_id uuid:=NULL; v_last_match_id uuid:=NULL; v_club_id uuid:=NULL; v_milestone_holder uuid:=NULL;';
  v_search_reset text := 'v_awards:=ARRAY[]::text[]; v_award_data:=''{}''::jsonb;';
  v_replace_reset text := 'v_awards:=ARRAY[]::text[]; v_award_data:=''{}''::jsonb; v_milestone_holder:=NULL;';
  v_search_century text := 'IF v_player.alltime_games>=100 THEN v_awards:=array_append(v_awards,''century_club''::text); v_award_data:=v_award_data||jsonb_build_object(''century_club'',jsonb_build_object(''alltime_games'',v_player.alltime_games)); END IF;';
  v_replace_century text;
  v_occurrences int;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE proname = 'compute_session_wrapped' AND pronamespace = 'public'::regnamespace;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'compute_session_wrapped() not found — aborting to avoid a silent no-op.';
  END IF;

  -- Anchor 1: DECLARE section — add v_milestone_holder.
  v_occurrences := (length(v_def) - length(replace(v_def, v_search_decl, ''))) / length(v_search_decl);
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION 'DECLARE anchor not found exactly once (found %). Aborting.', v_occurrences;
  END IF;
  v_def := replace(v_def, v_search_decl, v_replace_decl);

  -- Anchor 2: per-player loop reset — clear v_milestone_holder each iteration.
  v_occurrences := (length(v_def) - length(replace(v_def, v_search_reset, ''))) / length(v_search_reset);
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION 'Loop-reset anchor not found exactly once (found %). Aborting.', v_occurrences;
  END IF;
  v_def := replace(v_def, v_search_reset, v_replace_reset);

  -- Anchor 3: insert the first_to_100 check immediately before the
  -- existing century_club check (which is preserved verbatim afterward).
  v_occurrences := (length(v_def) - length(replace(v_def, v_search_century, ''))) / length(v_search_century);
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION 'century_club anchor not found exactly once (found %). Aborting.', v_occurrences;
  END IF;

  v_replace_century :=
    'IF v_player.alltime_games>=100 AND (v_player.alltime_games-v_player.games_played)<100 THEN '
    || 'SELECT player_id INTO v_milestone_holder FROM club_milestones WHERE club_id=v_club_id AND milestone=''first_to_100_games''; '
    || 'IF v_milestone_holder IS NULL THEN '
    || 'INSERT INTO club_milestones(club_id,milestone,player_id,session_id) VALUES (v_club_id,''first_to_100_games'',v_player.player_id,p_session_id) '
    || 'ON CONFLICT (club_id,milestone) DO NOTHING RETURNING player_id INTO v_milestone_holder; '
    || 'END IF; '
    || 'IF v_milestone_holder=v_player.player_id THEN '
    || 'v_awards:=array_append(v_awards,''first_to_100''::text); '
    || 'v_award_data:=v_award_data||jsonb_build_object(''first_to_100'',jsonb_build_object(''alltime_games'',v_player.alltime_games)); '
    || 'END IF; '
    || 'END IF; '
    || v_search_century;

  v_def := replace(v_def, v_search_century, v_replace_century);

  EXECUTE v_def;
END $$;
