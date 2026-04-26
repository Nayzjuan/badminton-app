-- Add court_time_limit_minutes column to sessions table.
-- Organizers can set a per-session time limit for court matches.
-- NULL means no limit. Positive integers only (enforced by CHECK).

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS court_time_limit_minutes INTEGER NULL
  CHECK (court_time_limit_minutes IS NULL OR court_time_limit_minutes > 0);

COMMENT ON COLUMN sessions.court_time_limit_minutes IS
  'Optional per-session court time limit in minutes. NULL = no limit. When set, active court cards visually escalate (emerald → amber → red) as elapsed time approaches and exceeds this threshold.';
