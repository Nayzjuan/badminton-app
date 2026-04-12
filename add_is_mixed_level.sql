-- ============================================================
-- Migration: Add is_mixed_level column to matches table
-- ============================================================
-- This column is set to TRUE when the matchmaking engine's
-- time-based fallback (>15 min wait) bypasses skill windows.
-- It signals to the UI to show a "Mixed Level Match" badge.
-- ============================================================

ALTER TABLE matches
ADD COLUMN IF NOT EXISTS is_mixed_level boolean NOT NULL DEFAULT false;

-- Optional: add a comment for documentation
COMMENT ON COLUMN matches.is_mixed_level IS
  'True when the time-based fallback bypassed skill-level windows to prevent long waits.';
