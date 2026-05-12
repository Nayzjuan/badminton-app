# Todo — Cross-Session Awards (B+E) + Integration Testing

## In Progress

_(none — all phases complete)_

## Up Next

_(no pending cross-session or testing work — see MEMORY.md for optional items)_

## Completed

### Cross-Session Awards (B+E) — All Phases Complete

- [x] ✅ Decisions locked (awards, thresholds, rolling-3, soulmates=20, slug strategy) — 2026-05-09
- [x] ✅ plan.md + todo.md created — 2026-05-09
- [x] ✅ Phase 1 — Schema migration applied + smoke-tested + types updated — 2026-05-09
  - `player_rivalries` + `player_partnerships` tables, `carry_forward` column, `refresh_cross_session_stats` RPC
  - 122 rivalry rows + 84 partnership rows populated from real session; idempotency confirmed
  - `sessions_faced` accumulation verified across 2 sessions
  - Code review passed (2 fixes: GRANT SELECT for authenticated, carry_forward optional in Insert type)
- [x] ✅ Phase 2 — `refresh_cross_session_stats` wired into `closeSession` (non-fatal, before compute_session_wrapped) — 2026-05-09
- [x] ✅ Phase 3 — `compute_session_wrapped` expanded: `_cross_session_stats` temp table (14 CTEs), 9 new award slugs, 4 enhanced, carry_forward write — 2026-05-09
  - Code review: 3 minor issues → all fixed (GRANT SELECT on tables, carry_forward optional in Insert type, ended_on_win_streak using `_ended_streaks` temp table instead of peak streak)
  - Smoke-tested on Thursday 05/07 session: bounced_back, settled_the_score, nemesis_slayer firing correctly
- [x] ✅ Phase 4 — 9 new AWARD_META entries in `wrapped-awards.ts`, tsc clean, code review LGTM — 2026-05-09
- [x] ✅ Phase 5 — APP_MANIFEST.md + MEMORY.md updated, worktree synced — 2026-05-09

### Integration Testing — All Phases Complete

- [x] ✅ Phase 1 — Vitest harness + smoke test (commit ac2a4a1, 2026-05-10)
  - `vitest.integration.config.ts`, global-setup, setup, mock-auth, withTx, truncate, factories, health.test.ts, CI workflow
- [x] ✅ Phase 2 — 3 critical-path suites (commit 5019624, 2026-05-10)
  - matchmaking.test.ts (8), close-session.test.ts (7), publish-match.test.ts (8)
- [x] ✅ Phase 3 — Coverage expansion + hardening (commit 6815425, 2026-05-10)
  - concurrency.test.ts (3), rls-edge-cases.test.ts (6), score-submission.test.ts (8), schema-parity.test.ts (13), performance.test.ts (1)
  - Coverage thresholds: 85% per-file, CI db reset, test:integration:reset script
- [x] ✅ Documentation pass — README completed, APP_MANIFEST.md updated, MEMORY.md + todo.md cleaned up

## Blocked

_(none)_

## Last Updated

2026-05-10
