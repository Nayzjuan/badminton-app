-- ============================================================================
-- Repair: first_to_100 milestone mis-attribution
-- ============================================================================
-- Root cause: the club-wide "First to 100 games" honor is gated by a single
-- club_milestones row. When the rightful holder reconnected, the pre-fix
-- migrate_player_identity did NOT repoint club_milestones (fixed in
-- 20260717170135), so deleting their old profile cascade-deleted the milestone
-- row. The now-empty slot was then re-claimed by a LATER crosser in a
-- subsequent session — so two players ended up with first_to_100.
--
-- This repair reconstructs the TRUE historical first-to-100 per club from match
-- history (cumulative completed games per player; earliest 100th-game crossing
-- wins, match_id as the deterministic tiebreaker — identical to the original
-- backfill in 20260704000001), then:
--   (1) upserts each club's ledger row to the true holder, and
--   (2) revokes first_to_100 from every stored wrap whose player is NOT the
--       true holder for their club.
-- Generic (no hardcoded ids), reconstruction-based, and idempotent — safe to
-- re-run and a no-op on any DB where the ledger already matches the truth.
-- ============================================================================

-- (1) Point every club's ledger row at the true first crosser (insert if missing).
WITH club_matches AS (
  SELECT s.club_id, m.id AS match_id, m.completed_at, m.session_id, mp.player_id
  FROM matches m
  JOIN sessions s ON s.id = m.session_id
  JOIN match_players mp ON mp.match_id = m.id
  WHERE m.status = 'completed' AND m.completed_at IS NOT NULL
),
cumulative AS (
  SELECT club_id, player_id, match_id, session_id, completed_at,
         ROW_NUMBER() OVER (PARTITION BY club_id, player_id ORDER BY completed_at, match_id) AS gn
  FROM club_matches
),
crossings AS (
  SELECT club_id, player_id, match_id, session_id, completed_at
  FROM cumulative WHERE gn = 100
),
true_first AS (
  SELECT DISTINCT ON (club_id) club_id, player_id AS true_player, session_id AS true_session, completed_at AS crossed_at
  FROM crossings
  ORDER BY club_id, completed_at ASC, match_id ASC
)
INSERT INTO club_milestones (club_id, milestone, player_id, session_id, achieved_at)
SELECT tf.club_id, 'first_to_100_games', tf.true_player, tf.true_session, tf.crossed_at
FROM true_first tf
ON CONFLICT (club_id, milestone) DO UPDATE
  SET player_id   = EXCLUDED.player_id,
      session_id  = EXCLUDED.session_id,
      achieved_at = EXCLUDED.achieved_at;

-- (2) Revoke first_to_100 from any stored wrap whose player is not the club's true first.
WITH club_matches AS (
  SELECT s.club_id, m.id AS match_id, m.completed_at, mp.player_id
  FROM matches m
  JOIN sessions s ON s.id = m.session_id
  JOIN match_players mp ON mp.match_id = m.id
  WHERE m.status = 'completed' AND m.completed_at IS NOT NULL
),
cumulative AS (
  SELECT club_id, player_id, match_id, completed_at,
         ROW_NUMBER() OVER (PARTITION BY club_id, player_id ORDER BY completed_at, match_id) AS gn
  FROM club_matches
),
crossings AS (
  SELECT club_id, player_id, match_id, completed_at
  FROM cumulative WHERE gn = 100
),
true_first AS (
  SELECT DISTINCT ON (club_id) club_id, player_id AS true_player
  FROM crossings
  ORDER BY club_id, completed_at ASC, match_id ASC
)
UPDATE session_wrapped_stats sws
SET earned_awards = array_remove(sws.earned_awards, 'first_to_100'),
    award_data    = sws.award_data - 'first_to_100'
FROM sessions s
JOIN true_first tf ON tf.club_id = s.club_id
WHERE sws.session_id = s.id
  AND 'first_to_100' = ANY (sws.earned_awards)
  AND sws.player_id <> tf.true_player;
