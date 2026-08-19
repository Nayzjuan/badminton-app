# 3.43 Organizer notice inbox + player score correction (2026-08-16)

> Extracted from `APP_MANIFEST.md` §3.43 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


**Files:** migration `20260818000000_session_notifications`, `src/types/database.ts`, `src/app/actions/notifications.ts`, `src/lib/session-notifications.ts`, `src/hooks/use-organizer-alerts.ts`, `src/components/organizer/{organizer-notice-inbox,organizer-center-alert,edit-match-dialog}.tsx`, `src/components/player/{match-history,score-correction-request}.tsx`, `src/app/actions/{queue,match-lifecycle}.ts`.

**Inbox.** `session_notifications` is the durable log. Kinds: `player_left`, `player_checked_out`, `player_paused_long`, `score_correction`. Status: `unread` / `read` / `resolved` / `superseded`. Hydrate on Match Control load (`fetchSeq`). Live updates reuse `queue_notice` on private `session-events:{id}` (full row upsert). No sixth Realtime table channel — `realtimeConnected` stays at 5. A 45s visible-tab poll plus visibility refresh catch missed broadcasts.

**Center then inbox.** A new unread/pending row interrupts with the existing centered card (cap 5). Dismiss files it into the bell. Informational dismiss → `read` (badge drops). Score-correction dismiss stays pending — looking is not handling. Actor suppress is **only** for `player_checked_out` when `actorId` is this organizer.

**Uniques.** One pending score correction per `match_id`. One pause row per `(session_id, subject_player_id, payload.bucket)`. Unique violation → no second broadcast. Leave-after-rejoin is a new row. Q-8 already-left / not-in-session does not insert. Insert failure after a successful leave still broadcasts so the board is never silent.

**Pause catch-up.** `recordPauseReminder` re-reads `is_paused` / `paused_at` and recomputes the bucket server-side. A bucket that was already due when the tab hydrated inserts as `read` with `interrupt: false`. Only a bucket that crosses while the tab is open interrupts.

**Score correction.** Session history only (not all-time). Player form labels Team A/B with names and submits `team_a_score` / `team_b_score`. Organizer Review opens the existing Edit Match dialog, pre-filled with the proposal. `resolve_score_correction` is `SECURITY DEFINER`, `GRANT service_role` only, `FOR UPDATE`, CAS on `matches.status = 'completed'`. Resolve against a reverted match fails and **leaves the notice pending**. History pencil save closes pending as `resolved`; revert closes as `superseded`. Closed session: no new requests / pause inserts; bell is read-only.

**Writes.** Gated Server Actions (`list` / `markRead` / `recordPauseReminder` / `request` / `resolve`) use the service client after `isSessionOrganizer` (the primary organizer has no `session_organizers` row). `emitOrganizerNotice` and `closePendingScoreCorrections` live in `src/lib/session-notice-write.ts` (`import "server-only"`) so they are not public POST endpoints. Authenticated clients have SELECT on their own correction rows only — no INSERT grant (the pending-correction unique would otherwise be poisonable). `resolve_score_correction` is `REVOKE`d from `PUBLIC`, `anon`, and `authenticated` by name (default privileges would otherwise leave EXECUTE on the RPC). Do not `DROP` the RPC.

**Not done:** Web Push. Migration `20260818000000` is **applied on prod** (stamp `20260816065517`).

---

