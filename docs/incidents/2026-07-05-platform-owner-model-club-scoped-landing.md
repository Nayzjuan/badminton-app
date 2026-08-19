# 11.7 Platform-owner model + club-scoped landing (2026-07-05)

> Extracted from `APP_MANIFEST.md` §11.7 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


Two privilege tiers, introduced once real onboarding replaced the single-club stopgaps:

- **Platform owner** (`src/lib/platform.ts` `isPlatformOwner`) — sourced from the server-only env var
  `PLATFORM_OWNER_IDS` with a baked-in fallback (the founding owner). Only platform owners may **create or see
  clubs**: `createClub` rejects non-owners server-side, `/clubs` + `/clubs/new` redirect non-owners to `/play`,
  and the club-switcher / `(app)` layout "All clubs" / "New club" links render only for the owner. Non-owners are
  scoped to the club(s) they belong to (cross-club **data** was already walled off by the §11.1 RLS; this adds the
  missing create/manage-capability + UI gate).
- **Primary-club resolution** (`getPrimaryClubSlug` → SECURITY DEFINER RPC `get_primary_club_slug`): the club a
  returning player lands in when they open the app cold (no QR) = their **last-attended session's** club
  (`queue_entries` ordered by `q.joined_at DESC`), else their last-joined active club, else `NULL`. `/play` scopes
  the session picker to this one club (a multi-club player sees the club they last used); `NULL` → the new
  **`/welcome`** join-via-QR screen ("ask your organizer for the QR"). `/welcome` redirects back to `/play` if the
  user actually has a club, so the two converge with no loop. **`/organizer` (PR #25, 2026-07-13)** is the same
  shape — a pure redirect shim using the same resolver (`getPrimaryClubSlug` → 308 `/c/<slug>/organizer`, no club →
  `/welcome`), with the hub itself moved to `/c/[clubSlug]/(full)/organizer` (member-gated; sessions listed +
  created strictly for the URL club, `soloClubId = club.id`; multi-club organizers switch via the in-club switcher).
  See §3.17.
- **Onboarding:** a QR/invite registrant is enrolled (`ensureClubMembership`) and routed straight to their session
  as before — they never see `/welcome`. The blanket `handle_new_user` auto-enroll into the Legacy/CHILLAX club was
  **retired** (migration `20260705000000`), so a plain-link registrant has no club and lands on `/welcome`. Existing
  members are untouched; `migrate_player_identity` repoints `club_members`, so PIN reconnect preserves membership.
- Non-owner-facing `/clubs` redirects/links were repointed to `/play` throughout (`requireClubMembership`
  non-member bounce, `/play/join` + `/c/[slug]/join` enroll-fail fallbacks, `auth.ts` enroll-fail, the club error
  boundary, and the PWA manifest `start_url`), so a non-owner never round-trips through the owner-only hub.

