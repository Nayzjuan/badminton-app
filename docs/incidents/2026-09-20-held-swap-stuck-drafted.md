# 3.4 / 3.1 Held-draft bench-swap left Darwin stuck Drafted (2026-09-20)

> Dated incident write-up, not current-state documentation. `src/` and
> `src/types/database.ts` are the authority. Current behaviour: APP_MANIFEST
> §3.4, §3.1 (held drafts / R3-1 / N-2), §3.22.

**Session:** `142785ae-e2fb-4b09-8c5e-7df3ba093d8b`
**Player:** Darwin (`a2ff9672-4d7b-4746-a41c-1d4ecd7a1285`)
**Held draft:** `615215d7` created 06:59:04 UTC with Darwin as the pulled body from source `446e4b33`.

## What happened

The organizer bench-swapped Darwin → Jay on the unpublished hold at 06:59:40. Darwin was still on court. `swap_player_in_match` Step d wrote him to `waiting` anyway. At 07:00:25 the source match ended; `endMatchAction` R3-1 re-reserved him as `drafted` because `pulled_player_ids` still named him (swap never ran `recomputeHeldReadiness` / N-2). He sat Drafted with no `match_players` row until he left and rejoined at 07:11:14. The hold published at 07:07 as a non-held Says/Lianne/Jay/Lei roster.

## Why

Two holes, same class:

1. Roster mutations hardcoded queue status (`waiting` / `on_deck` / `drafted` from `p_is_published` or `p_drafted_ids`) instead of asking where the player physically sits.
2. A stale `pulled_player_ids` pointer was treated as membership. N-2 only ran on end/cancel, and only checked the *held* roster, so a live-swap of the body off the source court left the pointer intact for R3-1.

The same class on other doors: `swap_match_players` never wrote `queue_entries` (drafted↔on_deck crossed); `swap_active_from_ondeck` hardcoded the fill as `on_deck` even into an unpublished hold; tap-swapping a playing body onto a second pending roster was allowed.

## Fix

Migration `20260920000000_queue_status_follows_roster.sql` (TypeScript in the same PR). **Not applied to prod at write time — migrations are hand-applied.**

- `queue_status_after_roster_change`: in_progress → playing; unpublished pending → drafted; published pending → on_deck; else waiting. Never writes `left`.
- Swap / requeue RPCs apply it. `p_drafted_ids` is ignored.
- `swap_match_players` rejects a still-playing body.
- `recomputeHeldReadiness` N-2b downgrades when the body is missing from a still-live source court. Callers after every pending/live roster mutation.
- Cancel restore intersects the pointer with the hold roster (`bodiesStillOnHeldRoster`).
- Undo is offered only when the outgoing player returned to `waiting`.

Pins: `tests/integration/held-swap-queue-status.test.ts` (HS-1…HS-8), `CC-RDY-CC05`, `CC-RDY-ERR6`, `CC-CAN-08`/`CC-CAN-09`.
