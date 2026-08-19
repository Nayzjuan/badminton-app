# 3.31 Session close — three delivery paths, one destination decision (2026-08-11)

> Extracted from `APP_MANIFEST.md` §3.31 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


The complaint was "the Session Wrapped doesn't fire right away when I close the session, and players get stuck." Two different bugs wearing one costume, plus a third that only *looked* like slowness.

**Files:** `src/hooks/use-session-closed-watcher.ts` **(new)** · `src/lib/with-timeout.ts` **(new)** · `src/utils/supabase/client.ts` · `src/lib/broadcast.ts` · `src/lib/realtime.ts` (`subscribeToSessionRow`) · `src/app/actions/sessions.ts` (`closeSession`, `getPlayerSessionStatus`, `renotifySessionClosed`) · `src/app/actions/_shared.ts` (`isSessionActive`) · `src/app/actions/{queue,matchmaking,match-lifecycle}.ts` · `src/app/actions/wrapped.ts` · `src/components/wrapped/wrapped-shell.tsx` · `src/hooks/use-organizer-{broadcast,dashboard,data,session}.ts` · `src/components/organizer/organizer-dashboard.tsx` · `src/app/c/[clubSlug]/(full)/play/[sessionId]/page.tsx` · `tests/unit/use-organizer-{broadcast-closure,dashboard}.test.ts`

> **No migrations.** Every change here is application code. `sessions` was already in the `supabase_realtime` publication with `is_active` and `id` in the narrowed column list, and `sessions_select` already admits every club member — so the new row subscription needed nothing from the database.

#### A. The socket recycle was bricking realtime (the real "nothing fired" bug)

`onAuthStateChange` recycled the Realtime socket on an anon→real transition with `disconnect(); connect();`. Both look symmetric; they are not. `RealtimeClient.disconnect()` is **async** and sets `isDisconnecting()` for its duration, and `connect()` early-returns on `isConnecting() || isDisconnecting() || isConnected()`. Called back to back, `connect()` did **nothing** — and the socket was left closed with `closeWasClean = true`, the exact flag phoenix uses to suppress all three of its recovery paths (the `onConnClose` reconnect timer, the `visibilitychange` rescue, the `pageshow` rescue). The tab ended up with no socket and nothing that would ever open one. `recycleRealtimeSocket()` awaits the teardown, guards against overlapping recycles with `recycleInFlight`, and re-arms once at 500 ms. The old comment claiming "worst case equals the status quo" is retracted in place — it was false, and this was strictly worse than the anon-bound channels it meant to fix.

`whenRealtimeAuthReady()` is now **bounded** (3 s). Every subscribe helper builds its channel *inside* that promise's `.then()`, so a `getSession()` that never settles meant no channel was ever constructed — no `.subscribe()`, no status callback, nothing logged, and indistinguishable from a healthy idle connection. Joining as `anon` after 3 s is bad; joining *never*, invisibly, is worse. `realtimeAuthSettled` skips the race once hydration lands, so the timer costs only a cold start.

#### B. One watcher, three independent paths — `useSessionClosedWatcher`

The closure logic moved out of `useOrganizerBroadcast` into a hook both the player dashboard and the organizer board mount. It listens on three paths that **fail independently**:

1. **Broadcast** (`session_closed`) — the fast path. Now retried once inside `postBroadcast`, the only sender that opts in: it is the one event with no cheap alternative, and the receiver latches on `navigatedRef`, so a duplicate delivery is a no-op.
2. **`subscribeToSessionRow`** — postgres_changes `UPDATE` on `sessions` filtered `id=eq.<id>`. A *committed row change*, so any tab holding a live join gets it even when the broadcast POST never happened.
3. **Status poll** — `SESSION_STATUS_POLL_MS = 20_000`, floored by `SESSION_STATUS_MIN_GAP_MS = 5_000`, plus `visibilitychange` and channel-status re-checks. Covers the tab with no working socket at all.

⚠️ **Do not wire path 2's `onStatus` into `useOrganizerSession.handleChannelStatus`.** That counter asserts an exact `REALTIME_CHANNEL_COUNT = 5` of postgres_changes channels; a sixth pegs the board's "live" indicator to disconnected forever.

**Every path converges on one destination decision**, because sending a player to Wrapped is only right if a recap exists for *them*. `compute_session_wrapped` builds `_wrapped_stats` from `matches … status='completed'`, so anyone who never finished one gets **no row** — walk-ins, late arrivals, the organizer who only ran the board. `getPlayerSessionStatus` therefore returns `hasWrapped` alongside `isActive` (scoped to `user.id`, never a caller-supplied id, so it cannot probe whether someone else attended), and `resolveDestination` reads it only when `!isActive`, matching the field's documented contract. No recap → the club lobby.

**The redirect/probe race, and why `Promise.all`.** The toast delay and the destination probe run **concurrently** and the push waits on both — not the probe *inside* the timer, and not the timer *after* the probe. A probe slower than the delay would otherwise navigate late or, worse, resolve first and fire twice. Pinned by OBC-10e.

**`isActive: null` is not `false`** (unchanged from §3.30 and still the invariant that matters): unknown holds the dashboard. Only a definite `success && !isActive` navigates.

#### C. Latency — measured, and the client was the bigger half

`pg_stat_statements` on prod, 123-day window: `compute_session_wrapped` **68 ms min / 237 ms mean / 827 ms max**, `refresh_cross_session_stats` **8.5 / 109 / 604 ms**. Player-visible total ≈1.2–1.5 s typical. The honest finding: **the client's own deliberate `WRAPPED_REDIRECT_DELAY_MS` of 800 ms was larger than the ~346 ms of server pre-work.** It is now **250 ms**.

**Deliberate deviation from the audit's prescription — recorded because it will look like an oversight later.** The audit called for flipping `is_active` and broadcasting *first*, with both RPCs moved into `after()`. Implemented instead: **compute stays before the flip; the cleanups moved to after the broadcast.** Three reasons. (a) `after()` buys ~346 ms mean. (b) It breaks the invariant that Wrapped rows exist at broadcast time — `broadcastSessionClosed(sessionId, wrappedReady)` is only meaningful because `wrappedReady` is *known* at emit time. (c) An `after()` failure can never be reported to the organizer. The reordering that actually mattered was the cleanups: they cancel every match, mark every queue entry `left` and close every court — **~30 postgres_changes events fanned to ~40 phones**, previously arriving while the session still read ACTIVE and nothing had said why. **That is the "I got kicked out of the queue" report**, and it explains it better than server latency does. The failure mode improves too: before, cleanups could apply while the flip failed (a half-torn-down session nobody was told about); now the session closes and stale rows are unreachable anyway.

**08/15/2026: a hung pre-compute stranded the session.** PostgREST never returned from the two RPCs (Warp `Thread killed by timeout manager` on a ~60 s cadence). The same calls completed in well under a second as `postgres`. Because compute still runs *before* the flip, an unbounded await meant Vercel killed the action and `is_active` stayed true — Saturday sat open until a manual close two days later. Each RPC is now raced against **`CLOSE_WRAPPED_RPC_MS = 3_000`** (`withTimeout`). Timeout, throw, or `{ error }` is non-fatal: we flip anyway and `wrappedReady=false` sends viewers to the lobby. The abandoned query may still commit rows after the close; that is fine. Do **not** retry on timeout — the original PostgREST thread is still running.

`compute_session_wrapped` also stops retrying on **`57014`** (statement timeout) and **`55P03`** (lock_not_available). Both mean the budget was spent waiting on the per-club advisory lock; an immediate retry queues behind the same holder. The organizer is holding a spinner for all of it, so we stop here and let `wrappedReady=false` drive the fallback instead. Pinned by `tests/unit/close-session-timeout.test.ts` (CST-1…4).

#### D. The organizer's own board, and an undelivered broadcast

`closeSession` now returns `delivered` (the Realtime API accepted the POST) and `alreadyClosed` (an explicit flag, not a message match, so re-wording the copy cannot turn a double-submit back into a red toast — the organizer's UI treats it as success). `delivered: false` surfaces a warning toast with a **Re-send** action calling `renotifySessionClosed` — the escape hatch for the one failure the flow cannot self-heal, where the session is closed but no phone was told and the only other remedy is walking the gym.

Three UI fixes that only appear together: `AlertDialogAction` **is** Radix's `Dialog.Close`, so without `e.preventDefault()` the dialog dismissed on the same click that started the request and "Closing session…" painted once onto a node already fading out — which is most of what "it didn't fire" *looked* like. That in turn requires `{(!isClosed || closing) && …}` on the controlled dialogs, because `isClosed` now derives from `liveSession` and the organizer hears their own close echo mid-flight. And `activeTab` is now **derived** (`effectiveTab`) rather than initial-state-only, because the tab set drops 5→2 on a live close and a stored `courts` would leave the strip with nothing selected beside a panel of live court controls.

Both destination probes in `handleCloseSession` are **bounded and caught** (`withTimeout`, 1.2 s). The session is already committed closed when they run, so they only choose between two destinations — but unguarded, a rejection escapes to the outer catch and reports **failure for a close that succeeded**, and a hang means `finally` never runs: `closing` latches true, no push fires, `suppressCloseWatcher(false)` is never reached, and all three watcher paths stay dead with nothing left to recover the board.

#### E. Post-close writes are refused — with production receipts

`isSessionActive(sessionId)` (in `_shared.ts`) gates `joinQueueAction`, `callNextMatch`, `createManualMatchAction` and `toggleAutoMatchmaking`. Not hypothetical: prod carries two queue entries created **46.7 s** and **2.2 s** after their session's `ended_at`, both from the player dashboard's Join Queue button, both by non-organizers whose boards had not learned the session was over. A late entry is not harmless — `closeSession` has already marked every entry `left` and computed Wrapped, so the row is invisible to the recap and permanently stuck `waiting`.

Enforced in the actions rather than in the database on purpose: a CHECK or trigger would reject with a Postgres error string every action would then pattern-match to say anything human, **and would fire on `closeSession`'s own teardown UPDATEs**. It **fails OPEN** — an unreadable session row returns `true`, because a transient read failure must never block a legitimate write mid-session.

#### F. The sticky empty-Wrapped redirect

`dismissWrappedIntro` now uses `{ count: "exact" }` and reports `dismissed`. `success: true, dismissed: false` is the silent failure it exists to surface: no `session_wrapped_stats` row for this pair, so the dismissal has nowhere to land and the intro replays forever. The club play page closes the other half — `if (!wrappedStats) redirect(clubBase(clubSlug))` **before** the `intro_dismissed_at` check, because `maybeSingle()` yields null for a rowless viewer and the page used to fall through to Wrapped and render `EMPTY_STATS`. This branch now runs far more often, since the watcher calls `router.refresh()` on close; without it the server redirect unmounts the dashboard and **cancels the client's carefully-probed push**. `src/app/play/[sessionId]/page.tsx` is a pure redirect shim, so the club page is the only site.

> **`intro_dismissed_at` is NOT a bug.** It has exactly one writer (`dismissWrappedIntro` ← `WrappedShell.handleDone`) and is NULL for everyone at close time. It is a correct re-entry guard. Do not "fix" it.

**Out of scope by explicit decision:** the **TV board**. A gym screen stays on its last frame until someone reloads it. Chosen deliberately, not missed.

**Coverage:** `use-organizer-broadcast-closure.test.ts` 40 cases (OBC-1…14) · `use-organizer-dashboard.test.ts` 50 cases (adds OD-10b, OD-22a–k, OD-23a–b). Suite **1057 passing / 1 skipped across 58 files**.

**End-to-end, against production** — `tests/e2e/scenario-r-resilience.spec.ts` **[R-2a]** (a viewer with no completed match lands on the club lobby) and **[R-2b]** (a viewer with one lands on their Wrapped page). The single [R-2] they replace asserted the *superseded* contract — always Wrapped — and would have failed correctly; Playwright is not in CI, so nothing caught it at merge time. Assume nothing about E2E coverage after a behaviour change of this kind.

Three properties of that test worth preserving. (a) **The toast identifies nothing about the delivery path** — `leaveClosedSession` emits the same one on all three; what makes it a fast-path test is suppressing the 20 s poll and bounding elapsed time. (b) **A probe run serially before the thing you are timing poisons it**: the toast probe's own 15 s timeout used to guarantee `elapsed >= 15_000` on a miss, failing with "the redirect was slow" when the redirect was fine. They race in one `Promise.all` now. (c) **These assert the composite destination, not `resolveDestination`**: §3.31 F's `router.refresh()` fires before the push and the RSC's identical per-viewer branch normally wins, so a client probe that always answered "Wrapped" would still pass R-2a. That branch is unit-covered; what only E2E can prove is that a real close over a real socket puts a real browser on the right page.

**Shipped:** PR #55 → main `6592864` → Vercel production `dpl_Du2Sj1D3ac4yArWXbohHiiFTLTyN` READY, zero runtime errors. Full scenario-R run against prod: **7/7**. The [R-2a]/[R-2b] rewrite followed as PR #56 → main `1688e95` → `dpl_EX5zdnYWyPh37V6SfEBtAbSVBANe` READY (test + docs only, no `src/` change).

---

