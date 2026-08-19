# Multi-Tenant Phase 2 — Route Migration: Implementation Blueprint

> Derived from a 7-agent "understand" workflow (2026-06-30) that exhaustively mapped the change surface,
> plus a completeness-critic pass. Phase 0 schema is LIVE on prod; Phase 1 (club registration UI) is built.
> This is the **route migration** phase — the largest and most breaking.

## Strategy (LOCKED): ADD-and-redirect, not MOVE

Add new `/c/[clubSlug]/{play,organizer,tv,wrapped,leaderboard,join}` route segments that **re-use the
existing components** (PlayerDashboard, OrganizerDashboard, TvBoard, WrappedShell, LeaderboardPage,
LoginForm) by threading `clubSlug` via params/props. Keep the OLD root paths alive as **session-resolving
redirect shims** so already-printed QR codes, push deep-links, OAuth `?next=` chains, and bookmarks survive.
A pure MOVE would orphan every external link. Path builders live in `src/lib/club-paths.ts` (DONE) so the
~25 client call-sites don't re-hardcode the prefix.

**Public exceptions kept at root** (auth-free, shareable on gym displays): `/tv/[sessionId]` and
`/leaderboard/[sessionId]`. Add club-namespaced variants for in-app nav with a `session.club_id === club.id`
cross-check. `/rename`, `/clubs*`, `/`, `/offline`, `/sandbox` stay at root.

## The interdependency that prevents clean chunking

New `/c/[clubSlug]/play` routes only work once the shared components stop hardcoding `/play` and become
slug-aware. So "add new routes" and "thread the slug through shared components/hooks" are **coupled** —
they must land together. The only cleanly-additive, independently-mergeable slice is the **foundation**
(below), already built.

## Foundation — DONE (build-only, validated: tsc/lint/9 tests)
- `src/lib/club-paths.ts` + `tests/unit/club-paths.test.ts` — pure path builders.
- `supabase/migrations/20260701000000_lookup_active_session_club_slug.sql` — extend the RPC to return
  `club_slug` (DROP+recreate, grants restored). **NOT applied to prod yet.**
- `src/types/database.ts` — `lookup_active_session` Returns += `club_slug: string | null`.

## Ordered steps (remaining — all breaking/deploy-dependent)

1. **Apply** the `lookup_active_session` migration to prod (additive; unblocks the join flow). [med]
2. **Restructure `/c/[clubSlug]` into gated + public groups.** Today `/c/[clubSlug]/layout.tsx` redirects
   non-members to `/clubs` — that would bounce public TV viewers and pre-enrollment QR scanners. Split:
   minimal `/c/[clubSlug]/layout.tsx` (resolve club, `notFound` on miss) + a `(app)` group layout that adds
   auth + membership gate + chrome (move the existing lobby + admin into `(app)`); public `tv` and `join`
   sit outside the gate. [high]
3. **Add club-namespaced gated routes** re-using components: `(app)/play`, `(app)/play/[sessionId]`,
   `(app)/organizer`, `(app)/organizer/[sessionId]`, `(app)/leaderboard`. [high]
4. **Add public routes:** `/c/[clubSlug]/tv/[sessionId]` (+ club cross-check), `/c/[clubSlug]/wrapped/...`,
   `/c/[clubSlug]/join`. [high]
5. **Anon QR enrollment (CRITICAL):** page-level enroll in `/c/[clubSlug]/join` only fires for already-authed
   users. New scanners have no uid until `signInAnonymously` runs — so wire club enrollment into
   `signInAnonymously` (auth.ts:28-34) via a `club_slug` hidden field threaded through LoginForm, then upsert
   an active `club_members` row after profile creation (use the service client → bypasses RLS). [high]
6. **Thread `clubSlug` into ~25 client nav sites + 3 hooks**, switching to club-paths builders. Server
   actions that compute destinations (signInAnonymously, reconnectPlayer, page.tsx redirects) must **return**
   the resolved club-scoped destination; clients consume it. Key hooks: use-organizer-broadcast.ts:71
   (realtime `session_closed`→wrapped redirect for every player), use-queue.ts:136, use-organizer-dashboard.ts:237.
   Also pwa-nav-bar.tsx:57 (wrapped-suppression `startsWith('/wrapped/')` breaks under `/c/<slug>/wrapped/`). [high]
7. **PWA/SW/push:** manifest.ts start_url(15) + shortcut(62) → `/clubs`; sw.js push default(260) +
   notificationclick(273) → `/clubs` AND **bump CACHE_VERSION v2→v3** (sw.js:18) so installs replace the
   stale SW; push-server.ts:130 `data.url` → club-resolved `/c/<slug>/play/<sessionId>`; safe-next.ts:10
   fallback → `/clubs`. [high]
8. **createSession legacy path:** organizer-entry.tsx:93 calls createSession without clubId (→ Legacy via
   DB default). Under `/c/[clubSlug]/organizer`, resolve clubId from the param and pass it. The
   `isClubAdmin` gate (sessions.ts:115) is already correct. [med]
9. **OLD→NEW redirect shims (LAST, after new routes proven):** thin per-path resolve-and-redirect server
   pages (NOT middleware DB lookups — middleware matches all routes and would tax every request). Old pages
   become stubs that resolve `sessions.club_id → slug` and 308. Keep `/play/join` shim + root public
   `/tv`,`/leaderboard` forever for printed codes / shared displays. [high]
10. **E2E specs** (missed by all mappers, caught by critic): scenario-{a,b,e,f,h,j,k,l,m} hardcode
    `goto('/organizer/<id>')` / `/play/<id>`; update to `/c/<slug>/...` or assert through the redirect.
    Also tests/fixtures/auth.ts. [med]

## Redirect map (old → new)
| from | to |
|---|---|
| `/play` (no session) | `/clubs` |
| `/play/[id]` | `/c/<slug>/play/[id]` (resolve club_id→slug, 308) |
| `/play/join?session=<id>` | `/c/<slug>/join?session=<id>` (LOAD-BEARING QR path — keep forever) |
| `/organizer`, `/organizer/[id]` | `/clubs` · `/c/<slug>/organizer/[id]` |
| `/tv/[id]` | `/c/<slug>/tv/[id]` if slug resolvable, else serve public root |
| `/wrapped/[id]/[pid]` | `/c/<slug>/wrapped/[id]/[pid]` |
| `/leaderboard`, `/leaderboard/[id]` | `/c/<slug>/leaderboard...` (keep root public variant) |
| PWA start_url/shortcut `/play` | `/clubs` |
| sw.js + push-server defaults `/play` | `/clubs` / club-resolved deep link (+ CACHE_VERSION bump) |
| safeNext fallback `/play` | `/clubs` |

## Locked decisions (recommendations accepted)
- ADD + redirect (not MOVE). · Redirects = thin per-path server pages (not middleware). · Public TV +
  standalone leaderboard stay at root. · Anon enrollment wired into `signInAnonymously`. · PWA home →
  `/clubs`. · createSession passes clubId from route param. · safeNext fallback → `/clubs`. · Organizer
  switcher restricted to same-club sessions.

## Deferred to Phase 3 (DB view/RPC club-scoping — NOT Phase 2)
All leaderboard/aggregator club-scoping: `v_match_history` (root view — add club_id FIRST), then
`v_session_leaderboard` / `v_alltime_leaderboard_mat` (rekey to `(club_id,player_id)` + matching UNIQUE
index for `REFRESH CONCURRENTLY`), `get_player_streaks`, `get_alltime_snapshot_before` (⚠ absent from
migration files — reproduce live body), `get_monthly_leaderboard` + `get_leaderboard_months` (public
global merge today — the §6.12 visible bug), `get_h2h_record`. The coupled TS sites
(getAllTimeLeaderboard clubId, getPlayerStats `.eq(club_id)` before `.maybeSingle()`, monthly/h2h arg
threading, use-leaderboard.ts) must ship in the SAME release as their DB migration.

## Open / unverified (flag for implementer)
- **RLS gap:** the `is_session_organizer` SQL-function / RLS dimension's mapper failed; its club-admin
  addition + whether `club_members` RLS permits the anon scanner's own-row insert are **unverified**
  (auto-enroll via the service client sidesteps RLS, so that path is fine — confirm).
- Confirm the Legacy club row (`0000…0001`) has a usable non-null slug before relying on non-null `club_slug`.
- **Verification reality:** redirect shims, PWA cache, push deep-links, and QR enrollment cannot be verified
  build-only — they need a deploy (QR scan, PWA install, push). Recommend a Vercel preview deploy to verify.

## Overreach guard
Do NOT thread `clubId` through the ~30 session-scoped mutation actions. `isSessionOrganizer` + the
NOT-NULL 1:1 session→club already provide tenant isolation. Phase 2 = routing + auth/membership +
per-route guards + `createSession` clubId only.
