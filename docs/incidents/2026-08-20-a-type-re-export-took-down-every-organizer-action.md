# A type re-export took down every organizer server action

**Reported:** 2026-08-20 — "I have a new session currently in production, but I can't seem to
toggle off auto matchmaking."
**Window:** first occurrence 2026-08-16T08:39:07Z, last 2026-08-20T10:10:29Z. Four days.
**Blast radius:** 57 recorded occurrences across 4 users, on
`/c/[clubSlug]/organizer/[sessionId]` and `/c/[clubSlug]/play/[sessionId]`.
**Fix:** `fix/use-server-type-reexport` — one deleted line in
`src/app/actions/notifications.ts`, plus `tests/unit/use-server-exports.test.ts`.

## The symptom, and why it was misleading

The organizer pressed **Auto On**. The button showed a spinner, then flipped back to **Auto On**.
No error toast that named anything real, no obviously broken page, and the rest of the board kept
updating — matches ran, the queue moved, realtime was fine.

That reads like a failed write. It was not a write at all. Supabase `edge_logs` showed **zero**
calls to `/rest/v1/rpc/toggle_auto_matchmaking` for the whole window. Nothing ever reached
Postgres.

The snap-back is `handleToggleAuto` in `use-organizer-dashboard.ts` behaving exactly as designed.
It sets `pendingAuto` optimistically, and the rendered value is `pendingAuto ?? liveAutoMatchmaking`.
When the action 500s, the `catch` resets `pendingAuto` to `null` and the button falls back to the
live value — which never changed. A correct optimistic-UI yield-back rendered a total failure as a
no-op.

## Root cause

`src/app/actions/notifications.ts` carries `"use server"` on its first line and carried one line of
type plumbing:

```ts
export type { NotificationType };
```

Next's server-action transform enumerates every export **specifier** of a `"use server"` module and
emits each as a runtime identifier:

```js
(0, o.ensureServerEntryExports)([F, G, H, I, J, K, L, NotificationType])
```

`NotificationType` is a type. It has no runtime binding. The array references a free variable, so
the chunk — `src_app_actions_queue_ts_*.js`, named after one module but bundling many — threw
`ReferenceError: NotificationType is not defined` at module evaluation. The organizer route's
server-action entry transitively instantiates that chunk, and `toggleAutoMatchmaking` lives in the
same entry. Every organizer action on the route 500'd.

## Why nothing caught it

The line was introduced in `4e2419a` and sat harmless for over two months. It only became fatal on
2026-08-16, when chunking changed and put the offending module in the organizer entry's graph. The
source never changed on the day it broke.

`npx tsc --noEmit`, `npm run lint`, `npm run test:unit` and `npm run build` were all green
throughout — the type erases in every one of them. The defect exists **only** in emitted bundle
code. `next build` does not evaluate the chunk it emits, so a successful build proves nothing here.

## The rule this produced

A `"use server"` module never re-exports a type. Declare the type in a plain module and import it.
An inline `import { fn, type X }` specifier and a type *position* are both fine; a type alias
*declaration* (`export type ActionResult = …`) is also fine — it declares rather than re-exports,
and the transform drops it. The failing production is the export **clause**.

`tests/unit/use-server-exports.test.ts` pins the class by reading the source tree: US-1 asserts no
`"use server"` file carries a type-only export clause, US-2 proves the detector discriminates so
US-1 cannot pass by scanning nothing.

## Verifying a fix of this shape

Grep the emitted bundle, not the type checker:

```
grep -o "ensureServerEntryExports)(\[[^]]*\]" .next/server/chunks/ssr/src_app_actions_queue_ts_*.js
```

Before: `[F,G,H,I,J,K,L,NotificationType]`. After: `[F,G,H,I,J,K,L]`. A bare capitalised identifier
in one of those arrays is the defect, visible directly.

## Mitigation taken during the incident

`is_auto_matchmaking_on` was set to `false` by hand on the live session
(`28c224fa-918c-41d0-823b-9e6b00d893cd`) so the organizer was unblocked before the fix deployed.
`runEngineForSession` re-reads the flag with its own service client and no-ops when it is off, so
flipping the column genuinely pauses the engine; the organizer can flip it back with one click once
the deploy lands.
