# Project: Cross-Session Awards (B+E)

## Goal

Extend Session Wrapped so awards have memory across sessions. Players with recurring rivalries, long-term partnerships, momentum across sessions, and consistent performance get richer, more personalised awards — not just a snapshot of one night.

## Approach

Three new persistence primitives are added:

1. **`player_rivalries`** — running win/loss ledger between every pair of players across all sessions (directional: A→B and B→A both stored).
2. **`player_partnerships`** — running games/wins/sessions ledger between every player pair who has teamed up.
3. **`carry_forward jsonb`** column on `session_wrapped_stats` — stores a small per-player payload (streak, win_pct, session_id) that the _next_ session's RPC reads for momentum signals.

A new `refresh_cross_session_stats(p_session_id)` RPC upserts both tables at session close (before `compute_session_wrapped`), mirroring the existing `refresh_alltime_leaderboard()` pattern. `compute_session_wrapped` is then extended to read all three sources and emit 9 new award slugs plus richer subtitles on 4 existing awards.

## Phases

### Phase 1 — Schema Migration

Create `player_rivalries`, `player_partnerships` tables and add `carry_forward` column to `session_wrapped_stats`. Add indexes. Add new types to `src/types/database.ts`.

### Phase 2 — `refresh_cross_session_stats` RPC

New plpgsql function that reads completed matches from the session and upserts into both ledger tables. Handles directional upserts, per-session dedup for `sessions_faced` / `sessions_together`, and `last_session_id` tracking.

### Phase 3 — Wire into `closeSession`

Call `refresh_cross_session_stats(sessionId)` before `compute_session_wrapped(sessionId)` in `src/app/actions/sessions.ts` (or wherever `closeSession` lives).

### Phase 4 — Expand `compute_session_wrapped`

- Pre-compute cross-session data for all players before the award loop:
  - `rivalry_stats` — join `player_rivalries` for each player's all-time records
  - `partnership_stats` — join `player_partnerships` for all-time partner data
  - `prior_sessions_pct` — last 2 rows from `session_wrapped_stats` per player (for rolling last-3 including tonight)
  - `prior_carry_forward` — most recent `carry_forward` per player
- Enhance 4 existing award subtitles (same slug, richer data in `award_data`)
- Add 9 new award IF blocks
- Write `carry_forward` payload into the final upsert

### Phase 5 — TypeScript: `AWARD_META` + types

- Add 9 new entries to `AWARD_META` in `src/lib/wrapped-awards.ts`
- Update `session_wrapped_stats` type in `src/types/database.ts` to include `carry_forward`

---

## Award Inventory

### Enhanced existing (same slug, richer subtitle / award_data)

| Slug             | Enhancement                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `my_nemesis`     | Subtitle now shows all-time H2H record ("They're 7–3 against you all time")                |
| `kryptonite`     | Subtitle shows all-time dominance count                                                    |
| `loyal_partner`  | Fires on 3+ games tonight OR 10+ games all-time (subtitle distinguishes path)              |
| `redemption_arc` | Fires on same-session OR cross-session (lost to pair last session, beat them this session) |

### New slugs (9 new → 60 total awards)

| Slug                   | Trigger                                                                          | Category    | Rarity    |
| ---------------------- | -------------------------------------------------------------------------------- | ----------- | --------- |
| `nemesis_slayer`       | Beat your all-time nemesis tonight (rival has net H2H advantage all-time vs you) | Nemesis/H2H | Rare      |
| `settled_the_score`    | Losing all-time H2H record vs rival → levelled or flipped it tonight             | Rivalry     | Rare      |
| `the_dynasty`          | 5+ all-time wins vs same rival, ≥70% win rate vs them                            | Rivalry     | Legendary |
| `serial_rivals`        | Faced same rival in 3+ distinct sessions all-time                                | Rivalry     | Uncommon  |
| `soulmates`            | 20+ games together across multiple sessions                                      | Social      | Rare      |
| `winning_formula`      | 60%+ win rate with specific partner, 6+ games together all-time                  | Social      | Uncommon  |
| `consistent_dominator` | ≥70% win rate in 2 of last 3 sessions (rolling, current session counts)          | Performance | Legendary |
| `momentum`             | Ended last session on win streak ≥3, AND won first game tonight                  | Streak      | Rare      |
| `bounced_back`         | win_pct < 50% last session → ≥50% this session                                   | Resilience  | Uncommon  |

---

## Schema Detail

### `player_rivalries`

```
player_id       uuid PK (→ profiles.id)
rival_id        uuid PK (→ profiles.id)
wins_vs         int  DEFAULT 0   -- player_id's team beat rival_id's team N times
losses_vs       int  DEFAULT 0   -- rival_id's team beat player_id's team N times
sessions_faced  int  DEFAULT 0   -- distinct sessions where they were on opposing teams
last_session_id uuid → sessions.id
last_faced_at   timestamptz
updated_at      timestamptz
PRIMARY KEY (player_id, rival_id)
```

Directional: (A, B) and (B, A) stored independently.

### `player_partnerships`

```
player_id        uuid PK (→ profiles.id)
partner_id       uuid PK (→ profiles.id)
games_together   int  DEFAULT 0
wins_together    int  DEFAULT 0
losses_together  int  DEFAULT 0
sessions_together int DEFAULT 0   -- distinct sessions as partners
last_session_id  uuid → sessions.id
last_played_at   timestamptz
updated_at       timestamptz
PRIMARY KEY (player_id, partner_id)
```

Directional: (A, B) and (B, A) stored independently.

### `session_wrapped_stats.carry_forward`

```json
{
  "ended_on_win_streak": 4,
  "session_win_pct": 65.5,
  "session_id": "uuid-of-this-session"
}
```

---

## Key Decisions

- **Rolling last-3**: uses `session_wrapped_stats` (last 2 prior rows) + tonight = 3 sessions total.
- **`soulmates` threshold**: 20 games together all-time.
- **Nemesis slayer trigger**: rival's `wins_vs` > player's `wins_vs` all-time (net negative H2H).
- **Slug strategy**: 4 enhanced existing slugs (same slug, richer subtitle). 9 fully new slugs.
- **`refresh_cross_session_stats` timing**: runs BEFORE `compute_session_wrapped` so the RPC sees fully updated rivalry/partnership data including tonight's matches.
- **Directional storage**: both (A, B) and (B, A) rows maintained for simple per-player queries.
- **No triggers**: tables updated only at session close via RPC (not per-match), same pattern as `refresh_alltime_leaderboard`.

## Files Affected

| File                                                                  | Change                                                                                       |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `supabase/migrations/20260510000000_cross_session_awards.sql`         | NEW — schema + `refresh_cross_session_stats` RPC                                             |
| `supabase/migrations/20260510000001_expand_wrapped_cross_session.sql` | NEW — updated `compute_session_wrapped`                                                      |
| `src/types/database.ts`                                               | Add `PlayerRivalry`, `PlayerPartnership` types; add `carry_forward` to `SessionWrappedStats` |
| `src/app/actions/sessions.ts`                                         | Call `refresh_cross_session_stats` before `compute_session_wrapped`                          |
| `src/lib/wrapped-awards.ts`                                           | 9 new `AWARD_META` entries                                                                   |

## Notes & Context

- `compute_session_wrapped` already starts with `PERFORM refresh_alltime_leaderboard()` — `refresh_cross_session_stats` follows the same pattern.
- All new award IF blocks use pre-computed CTEs / pre-fetched data, NOT per-player subqueries inside the loop (avoids N+1).
- `carry_forward` is written as part of the existing upsert into `session_wrapped_stats`, not a separate query.
- Prior carry_forward is read via a pre-loop bulk query (one row per player for last prior session) stored in a temp table.
- `sessions_faced` / `sessions_together` are incremented by 1 per session per pair (not per match), using a DISTINCT pair CTE inside `refresh_cross_session_stats`.
- The `the_dynasty` award is Legendary because a 70%+ all-time win rate vs a specific rival across many sessions is extremely rare.

## Last Updated

2026-05-09
