-- ============================================================
-- Session Wrapped — intro dismiss persistence
-- ============================================================
-- Adds intro_dismissed_at to session_wrapped_stats so the
-- "Session Wrapped" intro overlay is shown once per session,
-- per player, device-agnostic (DB-backed dismiss).
--
-- Logic:
--   NULL     → intro has NOT been dismissed → show overlay
--   NOT NULL → intro was dismissed at this timestamp → skip
--
-- The dismiss is set via the dismissWrappedIntro server action
-- when the player explicitly clicks the "Done" button.
--
-- Security:
--   Column-level GRANT means authenticated users can only
--   update intro_dismissed_at — not any other stats column.
--   The row-level policy further restricts to their own row.
-- ============================================================

ALTER TABLE session_wrapped_stats
  ADD COLUMN IF NOT EXISTS intro_dismissed_at timestamptz DEFAULT NULL;

-- ── RLS: players can update only their own intro_dismissed_at ──
-- The existing "Service role update" policy covers all columns for
-- the service role.  This new policy lets each player flip their
-- own dismiss flag without touching wins/losses/etc.
CREATE POLICY "Players can dismiss their own wrapped intro"
  ON session_wrapped_stats
  FOR UPDATE
  USING     (player_id = auth.uid())
  WITH CHECK (player_id = auth.uid());

-- ── Column-level GRANT: limits UPDATE to the single new column ─
-- Even with the above RLS policy, authenticated users had no
-- UPDATE privilege at all.  Grant only the one column so the
-- blast radius is minimal even if another policy is mis-scoped.
GRANT UPDATE (intro_dismissed_at) ON session_wrapped_stats TO authenticated;
