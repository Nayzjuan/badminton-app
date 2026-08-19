# 11.4 Club-scoped Wrapped route (2026-07-02)

> Extracted from `APP_MANIFEST.md` §11.4 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


**Gap closed.** `MULTI_TENANT_PHASE2_PLAN.md` (step 4 + its redirect-map table) always planned
`/c/[clubSlug]/wrapped/[sessionId]/[playerId]` alongside the TV/Leaderboard club variants, but it was never
built — a dead `clubWrapped()` path builder existed in `src/lib/club-paths.ts` with zero call sites, and every
redirect into Wrapped (session-end, organizer `session_closed` broadcast, offline-reconnect, a misleading code
comment claiming Wrapped "stays root-only like the TV board") pointed at the flat root path only. Root TV does
**not** stay root-only either — it already has both variants — so the comment's premise was false; this was a
real implementation gap, not a documented deviation.

**Fix — dual-path, same pattern as TV/Leaderboard.** New `src/app/actions/wrapped.ts::getWrappedData(sessionId,
playerId)` is a shared server-action data-fetcher (mirrors `getTvData`), always using the service-role client
since Wrapped is a public/shareable recap and the viewer may not be authenticated as the player at all. New
route `src/app/c/[clubSlug]/wrapped/[sessionId]/[playerId]/page.tsx` mirrors the TV club-route structure:
resolves the club via `getClubBySlug` (404 if missing), calls `getWrappedData`, 404s if the profile is missing
or if `sessionClubId !== club.id`. The root `/wrapped/[sessionId]/[playerId]` page now just calls the same
`getWrappedData` instead of inline queries. Every redirect site was updated to prefer the club-scoped path
when a club slug is resolvable, falling back to root otherwise: the club play-page's session-end redirect,
`WrappedShell`'s "Done" button (via `useClubSlug()`, same pathname-derived pattern as `PwaNavBar`),
`useOrganizerBroadcast`'s `session_closed` redirect (via a new `clubSlugRef`, following the hook's existing
`playerIdRef`/`routerRef` ref-stability pattern so the realtime subscription never re-registers on a slug
change), and `reconnectPlayer`'s offline-Wrapped redirect (via `resolveSessionClubSlug`). `PwaNavBar`'s
Wrapped-suppression check widened from `pathname.startsWith("/wrapped/")` to `.includes("/wrapped/")` to also
catch the club-namespaced variant.

**Side-effect bugfix, not just a refactor.** The original root page fetched `session_wrapped_stats` via the
RLS-scoped client; that table's RLS only grants SELECT to the row's own player or a session organizer
(`20260423000000_session_wrapped_stats.sql`), so any third party opening someone else's shared Wrapped link
previously got silently bounced to the empty-stats fallback despite a real stats row existing. `getWrappedData`'s
always-service-role fetch fixes this as a side effect.

**Verified:** `tsc`/`build`/lint clean; independent review verdict **Minor issues, non-blocking** (the stats
RLS behavior change above, called out explicitly so it isn't mistaken for a silent regression; the
`.single()`→`.maybeSingle()` swap confirmed semantically equivalent for the not-found branches). Live-clicked
through both routes against a real prod session (`bcf19499…`, CHILLAX club — slug `legacy` at the time, now
`chillax`; the `/c/legacy/...` URLs below are the literal ones exercised then, and still resolve via the permanent
redirect): intro overlay + real awards feed
render correctly on both `/wrapped/...` and `/c/legacy/wrapped/...`; nav bar stays suppressed on both; the
"Done" button issues `GET /c/legacy` (confirmed via dev-server request log) on the club route vs `/play` on
root — both then bounce to `/` only because the test session wasn't authenticated (the membership gate doing
its job, not a Wrapped bug). The organizer-broadcast and offline-reconnect redirect sites were verified by
code reading + successful build only, not clicked through live (both require a live session-close/reconnect
event to trigger).

