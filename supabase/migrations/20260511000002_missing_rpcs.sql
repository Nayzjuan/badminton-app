-- ============================================================
-- Migration: missing_rpcs
-- Adds elevate_to_organizer and rejoin_queue, two production
-- RPCs that were created manually before the migration system
-- was adopted. Both are called from browser clients (SECURITY
-- DEFINER so they execute with the privileges of the function
-- owner, bypassing RLS for the specific writes they perform).
-- ============================================================

-- ── elevate_to_organizer ──────────────────────────────────────
-- Allows a player to become a co-organizer for a session by
-- providing the session's organizer_passcode.
--
-- Returns:
--   true   — passcode matched; caller added to session_organizers
--            (idempotent: already-organizer also returns true)
--   false  — session not found, inactive, or wrong passcode
--
-- Callers: browser client, joinAsCoOrganizer server action
CREATE OR REPLACE FUNCTION public.elevate_to_organizer(
  p_session_id uuid,
  p_passcode   text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_stored_passcode text;
BEGIN
  -- Look up the active session's passcode
  SELECT organizer_passcode
    INTO v_stored_passcode
    FROM public.sessions
   WHERE id = p_session_id
     AND is_active = true;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Require a non-null passcode and an exact match
  IF v_stored_passcode IS NULL OR v_stored_passcode != p_passcode THEN
    RETURN false;
  END IF;

  -- Idempotent upsert — if already an organizer, succeed silently
  INSERT INTO public.session_organizers (session_id, user_id)
  VALUES (p_session_id, auth.uid())
  ON CONFLICT (session_id, user_id) DO NOTHING;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.elevate_to_organizer(uuid, text)
  TO authenticated;

-- ── rejoin_queue ──────────────────────────────────────────────
-- Allows a player who previously left a session (status='left')
-- to rejoin the waiting queue.
--
-- Resets:
--   status    → 'waiting'
--   joined_at → now()      (so they start at back of wait-time)
--
-- No-op if the player has no 'left' entry in this session.
-- Callers: browser client after a player chooses to return
CREATE OR REPLACE FUNCTION public.rejoin_queue(
  p_session_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.queue_entries
     SET status    = 'waiting'::public.queue_status,
         joined_at = now()
   WHERE session_id = p_session_id
     AND player_id  = auth.uid()
     AND status     = 'left'::public.queue_status;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rejoin_queue(uuid)
  TO authenticated;
