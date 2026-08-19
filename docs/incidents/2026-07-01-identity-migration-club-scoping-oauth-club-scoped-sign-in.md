# 11.2 Identity-migration club scoping + OAuth club-scoped sign-in (2026-07-01)

> Extracted from `APP_MANIFEST.md` §11.2 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


Two follow-on gaps from the 11.1 audit, closed the same day:

- **`migrate_player_identity` rivalries/partnerships repoint.** The RPC (called from `reconnectPlayer` when a
  guest profile is merged into a returning player's identity) now repoints `rivalries` and `partnerships` rows
  from the old (guest) profile id to the surviving profile id, mirroring the pre-existing repoint logic already
  applied to `matches`/`match_players`/etc. Previously these two tables were left pointing at the
  now-orphaned guest id, silently losing head-to-head/partner history across a reconnect merge. Migration:
  `migrate_identity_rivalries_partnerships` — confirmed live on prod via `list_migrations`.
- **OAuth sign-in is now club-scoped end-to-end**, mirroring the anonymous sign-in flow's `club_slug` handling:
  - `signInWithGoogle(next?, clubSlug?)` (`src/app/actions/oauth.ts`) appends `&club=${encodeURIComponent(clubSlug)}`
    to the PKCE `redirectTo` URL when a `clubSlug` is provided (e.g. from a `/c/[slug]/join` page).
  - `GoogleSignInButton` (`src/components/auth/google-sign-in-button.tsx`) accepts and threads a `clubSlug` prop
    through to `signInWithGoogle`, alongside its pre-existing `next` prop.
  - `/auth/callback` reads the `club` query param post-consent and enrolls the user via `ensureClubMembership`,
    the same idempotent helper the anonymous flow uses.
  - **Verified live via browser click-through**: triggering the button from `/c/legacy/join` produces a server
    action response of `{"success":true,"url":"...&redirect_to=...%2Fauth%2Fcallback%3Fnext%3D%252Fc%252Flegacy%26club%3Dlegacy..."}`
    — the decoded `redirect_to` is `/auth/callback?next=/c/legacy&club=legacy`, confirming the club is threaded
    through the full PKCE round trip.
- **`isSessionOrganizer` (C6) auto-organizer fallback** (`src/app/actions/_shared.ts`): beyond `created_by` and
  explicit `session_organizers` membership, a user is also treated as the session's organizer if they hold an
  active (`is_active=true`) `club_members` row with `role IN ('owner','admin')` for the session's club. Mirrored
  at the DB level by migration `club_admin_auto_organizer` (confirmed live on prod) so RLS-enforced writes agree
  with the app-layer check.
- **`reconnectPlayer` profile lookup is club-scoped when a `clubSlug` is passed**: joins
  `club_members!club_members_player_id_fkey!inner(club_id)` (explicit constraint name needed because
  `club_members` has two FKs to `profiles`) and filters `club_members.club_id = club.id`, so reconnecting inside
  a specific club only matches that club's members instead of any player display-name/PIN match app-wide.
- **Leaderboard club scoping**: `/leaderboard` (lobby picker) scopes its session list via
  `getMyActiveClubIds(user.id)` (auth is best-effort — never redirects logged-out users, just shows an empty
  picker). `/leaderboard/[sessionId]` (the public share link) intentionally keeps using `createServiceClient()`
  to bypass the club-scoped `sessions_select` RLS policy for a single known-sessionId lookup — the sanctioned
  service-role-for-public-share pattern, same as the TV board and Wrapped share page. Backed by migration
  `scope_sessions_select` (confirmed live on prod).

All of the above was independently reviewed by three separate code-review agent passes (all clean/LGTM) and
personally re-verified by direct file reads against the review reports before being marked done — no
discrepancies found.

