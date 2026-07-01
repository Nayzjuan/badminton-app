-- ============================================================
-- Club-scoped RLS for matches, match_players, queue_entries,
-- courts, session_organizers, match_games
-- ============================================================
-- Every SELECT policy on these 6 tables was `qual: true` (or, for
-- `matches`, an organizer/draft-firewall check with no club
-- dimension at all) — meaning any authenticated (or, for several
-- tables, even fully anonymous) caller could read live queue/match/
-- court/organizer data from every club in the system, not just their
-- own. This closes that cross-club leak by AND-ing a club-membership
-- requirement into each policy, while leaving every existing
-- organizer-bypass and the `matches` draft-mode firewall untouched.
--
-- profiles_select is deliberately NOT touched here: it stays
-- `qual: true` by design (leaderboard.ts and the Wrapped share page
-- both read arbitrary profiles unauthenticated, on purpose). The
-- profiles.pin leak was already closed at the column-selection layer
-- (see PUBLIC_PROFILE_COLUMNS in src/types/database.ts) — RLS is
-- row-level and can't restrict by column, and the other profile
-- fields (display_name, skill_level, vip_tag, ...) are intentionally
-- public across clubs.
-- ============================================================

-- ── Helper functions (mirror is_session_organizer's shape) ────────

CREATE OR REPLACE FUNCTION public.is_club_member(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM club_members cm
    WHERE cm.club_id = p_club_id
      AND cm.player_id = auth.uid()
      AND cm.is_active = true
  );
$$;

CREATE OR REPLACE FUNCTION public.is_session_club_member(p_session_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.id = p_session_id
      AND is_club_member(s.club_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.is_match_club_member(p_match_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM matches m
    WHERE m.id = p_match_id
      AND is_session_club_member(m.session_id)
  );
$$;

-- ── matches ────────────────────────────────────────────────────
-- matches_select (PERMISSIVE) and matches_select_draft_firewall
-- (RESTRICTIVE) carried an IDENTICAL qual before this change — the
-- restrictive one is a defense-in-depth backstop for the same draft-
-- mode-firewall rule, not a separate concern. Keep them identical
-- after adding club-scoping too. Organizers bypass unconditionally
-- (mirrors is_session_organizer's existing no-club-check behaviour
-- elsewhere); everyone else needs both club membership AND the
-- existing visibility rule (published, or no longer pending).

DROP POLICY IF EXISTS matches_select ON matches;
CREATE POLICY matches_select ON matches
  FOR SELECT
  TO public
  USING (
    is_session_organizer(session_id)
    OR (
      is_session_club_member(session_id)
      AND (status <> 'pending' OR is_published = true)
    )
  );

DROP POLICY IF EXISTS matches_select_draft_firewall ON matches;
CREATE POLICY matches_select_draft_firewall ON matches
  AS RESTRICTIVE
  FOR SELECT
  TO public
  USING (
    is_session_organizer(session_id)
    OR (
      is_session_club_member(session_id)
      AND (status <> 'pending' OR is_published = true)
    )
  );

-- ── queue_entries ──────────────────────────────────────────────
-- Two genuinely-redundant PERMISSIVE qual:true policies existed
-- (queue_entries_select for `authenticated`, queue_select for
-- `public`) — both OR together, so both must be tightened or the fix
-- is a no-op. Preserve the original role split; tighten both quals
-- identically.

DROP POLICY IF EXISTS queue_entries_select ON queue_entries;
CREATE POLICY queue_entries_select ON queue_entries
  FOR SELECT
  TO authenticated
  USING (is_session_organizer(session_id) OR is_session_club_member(session_id));

DROP POLICY IF EXISTS queue_select ON queue_entries;
CREATE POLICY queue_select ON queue_entries
  FOR SELECT
  TO public
  USING (is_session_organizer(session_id) OR is_session_club_member(session_id));

-- ── courts ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS courts_select ON courts;
CREATE POLICY courts_select ON courts
  FOR SELECT
  TO authenticated
  USING (is_session_organizer(session_id) OR is_session_club_member(session_id));

-- ── session_organizers ─────────────────────────────────────────
-- Zero RLS-subject app-code reads found in the full-repo audit —
-- safe to lock down with no regression risk.

DROP POLICY IF EXISTS session_organizers_select ON session_organizers;
CREATE POLICY session_organizers_select ON session_organizers
  FOR SELECT
  TO authenticated
  USING (is_session_organizer(session_id) OR is_session_club_member(session_id));

-- ── match_players ──────────────────────────────────────────────
-- No session_id column directly; resolve club via matches.session_id.

DROP POLICY IF EXISTS match_players_select ON match_players;
CREATE POLICY match_players_select ON match_players
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM matches m
      WHERE m.id = match_players.match_id
        AND is_session_organizer(m.session_id)
    )
    OR is_match_club_member(match_id)
  );

-- ── match_games ────────────────────────────────────────────────
-- Was qual:true for the `public` role (broadest possible grant) with
-- zero RLS-subject app-code reads found — lock down the same way.

DROP POLICY IF EXISTS match_games_select ON match_games;
CREATE POLICY match_games_select ON match_games
  FOR SELECT
  TO public
  USING (
    EXISTS (
      SELECT 1 FROM matches m
      WHERE m.id = match_games.match_id
        AND is_session_organizer(m.session_id)
    )
    OR is_match_club_member(match_id)
  );
