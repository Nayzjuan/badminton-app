-- ============================================================================
-- M3a: drop never-used and prefix-redundant indexes (they only tax writes).
-- All confirmed against pg_stat_user_indexes (idx_scan=0 for dead; leading-
-- column coverage for redundant).
-- ============================================================================

-- match_events: append-only audit log. Reads are exclusively by
-- (match_id_snapshot, seq) via idx_match_events_match. These three have 0 scans.
DROP INDEX IF EXISTS public.idx_match_events_session;       -- (session_id_snapshot) 0 scans
DROP INDEX IF EXISTS public.idx_match_events_session_type;  -- (session_id_snapshot, event_type) 0 scans
DROP INDEX IF EXISTS public.idx_match_events_correlation;   -- (correlation_id) 0 scans

-- Ledger tables: PK is (club_id, player_id, {rival,partner}_id), so club_id-only
-- lookups are served by the PK's leading column -> the club_id indexes are
-- redundant; and the player_id-only indexes are covered by the (player_id, …DESC)
-- composites' leading column.
DROP INDEX IF EXISTS public.idx_player_partnerships_club_id;
DROP INDEX IF EXISTS public.idx_player_rivalries_club_id;
DROP INDEX IF EXISTS public.idx_partnership_player;  -- prefix of idx_partnership_games_desc
DROP INDEX IF EXISTS public.idx_rivalry_player;      -- prefix of idx_rivalry_sessions_desc
