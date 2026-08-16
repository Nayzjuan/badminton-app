-- ============================================================
-- session_notifications
--
-- Session-scoped organizer inbox: leave, checkout, pause
-- buckets, and player score-correction requests.
--
-- Writes from the app go through the service client after an
-- auth gate (primary organizer has no session_organizers row).
-- RLS below is defence in depth for a leaked user-client call.
--
-- resolve_score_correction: one RPC so two organizers cannot
-- both stamp scores. GRANT service_role only. Do not DROP.
-- ============================================================

CREATE TABLE public.session_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (
    kind IN (
      'player_left',
      'player_checked_out',
      'player_paused_long',
      'score_correction'
    )
  ),
  status text NOT NULL DEFAULT 'unread' CHECK (
    status IN ('unread', 'read', 'resolved', 'superseded')
  ),
  subject_player_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  match_id uuid REFERENCES public.matches(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX session_notifications_session_created_idx
  ON public.session_notifications (session_id, created_at DESC);

CREATE UNIQUE INDEX session_notifications_pending_correction_idx
  ON public.session_notifications (match_id)
  WHERE kind = 'score_correction'
    AND status IN ('unread', 'read')
    AND match_id IS NOT NULL;

CREATE UNIQUE INDEX session_notifications_pause_bucket_idx
  ON public.session_notifications (
    session_id,
    subject_player_id,
    ((payload ->> 'bucket'))
  )
  WHERE kind = 'player_paused_long';

ALTER TABLE public.session_notifications ENABLE ROW LEVEL SECURITY;

-- Players may read their own correction rows. All writes go through the
-- service role after an app-level gate (isSessionOrganizer / match seat).
-- Do not GRANT INSERT to authenticated — a bare insert policy would let
-- any signed-in user park a pending row on any match_id and block the
-- real requester via the pending-correction unique.
CREATE POLICY session_notifications_player_select_own
  ON public.session_notifications
  FOR SELECT
  TO authenticated
  USING (
    kind = 'score_correction'
    AND subject_player_id = auth.uid()
  );

REVOKE ALL ON TABLE public.session_notifications FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.session_notifications TO authenticated;
GRANT ALL ON TABLE public.session_notifications TO service_role;

-- ── resolve_score_correction ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_score_correction(
  p_notification_id uuid,
  p_actor_id uuid,
  p_score_a int,
  p_score_b int
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_row public.session_notifications%ROWTYPE;
  v_actor_name text;
  v_match public.matches%ROWTYPE;
  v_updated int;
BEGIN
  SELECT * INTO v_row
  FROM public.session_notifications
  WHERE id = p_notification_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Notification not found.');
  END IF;

  IF v_row.kind <> 'score_correction' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not a score-correction notice.');
  END IF;

  IF v_row.status NOT IN ('unread', 'read') THEN
    SELECT display_name INTO v_actor_name
    FROM public.profiles
    WHERE id = v_row.resolved_by;
    RETURN jsonb_build_object(
      'success', false,
      'alreadyResolved', true,
      'actorName', COALESCE(v_actor_name, 'Another organizer'),
      'error', 'Already handled.'
    );
  END IF;

  IF v_row.match_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Match is missing.');
  END IF;

  SELECT * INTO v_match
  FROM public.matches
  WHERE id = v_row.match_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Match not found.');
  END IF;

  UPDATE public.matches
  SET team_a_score = p_score_a,
      team_b_score = p_score_b
  WHERE id = v_row.match_id
    AND status = 'completed';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'This match is no longer completed — it was reverted to an active court.'
    );
  END IF;

  SELECT display_name INTO v_actor_name
  FROM public.profiles
  WHERE id = p_actor_id;

  UPDATE public.session_notifications
  SET status = 'resolved',
      resolved_by = p_actor_id,
      resolved_at = now()
  WHERE id = p_notification_id;

  RETURN jsonb_build_object(
    'success', true,
    'actorName', v_actor_name,
    'oldScoreA', v_match.team_a_score,
    'oldScoreB', v_match.team_b_score,
    'sessionId', v_row.session_id,
    'matchId', v_row.match_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_score_correction(uuid, uuid, int, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_score_correction(uuid, uuid, int, int) TO service_role;
