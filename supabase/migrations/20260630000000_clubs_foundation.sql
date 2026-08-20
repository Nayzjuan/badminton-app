-- ============================================================
-- Multi-Tenant Phase 0 — Migration 1: Clubs foundation
-- ============================================================
-- Adds the three core tenancy tables (clubs, club_invites, club_members).
-- Purely additive — no existing table or behavior is touched here.
--
-- RLS posture: enabled with NO permissive policies (deny-all to anon /
-- authenticated). All access in the app goes through the service-role client
-- (createServiceClient), which bypasses RLS — the same pattern player_renames
-- uses. Member-read policies are added with the route migration, not now.
--
-- Idempotent: safe to re-run. ✅ APPLIED to production, stamp `20260630092810`.
-- (Was labelled "BUILD ONLY — not applied to production yet"; that was true when
--  written and went stale on apply. Verify with `list_migrations`, not this note.
--  Disposition: docs/reference/MIGRATION_RECONCILIATION.md)
-- See MULTI_TENANT_PLAN.md §4.1, §4.2, §8 Phase 0.
-- ============================================================

-- ---- clubs --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clubs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  created_by  uuid NOT NULL REFERENCES public.profiles(id),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- slug: 3–50 chars, lowercase alphanumeric words joined by single hyphens
  -- (no leading/trailing/double hyphens). URL identifier under /c/[slug].
  CONSTRAINT clubs_slug_format
    CHECK (char_length(slug) BETWEEN 3 AND 50 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

COMMENT ON TABLE public.clubs IS
  'Tenant root. One row per club/group. slug is the URL identifier under /c/[slug].';

-- ---- club_invites -------------------------------------------
CREATE TABLE IF NOT EXISTS public.club_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id     uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  token       text NOT NULL UNIQUE,
  role        text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_by  uuid REFERENCES public.profiles(id),
  consumed_by uuid REFERENCES public.profiles(id),
  consumed_at timestamptz,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_club_invites_club_id ON public.club_invites (club_id);

COMMENT ON TABLE public.club_invites IS
  'One-time invite tokens for joining a club. Consumed (consumed_by/consumed_at) on first use.';

-- ---- club_members -------------------------------------------
CREATE TABLE IF NOT EXISTS public.club_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id     uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  player_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  is_active   boolean NOT NULL DEFAULT true,  -- soft offboarding; preserves historical stats
  invited_by  uuid REFERENCES public.profiles(id),
  joined_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (club_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_club_members_player_id ON public.club_members (player_id);
CREATE INDEX IF NOT EXISTS idx_club_members_club_id   ON public.club_members (club_id);

COMMENT ON TABLE public.club_members IS
  'Membership + role of a player within a club. role owner/admin = implicit organizer on every session in the club.';

-- ---- RLS: enable, deny-all (service-role bypasses) ----------
ALTER TABLE public.clubs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_members ENABLE ROW LEVEL SECURITY;
-- No policies yet. Only the service-role client (RLS-bypassing) reads/writes
-- these in Phase 0; member-read policies land with the route migration
-- (MULTI_TENANT_PLAN §5.2/§5.3).
