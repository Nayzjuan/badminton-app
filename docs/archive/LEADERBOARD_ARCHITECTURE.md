# Leaderboard System — Architecture Blueprint

> **Scope:** Dual-mode hybrid leaderboard (Session-Specific + All-Time) with live win streaks,
> rank movement indicators, an Advanced Stats toggle, and a live in-app leaderboard panel
> embedded in both the Player Dashboard and Organizer Dashboard.
> This document covers database design, component hierarchy, edge-case handling, and the
> UI design + implementation workflow using `/impeccable` and `/ui-ux-pro-max`.

---

## 1. Database Aggregation Strategy

### 1a. Session-Specific Leaderboard — Regular VIEW

Use a standard PostgreSQL `VIEW` (not materialized) for session stats. Sessions are small
(typically 10–40 players, dozens of matches), so on-the-fly aggregation is fast. Freshness
is critical here — the leaderboard should reflect the last completed match immediately.

**Source:** `v_match_history` (already exists) — provides `player_id`, `session_id`, `team`,
`team_a_score`, `team_b_score`, `match_status`, `completed_at`.

**View name:** `v_session_leaderboard`

```sql
CREATE OR REPLACE VIEW v_session_leaderboard AS
WITH match_results AS (
  SELECT
    mh.player_id,
    mh.session_id,
    CASE
      WHEN (mh.team = 'a' AND mh.team_a_score > mh.team_b_score)
        OR (mh.team = 'b' AND mh.team_b_score > mh.team_a_score)
      THEN 1 ELSE 0
    END                                                         AS won,
    CASE WHEN mh.team = 'a'
      THEN COALESCE(mh.team_a_score, 0)
      ELSE COALESCE(mh.team_b_score, 0)
    END                                                         AS pts_for,
    CASE WHEN mh.team = 'a'
      THEN COALESCE(mh.team_b_score, 0)
      ELSE COALESCE(mh.team_a_score, 0)
    END                                                         AS pts_against
  FROM v_match_history mh
  WHERE mh.match_status = 'completed'
)
SELECT
  mr.player_id,
  mr.session_id,
  p.display_name,
  COUNT(*)::int                                                  AS games_played,
  SUM(mr.won)::int                                              AS wins,
  (COUNT(*) - SUM(mr.won))::int                                 AS losses,
  SUM(mr.pts_for)::int                                          AS points_for,
  SUM(mr.pts_against)::int                                      AS points_against,
  (SUM(mr.pts_for) - SUM(mr.pts_against))::int                  AS point_diff,
  ROUND(
    SUM(mr.won)::numeric / NULLIF(COUNT(*), 0) * 100, 1
  )                                                              AS win_pct
FROM match_results mr
JOIN profiles p ON p.id = mr.player_id
GROUP BY mr.player_id, mr.session_id, p.display_name;
```

**Query at runtime:**
```sql
SELECT * FROM v_session_leaderboard
WHERE session_id = $1
  AND games_played >= 3        -- anti-ghost threshold
ORDER BY wins DESC, win_pct DESC, point_diff DESC;
```

---

### 1b. All-Time Leaderboard — Materialized VIEW

Use a `MATERIALIZED VIEW` for lifetime stats. The aggregation spans all sessions and all
completed matches — this query can be expensive as data grows. A materialized view stores
the result on disk and is refreshed explicitly.

**View name:** `v_alltime_leaderboard_mat`

```sql
CREATE MATERIALIZED VIEW v_alltime_leaderboard_mat AS
WITH match_results AS (
  SELECT
    mh.player_id,
    CASE
      WHEN (mh.team = 'a' AND mh.team_a_score > mh.team_b_score)
        OR (mh.team = 'b' AND mh.team_b_score > mh.team_a_score)
      THEN 1 ELSE 0
    END                                                         AS won,
    CASE WHEN mh.team = 'a'
      THEN COALESCE(mh.team_a_score, 0)
      ELSE COALESCE(mh.team_b_score, 0)
    END                                                         AS pts_for,
    CASE WHEN mh.team = 'a'
      THEN COALESCE(mh.team_b_score, 0)
      ELSE COALESCE(mh.team_a_score, 0)
    END                                                         AS pts_against
  FROM v_match_history mh
  WHERE mh.match_status = 'completed'
)
SELECT
  mr.player_id,
  p.display_name,
  COUNT(*)::int                                                  AS games_played,
  SUM(mr.won)::int                                              AS wins,
  (COUNT(*) - SUM(mr.won))::int                                 AS losses,
  SUM(mr.pts_for)::int                                          AS points_for,
  SUM(mr.pts_against)::int                                      AS points_against,
  (SUM(mr.pts_for) - SUM(mr.pts_against))::int                  AS point_diff,
  ROUND(
    SUM(mr.won)::numeric / NULLIF(COUNT(*), 0) * 100, 1
  )                                                              AS win_pct
FROM match_results mr
JOIN profiles p ON p.id = mr.player_id
GROUP BY mr.player_id, p.display_name
WITH DATA;

-- Required for CONCURRENTLY refresh (non-blocking reads during refresh)
CREATE UNIQUE INDEX ON v_alltime_leaderboard_mat (player_id);
```

**Refresh wrapper function** (call from `endMatchAction` server action):
```sql
CREATE OR REPLACE FUNCTION refresh_alltime_leaderboard()
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY v_alltime_leaderboard_mat;
$$;
```

The existing `endMatchAction` in `src/app/actions/match.ts` calls
`supabase.rpc('refresh_alltime_leaderboard')` as the final step after scoring is committed.
`CONCURRENTLY` ensures active readers are never blocked during the refresh.

---

### 1c. Win Streak SQL

The streak is the count of **consecutive wins ending at the player's most recent match**,
counting backwards in time until the first loss (or the beginning of their match history).

**Strategy:** Use `ROW_NUMBER()` ordered by `completed_at DESC` to rank matches newest-first.
Find the smallest row number where `won = 0` (the first loss looking back). The streak is
the count of wins before that loss.

```sql
-- Can be used as a CTE or subquery; parameterize session_id for session streaks.
WITH ordered_results AS (
  SELECT
    mh.player_id,
    mh.completed_at,
    CASE
      WHEN (mh.team = 'a' AND mh.team_a_score > mh.team_b_score)
        OR (mh.team = 'b' AND mh.team_b_score > mh.team_a_score)
      THEN 1 ELSE 0
    END AS won,
    ROW_NUMBER() OVER (
      PARTITION BY mh.player_id
      ORDER BY mh.completed_at DESC        -- newest match = rn 1
    ) AS rn
  FROM v_match_history mh
  WHERE mh.match_status = 'completed'
    -- AND mh.session_id = $1             -- uncomment for session-scoped streak
),
first_loss AS (
  -- The first loss looking backwards (lowest rn where won = 0)
  SELECT player_id, MIN(rn) AS first_loss_rn
  FROM ordered_results
  WHERE won = 0
  GROUP BY player_id
)
SELECT
  o.player_id,
  COUNT(*) AS win_streak
FROM ordered_results o
LEFT JOIN first_loss fl ON fl.player_id = o.player_id
WHERE
  o.won = 1
  AND o.rn < COALESCE(fl.first_loss_rn, 2147483647)  -- all wins if never lost
GROUP BY o.player_id;
```

**Example:**
- Player matches (newest → oldest): W, W, W, L, W → streak = 3
- Player matches: W, W, W, W, W → streak = 5 (never lost)
- Player matches: L, W, W → streak = 0 (most recent is a loss)

**Display rule:** The 🔥 indicator only appears when `win_streak >= 3`. Shown inline next to
the player's name in the leaderboard table (e.g., "Miguel 🔥🔥🔥" for streak = 3, or
"Miguel 🔥×5" for streak ≥ 5 to avoid emoji sprawl). No badge cards, no titles — just
the flame indicator, clean and contextual.

**Where streaks are computed:**
Streaks are fetched via a separate query in the leaderboard server action and merged into the
leaderboard rows in TypeScript before rendering. They are **not** embedded into the aggregation
views, keeping each view focused and independently reusable.

---

### 1d. Rank Movement Indicators — Date-Filter Strategy

**Decision: No snapshot table required for MVP.**

Rank movement is computed by running the all-time aggregation twice with different date filters,
then comparing the two rank arrays in TypeScript:

```
current_rank  = rank from v_alltime_leaderboard_mat  (all history)
previous_rank = rank from raw query WHERE completed_at < NOW() - INTERVAL '7 days'
delta         = previous_rank - current_rank
```

- `delta > 0` → player moved **up** (show green arrow ↑N)
- `delta < 0` → player moved **down** (show red arrow ↓N)
- `delta = 0` → no change (show dash —)
- Player not in previous snapshot (new entrant) → show ✦ **NEW**

**Why this approach over a cron snapshot table:**
- Zero new database tables or scheduled jobs
- "7 days ago" is a meaningful comparison window for a weekly gym context
- Both queries run in the TypeScript server action layer, not in the DB view
- The materialized view handles current rank; the "7 days ago" query hits `v_match_history`
  directly with a date filter — acceptable performance at gym scale (< 5,000 total matches)

**v2 upgrade path:** If the gym scales to thousands of players and the dual-query approach
becomes slow, add a `leaderboard_rank_snapshots` table populated by a `pg_cron` weekly job.
The UI delta logic stays identical — just swap the source of `previous_rank`.

---

## 2. Live In-App Leaderboard Panel

This is a **condensed, always-visible leaderboard** embedded directly inside the existing
Player and Organizer dashboards. It shows the current session standings without requiring
navigation to the standalone `/leaderboard/[sessionId]` page.

### 2a. Player Dashboard — "Leaderboard" Tab (4th Tab)

**Location:** New 4th tab in `src/components/player/player-dashboard.tsx`

```
[ My Status ]  [ Live Courts ]  [ Waitlist ]  [ Leaderboard ]
```

The tab grid changes from `grid-cols-3` → `grid-cols-4`.

**Panel contents (session-scoped only — no All-Time tab here):**
- Personal Hero Card pinned at top (rank, GP, W-L, Win%, streak)
- Compact leaderboard table (top 10 + current user row always visible)
- 🔥 streak indicator inline on qualifying rows (≥ 3 wins)
- No Advanced Stats toggle in the compact view — keep it clean
- "View Full Leaderboard →" link at the bottom opens `/leaderboard/[sessionId]`

**Real-time:** Subscribes to match completion events via the existing
`subscribeToMatches` channel already wired in the player hooks. Re-fetches
`v_session_leaderboard` on each trigger — no new subscription needed.

**Minimum games:** 3 GP to appear. Players below threshold see a row:
`"Play 2 more games to appear on the board"`

---

### 2b. Organizer Dashboard — "Leaderboard" Tab (5th Tab)

**Location:** New 5th tab in `src/components/organizer/organizer-dashboard.tsx`

```
[ Active Courts ]  [ Queue Control ]  [ Wait Monitor ]  [ Match History ]  [ Leaderboard ]
```

**Panel contents (session-scoped):**
- Full leaderboard table (all ranked players, no truncation)
- 🔥 streak indicator inline
- Advanced Stats toggle (organizer is the stat nerd — show them everything)
- No personal Hero Card (organizer context, not a player's personal view)
- "View Public Leaderboard ↗" link opens `/leaderboard/[sessionId]` in a new tab (for
  projecting on a screen or sharing with players)

**Real-time:** Uses the existing `useOrganizerData` hook's match subscription. Re-fetches
leaderboard on match completion — same trigger as the match history panel refresh.

---

### 2c. Standalone Public Page — `/leaderboard/[sessionId]`

Full-featured leaderboard for sharing (QR code, TV display, projected screen).

| Feature | Session Tab | All-Time Tab |
|---|---|---|
| Hero Card (personal rank pin) | Yes (auth only) | Yes (auth only) |
| 🔥 Streak indicator | Yes (≥3 wins) | Yes (≥3 wins) |
| Rank movement (↑↓) | No | Yes (vs. 7 days ago) |
| Advanced Stats toggle | Yes | Yes |
| Min games threshold | 3 GP | 10 GP |
| Auth required | No (public) | No (public) |

Mirrors the `/tv/[sessionId]` access pattern — no redirect on missing auth.

---

## 3. UI Component Hierarchy

### 3a. Route & Access Model

| Surface | Auth Required | Scope |
|---|---|---|
| `/leaderboard/[sessionId]` | No (public) | Session + All-Time tabs |
| Player Dashboard → "Leaderboard" tab | Yes (player) | Session only (compact) |
| Organizer Dashboard → "Leaderboard" tab | Yes (organizer) | Session only (full + advanced) |

---

### 3b. Full Component Tree

```
/leaderboard/[sessionId]/page.tsx          ← Server Component (public)
  Fetches: session name, currentUserId (optional)
  Renders:
  └── <LeaderboardPage                     ← "use client" — owns all state
        sessionId={string}
        sessionName={string}
        currentUserId={string | null}
        variant="standalone"               ← "standalone" | "player-panel" | "organizer-panel"
      />
        ├── <LeaderboardHeader />           ← Session name, back nav, theme toggle
        │
        ├── <LeaderboardHeroCard            ← Pinned personal stats (auth only)
        │     playerId={currentUserId}
        │     sessionId={sessionId}
        │   />
        │
        ├── <LeaderboardTabs               ← "This Session" | "All-Time" pill toggle
        │     activeTab={tab}              ← hidden in player-panel variant
        │     onTabChange={setTab}
        │   />
        │
        └── <LeaderboardTabContent
              tab={tab}
              sessionId={sessionId}
              currentUserId={currentUserId}
              variant={variant}
            />
              ├── <AdvancedStatsToggle     ← hidden in player-panel variant
              │     isOpen={showAdvanced}
              │     onToggle={setShowAdvanced}
              │   />
              │
              └── <LeaderboardTable
                    rows={leaderboardRows}
                    currentUserId={currentUserId}
                    showAdvanced={showAdvanced}
                    truncate={variant === "player-panel"}   ← top 10 only
                    loading={loading}
                  />
                    └── <LeaderboardRow    ← inline 🔥 streak when win_streak >= 3
                          row={row}
                          isCurrentUser={row.player_id === currentUserId}
                          showAdvanced={showAdvanced}
                        /> × N
```

The `variant` prop controls which features are visible without needing separate components:

| Feature | `standalone` | `player-panel` | `organizer-panel` |
|---|---|---|---|
| Header with back nav | Yes | No | No |
| All-Time tab | Yes | No | No |
| Rank movement indicators | Yes (All-Time) | No | No |
| Hero Card | Yes | Yes | No |
| Advanced Stats toggle | Yes | No | Yes |
| Row truncation (top 10) | No | Yes | No |
| "View full leaderboard →" link | No | Yes | Yes |

---

### 3c. Hero Card — Personal Rank Pin

The Hero Card is a visually distinct card that pins the logged-in player's rank to the
top of their leaderboard view regardless of actual position.

**Visual spec:**
```
┌─────────────────────────────────────────────────────────┐
│ ★ You                                          #4 of 12 │
│ Miguel Santos    7 GP   5W–2L   71.4%   🔥🔥🔥         │
└─────────────────────────────────────────────────────────┘
```

- Amber border on dark mode / indigo border on light mode
- Always shows: Rank #N · Display Name · GP · W-L · Win% · 🔥 streak (if ≥ 3)
- Below threshold: `"Play N more game(s) to appear on the leaderboard"`
- Not rendered when `currentUserId === null` (unauthenticated public view)

---

### 3d. Tab Structure (Standalone Page Only)

```
┌─────────────────────────────────────────────┐
│  [ This Session ]  [   All-Time   ]          │
└─────────────────────────────────────────────┘
```

- **"This Session"** (default): session_id-filtered stats, 3 GP minimum, session-scoped streak
- **"All-Time"**: cross-session lifetime stats, 10 GP minimum, rank movement indicators

Tab state lives in memory only (no URL param for MVP).

---

### 3e. Default Columns vs. Advanced Stats

**Default view** (always visible):

| Column | Notes |
|---|---|
| **Rank** | 🥇🥈🥉 for top 3, number for rest |
| **Player** | Display name + 🔥×N inline when streak ≥ 3 |
| **GP** | Games played |
| **W–L** | e.g., "5–2" |
| **Win%** | e.g., "71.4%" |
| *(rank Δ)* | All-Time tab only: ↑2 / ↓1 / — / ✦NEW |

**Advanced Stats** (toggle-revealed, not shown by default):

| Column | Notes |
|---|---|
| **PF** | Points For |
| **PA** | Points Against |
| **+/-** | Point Differential |

On mobile: horizontal scroll on the table row, not collapsing columns to separate rows.

---

## 4. Edge Cases & Constraints

### 4a. Minimum Games Threshold

| Context | Min GP | Rationale |
|---|---|---|
| Session leaderboard | **3 games** | Achievable in a single 90-min session |
| All-time leaderboard | **10 games** | Meaningful lifetime history |
| 🔥 On Fire streak indicator | **3 consecutive wins** | Streak must be earned, not a fluke |

Players below session threshold: excluded from table, Hero Card shows "play N more."
Players below all-time threshold: excluded from all-time tab entirely.

---

### 4b. Tie-Breaker Hierarchy

```
1. Wins            (higher = better) — raw volume first
2. Win %           (higher = better) — efficiency when wins are equal
3. Point Diff (+/-)(higher = better) — dominance when efficiency is equal
4. Points For (PF) (higher = better) — output as final numeric tie-break
5. Display name    (A → Z)           — deterministic alphabetical fallback
```

Applied in both the SQL `ORDER BY` clause and the TypeScript rank-assignment loop.

---

### 4c. Real-Time Refresh Strategy

| Surface | Trigger | Mechanism |
|---|---|---|
| Player panel (session) | Match completes | Existing `subscribeToMatches` channel, re-fetch `v_session_leaderboard` |
| Organizer panel (session) | Match completes | Existing `useOrganizerData` match subscription, re-fetch |
| Standalone page (session) | Match completes | New Realtime subscription in `use-leaderboard.ts` |
| Standalone page (all-time) | Match completes | `endMatchAction` → `refresh_alltime_leaderboard()` RPC → client re-fetch |

---

### 4d. Empty States

| Condition | Message |
|---|---|
| Session has 0 completed matches | "No matches completed yet — get playing!" |
| Current user has 0 GP this session | Hero Card: "You haven't played yet this session" |
| All-time < 3 qualified players | "Play more sessions to build the all-time board" |
| Player below session threshold | "Play N more game(s) to appear" |

---

## 5. UI Design & Implementation Workflow

This section defines how the leaderboard UI is designed and built. Two skills handle this
in sequence: `/impeccable` designs the visual system, then `/ui-ux-pro-max` implements it.

---

### Step A — `/impeccable` : Visual Design Planning

**When to run:** After the database views and TypeScript types are in place (Steps 1–5 of
the implementation order below). Run `/impeccable` before writing any component code.

**What `/impeccable` must produce:**

1. **Color & token decisions** for leaderboard-specific UI states:
   - Rank #1 / #2 / #3 medal treatment (gold/silver/bronze vs. emoji-only)
   - 🔥 streak glow or color accent (should it pulse? animate?)
   - Hero Card border/background treatment (distinguishes from regular rows)
   - Rank movement up/down arrow colors (re-use existing emerald/red tokens or new ones?)
   - "Below threshold" row muted treatment

2. **Layout decisions** per variant:
   - `player-panel`: compact table, top-10 truncation, no advanced stats — max height,
     scroll behavior on overflow
   - `organizer-panel`: full table, advanced stats toggle — how does the extra column
     set reflow on tablet viewport?
   - `standalone`: full-page with header, two tabs — spacing, max-width, breakpoints

3. **Typography hierarchy** for the leaderboard-specific elements:
   - Rank number size (large medal vs. small badge)
   - Win% display (is it a progress bar? plain text? colored?)
   - Streak indicator (emoji count vs. "🔥×5" text shorthand)

4. **Interaction design:**
   - Advanced Stats toggle animation (expand/collapse vs. instant swap)
   - Tab switch (instant vs. fade transition)
   - Live update flash (brief highlight on a row when rank changes)

5. **Anti-pattern checklist** — explicitly rule out:
   - No gradient text on player names
   - No glassmorphism on the Hero Card
   - No card-grid layout for the table rows (use a real `<table>` or strict flex rows)
   - No bounce easing on rank updates

**Output format:** A design spec section appended to this file (or a linked
`LEADERBOARD_UI_SPEC.md`) covering all decisions above with exact token names and
component-level mockup ASCII art.

---

### Step B — `/ui-ux-pro-max` : Component Implementation

**When to run:** After `/impeccable` has produced the UI spec. This skill writes all
component code following the spec and this architecture blueprint.

**Implementation checklist for `/ui-ux-pro-max`:**

| Component | File | Notes |
|---|---|---|
| `LeaderboardPage` | `src/components/leaderboard/leaderboard-page.tsx` | Main orchestrator, `variant` prop |
| `LeaderboardTable` | `src/components/leaderboard/leaderboard-table.tsx` | Rank, streak, advanced columns |
| `LeaderboardRow` | `src/components/leaderboard/leaderboard-row.tsx` | Per-row: medal, name+🔥, stats |
| `LeaderboardHeroCard` | `src/components/leaderboard/leaderboard-hero-card.tsx` | Personal pinned card |
| `AdvancedStatsToggle` | `src/components/leaderboard/advanced-stats-toggle.tsx` | Show/hide PF/PA/+/- |
| Page route | `src/app/leaderboard/[sessionId]/page.tsx` | Server Component, public |
| Player tab | `src/components/player/player-dashboard.tsx` | Add 4th tab, `grid-cols-4` |
| Organizer tab | `src/components/organizer/organizer-dashboard.tsx` | Add 5th tab |

**Hook:**
`src/hooks/use-leaderboard.ts` — fetches session + all-time data, merges streaks,
computes rank deltas, exposes variant-aware state, wires Realtime subscription.

**Server actions:**
`src/app/actions/leaderboard.ts` — `getSessionLeaderboard`, `getAllTimeLeaderboard`,
`getWinStreaks`, `getRankMovement` (no auth required — public read).

**Constraints `/ui-ux-pro-max` must follow:**
- Use existing Tailwind v4 tokens only — no hard-coded hex values
- All components must pass `npx tsc --noEmit` before commit
- Mobile-first: default columns must be readable at 375px width
- Advanced stats columns use horizontal scroll on mobile, not line-wrap
- Realtime updates must follow the `ref`-based subscription stability pattern from CLAUDE.md
- No `useState` / `useEffect` in Server Components

---

## 6. Implementation Order (Dependency Chain)

Execute strictly in this order:

1. **Supabase dashboard** — Create `v_session_leaderboard` (regular view)
2. **Supabase dashboard** — Create `v_alltime_leaderboard_mat` (materialized view + unique index)
3. **Supabase dashboard** — Create `refresh_alltime_leaderboard()` RPC function
4. **`src/types/database.ts`** — Add `SessionLeaderboardEntry`, `AllTimeLeaderboardEntry`, `LeaderboardRow` types
5. **`src/app/actions/leaderboard.ts`** — New file: `getSessionLeaderboard`, `getAllTimeLeaderboard`, `getWinStreaks`, `getRankMovement`
6. **`src/app/actions/match.ts`** — Add RPC call to `endMatchAction`
7. **Run `/impeccable`** — Design spec output (see Section 5A)
8. **`src/hooks/use-leaderboard.ts`** — New hook (after spec is finalized)
9. **Run `/ui-ux-pro-max`** — Implement all components per spec + this blueprint
10. **`src/app/leaderboard/[sessionId]/page.tsx`** — New public route
11. **`src/components/player/player-dashboard.tsx`** — Add 4th tab
12. **`src/components/organizer/organizer-dashboard.tsx`** — Add 5th tab
13. **TypeScript check** — `npx tsc --noEmit` must pass before any commit

---

## 7. Summary of All Decisions

| Decision | Chosen Approach | Rationale |
|---|---|---|
| Session stats storage | Regular VIEW | Small dataset, freshness > speed |
| All-time stats storage | Materialized VIEW + CONCURRENTLY refresh | Large aggregation, stale-ok |
| Win streak display | 🔥 inline on player name, ≥3 wins only | Clean, no badge clutter |
| Badge titles | **Removed** — only 🔥 On Fire streak survives | Titles felt gamey and distracting |
| Rank movement | Date-filter dual-query in TypeScript | Zero new tables, 7-day window fits gym cadence |
| Streak scope (session tab) | Session-scoped | Contextually relevant to tonight |
| Streak scope (all-time tab) | Cross-session (lifetime) | Rewards consistent players |
| Live panels | Player tab (compact) + Organizer tab (full+advanced) | No navigation required |
| Public access | Yes — no auth required | Shareable via QR, TV, link |
| Min games (session) | 3 GP | Achievable in a single session |
| Min games (all-time) | 10 GP | Meaningful lifetime sample |
| 🔥 threshold | 3 consecutive wins | Meaningful streak, not a fluke |
| Tie-breaker | Wins → Win% → +/- → PF → Name | Deterministic, rewards volume then efficiency |
| Advanced stats | Toggled columns (PF / PA / +/-) | Default view clean for casual players |
| UI design workflow | `/impeccable` → `/ui-ux-pro-max` | Design before build, prevents rework |
