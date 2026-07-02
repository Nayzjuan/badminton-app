-- ============================================================
-- Scope match_players_insert to session organizers (was with_check=true)
-- ============================================================
-- match_players_insert previously had with_check=true, allowing ANY
-- authenticated/anon caller to INSERT arbitrary match_players rows directly
-- via PostgREST (any match_id/player_id), bypassing all validation normally
-- done by the SECURITY DEFINER RPCs (create_match_with_players,
-- swap_player_in_match, create_held_cross_court_match, etc.) that are the
-- only legitimate writers of this table. Those RPCs are unaffected by this
-- change — SECURITY DEFINER functions run as the function owner and bypass
-- RLS regardless of policy content.
--
-- Mirrors the existing match_players_update / match_players_delete policies:
-- caller must be the organizer of the match's session.

drop policy if exists match_players_insert on public.match_players;

create policy match_players_insert on public.match_players
  for insert
  with check (
    exists (
      select 1 from matches m
      where m.id = match_players.match_id
        and is_session_organizer(m.session_id)
    )
  );
