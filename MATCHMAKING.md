# Matchmaking Engine — Complete Reference

> **Last updated:** 2026-04-24  
> **Source files:** `src/app/actions/matchmaking.ts` · `src/lib/matchmaking-core.ts` · `src/lib/constants.ts`

---

## Table of Contents

1. [Overview](#overview)
2. [Pipeline: Queue → On Deck → Court](#pipeline)
3. [Priority Scoring](#priority-scoring)
4. [Skill Matching & Variance Windows](#skill-matching)
5. [Anti-Repeat / Diversity System](#anti-repeat)
6. [3-Tier Swap System](#swap-system)
7. [Partner Rotation (rotatedDraft)](#partner-rotation)
8. [Soft Gate](#soft-gate)
9. [On-Deck Capacity](#on-deck-capacity)
10. [Last-Resort Time Fallback](#fallback)
11. [Red Zone](#red-zone)
12. [Paused Players](#paused-players)
13. [Entry Points](#entry-points)
14. [Constants Reference](#constants)
15. [Decision Flow Diagram](#decision-flow)

---

## Overview

The matchmaking engine is a **queue-to-on-deck filler**. Its job is to continuously examine the waiting player pool and produce the best possible group of 4 players for the next match — balancing:

- **Fairness** — who has waited the longest, who has played the most
- **Skill balance** — keep team skill gaps small
- **Variety** — avoid putting the same players together repeatedly
- **Urgency** — guarantee nobody waits so long they never play

Matches are never placed directly onto courts. The engine writes a **pending (on-deck) match**. The organizer promotes it to a court via *Call Next Match*. This two-step design means courts never idle while the engine runs.

---

## Pipeline

```
Players join queue (status = "waiting")
          │
          ▼
  runEngineInternal()
  ┌─────────────────────────────────────────────────────────────┐
  │  1. How many court slots are available?                     │
  │     capacity = courtCount + ON_DECK_LOOKAHEAD               │
  │     slots = capacity − existingOnDeckMatches                │
  │                                                             │
  │  2. Soft gate: is the pool too small to diversify?          │
  │     If yes and active courts exist → defer                  │
  │                                                             │
  │  3. For each available slot:                                │
  │     createOneOnDeckMatch() → runAlgorithm()                 │
  │       → executeMatch() → writes match row (status=pending)  │
  └─────────────────────────────────────────────────────────────┘
          │
          ▼
  Organizer clicks "Call Next Match"
  promoteOnDeckMatchInternal()
    → match.status = "in_progress"
    → court.status  = "in_use"
    → queue_entry.status = "playing"
          │
          ▼
  Match ends → endMatchAction()
    → queue_entry.status = "waiting"  (players return to queue)
    → runEngineForSession()           (engine refills the slot)
```

---

## Priority Scoring

Every waiting player receives a **priority score** that determines who anchors the next match.

### Normal queue (wait < 25 min)

```
priorityScore = max(0, waitMinutes − (gamesPlayed × GAME_PENALTY_MINUTES))
```

- `GAME_PENALTY_MINUTES = 12` — each game played costs 12 "virtual minutes" of wait time.
- **Floor at 0** — game debt never drops a player below a fresh joiner. Both score 0 in that case; `joined_at` (earlier = higher priority) breaks the tie.
- Effect: a player with 3 games played and 10 minutes waited scores `max(0, 10 − 36) = 0`. A fresh joiner also scores 0, but if they joined later, the veteran gets matched first.

### Red Zone (wait ≥ 25 min)

```
priorityScore = 1000 + waitMinutes
```

- Scores 1000+ guarantee this player **anchors the very next match**, regardless of how many games they have played.
- Game debt is completely ignored in the Red Zone.
- A Red Zone player with 30 min wait scores 1030 — always beats any Normal player (max Normal score ≈ 24).

### Sort order

The pool is sorted **descending by priorityScore**, ties broken **ascending by `joined_at`**. The top player (index 0) is the **anchor** around whom the match is built.

---

## Skill Matching

### Skill levels

| Label | Integer |
|---|---|
| Beginner | 1–2 |
| Intermediate | 3–5 |
| Advanced | 6–7 |

The engine works on integer skill levels stored in `skill_level_int`.

### Variance windows

The engine tries to form a group where **every pairwise skill difference ≤ maxVariance**. It attempts windows in order, expanding only if the current window can't find 3 candidates:

| Window | `maxVariance` | Condition |
|---|---|---|
| Target | `SKILL_VARIANCE_TARGET = 1` | Always tried first |
| Max | `SKILL_VARIANCE_MAX = 2` | If ±1 fails |
| Extended (Red Zone only) | 3, then 4 | Only when anchor is in Red Zone |

A group is only considered valid when `isGroupValid()` returns true — i.e., no pair within the proposed 4 exceeds `maxVariance`.

### Combination search (`buildCombinationGroup`)

Rather than greedy selection (which can get trapped by an incompatible high-priority player), the engine does a full **N-choose-3 combination search** across all eligible candidates. The candidates are already sorted best-priority-first, so the very first valid combination found is optimal. Worst case: C(30, 3) = 4,060 iterations — negligible at runtime.

---

## Anti-Repeat / Diversity System

### What it prevents

The engine checks if ≥ 3 of the proposed 4 players appeared together in any **single recent match roster**. If yes, it's a "diversity violation" and the engine tries to find a better group.

### Dynamic lookback window

The number of recent matches examined scales with the eligible pool size to avoid false violations in small sessions:

| Eligible pool size | Lookback window |
|---|---|
| ≤ 5 players | 2 matches |
| 6–9 players | 3 matches |
| 10–15 players | 4 matches |
| 16+ players | 5 matches |

"Eligible pool" = candidates within the current skill window + the anchor.

### Anti-repeat overlap scoring (`scoreCandidates`)

Each candidate receives a composite score that penalises repeat pairings with the anchor:

```
Normal candidate:    score = −priorityScore + (overlapCount × 10,000)
Red Zone candidate:  score = −priorityScore + (overlapCount × 100)
```

The 10,000× multiplier for Normal candidates means a repeat pairing almost always loses to a fresh pairing. For Red Zone candidates the penalty is capped at 100× so that urgency wins: a Red Zone player with 1 overlap (`−1030 + 100 = −930`) still sorts before a fresh Normal player (`−2 + 0 = −2`).

---

## 3-Tier Swap System

When `buildCombinationGroup` returns a valid group of 3 but the full 4-player combo triggers a **diversity violation**, the engine steps through three escalating attempts before accepting a repeat:

### Tier 1 — Primary swap (same skill window)

Keep the top 2 companions from the original group. Replace the 3rd with any candidate from the same `±maxVariance` pool that:
1. Passes `isGroupValid()` with the anchor + fixed two
2. Does not trigger `isDiversityViolation()`

If a diverse swap is found → create the match with `snakeDraft` team assignment.  
`isMixedLevel` is inherited from the current skill window (`maxVariance > SKILL_VARIANCE_MAX`).

### Tier 2 — Expanded swap (±SKILL_VARIANCE_MAX)

Only triggered when **Tier 1's swap pool was empty** (i.e., the current `±maxVariance` window had exactly 3 candidates — all now in the group — and there are no extras). Expands the search to `±SKILL_VARIANCE_MAX` candidates not already in the group.

This breaks tier isolation: an Advanced player (skill 6) whose only ±1 partners have all recently played together can now draw from Intermediate players (skill 4–5) as swap candidates. Match is not flagged `isMixedLevel` because `±SKILL_VARIANCE_MAX` is still within the normal skill range.

### Tier 3 — Partner rotation (forced repeat)

All swap paths exhausted. The same 4 players must play again. Instead of always producing the identical team split, `rotatedDraft` cycles through 3 possible configurations (see [Partner Rotation](#partner-rotation)).

### Red Zone immunity (swap exception)

If the **3rd companion** (the swap target) has `priorityScore ≥ 1000`, they are in the Red Zone themselves and **cannot be benched** for diversity reasons. Urgency always wins. The original group is accepted with `snakeDraft` — no swap attempted.

---

## Partner Rotation

`rotatedDraft()` is called only as a last resort when the same 4 players are forced to repeat. It cycles through 3 team-split configurations so **partners change on each repeat**, providing variety even when the opponent group cannot change.

Players are sorted descending by skill (positions 0=highest, 3=lowest):

| `splitIndex` | Team A | Team B | Description |
|---|---|---|---|
| 0 | [0, 3] | [1, 2] | Snake draft (highest+lowest vs 2nd+3rd) |
| 1 | [0, 1] | [2, 3] | Top pair vs bottom pair |
| 2 | [0, 2] | [1, 3] | Alternating cross-split |

`splitIndex = repeatCount % 3` where `repeatCount` is the number of **completed** matches in the recent roster window that contained all 4 of these players.

**Example:**
- First time these 4 play: snakeDraft (normal path, rotation not involved)
- 2nd play (forced repeat): `repeatCount = 1` → split 1 — top pair vs bottom pair
- 3rd play: `repeatCount = 2` → split 2 — cross-split
- 4th play: `repeatCount = 3 % 3 = 0` → split 0 — back to snake (full cycle)

---

## Soft Gate

### Problem it solves

With 2 courts and exactly 4 players waiting, there is only one possible combination. If those 4 just played together, the diversity check fires — but there are no swap alternatives. The engine would be forced to immediately repeat the same match.

The soft gate **defers on-deck generation** to wait for more players before scheduling, giving the engine a larger, more diverse pool to work with.

### Gate activation conditions (ALL must be true)

1. `waitingCount ≤ GATE_POOL_THRESHOLD (4)` — only ≤4 players waiting
2. At least 1 match is currently `in_progress`
3. No player has waited ≥ `GATE_HOLD_MINUTES (8)` — no timeout
4. No player is in the Red Zone (wait ≥ `CRITICAL_WAIT_MINUTES = 25`)

### Gate release conditions (ANY is sufficient)

| Condition | Constant | Reason |
|---|---|---|
| Max wait ≥ 8 minutes | `GATE_HOLD_MINUTES` | Player waited long enough; schedule now |
| Max wait ≥ 25 minutes | `CRITICAL_WAIT_MINUTES` | Red Zone player — urgency overrides |
| No active courts | — | Nothing to wait for; pool won't grow |
| Organizer bypasses | `bypassGate = true` | Explicit organizer request |

### bypassGate flag

`callNextMatch` (organizer's "Call Next Match" button) always passes `bypassGate = true` when running the engine inline, ensuring the organizer **always gets a match** even when the gate would normally hold.

The refill run after a successful promotion uses `bypassGate = false` (default) — the gate may hold the refill if the pool is still small. This is intentional and safe: the organizer can call "Call Next Match" again if needed.

---

## On-Deck Capacity

The engine maintains a buffer of pre-built matches so courts never idle:

```
capacity = courtCount + ON_DECK_LOOKAHEAD
```

With `ON_DECK_LOOKAHEAD = 1` (the default):

| Courts | On-deck capacity |
|---|---|
| 1 | 2 |
| 2 | **3** |
| 3 | 4 |
| 4 | 5 |

The `+1` lookahead absorbs the gap when two courts finish nearly simultaneously — the second court always has a match waiting rather than idling while the engine refills.

The fill loop stops gracefully when the player pool is exhausted, so no phantom matches are ever created.

---

## Last-Resort Time Fallback

If the anchor has waited **more than `FALLBACK_WAIT_MINUTES = 15` minutes** and all skill-window expansion passes have failed to find a group:

1. Skill validation is **bypassed entirely** — any 3 players fill the group.
2. Overlap penalties still apply (to avoid repeating exact matches where possible).
3. The match is **always flagged `is_mixed_level = true`** so the organizer's UI highlights it.

This prevents indefinite starvation: a Beginner who joined an all-Advanced session will eventually be matched at the 15-minute mark rather than waiting forever.

**Threshold order:** Normal window (±1) → Max window (±2) → Red Zone extensions (±3, ±4) → Last-resort fallback.

---

## Red Zone

A player enters the Red Zone when their wait time reaches **25 minutes** (`CRITICAL_WAIT_MINUTES`).

### Effects of Red Zone status

| Behaviour | Detail |
|---|---|
| **Always anchors** | Red Zone player is guaranteed to be in the next match |
| **Game debt ignored** | `priorityScore = 1000 + waitMinutes` regardless of games played |
| **Skill window expands** | Engine tries ±1, ±2, ±3, ±4 in succession |
| **Swap immunity** | A Red Zone companion cannot be benched for diversity |
| **Gate release** | Red Zone player immediately releases the soft gate |
| **Never penalised** | Overlap penalty capped at 100× instead of 10,000× |

---

## Paused Players

An organizer can **pause** a player in the queue (`is_paused = true`). Paused players are:

- **Invisible to the engine** — filtered out before pool scoring
- **Not matched** under any circumstances, even in last-resort fallback
- **Still counted by the soft gate** (gate reads `status = "waiting"` from the view, which includes paused players) — this is a minor conservative effect that causes the gate to fire slightly more often than strictly necessary, but is always safe.

---

## Entry Points

### `runEngineForSession(sessionId)` — automatic trigger

Called by: toggle-ON event, `joinQueueAction`, `endMatchAction`, `clearOnDeckMatch`.

Checks the **auto-matchmaking toggle** first. If OFF, returns immediately. If ON, calls `runEngineInternal`.

### `callNextMatch(sessionId, courtId)` — organizer action

Called when organizer taps "Call Next Match" on a court card.

1. Tries to **promote** the oldest pending on-deck match to the court.
2. If no on-deck match exists and **toggle is ON**, runs the engine inline (`bypassGate = true`) then retries promotion once.
3. If toggle is OFF and no on-deck match exists, returns an error message.
4. After a successful promotion, **always** runs the engine to refill the slot (toggle-independent — even if toggle was just switched OFF, the slot is still refilled once).

### `runEngineInternal(supabase, sessionId, bypassGate?)` — internal

The core filler loop. Not exported to the client. Checks capacity, soft gate, then calls `createOneOnDeckMatch` for each available slot.

---

## Constants Reference

| Constant | Value | Purpose |
|---|---|---|
| `PLAYERS_PER_MATCH` | 4 | Players per court (always doubles) |
| `SKILL_VARIANCE_TARGET` | 1 | Preferred max pairwise skill gap (±1 level) |
| `SKILL_VARIANCE_MAX` | 2 | Hard max skill gap for normal matches (±2 levels) |
| `GAME_PENALTY_MINUTES` | 12 | Virtual minutes deducted per game played in priority score |
| `CRITICAL_WAIT_MINUTES` | 25 | Wait threshold for Red Zone (priority = 1000 + wait) |
| `RED_ZONE_SCORE_FLOOR` | 1000 | Minimum priority score that signals Red Zone |
| `FALLBACK_WAIT_MINUTES` | 15 | Wait threshold for last-resort skill bypass |
| `ANTI_REPEAT_LOOKBACK` | 5 | Max recent matches examined for diversity checks |
| `BOTTLENECK_THRESHOLD_MINUTES` | 20 | Wait time at which the Wait Monitor flags a player |
| `GATE_POOL_THRESHOLD` | 4 | Max waiting players that activates the soft gate |
| `GATE_HOLD_MINUTES` | 8 | Minutes before soft gate releases by timeout |
| `ON_DECK_LOOKAHEAD` | 1 | Extra on-deck slots beyond courtCount |

---

## Decision Flow Diagram

```
runAlgorithm()
│
├─ Fetch waiting pool (status = "waiting", not paused)
│
├─ Score & sort by priorityScore DESC, joined_at ASC
│
├─ Anchor = pool[0]  (highest priority)
│
├─ Build overlapMap  (anchor's pairing history with each candidate)
│
├─ For each skill window [±1, ±2, (±3, ±4 if Red Zone)]:
│  │
│  ├─ eligible = candidates within ±maxVariance
│  ├─ if eligible.length < 3 → expand window
│  │
│  ├─ scored = scoreCandidates(eligible, overlapMap)
│  │            sorts by: -(priorityScore) + overlapPenalty
│  │
│  ├─ group = buildCombinationGroup(anchor, scored, maxVariance)
│  │            N-choose-3 search, returns first valid triple
│  │
│  ├─ if group.length < 3 → expand window
│  │
│  └─ isDiversityViolation([anchor + group], recentRosters)?
│     │
│     ├─ NO  → snakeDraft → executeMatch ✅
│     │
│     └─ YES → is swap target (group[2]) in Red Zone?
│              │
│              ├─ YES → Red Zone immunity: skip swap
│              │         snakeDraft → executeMatch ✅ (diversity accepted)
│              │
│              └─ NO → Tier 1: try replacing group[2] with any
│                       other candidate (same ±maxVariance window)
│                       │
│                       ├─ diverse swap found →
│                       │   snakeDraft → executeMatch ✅
│                       │
│                       └─ no diverse swap →
│                           Tier 2: swapPool empty AND maxVariance < MAX?
│                           │
│                           ├─ YES → try candidates at ±SKILL_VARIANCE_MAX
│                           │         diverse swap found →
│                           │         snakeDraft → executeMatch ✅
│                           │
│                           └─ NO → Tier 3: partner rotation
│                                    rotatedDraft → executeMatch ✅
│                                    (forced repeat, different team split)
│
└─ All windows exhausted AND anchor.wait > FALLBACK_WAIT_MINUTES?
   │
   ├─ YES → last-resort fallback: any 3 players, isMixedLevel=true
   │         snakeDraft → executeMatch ✅
   │
   └─ NO → return "No compatible match could be formed"
```

---

## Team Assignment

Once a valid group of 4 is confirmed, teams are assigned with **snake draft** to minimise the aggregate skill gap:

```
Sort 4 players descending by skill_level_int: [P0, P1, P2, P3]
Team A = [P0, P3]  ← highest + lowest
Team B = [P1, P2]  ← 2nd + 3rd
```

Example: skill levels [7, 6, 5, 4]  
Team A = 7+4 = 11 · Team B = 6+5 = 11 → perfectly balanced.

For forced repeats, `rotatedDraft` overrides this with one of three alternative splits (see [Partner Rotation](#partner-rotation)).

---

## What the Engine Does NOT Do

- **It does not guarantee zero repeats.** With small groups (< 8 players) the engine will eventually cycle through all unique combinations and must repeat. Partner rotation minimises the impact.
- **It does not balance win/loss records.** Teams are built on skill level, not current W/L. The leaderboard is a separate system.
- **It does not consider gender, physical condition, or preferences.** Grouping is purely skill + fairness + diversity.
- **It does not place matches on courts directly.** All engine output is `status = "pending"`. Court assignment is always an organiser action.
- **It does not run on a timer.** The engine is event-driven: it fires when players join, matches end, or the organiser acts. There is no polling loop.
