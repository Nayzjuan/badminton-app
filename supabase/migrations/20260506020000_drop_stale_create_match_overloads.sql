-- ============================================================
-- Migration: Drop stale create_match_with_players overloads
-- ============================================================
-- After the draft_mode_bugfixes migration the canonical version
-- of create_match_with_players is the 10-arg form (with p_origin
-- and p_is_published). The two older overloads are dead code —
-- every call site passes p_is_published explicitly so Postgres
-- always resolves to the 10-arg version. Dropping them prevents
-- a future caller from accidentally hitting a stale overload via
-- positional arguments.

DROP FUNCTION IF EXISTS public.create_match_with_players(
  uuid, uuid, text, boolean, timestamptz, boolean, uuid[], uuid[]
);

DROP FUNCTION IF EXISTS public.create_match_with_players(
  uuid, uuid, text, boolean, timestamptz, boolean, uuid[], uuid[], public.match_origin
);
