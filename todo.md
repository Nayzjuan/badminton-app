# Todo — Cross-Session Awards (B+E)

## In Progress

_(done — all phases complete)_

## Up Next

### Phase 2 — Wire into closeSession

- [ ] Find the `closeSession` server action in `src/app/actions/sessions.ts`
- [ ] Add `supabase.rpc('refresh_cross_session_stats', { p_session_id: sessionId })` call immediately before the existing `compute_session_wrapped` call
- [ ] Verify error handling: if `refresh_cross_session_stats` fails, the close should still surface a useful error (same pattern as existing RPC calls)

### Phase 3 — Expand `compute_session_wrapped`

- [ ] Write `20260510000001_expand_wrapped_cross_session.sql` (full CREATE OR REPLACE):
  - Pre-loop: bulk-fetch `rivalry_stats` (join `player_rivalries` for each player's relevant records)
  - Pre-loop: bulk-fetch `partnership_stats` (join `player_partnerships`)
  - Pre-loop: bulk-fetch `prior_sessions` (last 2 `session_wrapped_stats` rows per player for rolling-3)
  - Pre-loop: bulk-fetch `prior_carry_forward` (most recent carry_forward per player)
  - Enhance 4 existing award blocks: `my_nemesis`, `kryptonite`, `loyal_partner`, `redemption_arc`
  - Add 9 new award IF blocks (in order): `momentum`, `consistent_dominator`, `bounced_back`, `nemesis_slayer`, `settled_the_score`, `the_dynasty`, `serial_rivals`, `soulmates`, `winning_formula`
  - Write `carry_forward` payload into the final INSERT upsert
- [ ] Apply migration to Supabase dev
- [ ] Smoke-test: close a test session, verify new awards appear in `session_wrapped_stats.earned_awards`

### Phase 4 — TypeScript

- [ ] Add 9 new entries to `AWARD_META` in `src/lib/wrapped-awards.ts`:
  - `momentum` 🌊 Rare
  - `consistent_dominator` 👑 Legendary
  - `bounced_back` 📈 Uncommon
  - `nemesis_slayer` ⚔️ Rare
  - `settled_the_score` ✅ Rare
  - `the_dynasty` 🏛️ Legendary
  - `serial_rivals` 🔁 Uncommon
  - `soulmates` 💞 Rare
  - `winning_formula` 🧪 Uncommon
- [ ] Run `npx tsc --noEmit` — zero errors
- [ ] Run `npm run lint` — clean

### Phase 5 — Code Review Gate

- [ ] Spawn independent review agent (MANDATORY before completion summary)
- [ ] Address any "Needs fixes" items
- [ ] Final: update `APP_MANIFEST.md` + `MEMORY.md`

## Completed

- [x] ✅ Decisions locked (awards, thresholds, rolling-3, soulmates=20, slug strategy) — 2026-05-09
- [x] ✅ plan.md + todo.md created — 2026-05-09
- [x] ✅ Phase 5 — APP_MANIFEST.md + MEMORY.md updated, worktree synced — 2026-05-09
- [x] ✅ Phase 4 — 9 new AWARD_META entries in `wrapped-awards.ts`, tsc clean, code review LGTM — 2026-05-09
  - Note: edits initially landed in main repo; copied to worktree (claude/funny-gates-64ff30) via cp
- [x] ✅ Phase 3 — `compute_session_wrapped` expanded: \_cross_session_stats temp table (14 CTEs), 9 new award slugs, 4 enhanced, carry_forward write — 2026-05-09
  - Code review: 3 minor issues → all fixed (GRANT SELECT on tables, carry_forward optional in Insert type, ended_on_win_streak using \_ended_streaks temp table instead of peak streak)
  - Smoke-tested on Thursday 05/07 session: bounced_back, settled_the_score, nemesis_slayer firing correctly; carry_forward populated with correct end-of-session streak
- [x] ✅ Phase 2 — `refresh_cross_session_stats` wired into `closeSession` (non-fatal, before compute_session_wrapped) — 2026-05-09
- [x] ✅ Phase 1 — Schema migration applied + smoke-tested + types updated — 2026-05-09
  - `player_rivalries` + `player_partnerships` tables, `carry_forward` column, `refresh_cross_session_stats` RPC
  - 122 rivalry rows + 84 partnership rows populated from real session; idempotency confirmed
  - `sessions_faced` accumulation verified across 2 sessions
  - Code review passed (2 fixes applied: GRANT SELECT for authenticated, carry_forward optional in Insert type)
  - Note: `carry_forward` TypeScript type remains `Record<string, unknown>` — will be narrowed in Phase 4 when the reader is built

## Blocked

_(none)_

## Last Updated

2026-05-09
