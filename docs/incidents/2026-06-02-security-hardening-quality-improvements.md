# 3.23 Security Hardening & Quality Improvements (2026-06-02)

> Extracted from `APP_MANIFEST.md` §3.23 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


A systematic audit was applied and all confirmed findings were resolved. Key architectural changes that affect future development:

**Profile actions require organizer gate (`src/app/actions/profile.ts`):**
All four profile mutation actions (`updatePlayerSkill`, `getPlayerPin`, `resetPlayerPin`, `updatePlayerPin`) now require both `getAuthenticatedUser()` AND `isSessionOrganizer(userId, sessionId)` as their first two guards. The `sessionId` parameter is the first argument on all four. Callers must pass the active session ID — `QueueControl` receives it via a `sessionId` prop from `OrganizerDashboard`.

**`createServiceClient` is server-only (`src/utils/supabase/service.ts`):**
`import "server-only"` is the first line. Accidentally importing this module into a Client Component now causes a hard **build error**. The `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` fallback has also been removed — only `SUPABASE_SERVICE_ROLE_KEY` (no `NEXT_PUBLIC_` prefix) is accepted.

**Global App Router error boundaries (`src/app/error.tsx`, `src/app/not-found.tsx`):**
`error.tsx` catches unhandled errors in any route segment with a "Try again" reset button. `not-found.tsx` renders a 404 page with a home link. Both use the existing design system tokens.

**PIN security (`src/app/actions/profile.ts`):**
`resetPlayerPin` uses `crypto.getRandomValues()` instead of `Math.random()`. `updatePlayerPin` rejects `"0000"` explicitly.

**`getH2HRecord` is session-gated (`src/app/actions/h2h.ts`):**
See §3.11 for the updated auth model.

**`src/lib/realtime.ts` — debug logs stripped:**
All `console.log` calls removed from hot subscription paths. Only `console.error` remains (CHANNEL_ERROR / TIMED_OUT). `castPayload<T>()` helper centralises the unavoidable Supabase SDK type assertion for unfiltered subscriptions. File header updated to reflect new debug behavior.

**History data via server actions (`src/app/actions/history.ts`):**
See §3.16 for the updated data layer.

**Action return shape consistency:**
All `{ error }` bare returns in `auth.ts` and `sessions.ts` now include `success: false`. The canonical shape `{ success: boolean, message?: string, error?: string }` from CLAUDE.md is now enforced across all action files.

---

