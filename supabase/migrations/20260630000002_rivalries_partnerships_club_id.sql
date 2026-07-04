-- ============================================================
-- Multi-Tenant Phase 0 — Migration 3: club_id on the rivalry/partnership ledgers
-- ============================================================
-- ATOMIC unit (MULTI_TENANT_PLAN.md §6.6 / correction C4): the PRIMARY KEY swap
-- and the refresh_cross_session_stats body MUST change together. If the key
-- changes but the RPC keeps ON CONFLICT (player_id, rival_id), the next
-- closeSession() throws "no unique or exclusion constraint matching the
-- ON CONFLICT specification". Both live in this single migration.
--
-- Note: (player_id, rival_id) / (player_id, partner_id) are PRIMARY KEYs
-- (correction C5), not secondary unique constraints. No inbound FKs reference
-- them, so they can be dropped and re-added.
--
-- Steps: add club_id (nullable) -> backfill to Legacy -> SET NOT NULL ->
--        swap PK to (club_id, ...) -> CREATE OR REPLACE refresh_cross_session_stats.
--
-- Idempotent. BUILD ONLY — not applied to production yet.
-- ============================================================

-- ---- 1+2 — add club_id, backfill to Legacy club ----
ALTER TABLE public.player_rivalries
  ADD COLUMN IF NOT EXISTS club_id uuid REFERENCES public.clubs(id) ON DELETE CASCADE;
UPDATE public.player_rivalries
  SET club_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE club_id IS NULL;

ALTER TABLE public.player_partnerships
  ADD COLUMN IF NOT EXISTS club_id uuid REFERENCES public.clubs(id) ON DELETE CASCADE;
UPDATE public.player_partnerships
  SET club_id = '00000000-0000-0000-0000-000000000001'::uuid WHERE club_id IS NULL;

-- ---- 3 — verify backfill, then SET NOT NULL ----
DO $$
BEGIN
  IF (SELECT count(*) FROM public.player_rivalries    WHERE club_id IS NULL) > 0
   OR (SELECT count(*) FROM public.player_partnerships WHERE club_id IS NULL) > 0 THEN
    RAISE EXCEPTION 'rivalry/partnership club_id backfill incomplete — NULLs remain';
  END IF;
  ALTER TABLE public.player_rivalries    ALTER COLUMN club_id SET NOT NULL;
  ALTER TABLE public.player_partnerships ALTER COLUMN club_id SET NOT NULL;
END $$;

-- ---- 4 — PRIMARY KEY swap (constant club_id keeps existing rows unique) ----
ALTER TABLE public.player_rivalries    DROP CONSTRAINT player_rivalries_pkey;
ALTER TABLE public.player_rivalries
  ADD CONSTRAINT player_rivalries_pkey PRIMARY KEY (club_id, player_id, rival_id);

ALTER TABLE public.player_partnerships DROP CONSTRAINT player_partnerships_pkey;
ALTER TABLE public.player_partnerships
  ADD CONSTRAINT player_partnerships_pkey PRIMARY KEY (club_id, player_id, partner_id);

CREATE INDEX IF NOT EXISTS idx_player_rivalries_club_id    ON public.player_rivalries (club_id);
CREATE INDEX IF NOT EXISTS idx_player_partnerships_club_id ON public.player_partnerships (club_id);

-- ---- 5 — refresh_cross_session_stats, club_id threaded ----
-- Resolves the session's club once, stamps it on every upserted ledger row,
-- and includes club_id in both ON CONFLICT targets so the new PK matches.
-- Behavior is otherwise identical to the pre-multi-tenant version.
CREATE OR REPLACE FUNCTION public.refresh_cross_session_stats(p_session_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_club_id uuid;
BEGIN
  -- Resolve the owning club for this session (NOT NULL post-migration).
  SELECT club_id INTO v_club_id FROM public.sessions WHERE id = p_session_id;
  IF v_club_id IS NULL THEN
    RETURN;  -- session missing or not club-scoped; nothing to accumulate
  END IF;

  -- Idempotency guard: this session was already rolled up.
  IF EXISTS (
    SELECT 1 FROM player_rivalries   WHERE last_session_id = p_session_id LIMIT 1
  ) OR EXISTS (
    SELECT 1 FROM player_partnerships WHERE last_session_id = p_session_id LIMIT 1
  ) THEN
    RETURN;
  END IF;

  WITH completed AS (
    SELECT
      m.id AS match_id, mp.player_id, mp.team,
      CASE
        WHEN mp.team = 'a' AND m.team_a_score > m.team_b_score THEN true
        WHEN mp.team = 'b' AND m.team_b_score > m.team_a_score THEN true
        ELSE false
      END AS won,
      m.completed_at
    FROM matches m
    JOIN match_players mp ON mp.match_id = m.id
    WHERE m.session_id = p_session_id AND m.status = 'completed'
      AND m.team_a_score IS NOT NULL AND m.team_b_score IS NOT NULL
  ),
  rivalry_deltas AS (
    SELECT
      p.player_id,
      opp.player_id                                    AS rival_id,
      SUM(CASE WHEN p.won     THEN 1 ELSE 0 END)::int  AS wins_vs,
      SUM(CASE WHEN NOT p.won THEN 1 ELSE 0 END)::int  AS losses_vs,
      MAX(p.completed_at)                              AS last_faced_at
    FROM completed p
    JOIN match_players opp ON opp.match_id = p.match_id AND opp.team != p.team
    GROUP BY p.player_id, opp.player_id
  )
  INSERT INTO player_rivalries (
    club_id, player_id, rival_id, wins_vs, losses_vs,
    sessions_faced, last_session_id, last_faced_at, updated_at
  )
  SELECT v_club_id, player_id, rival_id, wins_vs, losses_vs, 1, p_session_id, last_faced_at, now()
  FROM rivalry_deltas
  ON CONFLICT (club_id, player_id, rival_id) DO UPDATE SET
    wins_vs         = player_rivalries.wins_vs   + EXCLUDED.wins_vs,
    losses_vs       = player_rivalries.losses_vs + EXCLUDED.losses_vs,
    sessions_faced  = player_rivalries.sessions_faced +
      CASE WHEN player_rivalries.last_session_id IS DISTINCT FROM EXCLUDED.last_session_id THEN 1 ELSE 0 END,
    last_session_id = EXCLUDED.last_session_id,
    last_faced_at   = GREATEST(player_rivalries.last_faced_at, EXCLUDED.last_faced_at),
    updated_at      = now();

  WITH completed AS (
    SELECT
      m.id AS match_id, mp.player_id, mp.team,
      CASE
        WHEN mp.team = 'a' AND m.team_a_score > m.team_b_score THEN true
        WHEN mp.team = 'b' AND m.team_b_score > m.team_a_score THEN true
        ELSE false
      END AS won,
      m.completed_at
    FROM matches m
    JOIN match_players mp ON mp.match_id = m.id
    WHERE m.session_id = p_session_id AND m.status = 'completed'
      AND m.team_a_score IS NOT NULL AND m.team_b_score IS NOT NULL
  ),
  partnership_deltas AS (
    SELECT
      p.player_id,
      partner.player_id                                AS partner_id,
      COUNT(*)::int                                    AS games_together,
      SUM(CASE WHEN p.won     THEN 1 ELSE 0 END)::int  AS wins_together,
      SUM(CASE WHEN NOT p.won THEN 1 ELSE 0 END)::int  AS losses_together,
      MAX(p.completed_at)                              AS last_played_at
    FROM completed p
    JOIN match_players partner ON partner.match_id   = p.match_id
                              AND partner.team        = p.team
                              AND partner.player_id  != p.player_id
    GROUP BY p.player_id, partner.player_id
  )
  INSERT INTO player_partnerships (
    club_id, player_id, partner_id,
    games_together, wins_together, losses_together,
    sessions_together, last_session_id, last_played_at, updated_at
  )
  SELECT
    v_club_id, player_id, partner_id, games_together, wins_together, losses_together,
    1, p_session_id, last_played_at, now()
  FROM partnership_deltas
  ON CONFLICT (club_id, player_id, partner_id) DO UPDATE SET
    games_together    = player_partnerships.games_together  + EXCLUDED.games_together,
    wins_together     = player_partnerships.wins_together   + EXCLUDED.wins_together,
    losses_together   = player_partnerships.losses_together + EXCLUDED.losses_together,
    sessions_together = player_partnerships.sessions_together +
      CASE WHEN player_partnerships.last_session_id IS DISTINCT FROM EXCLUDED.last_session_id THEN 1 ELSE 0 END,
    last_session_id   = EXCLUDED.last_session_id,
    last_played_at    = GREATEST(player_partnerships.last_played_at, EXCLUDED.last_played_at),
    updated_at        = now();

END;
$function$;
