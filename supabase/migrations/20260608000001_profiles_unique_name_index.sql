-- ============================================================
-- Migration: profiles — partial UNIQUE index on normalized name
-- ============================================================
-- The cross-instance / TOCTOU authority for R2 (global name uniqueness).
-- Scoped to non-flagged profiles via `WHERE needs_rename = false` so that:
--   • Every CLEAN profile (and the canonical of each former-duplicate cluster)
--     is unique by normalized name — blocks fresh/incognito dup registration
--     and blocks a flagged player from renaming back onto a taken name.
--   • Flagged duplicates are EXCLUDED from the index, so they may keep their
--     real display_name (no ugly sentinel) until the player returns and renames.
--     The instant they rename, needs_rename flips false and the new (unique)
--     name enters the index in the same statement.
--
-- Normalization key MUST match src/lib/normalize-name.ts byte-for-byte:
--   lower(btrim(regexp_replace(display_name, E'[ \t]+', ' ', 'g')))
-- ASCII space/tab only (NOT POSIX \s) — see the parity note in that file.
--
-- ⚠ PROD ORDERING ⚠
-- This index CANNOT build while two non-flagged rows share a normalized name.
-- On THIS production database it must be applied ONLY AFTER the Phase-4 data-fix
-- runbook has (a) merged the true duplicates and (b) flagged the non-canonical
-- survivors — at which point each name cluster has exactly one non-flagged row.
-- Fresh environments (no duplicate data) build it cleanly with no ordering need.
-- CONCURRENTLY avoids locking the table; run outside an explicit transaction.
-- ============================================================

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_profiles_unique_active_name
  ON public.profiles (lower(btrim(regexp_replace(display_name, E'[ \t]+', ' ', 'g'))))
  WHERE needs_rename = false;
