# Phantom 14–31 completed with no scorer (2026-10-03)

> Dated incident write-up, not current-state documentation. Current behaviour:
> APP_MANIFEST §3.3, §3.15. Types: `src/types/database.ts` (`complete_match_with_score`,
> `start_match_on_court`). Attribution spec: `src/lib/score-attribution.ts`.

**Session:** `1b7f5a32-1846-4880-9ca0-3144c6385086` (2026-10-03 Saturday)
**Match:** `ca0d02ef-f2c3-4ec6-a581-e9115460069d` (deleted after audit)
**Score:** 14–31 in 29.7s. Players said the game never happened.

## What happened

Timeline (Manila):

- 12:25:47 engine created the draft
- 12:25:58 Miggy `publish_all`
- 12:26:14 Court 11 start — no starter in `match_events`
- 12:26:44 14–31 complete — no scorer in `match_events`

`endMatchInternal` wrote `matches.status=completed` via a JS CAS UPDATE and never inserted a `scored` event. `promoteOnDeckMatchInternal` wrote `in_progress` / `started_at` / court `in_use` / queue `playing` the same way and never inserted a `started` event. Stelle was not an organizer until session end. Infra logs (Vercel/Supabase) did not retain the scorer.

Cleanup (prod, before this change): match + events deleted; `games_played` reversed; ledgers / wrapped / leaderboard rebuilt. Two other sub-60s scores in the same window were left in place (players did not dispute them).

## Why

The complete and start writes were not transactional with `match_events`. A score could exist with no actor. The engine never self-completes; a human or a client called the action. Without an event we cannot say who.

## Fix

Migration `20261004000000_score_and_start_actor_logging.sql` (TypeScript in the same change). Prod stamp `20261003185541` / `score_and_start_actor_logging`.

- `complete_match_with_score`: CAS complete + `scored` event. No JS fallback (`PGRST202` refuses the score).
- `start_match_on_court`: CAS promote + court + queue + `started` event. Call-next is organizer; after-score / after-cancel are `system` with null `actor_id`.
- `revert_match_to_active` refreshes `started_at`.
- `executeMatch` refuses `!isOnDeck` (dead branch that would have created an in-progress match with no start event).
- History copy (`describeMatchEvent`) never renders `seconds_since_start`.

Pins: SA-1…SA-6, MEC-1…MEC-5, EMC-1…EMC-4, EX-1, MP-CNT-03 (includes `scored`/`started`), Suite F `F-score-actor-*`, e2e scenario-o scored-event assertion.
