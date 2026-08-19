# 11.1 Security audit — club-scoped RLS + credential-leak closure (2026-07-01)

> Extracted from `APP_MANIFEST.md` §11.1 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


Follow-up audit triggered by the goal of running 2+ real, data-segregated clubs (not just one club in
practice). Found and closed 3 gaps beyond the Phase 3 leaderboard/Wrapped scoping above:

- **Operational-table RLS.** `matches`, `match_players`, `queue_entries`, `courts`, `session_organizers`,
  `match_games` had SELECT policies with no club dimension at all (`qual: true`, or for `matches` an
  organizer/draft-firewall check only) — any authenticated (some: even anonymous) caller could read any
  club's live queue/match/court/organizer data. `supabase/migrations/20260701000008_club_scoped_rls.sql`
  adds 3 `SECURITY DEFINER` SQL helpers mirroring the existing `is_session_organizer` shape —
  `is_club_member(p_club_id)` → `is_session_club_member(p_session_id)` → `is_match_club_member(p_match_id)`
  — and ANDs club membership into every policy, preserving the organizer bypass and the `matches`
  draft-mode PERMISSIVE+RESTRICTIVE firewall (duplicate qual, precedent: `20260506000000_draft_mode_bugfixes.sql`)
  exactly. Verified live via RLS impersonation inside rolled-back transactions: a real club member sees
  full expected data, a non-member sees zero rows across all 6 tables, the session organizer is unaffected.
- **`profiles.pin` exposure via bulk `.select("*")`.** At the time of this audit `profiles_select` was
  `qual: true`, so RLS could not close this — it is closed at the column layer instead. (That row policy
  was later narrowed to a shared-club/shared-session predicate by `20260723200000`; see §11.8. It does
  not affect `pin`, which was never gated by the row policy. The "unauthenticated on purpose" half of
  the original rationale was also wrong: there is no `anon` SELECT policy on `profiles`, and the
  leaderboard/Wrapped profile reads go through `createServiceClient` — `buildVipMap`
  (`src/app/actions/leaderboard.ts:182`) is the single RLS-bound one, and it is authenticated.)
  `PUBLIC_PROFILE_COLUMNS` (`src/types/database.ts`) is an
  explicit 10-column safe list (no `pin`), used by the 5 client hooks that bulk-fetch other players'
  profiles (`use-enriched-matches.ts`, `use-match-history.ts`, `use-organizer-queue.ts`,
  `use-player-match.ts`, `use-session-data.ts`); results are reconstructed as `{ ...p, pin: null }`. Own-row
  reads and the service-role reconnect lookup are untouched.
- **Realtime broadcast scoping.** `profiles.pin` and `sessions.organizer_passcode` were included in the
  `supabase_realtime` publication's replicated column set, so every UPDATE broadcast the raw secret to all
  subscribers regardless of relevance. `20260701000006_realtime_publication_exclude_secrets.sql` restricts
  each table's publication column list to exclude the secret column.

`getMyActiveClubIds(userId)` (`src/lib/clubs.ts`) was added as a cheaper alternative to `getMyClubs` for
pure membership-scoping, and was first used to fix `/play` and `/organizer`'s session listings (previously
unfiltered — a multi-club user saw every club's session names). **Superseded since:** `/play` now scopes to the
single primary club via `getPrimaryClubSlug` (§11.7), and `/organizer` is a redirect shim whose club-scoped hub
lists/creates only the URL club's sessions (§3.17) — creation is never ambiguous, so the old 0-or-2+-clubs
create-disable is gone. `getMyActiveClubIds` remains in use by `/leaderboard` and the `(full)` layout's club switcher.

**Push deep-links are club-scoped.** `pushToPlayers(userIds, type, sessionId?)` (`src/lib/notifications/push-server.ts`)
resolves the session's club via `resolveSessionClubSlug` and deep-links to `/c/<slug>/play/<sessionId>` when
resolvable, falling back to `/clubs` otherwise (never throws — a resolution failure is swallowed). All ~9
call sites across `actions/matchmaking.ts`, `actions/match-drafts.ts`, `actions/match-lifecycle.ts`,
`actions/live-match-swap.ts`, `actions/swap-player.ts`, and `actions/notifications.ts`'s
`sendPlayerNotification` now thread `sessionId` through.

**Deferred:** further E2E spec path updates for `/c/[clubSlug]/...` routes (the 50-player simulation spec's
reconnect-navigation assertion was widened to accept both the flat `/play` path and the club-scoped
`/c/[slug]/play/[sessionId]` redirect target, but the rest of the E2E suite still asserts flat paths only).

