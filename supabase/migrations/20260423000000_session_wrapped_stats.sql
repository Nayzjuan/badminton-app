-- ============================================================
-- Migration: session_wrapped_stats table
-- ============================================================
-- Stores the pre-computed per-player statistics and awards for
-- a session's Wrapped experience. Populated by the
-- compute_session_wrapped() RPC immediately before the organizer
-- broadcasts session_closed to all players.
--
-- One row per (session, player). UNIQUE constraint prevents
-- duplicate computation; ON CONFLICT DO UPDATE lets us re-run
-- the RPC safely (idempotent).
-- ============================================================

CREATE TABLE IF NOT EXISTS session_wrapped_stats (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid        NOT NULL REFERENCES sessions(id)  ON DELETE CASCADE,
  player_id       uuid        NOT NULL REFERENCES profiles(id)  ON DELETE CASCADE,
  computed_at     timestamptz NOT NULL DEFAULT now(),

  -- ── Raw stats ──────────────────────────────────────────────
  games_played    integer     NOT NULL DEFAULT 0,
  wins            integer     NOT NULL DEFAULT 0,
  losses          integer     NOT NULL DEFAULT 0,
  points_for      integer     NOT NULL DEFAULT 0,
  points_against  integer     NOT NULL DEFAULT 0,
  point_diff      integer     GENERATED ALWAYS AS (points_for - points_against) STORED,
  win_pct         numeric(5,2) NOT NULL DEFAULT 0,

  -- ── Derived stats ──────────────────────────────────────────
  win_streak      integer     NOT NULL DEFAULT 0,  -- longest win streak this session
  session_rank    integer,                         -- rank by wins (NULL if unranked)

  -- ── Awards ─────────────────────────────────────────────────
  earned_awards   text[]      NOT NULL DEFAULT '{}',
  award_data      jsonb       NOT NULL DEFAULT '{}',

  UNIQUE (session_id, player_id)
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sws_session    ON session_wrapped_stats (session_id);
CREATE INDEX IF NOT EXISTS idx_sws_player     ON session_wrapped_stats (player_id);
CREATE INDEX IF NOT EXISTS idx_sws_session_rank ON session_wrapped_stats (session_id, session_rank);

-- ── RLS ───────────────────────────────────────────────────────
ALTER TABLE session_wrapped_stats ENABLE ROW LEVEL SECURITY;

-- Players can read their own row (for the Wrapped page)
CREATE POLICY "Players can read own wrapped stats"
  ON session_wrapped_stats
  FOR SELECT
  USING (player_id = auth.uid());

-- Organizers can read all rows in sessions they manage
CREATE POLICY "Organizers can read wrapped stats for their sessions"
  ON session_wrapped_stats
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM session_organizers so
      WHERE so.session_id = session_wrapped_stats.session_id
        AND so.user_id    = auth.uid()
    )
  );

-- Only service_role (via RPC SECURITY DEFINER) may insert/update
-- Normal authenticated users cannot write to this table directly.
CREATE POLICY "Service role insert"
  ON session_wrapped_stats
  FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role update"
  ON session_wrapped_stats
  FOR UPDATE
  USING (auth.role() = 'service_role');

-- Grant read to authenticated users (RLS filters to own rows)
GRANT SELECT ON session_wrapped_stats TO authenticated;
