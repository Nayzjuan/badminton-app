-- ============================================================
-- ONE-SHOT DATA FIX — Duplicate-name resolution (Scope A)
-- ============================================================
-- ⚠ DO NOT auto-apply. This is a hand-run runbook with hard-coded prod
--   UUIDs, NOT a schema migration. Run it deliberately, in order, only
--   AFTER migration 20260608000000 (flag columns + RPCs) is applied and
--   reviewed. It is idempotent + guarded — safe to re-run.
--
-- What it does, in order:
--   PART 0  Preview (read-only) — confirm the rows before any write.
--   PART 1  MERGE the two true-same-person duplicates (Miggy, Lianne).
--   PART 2  FLAG the non-canonical survivors of every remaining cluster
--           (Tristan / Bea / Jason) for forced rename on next login.
--   PART 3  Build the partial UNIQUE index (migration 20260608000001).
--   PART 4  Refresh the all-time leaderboard MV.
--   PART 5  Recompute Wrapped for merge-affected sessions.
--   PART 6  Verify (read-only).
--
-- Identity model: profiles.id === auth.users.id. Deleting a merged-away
-- loser removes its profile AND its auth user; any device still holding
-- that loser's cookie lands on the app's profileless-recovery path (the
-- login form re-creates a clean profile), so nothing breaks.
--
-- Verified inputs (2026-06-08), all guarded below so a stale assumption
-- raises instead of corrupting data:
--   Miggy  — KEEP 499b5fb7… (69 games, PIN 7777) · DELETE ghost 3a14c449… (0 games, PIN 7777)
--   Lianne — KEEP f30a6c4f… ("Lianne", PIN 0000, latest) · MERGE 9c6bc387… ("lianne", PIN 1111) in
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- PART 0 — PREVIEW (read-only; run first, eyeball the output)
-- ════════════════════════════════════════════════════════════
-- 0a. Every duplicate cluster currently in the table.
SELECT
  lower(btrim(regexp_replace(display_name, E'[ \t]+', ' ', 'g'))) AS norm,
  count(*) AS profiles,
  string_agg(display_name || ' [pin ' || coalesce(pin, '—') || ']', ' | ' ORDER BY created_at) AS variants
FROM public.profiles
GROUP BY 1
HAVING count(*) > 1
ORDER BY profiles DESC, norm;

-- 0b. Game counts for the specific ids this runbook touches (sanity).
SELECT p.id, p.display_name, p.pin, p.created_at,
       (SELECT count(*) FROM match_players mp JOIN matches m ON m.id = mp.match_id
         WHERE mp.player_id = p.id AND m.status = 'completed') AS completed_games,
       (SELECT count(*) FROM queue_entries qe WHERE qe.player_id = p.id) AS queue_rows
FROM public.profiles p
WHERE p.id IN (
  '499b5fb7-b7d6-4429-b35e-c77df4e30930', -- Miggy KEEP
  '3a14c449-5ff4-4011-9dcc-f357a9681024', -- Miggy ghost DELETE
  'f30a6c4f-4325-43fd-881f-b8b21b8c9656', -- Lianne KEEP
  '9c6bc387-2c73-4f61-ac79-be14f75e7916'  -- lianne MERGE in
)
ORDER BY p.display_name, p.created_at;


-- ════════════════════════════════════════════════════════════
-- PART 1 — MERGES (transactional + guarded + idempotent)
-- ════════════════════════════════════════════════════════════
BEGIN;

-- ── 1a. Miggy: delete the empty ghost ───────────────────────────────────────
-- Ghost has zero data (verified). The guard ABORTS the whole transaction if it
-- ever has match/queue rows, so we can never delete a profile that owns games.
DO $$
DECLARE
  v_ghost uuid := '3a14c449-5ff4-4011-9dcc-f357a9681024';
  v_keep  uuid := '499b5fb7-b7d6-4429-b35e-c77df4e30930';
  v_games int;
  v_queue int;
BEGIN
  IF EXISTS (SELECT 1 FROM profiles WHERE id = v_ghost) THEN
    SELECT count(*) INTO v_games FROM match_players WHERE player_id = v_ghost;
    SELECT count(*) INTO v_queue FROM queue_entries WHERE player_id = v_ghost;
    IF v_games <> 0 OR v_queue <> 0 THEN
      RAISE EXCEPTION 'ABORT: Miggy ghost % unexpectedly owns data (% matches, % queue rows) — not an empty ghost.',
        v_ghost, v_games, v_queue;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_keep) THEN
      RAISE EXCEPTION 'ABORT: Miggy keep-profile % missing.', v_keep;
    END IF;
    DELETE FROM profiles WHERE id = v_ghost;  -- auth.users row removed in PART 1c
    RAISE NOTICE 'Miggy ghost % profile deleted.', v_ghost;
  ELSE
    RAISE NOTICE 'Miggy ghost % already gone — skipping (idempotent).', v_ghost;
  END IF;
END $$;

-- ── 1b. Lianne: reassign loser → winner, keep winner (latest PIN 0000) ───────
-- Loser and winner are in DIFFERENT sessions, so reassignment cannot collide on
-- the (session_id, player_id) uniqueness of queue_entries / wrapped_stats; the
-- NOT EXISTS guards make it conflict-safe even if that ever changes.
DO $$
DECLARE
  v_loser  uuid := '9c6bc387-2c73-4f61-ac79-be14f75e7916'; -- "lianne" PIN 1111
  v_winner uuid := 'f30a6c4f-4325-43fd-881f-b8b21b8c9656'; -- "Lianne" PIN 0000 (latest)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_loser) THEN
    RAISE NOTICE 'Lianne loser % already merged — skipping (idempotent).', v_loser;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_winner) THEN
    RAISE EXCEPTION 'ABORT: Lianne winner % missing.', v_winner;
  END IF;

  -- match_players: matches are disjoint, no conflict possible.
  UPDATE match_players SET player_id = v_winner WHERE player_id = v_loser;

  -- queue_entries: move rows for sessions the winner is NOT already in; drop any
  -- leftover (would only exist on a same-session overlap, which there isn't).
  UPDATE queue_entries qe SET player_id = v_winner
   WHERE qe.player_id = v_loser
     AND NOT EXISTS (SELECT 1 FROM queue_entries w
                      WHERE w.player_id = v_winner AND w.session_id = qe.session_id);
  DELETE FROM queue_entries WHERE player_id = v_loser;

  -- session_wrapped_stats: same conflict-safe move.
  UPDATE session_wrapped_stats s SET player_id = v_winner
   WHERE s.player_id = v_loser
     AND NOT EXISTS (SELECT 1 FROM session_wrapped_stats w
                      WHERE w.player_id = v_winner AND w.session_id = s.session_id);
  DELETE FROM session_wrapped_stats WHERE player_id = v_loser;

  -- session_organizers: loser is not an organizer, but be defensive.
  UPDATE session_organizers o SET user_id = v_winner
   WHERE o.user_id = v_loser
     AND NOT EXISTS (SELECT 1 FROM session_organizers w
                      WHERE w.user_id = v_winner AND w.session_id = o.session_id);
  DELETE FROM session_organizers WHERE user_id = v_loser;

  -- Winner keeps its own (latest) PIN 0000 and "Lianne" capitalization — no change.
  -- Audit the merge.
  INSERT INTO player_renames (player_id, old_name, new_name, reason, actor_user_id)
  SELECT v_winner, 'lianne', display_name, 'data_fix_merge', v_winner
  FROM profiles WHERE id = v_winner;

  DELETE FROM profiles WHERE id = v_loser;  -- auth.users row removed in PART 1c
  RAISE NOTICE 'Lianne loser % merged into winner %.', v_loser, v_winner;
END $$;

COMMIT;

-- ── 1c. Remove the merged-away auth users (cannot be inside the tx above if you
--        prefer; safe to run after COMMIT). Idempotent — no-op if already gone.
-- NOTE: requires privileges on the auth schema (Supabase SQL editor / service
--       role). Alternatively delete these two users via Dashboard → Authentication.
DELETE FROM auth.users WHERE id = '3a14c449-5ff4-4011-9dcc-f357a9681024'; -- Miggy ghost
DELETE FROM auth.users WHERE id = '9c6bc387-2c73-4f61-ac79-be14f75e7916'; -- lianne loser


-- ════════════════════════════════════════════════════════════
-- PART 2 — FLAG non-canonical survivors of every remaining cluster
-- ════════════════════════════════════════════════════════════
-- Generic (NOT UUID-hard-coded): after the merges, the only remaining duplicate
-- clusters are Tristan / Bea / Jason. Canonical = most completed games, tie-break
-- earliest created_at, then id. Every rn>1 row is flagged; it KEEPS its real name
-- (collided_name) and is excluded from the unique index until it renames.
WITH games AS (
  SELECT p.id, p.display_name, p.created_at,
         lower(btrim(regexp_replace(p.display_name, E'[ \t]+', ' ', 'g'))) AS norm,
         (SELECT count(*) FROM match_players mp JOIN matches m ON m.id = mp.match_id
           WHERE mp.player_id = p.id AND m.status = 'completed') AS g
  FROM profiles p
),
ranked AS (
  SELECT id, display_name, norm,
         row_number() OVER (PARTITION BY norm ORDER BY g DESC, created_at ASC, id ASC) AS rn,
         count(*)     OVER (PARTITION BY norm) AS cluster_size
  FROM games
)
UPDATE profiles p
SET needs_rename = true,
    collided_name = p.display_name,
    flagged_at = now()
FROM ranked r
WHERE p.id = r.id
  AND r.rn > 1
  AND r.cluster_size > 1
  AND p.needs_rename = false;   -- idempotent: never re-flag

-- Audit the flagging.
INSERT INTO player_renames (player_id, old_name, new_name, reason, actor_user_id)
SELECT id, display_name, display_name, 'duplicate_flag', NULL
FROM profiles
WHERE needs_rename = true
  AND NOT EXISTS (
    SELECT 1 FROM player_renames pr
    WHERE pr.player_id = profiles.id AND pr.reason = 'duplicate_flag'
  );


-- ════════════════════════════════════════════════════════════
-- PART 3 — Build the partial UNIQUE index (now safe)
-- ════════════════════════════════════════════════════════════
-- Each cluster now has exactly ONE non-flagged row, so the index builds clean.
-- Apply migration 20260608000001_profiles_unique_name_index.sql, i.e.:
--   (run OUTSIDE any transaction — CONCURRENTLY cannot run in a tx block)
--
-- CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_profiles_unique_active_name
--   ON public.profiles (lower(btrim(regexp_replace(display_name, E'[ \t]+', ' ', 'g'))))
--   WHERE needs_rename = false;
--
-- If it errors with a duplicate-key violation, PART 1/2 did not fully resolve a
-- cluster — re-run PART 0a to find the offending non-flagged pair before retrying.


-- ════════════════════════════════════════════════════════════
-- PART 4 — Refresh the all-time leaderboard materialized view
-- ════════════════════════════════════════════════════════════
SELECT public.refresh_alltime_leaderboard();


-- ════════════════════════════════════════════════════════════
-- PART 5 — Recompute Wrapped for merge-affected sessions
-- ════════════════════════════════════════════════════════════
-- Only the MERGES move games between profiles, so only their sessions can carry a
-- stale name in award_data JSONB. (Flagging changes no names yet — names change
-- lazily at rename, handled then.) 5a detects; 5b recomputes per distinct session.
--
-- 5a. Detect sessions whose Wrapped award_data still embeds a merged-away name.
SELECT DISTINCT s.session_id
FROM public.session_wrapped_stats s
WHERE s.award_data::text ILIKE '%lianne%'
  AND s.player_id = 'f30a6c4f-4325-43fd-881f-b8b21b8c9656';
-- 5b. For each session_id returned above, recompute (idempotent):
--   SELECT public.compute_session_wrapped('<session_id>');


-- ════════════════════════════════════════════════════════════
-- PART 6 — VERIFY (read-only)
-- ════════════════════════════════════════════════════════════
-- 6a. No non-flagged duplicate clusters remain (should return ZERO rows).
SELECT lower(btrim(regexp_replace(display_name, E'[ \t]+', ' ', 'g'))) AS norm, count(*)
FROM public.profiles
WHERE needs_rename = false
GROUP BY 1 HAVING count(*) > 1;

-- 6b. The flagged set (expect the Tristan / Bea / Jason non-canonicals).
SELECT id, display_name, collided_name, flagged_at
FROM public.profiles WHERE needs_rename = true ORDER BY display_name;

-- 6c. Merge winners intact with their games consolidated.
SELECT p.display_name, p.pin,
       (SELECT count(*) FROM match_players mp JOIN matches m ON m.id = mp.match_id
         WHERE mp.player_id = p.id AND m.status = 'completed') AS completed_games
FROM public.profiles p
WHERE p.id IN ('499b5fb7-b7d6-4429-b35e-c77df4e30930',  -- Miggy (expect ~69)
               'f30a6c4f-4325-43fd-881f-b8b21b8c9656'); -- Lianne (expect 7 + 6 = ~13)

-- 6d. Losers fully gone (profiles AND auth users) — expect ZERO rows each.
SELECT 'profile' AS kind, id FROM public.profiles
  WHERE id IN ('3a14c449-5ff4-4011-9dcc-f357a9681024','9c6bc387-2c73-4f61-ac79-be14f75e7916')
UNION ALL
SELECT 'auth_user', id FROM auth.users
  WHERE id IN ('3a14c449-5ff4-4011-9dcc-f357a9681024','9c6bc387-2c73-4f61-ac79-be14f75e7916');
