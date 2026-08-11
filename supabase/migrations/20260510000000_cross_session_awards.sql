-- ============================================================
-- Migration: Cross-session award persistence (Phase 1)
-- ============================================================
-- Creates two running-ledger tables (player_rivalries,
-- player_partnerships) and adds a carry_forward column to
-- session_wrapped_stats. Introduces refresh_cross_session_stats()
-- RPC which upserts both tables at session close, immediately
-- before compute_session_wrapped() runs.
--
-- Design notes:
--   • Both tables are DIRECTIONAL — (A,B) and (B,A) stored
--     separately for trivial per-player queries.
--   • sessions_faced / sessions_together count DISTINCT sessions,
--     not total matches. The ON CONFLICT clause only increments
--     them when last_session_id changes.
--   • carry_forward is a small JSONB payload written by
--     compute_session_wrapped at session close and read by the
--     next session's RPC for momentum/streak signals.
--   • refresh_cross_session_stats exits early if this session_id
--     is already the last_session_id on any existing row.
--     RETRACTED 2026-08-11: this comment called that "idempotent"
--     and claimed it "prevents double-counting on accidental
--     retry". Both are false. The body only ever ADDS
--     (ON CONFLICT ... SET wins_vs = wins_vs + EXCLUDED.wins_vs),
--     and last_session_id is OVERWRITTEN whenever a pair meets
--     again -- so once every pair from an old session has played
--     a newer one, nothing references the old session, the guard
--     stops firing, and a retry double-counts it. Verified on
--     prod: session d820efea-d3ff-4ca3-9c0a-6a76de6090dc
--     ("Chillax Thursday 4/23", 20 completed matches) already has
--     zero ledger rows pointing at it. One-shot-per-session is
--     NOT idempotence. See APP_MANIFEST.md, cross-session
--     persistence section.
-- ============================================================

-- ═══════════════════════════════════════════════════════════════
-- 1. player_rivalries
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE player_rivalries (
  player_id       uuid        NOT NULL REFERENCES profiles(id)  ON DELETE CASCADE,
  rival_id        uuid        NOT NULL REFERENCES profiles(id)  ON DELETE CASCADE,
  wins_vs         integer     NOT NULL DEFAULT 0,
  losses_vs       integer     NOT NULL DEFAULT 0,
  -- count of distinct sessions where they appeared on opposing teams
  sessions_faced  integer     NOT NULL DEFAULT 0,
  last_session_id uuid        REFERENCES sessions(id) ON DELETE SET NULL,
  last_faced_at   timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (player_id, rival_id),
  CHECK (player_id <> rival_id)
);

CREATE INDEX idx_rivalry_player        ON player_rivalries (player_id);
CREATE INDEX idx_rivalry_rival         ON player_rivalries (rival_id);
CREATE INDEX idx_rivalry_sessions_desc ON player_rivalries (player_id, sessions_faced DESC);

ALTER TABLE player_rivalries ENABLE ROW LEVEL SECURITY;

-- Players can read their own rivalry data (for future display surfaces)
CREATE POLICY "Players can read own rivalry data"
  ON player_rivalries FOR SELECT
  USING (player_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════
-- 2. player_partnerships
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE player_partnerships (
  player_id         uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  partner_id        uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  games_together    integer     NOT NULL DEFAULT 0,
  wins_together     integer     NOT NULL DEFAULT 0,
  losses_together   integer     NOT NULL DEFAULT 0,
  -- count of distinct sessions where they appeared on the same team
  sessions_together integer     NOT NULL DEFAULT 0,
  last_session_id   uuid        REFERENCES sessions(id) ON DELETE SET NULL,
  last_played_at    timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (player_id, partner_id),
  CHECK (player_id <> partner_id)
);

CREATE INDEX idx_partnership_player       ON player_partnerships (player_id);
CREATE INDEX idx_partnership_partner      ON player_partnerships (partner_id);
CREATE INDEX idx_partnership_games_desc   ON player_partnerships (player_id, games_together DESC);

ALTER TABLE player_partnerships ENABLE ROW LEVEL SECURITY;

-- Players can read their own partnership data
CREATE POLICY "Players can read own partnership data"
  ON player_partnerships FOR SELECT
  USING (player_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════
-- 3. carry_forward column on session_wrapped_stats
-- ═══════════════════════════════════════════════════════════════
-- Written by compute_session_wrapped at session close.
-- Read at the start of the NEXT session's computation.
-- Schema: { ended_on_win_streak: int, session_win_pct: float, session_id: uuid }

ALTER TABLE session_wrapped_stats
  ADD COLUMN IF NOT EXISTS carry_forward jsonb NOT NULL DEFAULT '{}';

-- ═══════════════════════════════════════════════════════════════
-- 4. refresh_cross_session_stats RPC
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION refresh_cross_session_stats(p_session_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN

  -- ── One-shot guard (NOT an idempotency guard) ─────────────────────────────
  -- Exit early if this session appears to have been processed already.
  -- RETRACTED 2026-08-11: "Prevents double-counting if the caller retries. A
  -- real session always produces at least one rivalry or partnership row, so
  -- this check is reliable in practice." Both sentences are false. The rows it
  -- looks for are not stable: last_session_id is OVERWRITTEN every time a pair
  -- meets again, so the evidence of an old session decays to zero and a retry
  -- then double-counts. Verified on prod -- session
  -- d820efea-d3ff-4ca3-9c0a-6a76de6090dc ("Chillax Thursday 4/23", 20 completed
  -- matches) already has no ledger row referencing it. See the header note.
  IF EXISTS (
    SELECT 1 FROM player_rivalries   WHERE last_session_id = p_session_id LIMIT 1
  ) OR EXISTS (
    SELECT 1 FROM player_partnerships WHERE last_session_id = p_session_id LIMIT 1
  ) THEN
    RETURN;
  END IF;

  -- ── 1. Rivalry upserts ───────────────────────────────────────────────────
  -- For each player, count wins/losses against every individual opponent
  -- across all completed matches in this session.
  -- (A, B) and (B, A) are upserted independently — directional by design.
  WITH completed AS (
    SELECT
      m.id          AS match_id,
      mp.player_id,
      mp.team,
      CASE
        WHEN mp.team = 'a' AND m.team_a_score > m.team_b_score THEN true
        WHEN mp.team = 'b' AND m.team_b_score > m.team_a_score THEN true
        ELSE false
      END           AS won,
      m.completed_at
    FROM matches m
    JOIN match_players mp ON mp.match_id = m.id
    WHERE m.session_id    = p_session_id
      AND m.status        = 'completed'
      AND m.team_a_score IS NOT NULL
      AND m.team_b_score IS NOT NULL
  ),
  rivalry_deltas AS (
    SELECT
      p.player_id,
      opp.player_id                                    AS rival_id,
      SUM(CASE WHEN p.won     THEN 1 ELSE 0 END)::int  AS wins_vs,
      SUM(CASE WHEN NOT p.won THEN 1 ELSE 0 END)::int  AS losses_vs,
      MAX(p.completed_at)                              AS last_faced_at
    FROM completed p
    JOIN match_players opp ON opp.match_id  = p.match_id
                          AND opp.team     != p.team
    GROUP BY p.player_id, opp.player_id
  )
  INSERT INTO player_rivalries (
    player_id, rival_id,
    wins_vs, losses_vs,
    sessions_faced, last_session_id, last_faced_at, updated_at
  )
  SELECT
    player_id, rival_id,
    wins_vs, losses_vs,
    1,           -- new pair: 1 session
    p_session_id,
    last_faced_at,
    now()
  FROM rivalry_deltas
  ON CONFLICT (player_id, rival_id) DO UPDATE SET
    wins_vs         = player_rivalries.wins_vs   + EXCLUDED.wins_vs,
    losses_vs       = player_rivalries.losses_vs + EXCLUDED.losses_vs,
    -- Only increment sessions_faced when this is a genuinely new session
    sessions_faced  = player_rivalries.sessions_faced +
      CASE WHEN player_rivalries.last_session_id IS DISTINCT FROM EXCLUDED.last_session_id
           THEN 1 ELSE 0 END,
    last_session_id = EXCLUDED.last_session_id,
    last_faced_at   = GREATEST(player_rivalries.last_faced_at, EXCLUDED.last_faced_at),
    updated_at      = now();

  -- ── 2. Partnership upserts ───────────────────────────────────────────────
  -- For each player, count games/wins/losses with every same-team partner
  -- across all completed matches in this session.
  -- (A, B) and (B, A) are upserted independently — directional by design.
  WITH completed AS (
    SELECT
      m.id          AS match_id,
      mp.player_id,
      mp.team,
      CASE
        WHEN mp.team = 'a' AND m.team_a_score > m.team_b_score THEN true
        WHEN mp.team = 'b' AND m.team_b_score > m.team_a_score THEN true
        ELSE false
      END           AS won,
      m.completed_at
    FROM matches m
    JOIN match_players mp ON mp.match_id = m.id
    WHERE m.session_id    = p_session_id
      AND m.status        = 'completed'
      AND m.team_a_score IS NOT NULL
      AND m.team_b_score IS NOT NULL
  ),
  partnership_deltas AS (
    SELECT
      p.player_id,
      partner.player_id                                      AS partner_id,
      COUNT(*)::int                                          AS games_together,
      SUM(CASE WHEN p.won     THEN 1 ELSE 0 END)::int       AS wins_together,
      SUM(CASE WHEN NOT p.won THEN 1 ELSE 0 END)::int       AS losses_together,
      MAX(p.completed_at)                                    AS last_played_at
    FROM completed p
    JOIN match_players partner ON partner.match_id   = p.match_id
                              AND partner.team        = p.team
                              AND partner.player_id  != p.player_id
    GROUP BY p.player_id, partner.player_id
  )
  INSERT INTO player_partnerships (
    player_id, partner_id,
    games_together, wins_together, losses_together,
    sessions_together, last_session_id, last_played_at, updated_at
  )
  SELECT
    player_id, partner_id,
    games_together, wins_together, losses_together,
    1,           -- new pair: 1 session
    p_session_id,
    last_played_at,
    now()
  FROM partnership_deltas
  ON CONFLICT (player_id, partner_id) DO UPDATE SET
    games_together    = player_partnerships.games_together  + EXCLUDED.games_together,
    wins_together     = player_partnerships.wins_together   + EXCLUDED.wins_together,
    losses_together   = player_partnerships.losses_together + EXCLUDED.losses_together,
    -- Only increment sessions_together when this is a genuinely new session
    sessions_together = player_partnerships.sessions_together +
      CASE WHEN player_partnerships.last_session_id IS DISTINCT FROM EXCLUDED.last_session_id
           THEN 1 ELSE 0 END,
    last_session_id   = EXCLUDED.last_session_id,
    last_played_at    = GREATEST(player_partnerships.last_played_at, EXCLUDED.last_played_at),
    updated_at        = now();

END;
$$;

-- Only invoked from server-side closeSession() via service role
GRANT EXECUTE ON FUNCTION refresh_cross_session_stats(UUID) TO service_role;

-- Table-level read grants so RLS SELECT policies can fire for authenticated users
GRANT SELECT ON player_rivalries    TO authenticated;
GRANT SELECT ON player_partnerships TO authenticated;
