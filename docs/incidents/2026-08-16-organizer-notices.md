# 3.42 Organizer notices — leave-queue + 15-minute pause reminder (2026-08-16)

> Extracted from `APP_MANIFEST.md` §3.42 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


**Files:** `src/lib/organizer-alerts.ts`, `src/hooks/use-organizer-alerts.ts`, `src/components/organizer/{organizer-center-alert,paused-badge}.tsx`, `src/lib/broadcast.ts` (`queue_notice`), `src/lib/realtime.ts`, `src/hooks/use-organizer-{session,data}.ts`, `src/app/actions/queue.ts`, `src/lib/constants.ts` (`PAUSE_REMIND_MINUTES`), migration `20260817000000_queue_leave_notices`.

A leaver **vanishes** from Match Control (`v_queue_full_with_wait_time` excludes `left`). The notice is what tells organizers who disappeared.

**Leave.** `checkoutPlayer` and `removePlayerFromQueue` emit `queue_notice` on the existing private `session-events:{id}` channel. Self-leave has no `actorId` — every open organizer dashboard shows a centered dismissible card. An organizer kick attaches `actorId`; that organizer's own client suppresses (they just confirmed the dialog). Copy: "{Name} left the queue", plus a line only when an **unpublished** draft was cancelled (a published on-deck teardown does not use that line). Already-left / not-in-session checkouts are silent.

**Pause reminder.** `queue_entries.paused_at` is stamped on pause and cleared on resume, self-leave, organizer remove, and rejoin. Each open dashboard computes `floor(minutes / 15)` locally (15s tick + queue refetch) and enqueues the same centered card at 15 / 30 / 45 …. An in-memory Set of `${playerId}:${bucket}` prevents a dismissed bucket from coming back. Resume clears that player's keys. The Match Control badge upgrades from "Paused" to "Paused 15m" (amber) / "Paused 30m" (red).

**Held-draft restore.** `checkout_player_cleanup_drafts` already restored only `status = 'drafted'` (hotfix `20260511210001`). The 20260817 replace keeps that contract and documents why: a held draft's pulled body stays `playing` and must not be written to `waiting`. The TypeScript fallback now mirrors the restore (it previously cancelled the draft and left the other three `drafted`).

**Not done:** Web Push to organizers; a persistent "left" list in Match Control. The on-deck / playing leave refusal is unchanged (§3.39). Inbox + player score-correction requests are §3.43.

