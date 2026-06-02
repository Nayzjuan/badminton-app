-- ============================================================
-- Live Match Player Swap — 3 atomic RPCs for fixing active courts
-- ============================================================
-- Provides three operations for organizers to correct player
-- assignments while a match is in_progress:
--
--   1. swap_player_in_active_match
--      Replaces one player in an in_progress match with a
--      player from the waiting queue.
--
--   2. swap_teams_in_active_match
--      Swaps the team assignment of two players within the
--      same in_progress match. Neither player touches the queue.
--
--   3. swap_active_from_ondeck
--      Atomic 3-way: pull an on-deck player into the active
--      match AND fill the vacated on-deck slot from the queue.
--      Organizers are forced to provide a fill player before
--      this RPC can execute.
--
--   4. undo_swap_active_from_ondeck
--      Reverses the 3-way swap atomically. Called within the
--      3-second undo window if the organizer changes their mind.
--
-- All RPCs:
--   • Run SECURITY DEFINER (elevated to service role)
--   • Use FOR UPDATE locks to prevent concurrent race conditions
--   • Are callable only from trusted server actions (Row-Level
--     Security enforcement happens in the server action layer)
--   • Recompute is_mixed_level after every write
--   • Flip origin from 'auto' → 'modified' (sticky rule)
-- ============================================================

-- ─── 1. swap_player_in_active_match ──────────────────────────
-- Replaces one player in an in_progress match with a queue player.
-- Writes:
--   a. DELETE out_player from match_players
--   b. INSERT in_player into match_players (same team)
--   c. UPDATE out_player queue_entries → 'waiting'
--   d. UPDATE in_player  queue_entries → 'playing'
--   e. Recompute is_mixed_level + mark origin = 'modified'
--
-- Named exceptions (caught by the server action and mapped to
-- typed error codes shown in the UI):
--   MATCH_NOT_ACTIVE     — match is no longer in_progress
--   PLAYER_NOT_IN_MATCH  — out_player already left this match
--   PLAYER_UNAVAILABLE   — in_player no longer waiting

CREATE OR REPLACE FUNCTION swap_player_in_active_match(
    p_match_id      UUID,
    p_out_player_id UUID,
    p_in_player_id  UUID,
    p_session_id    UUID,
    p_team          TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_match_status match_status;
    v_in_status    queue_status;
BEGIN
    -- Lock the match row to prevent concurrent swaps mid-flight.
    SELECT status INTO v_match_status
    FROM matches
    WHERE id = p_match_id
    FOR UPDATE;

    IF NOT FOUND OR v_match_status != 'in_progress' THEN
        RAISE EXCEPTION 'MATCH_NOT_ACTIVE';
    END IF;

    -- Guard: out_player must still be in this match.
    IF NOT EXISTS (
        SELECT 1 FROM match_players
        WHERE match_id = p_match_id AND player_id = p_out_player_id
    ) THEN
        RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH';
    END IF;

    -- Lock + check the incoming player's queue entry.
    SELECT status INTO v_in_status
    FROM queue_entries
    WHERE session_id = p_session_id AND player_id = p_in_player_id
    FOR UPDATE;

    IF NOT FOUND OR v_in_status != 'waiting' THEN
        RAISE EXCEPTION 'PLAYER_UNAVAILABLE';
    END IF;

    -- Atomic writes --

    DELETE FROM match_players
    WHERE match_id = p_match_id AND player_id = p_out_player_id;

    INSERT INTO match_players (match_id, player_id, team)
    VALUES (p_match_id, p_in_player_id, p_team);

    UPDATE queue_entries
    SET status = 'waiting'
    WHERE session_id = p_session_id AND player_id = p_out_player_id;

    UPDATE queue_entries
    SET status = 'playing'
    WHERE session_id = p_session_id AND player_id = p_in_player_id;

    UPDATE matches
    SET
        is_mixed_level = (
            SELECT COUNT(DISTINCT pr.skill_level) > 1
            FROM match_players mp
            JOIN profiles pr ON pr.id = mp.player_id
            WHERE mp.match_id = p_match_id
        ),
        origin = CASE WHEN origin = 'auto' THEN 'modified'::match_origin ELSE origin END
    WHERE id = p_match_id;
END;
$$;

GRANT EXECUTE ON FUNCTION swap_player_in_active_match(UUID, UUID, UUID, UUID, TEXT) TO service_role;


-- ─── 2. swap_teams_in_active_match ───────────────────────────
-- Swaps two players between teams within the same in_progress
-- match. No queue status changes — both players remain 'playing'.
-- Writes:
--   a. UPDATE team for player_a → player_b's original team
--   b. UPDATE team for player_b → player_a's original team
--   c. Recompute is_mixed_level + mark origin = 'modified'
--
-- Named exceptions:
--   MATCH_NOT_ACTIVE    — match is no longer in_progress
--   PLAYER_NOT_IN_MATCH — one player no longer in this match

CREATE OR REPLACE FUNCTION swap_teams_in_active_match(
    p_match_id    UUID,
    p_player_a_id UUID,
    p_player_b_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_team_a       TEXT;
    v_team_b       TEXT;
    v_match_status match_status;
BEGIN
    -- Lock match first.
    SELECT status INTO v_match_status
    FROM matches
    WHERE id = p_match_id
    FOR UPDATE;

    IF NOT FOUND OR v_match_status != 'in_progress' THEN
        RAISE EXCEPTION 'MATCH_NOT_ACTIVE';
    END IF;

    -- Read current teams (lock rows against concurrent changes).
    SELECT team INTO v_team_a
    FROM match_players
    WHERE match_id = p_match_id AND player_id = p_player_a_id
    FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH'; END IF;

    SELECT team INTO v_team_b
    FROM match_players
    WHERE match_id = p_match_id AND player_id = p_player_b_id
    FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH'; END IF;

    -- Atomic team swap --
    UPDATE match_players
    SET team = v_team_b
    WHERE match_id = p_match_id AND player_id = p_player_a_id;

    UPDATE match_players
    SET team = v_team_a
    WHERE match_id = p_match_id AND player_id = p_player_b_id;

    -- is_mixed_level won't change (same players, same skills), but
    -- recompute anyway to keep the rule consistent across all swap RPCs.
    UPDATE matches
    SET
        is_mixed_level = (
            SELECT COUNT(DISTINCT pr.skill_level) > 1
            FROM match_players mp
            JOIN profiles pr ON pr.id = mp.player_id
            WHERE mp.match_id = p_match_id
        ),
        origin = CASE WHEN origin = 'auto' THEN 'modified'::match_origin ELSE origin END
    WHERE id = p_match_id;
END;
$$;

GRANT EXECUTE ON FUNCTION swap_teams_in_active_match(UUID, UUID, UUID) TO service_role;


-- ─── 3. swap_active_from_ondeck ──────────────────────────────
-- Atomic 3-way: pull on-deck player into active match AND fill
-- the vacated on-deck slot with a queue player.
-- The organizer is forced to nominate a fill player before this
-- RPC runs — no partial-state is possible.
--
-- Writes:
--   Active match: DELETE out_player, INSERT ondeck_player (same team)
--   On-deck match: DELETE ondeck_player, INSERT fill_player (same team)
--   Queue: out_player → 'waiting', ondeck_player → 'playing', fill_player → 'on_deck'
--   Both matches: recompute is_mixed_level + mark origin = 'modified'
--
-- Named exceptions:
--   MATCH_NOT_ACTIVE       — active match no longer in_progress
--   ONDECK_MATCH_STARTED   — on-deck match was promoted before confirm
--   PLAYER_NOT_IN_MATCH    — out or ondeck player already moved
--   FILL_PLAYER_UNAVAILABLE — fill_player no longer waiting

CREATE OR REPLACE FUNCTION swap_active_from_ondeck(
    p_active_match_id  UUID,
    p_out_player_id    UUID,
    p_ondeck_player_id UUID,
    p_ondeck_match_id  UUID,
    p_fill_player_id   UUID,
    p_session_id       UUID,
    OUT o_out_team          TEXT,
    OUT o_ondeck_team       TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_active_status  match_status;
    v_ondeck_status  match_status;
    v_fill_status    queue_status;
BEGIN
    -- Lock both matches first (in deterministic ID order to prevent deadlocks).
    IF p_active_match_id < p_ondeck_match_id THEN
        SELECT status INTO v_active_status FROM matches WHERE id = p_active_match_id FOR UPDATE;
        SELECT status INTO v_ondeck_status FROM matches WHERE id = p_ondeck_match_id FOR UPDATE;
    ELSE
        SELECT status INTO v_ondeck_status FROM matches WHERE id = p_ondeck_match_id FOR UPDATE;
        SELECT status INTO v_active_status FROM matches WHERE id = p_active_match_id FOR UPDATE;
    END IF;

    IF NOT FOUND OR v_active_status != 'in_progress' THEN
        RAISE EXCEPTION 'MATCH_NOT_ACTIVE';
    END IF;

    IF v_ondeck_status != 'pending' THEN
        RAISE EXCEPTION 'ONDECK_MATCH_STARTED';
    END IF;

    -- Read teams of both players (also locks the rows).
    SELECT team INTO o_out_team
    FROM match_players
    WHERE match_id = p_active_match_id AND player_id = p_out_player_id
    FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH'; END IF;

    SELECT team INTO o_ondeck_team
    FROM match_players
    WHERE match_id = p_ondeck_match_id AND player_id = p_ondeck_player_id
    FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'PLAYER_NOT_IN_MATCH'; END IF;

    -- Check fill player is still waiting.
    SELECT status INTO v_fill_status
    FROM queue_entries
    WHERE session_id = p_session_id AND player_id = p_fill_player_id
    FOR UPDATE;

    IF NOT FOUND OR v_fill_status != 'waiting' THEN
        RAISE EXCEPTION 'FILL_PLAYER_UNAVAILABLE';
    END IF;

    -- Atomic writes --

    -- Active match: replace out_player with ondeck_player
    DELETE FROM match_players WHERE match_id = p_active_match_id AND player_id = p_out_player_id;
    INSERT INTO match_players (match_id, player_id, team)
    VALUES (p_active_match_id, p_ondeck_player_id, o_out_team);

    -- On-deck match: replace ondeck_player with fill_player
    DELETE FROM match_players WHERE match_id = p_ondeck_match_id AND player_id = p_ondeck_player_id;
    INSERT INTO match_players (match_id, player_id, team)
    VALUES (p_ondeck_match_id, p_fill_player_id, o_ondeck_team);

    -- Queue status updates
    UPDATE queue_entries SET status = 'waiting' WHERE session_id = p_session_id AND player_id = p_out_player_id;
    UPDATE queue_entries SET status = 'playing' WHERE session_id = p_session_id AND player_id = p_ondeck_player_id;
    UPDATE queue_entries SET status = 'on_deck' WHERE session_id = p_session_id AND player_id = p_fill_player_id;

    -- Recompute both matches
    UPDATE matches
    SET
        is_mixed_level = (
            SELECT COUNT(DISTINCT pr.skill_level) > 1
            FROM match_players mp
            JOIN profiles pr ON pr.id = mp.player_id
            WHERE mp.match_id = p_active_match_id
        ),
        origin = CASE WHEN origin = 'auto' THEN 'modified'::match_origin ELSE origin END
    WHERE id = p_active_match_id;

    UPDATE matches
    SET
        is_mixed_level = (
            SELECT COUNT(DISTINCT pr.skill_level) > 1
            FROM match_players mp
            JOIN profiles pr ON pr.id = mp.player_id
            WHERE mp.match_id = p_ondeck_match_id
        ),
        origin = CASE WHEN origin = 'auto' THEN 'modified'::match_origin ELSE origin END
    WHERE id = p_ondeck_match_id;
END;
$$;

GRANT EXECUTE ON FUNCTION swap_active_from_ondeck(UUID, UUID, UUID, UUID, UUID, UUID) TO service_role;


-- ─── 4. undo_swap_active_from_ondeck ─────────────────────────
-- Reverses swap_active_from_ondeck within the 3-second undo window.
-- Takes the original args + the original teams that were returned
-- by swap_active_from_ondeck as OUT params.
--
-- After the original swap:
--   active match  → ondeck_player playing, out_player waiting in queue
--   ondeck match  → fill_player on_deck
--
-- After undo:
--   active match  → out_player playing (original team restored)
--   ondeck match  → ondeck_player on_deck (original team restored)
--   queue         → fill_player waiting, ondeck_player on_deck, out_player playing

CREATE OR REPLACE FUNCTION undo_swap_active_from_ondeck(
    p_active_match_id  UUID,
    p_out_player_id    UUID,    -- original player who was removed (now waiting in queue)
    p_ondeck_player_id UUID,    -- player pulled from on-deck (now playing in active match)
    p_ondeck_match_id  UUID,
    p_fill_player_id   UUID,    -- queue player who filled on-deck slot (now on_deck)
    p_session_id       UUID,
    p_out_team         TEXT,    -- original team of out_player in active match
    p_ondeck_team      TEXT     -- original team of ondeck_player in on-deck match
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_active_status match_status;
    v_ondeck_status match_status;
BEGIN
    -- Lock both matches.
    IF p_active_match_id < p_ondeck_match_id THEN
        SELECT status INTO v_active_status FROM matches WHERE id = p_active_match_id FOR UPDATE;
        SELECT status INTO v_ondeck_status FROM matches WHERE id = p_ondeck_match_id FOR UPDATE;
    ELSE
        SELECT status INTO v_ondeck_status FROM matches WHERE id = p_ondeck_match_id FOR UPDATE;
        SELECT status INTO v_active_status FROM matches WHERE id = p_active_match_id FOR UPDATE;
    END IF;

    -- If either match has moved on (completed, cancelled, or the on-deck
    -- match was promoted), undo is no longer safe — silently abort.
    IF v_active_status != 'in_progress' OR v_ondeck_status != 'pending' THEN
        RETURN;
    END IF;

    -- Active match: remove ondeck_player, restore out_player
    DELETE FROM match_players WHERE match_id = p_active_match_id AND player_id = p_ondeck_player_id;
    INSERT INTO match_players (match_id, player_id, team)
    VALUES (p_active_match_id, p_out_player_id, p_out_team);

    -- On-deck match: remove fill_player, restore ondeck_player
    DELETE FROM match_players WHERE match_id = p_ondeck_match_id AND player_id = p_fill_player_id;
    INSERT INTO match_players (match_id, player_id, team)
    VALUES (p_ondeck_match_id, p_ondeck_player_id, p_ondeck_team);

    -- Queue status reversals
    UPDATE queue_entries SET status = 'playing' WHERE session_id = p_session_id AND player_id = p_out_player_id;
    UPDATE queue_entries SET status = 'on_deck' WHERE session_id = p_session_id AND player_id = p_ondeck_player_id;
    UPDATE queue_entries SET status = 'waiting' WHERE session_id = p_session_id AND player_id = p_fill_player_id;

    -- Recompute both matches
    UPDATE matches
    SET
        is_mixed_level = (
            SELECT COUNT(DISTINCT pr.skill_level) > 1
            FROM match_players mp
            JOIN profiles pr ON pr.id = mp.player_id
            WHERE mp.match_id = p_active_match_id
        ),
        origin = CASE WHEN origin = 'auto' THEN 'modified'::match_origin ELSE origin END
    WHERE id = p_active_match_id;

    UPDATE matches
    SET
        is_mixed_level = (
            SELECT COUNT(DISTINCT pr.skill_level) > 1
            FROM match_players mp
            JOIN profiles pr ON pr.id = mp.player_id
            WHERE mp.match_id = p_ondeck_match_id
        ),
        origin = CASE WHEN origin = 'auto' THEN 'modified'::match_origin ELSE origin END
    WHERE id = p_ondeck_match_id;
END;
$$;

GRANT EXECUTE ON FUNCTION undo_swap_active_from_ondeck(UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT) TO service_role;
