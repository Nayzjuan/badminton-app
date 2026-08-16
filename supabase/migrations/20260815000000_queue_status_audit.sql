-- ============================================================
-- Queue status audit trail
-- ============================================================
-- WHY: queue_entries.status is mutated from MANY code paths — the engine,
-- checkoutPlayer, remove_player_from_queue_organizer, closeSession,
-- endMatchAction, join/rejoin, migrate_player_identity, manual matches. When a
-- player silently disappears from Match Control (their status became 'left'),
-- there was previously NO record of what changed it or when, making the
-- "why can't I see <player>?" class of incident impossible to diagnose after
-- the fact (queue_entries has no history table and no triggers).
--
-- This adds a DB-level audit so EVERY status transition is captured regardless
-- of which code path made it — an application-level logger would inevitably
-- miss a path, which is exactly the failure mode we hit.
--
-- The trigger is deliberately BEST-EFFORT: its body is wrapped so a logging
-- failure can NEVER roll back or block the actual queue status update.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.queue_status_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL,
  player_id   uuid NOT NULL,
  old_status  text,
  new_status  text NOT NULL,
  -- Best-effort actor from the request JWT. NULL for service-role callers
  -- (the engine and every server action use the service client), so this is a
  -- hint, not proof — correlate `changed_at` with server logs for attribution.
  actor_uid   uuid,
  changed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_queue_status_events_session
  ON public.queue_status_events (session_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_queue_status_events_player
  ON public.queue_status_events (player_id, changed_at DESC);

-- Diagnostic/admin table: enable RLS with NO policy so only the service role
-- (which bypasses RLS) can read it. Mirrors how match_events audit data is
-- kept off anon/authenticated clients.
ALTER TABLE public.queue_status_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.log_queue_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_actor uuid;
BEGIN
  -- Best-effort actor from the Supabase request JWT. Absent/invalid for
  -- service-role and internal SQL callers → NULL.
  BEGIN
    v_actor := nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;
  END;

  BEGIN
    INSERT INTO public.queue_status_events (session_id, player_id, old_status, new_status, actor_uid)
    VALUES (NEW.session_id, NEW.player_id, OLD.status::text, NEW.status::text, v_actor);
  EXCEPTION WHEN OTHERS THEN
    -- Audit logging must NEVER break a queue status update.
    NULL;
  END;

  RETURN NULL; -- AFTER trigger: return value is ignored.
END;
$$;

DROP TRIGGER IF EXISTS trg_log_queue_status_change ON public.queue_entries;
CREATE TRIGGER trg_log_queue_status_change
AFTER UPDATE OF status ON public.queue_entries
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.log_queue_status_change();
