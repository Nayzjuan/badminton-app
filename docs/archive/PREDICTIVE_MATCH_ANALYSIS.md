# Predictive Match Swap — Systems Architecture Assessment

**Feature:** Simulate a future high-quality match by combining queue players with the players
from the longest-running active court. Show an Accept/Decline hint to the organizer. On Accept,
replace the current On Deck match with the prediction.

**Status:** Pre-implementation analysis. No code changes proposed here.

---

## Table of Contents

1. [Threat Model Summary](#1-threat-model-summary)
2. [Operational & Psychological Risks](#2-operational--psychological-risks)
   - 2.1 The Bait and Switch
   - 2.2 Back-to-Back Exhaustion
3. [State & Concurrency Conflicts](#3-state--concurrency-conflicts)
   - 3.1 Stale Prediction on Accept
   - 3.2 Red Zone Player Emerges During Deliberation
   - 3.3 Engine Re-fires After Accept
   - 3.4 Target Court Finishes While Organizer Decides
4. [Proposed Architecture](#4-proposed-architecture)
   - 4.1 Storage Strategy Decision
   - 4.2 Server Action Design
   - 4.3 Accept Transaction (Atomic Flow)
5. [Proposed UI/UX Workflow](#5-proposed-uiux-workflow)
6. [Schema Changes Required](#6-schema-changes-required)
7. [Open Questions for Product Decision](#7-open-questions-for-product-decision)
8. [Risk Register](#8-risk-register)
9. [Interaction Safeguards & Transactional Integrity](#9-interaction-safeguards--transactional-integrity)
   - 9.1 The "Reject" Action (The Mute Mechanism)
   - 9.2 The "Accept" Pre-Flight Check
   - 9.3 Database Integrity (PostgreSQL RPC for Atomic Swap)
   - 9.4 Graceful UI Recovery
10. [Targeted Queue Replacement (Match ID Binding)](#10-targeted-queue-replacement-match-id-binding)
    - 10.1 Engine Binding Logic
    - 10.2 Data Flow Through the Stack
    - 10.3 Organizer UI Clarity
    - 10.4 RPC Parameter Contract
11. [Player View Sync & UX Handling](#11-player-view-sync--ux-handling)
    - 11.1 Real-Time Event Propagation
    - 11.2 Bumped Player Dashboard Behaviour
    - 11.3 Player-Side Toast Notification

---

## 1. Threat Model Summary

| Risk | Severity | Exploitability | Verdict |
|---|---|---|---|
| Bait & Switch ruins bumped player queue positions | High | Certain if not handled | **Mitigable** — clearOnDeckMatch already preserves `joined_at` |
| Back-to-back exhaustion for court players | Medium | Certain without cooldown | **Mitigable** — add cooldown check or UI warning |
| Stale prediction on Accept (3-min delay) | High | Very likely in active sessions | **Must re-validate server-side on Accept** |
| Engine fires between clear + predictive insert (race) | Critical | Certain without atomicity | **Must use single atomic server action** |
| Target court finishes before Accept | Medium | Likely | **Mitigable** — re-validate player availability on Accept |
| Red Zone player bumped from On Deck | High | Possible | **Must be blocked server-side** |

---

## 2. Operational & Psychological Risks

### 2.1 The Bait and Switch

**Scenario:** Court 1 has a high-quality predicted match. The organizer accepts. The current
On Deck match's 4 players are bumped back to the waiting queue.

**Current On Deck player state (before bump):**
```
queue_entries.status = "on_deck"
queue_entries.joined_at = <original time they joined the queue>
queue_entries.games_played = <unchanged since they haven't played>
```

**Good news:** The existing `clearOnDeckMatch` server action already handles this correctly.
It restores players to `waiting` **without modifying `joined_at` or `games_played`**. Their
queue position and wait clock are fully preserved — they re-enter the waiting pool exactly
as they were before being selected.

**The Red Zone edge case:**

A player was `on_deck` for 10 minutes. Their `joined_at` is 22 minutes ago. After being
bumped back to `waiting`, their `wait_minutes` (computed live by the `v_queue_with_wait_time`
view) correctly reflects 22+ minutes. This means they are **3 minutes away from Red Zone**.
The engine will re-run after the bump and should prioritise them immediately.

**Hard block required:** The Accept action must **refuse to proceed** if any player in the
current On Deck match has `wait_minutes ≥ CRITICAL_WAIT_MINUTES (25)`. Bumping a Red Zone
player is categorically unacceptable — their situation is already critical, and removing
them from On Deck would reset the clock psychologically even if the data is correct.

**Recommended copy for this block state:**
> "Cannot accept: [Player Name] has been waiting 26 minutes and is already On Deck.
> Clear this match manually before using predictions."

---

### 2.2 Back-to-Back Exhaustion

**Scenario:** Court 3 has been running for 22 minutes. The algorithm identifies that Court 3's
players (who will finish soon) combine with 3 queue players to form a near-perfect match.
The organizer accepts. Court 3 finishes 2 minutes later. Those 4 players get ~120 seconds
of rest before being placed on the next court.

**Why this matters at the gym:**
- Physical: badminton doubles is intense. Zero rest between games leads to injuries and player
  complaints.
- Social: players who feel they're being "run back out" will distrust the system and the
  organizer. One bad experience poisons adoption.

**Proposed policy options (product decision required — see §7):**

| Option | Mechanism | Tradeoff |
|---|---|---|
| **A. Soft warning only** | UI shows "⚠ Back-to-Back: [names]" in Accept modal. Organizer decides. | Flexible but relies on organizer vigilance |
| **B. Mandatory cooldown skip** | After a `completed` match, players are ineligible for the *next* predicted match. The prediction engine skips them. | Requires tracking `last_completed_match_at` on `queue_entries` or a derived check |
| **C. Configurable per-session** | Add `rest_between_games: boolean` to session settings. | Most flexible, highest implementation cost |

**Recommended for v1:** Option A (soft warning). It's zero-schema-cost, keeps the organizer
in control, and surfaces the right information. Cooldown enforcement (Option B) can be added
in v2 once we have real usage data on how often back-to-back actually happens.

**Implementation note for Option B:** The `endMatchAction` already sets `joined_at = now()`
when re-queuing players. A cooldown could be implemented by adding a `rest_until` timestamptz
column to `queue_entries` and filtering `rest_until < now()` in the prediction engine's
eligible-player query.

---

## 3. State & Concurrency Conflicts

### 3.1 Stale Prediction on Accept (The 3-Minute Problem)

**Scenario timeline:**
```
T+0:00  Prediction computed: "Court 1 + Players A,B,C = perfect match"
T+0:30  Hint shown to organizer
T+2:00  Court 2 finishes → engine runs → Court 2 players rejoin queue
T+2:10  Engine creates a NEW On Deck match (different players than the prediction)
T+3:00  Organizer clicks Accept on the original prediction
T+3:01  Server receives Accept request — state is now completely different
```

**Problems at T+3:01:**
1. The On Deck match that would be bumped is a DIFFERENT match than the one that existed
   when the prediction was shown.
2. Court 1 (the target) may have already finished — its players are now back in the queue
   with `joined_at = now()`, making the prediction logic refer to stale player states.
3. Queue composition has shifted — the "perfect match" may no longer be the best grouping.

**Resolution — Mandatory Server-Side Re-Validation on Accept:**

The Accept server action must:
1. Check `generated_at` of the prediction. If `now() - generated_at > PREDICTION_TTL`
   (suggested: 5 minutes), reject with: "Prediction expired. Dismiss and let the engine
   re-evaluate."
2. Check that Court X (`target_court_id`) is still `in_progress`. If it already finished,
   the players are in the queue and the prediction is moot — the engine's normal flow
   already handles them.
3. Re-run the prediction simulation to confirm the same 4 players are still the optimal
   group. If the result differs significantly (different players), show a "Match changed"
   warning with the updated composition before confirming.

---

### 3.2 Red Zone Player Emerges During Deliberation

**Scenario:** Player D has been waiting 23 minutes at T+0. The prediction doesn't include
Player D (they weren't the anchor because they were just under Red Zone). At T+2:00,
Player D crosses 25 minutes → Red Zone.

**Impact on the prediction:**
- Player D's `priorityScore` jumps from ~(23 - games×12) to 1023+.
- If the engine runs (triggered by any event), Player D becomes the anchor.
- The existing prediction no longer represents the highest-priority grouping.

**This is actually not a hard failure** — the prediction is a *hint*, not a guarantee. The
organizer can decline. However, the hint UI should display a live "freshness indicator"
(e.g., "Generated 2 min ago") so the organizer knows to treat old predictions skeptically.

**Critical rule:** If Player D is in the *current On Deck match* and is Red Zone, the Accept
hard block from §2.1 applies. The prediction cannot bump Player D.

---

### 3.3 Engine Re-fires After Accept — Race Condition ⚠️

**This is the most critical concurrency risk.**

The current architecture: `clearOnDeckMatch` → restores players to `waiting` → **calls
`runEngineForSession` as a hook**. The engine runs immediately and creates a new On Deck
match from the queue.

**If Accept is implemented as two sequential calls:**
```
1. clearOnDeckMatch(existingOnDeckMatchId)  ← engine fires here, creates Match X
2. createPredictiveOnDeckMatch(predictedPlayers)  ← creates Match Y
```

**Result:** Two On Deck matches exist simultaneously. The capacity counter (which expects
max `courtCount - 1` pending matches) is violated. The engine may have already consumed
the predicted players in Match X.

**Resolution — Atomic Accept Server Action:**

The Accept action must be a **single server action** that:
1. Validates the prediction (TTL, player availability, no Red Zone bumps)
2. Fetches players from the existing On Deck match
3. In a single DB transaction (or rapid sequential writes guarded by CAS):
   a. Deletes the existing pending match row
   b. Restores bumped players to `waiting` in `queue_entries`
   c. Creates the new predictive pending match row
   d. Sets predicted players to `on_deck` in `queue_entries`
4. Does **NOT** call `runEngineForSession` — the engine is bypassed entirely for this
   Accept flow. The prediction IS the engine output for this cycle.

By doing steps a–d atomically, the engine has no window to fire in between.

---

### 3.4 Target Court Finishes Before Accept

**Scenario:** Court X is the target. The organizer has the prediction hint open. Court X
finishes (a player submits the score). `endMatchAction` runs: players re-queued, engine
fires, new On Deck match possibly created.

**At this point, the prediction is technically invalid** because:
- Court X players now have `joined_at = now()` (fresh restart from `endMatchAction`)
- They are `waiting`, not `playing`
- The "future" being predicted is now the present

**However, this creates an opportunity:** the prediction is now directly actionable. The
predicted match can be formed right now, not "when Court X finishes."

**Proposed handling on Accept:**
The server action checks each predicted player's current status:
- If all 4 are `waiting` → proceed immediately (the court finished, good timing)
- If some are `playing` (still on court) → standard flow (prediction will activate on court finish)
- If some are `on_deck` in a different match → conflict, reject with details

---

## 4. Proposed Architecture

### 4.1 Storage Strategy Decision

Four options were evaluated:

| Option | Description | Verdict |
|---|---|---|
| **A. `matches.status = "predicted"`** | Add new status value | ❌ Contaminates match queries, breaks engine capacity counts |
| **B. Separate `match_predictions` table** | Isolated table with TTL and status | ✅ Clean isolation, but requires migration |
| **C. Ephemeral (React state only)** | No DB write until Accept | ✅ Zero DB cost, always fresh on Accept |
| **D. `sessions.pending_prediction jsonb`** | Denormalized on session row | ❌ Wrong granularity, hard to query |

**Recommendation: Option C (Ephemeral) for v1.**

The prediction is a *read-only simulation*. Nothing should be persisted until the organizer
commits. This sidesteps all stale-state DB problems:

- Prediction is computed server-side and returned to the client as plain data.
- Client holds it in React state with a `generatedAt` timestamp.
- Client shows an expiry countdown (e.g., "Valid for 3:24").
- On Accept, the server re-runs the simulation and creates the real `pending` match.
- If the re-run produces a different composition, the Accept modal shows a diff and asks
  for re-confirmation.

**Option B (separate table) for v2** if we want cross-device persistence (e.g., co-organizers
sharing a prediction across devices) or audit logging of prediction decisions.

---

### 4.2 Server Action Design

```
getPrediction(sessionId) → PredictionResult
  // Read-only. Finds longest-running active court.
  // Simulates combining its 4 players (post-finish) with queue.
  // Returns: { targetCourtId, targetCourtName, runningMinutes,
  //            predictedPlayers, teamA, teamB, balanceScore,
  //            backToBackWarnings, generatedAt }
  // NO writes. Safe to call repeatedly.

acceptPrediction(sessionId, prediction: PredictionSnapshot) → AcceptResult
  // Validates: TTL, no Red Zone bumps, player availability
  // Atomic: clear old On Deck + create new predictive On Deck
  // Returns: { success, bumpedPlayers, newMatchId, warnings }
```

`PredictionSnapshot` = the prediction data the client received from `getPrediction`,
passed back verbatim so the server can compare against the re-validated result.

---

### 4.3 Accept Transaction (Atomic Flow)

```
acceptPrediction:
  1. Re-run getPrediction simulation server-side
  2. VALIDATE:
     a. |now - prediction.generatedAt| ≤ 5 min  → else: REJECT "Expired"
     b. target court still in_progress           → else: WARN "Court finished, players in queue"
     c. no predicted player has status != waiting/playing → else: REJECT with details
     d. current On Deck match has no Red Zone player → else: REJECT with names

  3. FETCH current On Deck match + its players

  4. ATOMIC WRITES (no engine hook between these):
     a. DELETE matches WHERE id = onDeckMatchId AND status = 'pending'  [CAS guard]
     b. UPDATE queue_entries SET status='waiting'
        WHERE session_id = X AND player_id IN (bumped players)
        -- joined_at and games_played left unchanged
     c. INSERT INTO matches (session_id, court_id=null, status='pending', ...)
     d. INSERT INTO match_players (match_id=new, player_id, team) × 4
     e. UPDATE queue_entries SET status='on_deck'
        WHERE session_id = X AND player_id IN (predicted waiting players)
        -- Note: court players remain 'playing' until their match ends naturally

  5. RETURN { success, newMatchId, bumpedPlayers, warnings }
  // Engine is NOT called. The prediction IS the on-deck fill for this cycle.
```

**Why no engine call after step 4?**
The engine's job is to fill empty on-deck slots. After the Accept transaction, one on-deck
slot is filled (the predictive match). Calling the engine would try to fill a second slot,
which may or may not be appropriate depending on capacity. Let the engine run naturally
on the next trigger event (next joinQueue, endMatch, etc.).

---

## 5. Proposed UI/UX Workflow

### Phase 1 — Prediction Hint (Non-intrusive Banner)

**Location:** Inline in the On Deck panel, below existing on-deck cards.

**Triggers:** Shown when all courts are `in_progress` AND a prediction computation returns a
balance score above threshold (e.g., max skill diff ≤ 1).

**Content:**
```
┌─────────────────────────────────────────────────────────────────┐
│  🔮  Predicted Match  ·  Court 2 (18 min)       Valid for 4:12  │
│  [Player A] & [Player C]  vs  [Player B] & [Player D]           │
│  Balance: ★★★★★  ·  ⚠ Back-to-back: Player A                   │
│                                     [Dismiss]  [Review & Accept] │
└─────────────────────────────────────────────────────────────────┘
```

- "Valid for 4:12" — live countdown from `generatedAt + 5 min`
- Hint auto-disappears when countdown hits 0 (client-side timer)
- Dismiss = hide for this prediction cycle only (re-appears if courts change)

---

### Phase 2 — Accept Confirmation Modal

Triggered by "Review & Accept". Opens a modal with two columns:

**LEFT: Being replaced (On Deck)**
```
Currently On Deck — will be returned to queue:
  • Player E  —  waited 18 min  —  2 games  ← normal, safe to bump
  • Player F  —  waited 12 min  —  1 game
  • Player G  —  waited 9 min   —  3 games
  • Player H  —  waited 7 min   —  0 games
These players keep their queue position.
```

**RIGHT: Incoming Predictive Match**
```
New On Deck — awaiting Court 2:
  Team A:  Player A (Intermediate) + Player D (Upper Beginner)
  Team B:  Player B (Lower Intermediate) + Player C (Intermediate)
  ⚠ Player A will play back-to-back (no rest after Court 2).
```

**Warning states that block Confirm:**
- 🔴 Any bumped player is in Red Zone (≥ 25 min wait)
- 🔴 Prediction is expired (> 5 min old)
- 🔴 A predicted player's status has changed (conflict)

**Warning states that allow Confirm with acknowledgment:**
- 🟡 One or more back-to-back players
- 🟡 Target court already finished (prediction is still valid, court players in queue)
- 🟡 Prediction composition changed from original hint (show diff)

**Footer buttons:**
- `[Cancel]` — close modal, no changes
- `[Confirm Swap]` — disabled if any red block condition; otherwise enabled

---

### Phase 3 — Post-Accept State

After successful Accept:
- On Deck panel refreshes: shows the new predictive match with an amber "Awaiting Court 2"
  label instead of the standard "Will be assigned when a court frees up"
- Bumped players reappear in the queue panel with their original positions
- No toast needed — the visual change is self-explanatory (the On Deck card changed)
- The prediction hint disappears (its work is done)

---

## 6. Schema Changes Required

### For v1 (Ephemeral — No DB changes)**

No schema migration needed. The prediction lives entirely in client React state and is
re-validated server-side on Accept.

### For v2 (Persistent Predictions — Optional)**

```sql
-- New table for cross-device prediction sharing and audit log
CREATE TABLE match_predictions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  target_court_id uuid NOT NULL REFERENCES courts(id),
  predicted_players jsonb NOT NULL,
  -- [{player_id, display_name, team, skill_level, source: "queue"|"court"}]
  balance_score   float,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'accepted', 'declined', 'expired')),
  decided_at      timestamptz,
  decided_by      uuid REFERENCES profiles(id)
);

CREATE INDEX ON match_predictions (session_id, status, expires_at);
```

### For Cooldown Enforcement (Option B, v2)**

```sql
-- Add to queue_entries:
ALTER TABLE queue_entries
  ADD COLUMN last_played_at timestamptz DEFAULT null;

-- Update endMatchAction to set last_played_at = now() when re-queuing players.
-- Prediction engine filters: last_played_at IS NULL OR last_played_at < now() - interval '5 minutes'
```

---

## 7. Open Questions for Product Decision

These require explicit design decisions before implementation begins:

| # | Question | Options | Recommendation |
|---|---|---|---|
| 1 | **Cooldown enforcement** | Soft warning only / Hard 1-game block / Configurable | Soft warning for v1 |
| 2 | **Prediction TTL** | 2 min / 5 min / Until court finishes | 5 min, shown as countdown |
| 3 | **How many on-deck matches to show predictions for?** | Only when 0 on-deck / Always / Threshold-based | Only when 0 on-deck |
| 4 | **What constitutes "longest-running" court?** | By `started_at` / By projected finish time | By `started_at` DESC |
| 5 | **Multi-on-deck: which match gets replaced?** | Oldest pending / Newest pending / Organizer picks | Oldest pending (FIFO) |
| 6 | **Who can see the prediction hint?** | Primary organizer only / All co-organizers | All co-organizers |
| 7 | **Persist predictions (v2 table)?** | Yes (cross-device, audit log) / No (ephemeral) | No for v1 |
| 8 | **Balance score threshold to show hint?** | Always show / Only if ≤ ±1 skill diff | Only if all 4 within ±2 |

---

## 8. Risk Register

| ID | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | Red Zone player bumped from On Deck | Medium | Critical | Hard block in server action | Engine |
| R2 | Back-to-back exhaustion | High | Medium | Soft warning in Accept modal | UI |
| R3 | Engine fires between clear and predictive insert | Certain | High | Atomic server action, skip engine hook | Server action |
| R4 | Stale prediction on Accept | High | Medium | Server-side re-validation + TTL | Server action |
| R5 | Target court finishes before Accept | Medium | Low | Detect in validation, allow with warning | Server action |
| R6 | Two on-deck matches created (capacity violation) | High (without fix) | High | Atomic insert, skip engine | Server action |
| R7 | Prediction degrades UX by showing too frequently | Medium | Medium | Show only when On Deck is empty | UI |
| R8 | Co-organizer accepts stale prediction from another device | Low (v1) | Medium | TTL check; v2: optimistic locking | Server action |

---

## 9. Interaction Safeguards & Transactional Integrity

This section defines the exact safeguards required for the two primary organizer interactions:
**Reject** (dismiss the prediction) and **Accept** (swap the On Deck match). These rules must
be enforced at the server layer — the client is untrusted and can hold arbitrarily stale state.

---

### 9.1 The "Reject" Action (The Mute Mechanism)

**Problem:** When an organizer clicks "Dismiss", the prediction hint should not reappear
immediately with the exact same four-player grouping. Without a mute mechanism, the next
engine trigger (any player joining the queue, any court finishing) would re-compute the
same prediction and flash the banner again within milliseconds.

**Why a mute is necessary:**
The prediction engine is deterministic for a given queue state. Dismissing the hint does
not change the queue — so without muting, dismiss is effectively a no-op. This would be
frustrating enough that organizers would stop trusting the hint entirely.

**Proposed strategy: Client-side ephemeral blacklist with a session-scoped key**

Since predictions are ephemeral (no DB write until Accept), the mute should also be
ephemeral — it lives in React state on the organizer's client.

```
// Mute key = stable hash of the 4 predicted player IDs (sorted, joined)
type MuteKey = string;  // e.g., "uuid-A:uuid-B:uuid-C:uuid-D" (sorted alphabetically)

// Stored in organizer component state
const [mutedPredictions, setMutedPredictions] = useState<Set<MuteKey>>(new Set());
```

**Mute lifecycle:**
1. Organizer clicks "Dismiss" → compute `muteKey` from the 4 predicted player IDs → add to `mutedPredictions` set.
2. `getPrediction` result arrives → before showing the hint, check if the result's 4 players hash to a muted key → if yes, silently discard.
3. **Auto-expiry condition:** The mute is cleared from the set when **any** of the four muted players' queue state changes (they leave the queue, get placed on a court, or their status changes). This is detectable because the organizer dashboard already subscribes to real-time queue changes — the component can call `setMutedPredictions(new Set())` (or selectively remove) on queue update events.
4. **Maximum mute lifetime:** As a safety net, mutes older than the prediction TTL (5 minutes) are automatically cleared, even without a state change. This prevents the set from growing stale across very quiet sessions.

**Why not server-side muting:**
A server-side mute table (e.g., `session_prediction_mutes`) would add a DB write to every
Dismiss click, require cleanup jobs, and create contention in multi-organizer scenarios.
For v1, where the primary use case is a single organizer, ephemeral client state is the
correct tradeoff. If co-organizer collaboration is required in v2 (see §7, Q6), a
server-side mute row with a short TTL column is the upgrade path.

**Implementation contract:**
```
rejectPrediction(prediction: PredictionSnapshot) → void  [CLIENT-ONLY, no server call]
  1. Compute muteKey = prediction.predictedPlayers.map(p => p.player_id).sort().join(":")
  2. Add muteKey to mutedPredictions set
  3. Clear the active prediction hint from local state
  // No server action. No DB write.
```

---

### 9.2 The "Accept" Pre-Flight Check

The server action must verify the world hasn't changed since the organizer was shown the
prediction. These checks run **before any database write**. A single failure aborts the
entire operation with a specific error message.

**Pre-flight validation sequence (ordered by cheapness):**

**Check 1 — TTL Freshness**
```
IF now() - prediction.generatedAt > PREDICTION_TTL (5 min)
  → REJECT: "This prediction expired. Dismiss it and let the engine re-evaluate."
```
This is the cheapest check (no DB read) and eliminates the most common stale-accept
scenario. Run it first.

**Check 2 — Exact On Deck Match Identity**
```
IF prediction.existingOnDeckMatchId is provided:
  SELECT id, status FROM matches WHERE id = prediction.existingOnDeckMatchId
  IF NOT FOUND OR status != 'pending'
    → REJECT: "The On Deck match was already changed. Reload to see the current state."
```
This guards against concurrent organizer actions (e.g., a co-organizer manually cleared
the On Deck match between the time the prediction hint appeared and the Accept click).
The CAS pattern: we refuse to proceed if the row we intend to delete has changed.

**Check 3 — Red Zone Block on Bumped Players**
```
SELECT qe.player_id, qe.joined_at, qe.status, p.display_name
FROM queue_entries qe
JOIN profiles p ON p.id = qe.player_id
WHERE qe.session_id = sessionId
  AND qe.player_id IN (players from existingOnDeckMatch)

FOR EACH bumped_player:
  wait_minutes = (now() - bumped_player.joined_at) / 60
  IF wait_minutes >= CRITICAL_WAIT_MINUTES (25)
    → REJECT: "Cannot accept: [Player Name] has been waiting X minutes and is On Deck.
               Clear this match manually before using predictions."
```
This is a hard block — no override. A Red Zone player in On Deck must never be bumped.

**Check 4 — Predicted Players Availability**
```
SELECT player_id, status FROM queue_entries
WHERE session_id = sessionId
  AND player_id IN (prediction.waitingPlayers)  -- queue-sourced players only

FOR EACH predicted_queue_player:
  IF status NOT IN ('waiting')
    → REJECT: "[Player Name] is no longer available (status: [status]).
               The prediction is stale. Dismiss and re-evaluate."
```
The court-sourced players (`prediction.courtPlayers`) are expected to have `status = 'playing'`
or potentially `'waiting'` (if their court already finished — see §3.4). Both are acceptable:
```
FOR EACH predicted_court_player:
  IF status NOT IN ('playing', 'waiting')
    → REJECT: "[Player Name]'s status is unexpected ([status]). Cannot proceed."
```

**Check 5 — No Double-Booking (predicted players not already on_deck)**
```
IF any predicted player has status = 'on_deck' in a DIFFERENT match
  → REJECT: "[Player Name] is already assigned to another On Deck match."
```
This edge case is unlikely but possible if two organizers interact with the system
simultaneously in a multi-device scenario.

**Summary — Pre-flight Check Table:**

| # | Check | DB cost | On failure |
|---|---|---|---|
| 1 | TTL freshness | None | Hard reject |
| 2 | Exact on-deck match ID unchanged | 1 point read | Hard reject |
| 3 | No Red Zone player in bumped match | 1 range read | Hard reject |
| 4 | Predicted queue players still `waiting` | 1 range read | Hard reject |
| 5 | No predicted player already `on_deck` elsewhere | Covered by #4 read | Hard reject |

All five checks use read-only queries. No writes occur during pre-flight.

---

### 9.3 Database Integrity (PostgreSQL RPC for Atomic Swap)

**The partial failure problem:**

If the swap is implemented as sequential client-triggered calls:
```
// DANGEROUS — partial failure window exists between each call
await supabase.from("matches").delete().eq("id", onDeckMatchId)     // Step A
await supabase.from("queue_entries").update({status:"waiting"})...  // Step B
await supabase.from("matches").insert({status:"pending", ...})      // Step C
await supabase.from("match_players").insert([...])                  // Step D
await supabase.from("queue_entries").update({status:"on_deck"})...  // Step E
```

If Step C or D fails after Step A has succeeded, the original On Deck match is gone and
the predicted match was never created. The four bumped players have `status = 'waiting'`
(restored by Step B), but the predicted players are now **in limbo** — their
`queue_entries` rows were never updated. The engine may or may not fix this on its next
trigger. The court will have no On Deck match despite pending capacity.

**Proposed Supabase RPC: `swap_on_deck_match`**

```sql
CREATE OR REPLACE FUNCTION swap_on_deck_match(
  p_session_id          uuid,
  p_old_match_id        uuid,       -- On Deck match being replaced
  p_bumped_player_ids   uuid[],     -- Players from old match returning to queue
  p_new_match_team_a    uuid[],     -- Predicted Team A player IDs
  p_new_match_team_b    uuid[],     -- Predicted Team B player IDs
  p_on_deck_player_ids  uuid[]      -- Queue-sourced players to set on_deck
                                    -- (court-sourced players stay 'playing')
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_match_id uuid;
  v_deleted_count int;
BEGIN
  -- All operations inside a single transaction.
  -- Any failure causes a full rollback — no partial state.

  -- Step 1: CAS-delete the old On Deck match.
  -- The AND status='pending' guard ensures we only proceed if the match
  -- hasn't been altered by a concurrent action since pre-flight check #2.
  DELETE FROM matches
  WHERE id = p_old_match_id AND status = 'pending';

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  IF v_deleted_count = 0 THEN
    -- Another process already deleted or modified this match.
    RAISE EXCEPTION 'MATCH_ALREADY_CHANGED'
      USING DETAIL = 'The On Deck match was modified by a concurrent action.';
  END IF;

  -- Step 2: Delete old match_players rows (cascade should handle this,
  -- but explicit delete is clearer for auditability).
  DELETE FROM match_players WHERE match_id = p_old_match_id;

  -- Step 3: Restore bumped players to waiting.
  -- joined_at and games_played are intentionally NOT modified.
  UPDATE queue_entries
  SET status = 'waiting',
      updated_at = now()
  WHERE session_id = p_session_id
    AND player_id = ANY(p_bumped_player_ids)
    AND status = 'on_deck';

  -- Step 4: Create the new predictive On Deck match.
  INSERT INTO matches (id, session_id, court_id, status, created_at)
  VALUES (gen_random_uuid(), p_session_id, NULL, 'pending', now())
  RETURNING id INTO v_new_match_id;

  -- Step 5: Insert match_players for Team A.
  INSERT INTO match_players (match_id, player_id, team)
  SELECT v_new_match_id, unnest(p_new_match_team_a), 'A';

  -- Step 6: Insert match_players for Team B.
  INSERT INTO match_players (match_id, player_id, team)
  SELECT v_new_match_id, unnest(p_new_match_team_b), 'B';

  -- Step 7: Set queue-sourced predicted players to on_deck.
  UPDATE queue_entries
  SET status = 'on_deck',
      updated_at = now()
  WHERE session_id = p_session_id
    AND player_id = ANY(p_on_deck_player_ids)
    AND status = 'waiting';

  -- Return the new match ID so the client can optimistically update its state.
  RETURN jsonb_build_object('success', true, 'new_match_id', v_new_match_id);

EXCEPTION
  WHEN OTHERS THEN
    -- PostgreSQL automatically rolls back the transaction on any unhandled exception.
    -- Re-raise with context so the server action can surface the right error message.
    RAISE;
END;
$$;
```

**Key integrity guarantees this RPC provides:**

| Guarantee | Mechanism |
|---|---|
| Atomic execution | Single `plpgsql` transaction — all steps succeed or all roll back |
| No orphaned players | Bumped players restored in same transaction as new match creation |
| No capacity violation | Old match deleted before new one created — net On Deck count unchanged |
| Concurrent action guard | CAS on `status = 'pending'` in the DELETE; raises if count = 0 |
| Court-sourced players preserved | `p_on_deck_player_ids` only includes queue-sourced players; court players keep `playing` status untouched |

**Calling the RPC from the server action:**
```ts
const { data, error } = await supabase.rpc("swap_on_deck_match", {
  p_session_id: sessionId,
  p_old_match_id: existingOnDeckMatchId,
  p_bumped_player_ids: bumpedPlayerIds,
  p_new_match_team_a: teamA,
  p_new_match_team_b: teamB,
  p_on_deck_player_ids: queueSourcedPlayerIds,
});

if (error) {
  if (error.message.includes("MATCH_ALREADY_CHANGED")) {
    return { success: false, code: "STALE_MATCH", message: "..." };
  }
  return { success: false, code: "DB_ERROR", message: error.message };
}
```

**Engine bypass:** The server action does NOT call `runEngineForSession` after this RPC.
The predictive swap IS the engine output for this cycle. The next natural trigger
(joinQueue, endMatch, etc.) will resume normal engine operation.

---

### 9.4 Graceful UI Recovery

The Accept flow has two distinct phases with different UI states: the request lifecycle
(optimistic → loading → resolved) and error recovery (specific feedback per failure mode).

**Button states during the request lifecycle:**

```
[Idle]                     → [Submitting]                → [Resolved]
"Confirm Swap"             → "Confirming…" (spinner)     → modal closes / error shown
enabled                    → disabled (all modal buttons) → N/A
```

The entire Accept modal should disable all interactive elements (both "Cancel" and
"Confirm Swap") during the request. This prevents double-submits and prevents the
organizer from dismissing the modal while the transaction is in-flight, which would
leave the UI in an ambiguous state.

**No optimistic updates during Accept.** Unlike toggle or join-queue actions where
we flip local state immediately, the swap changes 3 separate concerns (On Deck panel,
queue list, bumped players). Optimistically updating all three would require complex
rollback logic. Instead: keep the current UI frozen during the ~300ms RPC call, then
refresh all three on success via the existing real-time subscriptions (which will fire
automatically when the DB rows change).

---

**Error recovery — specific toasts per failure mode:**

| Failure code | User-visible toast | Recommended action offered |
|---|---|---|
| `EXPIRED` (TTL exceeded) | "This prediction expired after 5 minutes. Dismiss and let the engine suggest a fresh match." | `[Dismiss]` button — no retry |
| `STALE_MATCH` (on-deck match changed) | "The On Deck match was already changed by another action. Reload to see the current state." | `[Reload]` button — triggers `router.refresh()` |
| `RED_ZONE_BLOCK` | "Cannot swap: [Name] has been waiting 27 minutes and cannot be bumped. Clear this match manually first." | `[Close]` button — no retry |
| `PLAYER_UNAVAILABLE` | "[Name] is no longer available (they may have left or been assigned). The prediction is stale." | `[Dismiss Prediction]` |
| `DOUBLE_BOOKING` | "[Name] is already in another On Deck match. The prediction is outdated." | `[Dismiss Prediction]` |
| `DB_ERROR` (unexpected) | "Something went wrong on our end. No changes were made. Try again or refresh." | `[Try Again]` button (re-enables Confirm Swap) + `[Cancel]` |

**Toast implementation notes:**
- Toasts should persist until dismissed (not auto-hide) for error states — the organizer
  needs to read the message and understand what to do next.
- `[Dismiss Prediction]` clears the prediction hint entirely (same effect as clicking
  "Dismiss" on the banner). Since the prediction is stale, there's no point retrying.
- `[Reload]` calls `router.refresh()` + the three client-side `refresh()` callbacks
  (`refreshQueue`, `refreshMatch`, `refreshSession`) — same as `useVisibilityRefresh`.
- For `DB_ERROR`, the "Try Again" button re-enables the Confirm button but does NOT
  recompute the prediction — it re-submits the same `PredictionSnapshot`. The server
  action's pre-flight checks will catch any new staleness.

**Post-success state:**
After a successful swap, the modal closes automatically. No success toast is needed —
the On Deck panel updates visually (the old match card is replaced by the new predictive
match card), which is sufficient feedback. The bumped players reappear in the queue
panel with their original positions. This follows the principle: the UI change IS the
confirmation.

---

---

## 10. Targeted Queue Replacement (Match ID Binding)

The prediction engine must not operate on an abstract concept of "the current On Deck match."
It must bind its suggestion to a **specific, named match row by ID** at the moment of
computation. This binding is the thread that connects the hint, the confirmation modal, the
RPC call, and the CAS delete into a single coherent operation.

---

### 10.1 Engine Binding Logic

When `getPrediction` runs, the first thing it does — before any player scoring — is identify
the exact On Deck match it intends to replace.

**Selection rule:** The match with `status = 'pending'` and `court_id = null` that has the
oldest `created_at` timestamp for this session. This is "On Deck #1" — the match that has
been waiting longest for a court assignment.

**Rationale for targeting the oldest:**
- FIFO discipline — the oldest On Deck match was formed first and should be the first to
  be reconsidered.
- Predictability — organizers can reason about which match the hint is targeting. There is
  no ambiguity about "which On Deck slot" the engine has picked.
- Avoids last-in-first-out bias — without a tie-breaking rule, the engine might repeatedly
  target newly formed matches (which are likely newer and less "stuck"), leaving older
  pending matches to age indefinitely.

**Binding query (conceptual):**
```sql
SELECT id, created_at
FROM matches
WHERE session_id = p_session_id
  AND status     = 'pending'
  AND court_id   IS NULL
ORDER BY created_at ASC
LIMIT 1;
```

If **no On Deck match exists** at prediction time, `getPrediction` returns `null` — there is
nothing to replace, so no hint should be shown. The engine's event-driven pipeline (see §4)
already handles filling empty On Deck slots; the predictive hint is only relevant when an
On Deck match already exists and a better alternative can be computed.

---

### 10.2 Data Flow Through the Stack

The `target_match_id` flows through every layer of the feature without mutation.

```
getPrediction(sessionId) → PredictionResult
  ├─ Queries oldest pending match → captures target_match_id
  ├─ Captures match_players for that match → bumped_player_ids
  ├─ Runs player scoring and grouping algorithm
  └─ Returns:
       {
         target_match_id:   uuid,          // ← bound here, immutable from this point
         target_match_label: "On Deck #1", // ← computed label for UI (position in queue)
         bumped_players:    Profile[],     // ← players who will return to queue
         predicted_players: ScoredPlayer[],
         teamA:             uuid[],
         teamB:             uuid[],
         balance_score:     number,
         back_to_back_warnings: string[],
         generated_at:      ISO8601,
       }
```

The client receives this object and stores it in React state as a `PredictionSnapshot`.
When the organizer clicks "Confirm Swap", the entire `PredictionSnapshot` — including the
original `target_match_id` — is passed back to `acceptPrediction` verbatim. The server
does not re-query "which match to replace." It uses exactly the ID the client sent.

The pre-flight check §9.2 Check 2 then verifies the row with that ID still exists and is
still `pending` — confirming no concurrent process changed it between `getPrediction` and
`acceptPrediction`.

---

### 10.3 Organizer UI Clarity

The Accept confirmation modal must name the target match explicitly so the organizer
cannot mistake which On Deck slot is being swapped.

**Modal header:**
```
┌─────────────────────────────────────────────────────────────┐
│  Confirm Match Swap                                         │
│  This will replace  On Deck #1  with the predicted match.  │
└─────────────────────────────────────────────────────────────┘
```

**"On Deck #1" label derivation:**
The label is computed at `getPrediction` time by ordering all current pending matches by
`created_at ASC` and assigning 1-based position numbers. The label is included in the
`PredictionResult` as `target_match_label` (a string, e.g. `"On Deck #1"`) so the
client never has to re-derive it.

**Why the label matters:**
In sessions with multiple On Deck matches, the organizer can visually cross-reference the
modal label with the On Deck panel card list and confirm they are replacing the correct
match. Without a label, the modal description "the current On Deck match" is ambiguous
when multiple pending matches are visible.

**Visual treatment in the modal (left column, Being Replaced section):**
```
On Deck #1 — will be returned to queue:
  • Player E  —  waited 18 min  —  2 games
  • Player F  —  waited 12 min  —  1 game
  • Player G  —  waited  9 min  —  3 games
  • Player H  —  waited  7 min  —  0 games
  These players keep their queue position and wait time.
```

The label "On Deck #1" should also be rendered as an amber chip (matching the existing
On Deck card styling in the organizer panel) so the organizer visually connects the modal
to the card they see on screen.

---

### 10.4 RPC Parameter Contract

The `target_match_id` is passed as a required, non-nullable parameter to
`swap_on_deck_match`. The RPC's CAS delete becomes the final, authoritative verification:

```sql
DELETE FROM matches
WHERE id     = p_old_match_id   -- ← target_match_id passed from acceptPrediction
  AND status = 'pending';        -- ← CAS guard: only proceed if still on-deck

GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
IF v_deleted_count = 0 THEN
  RAISE EXCEPTION 'MATCH_ALREADY_CHANGED' ...
END IF;
```

**Why this is sufficient as a final guard:**
The pre-flight check (§9.2 Check 2) verifies the match exists and is `pending` before
entering the RPC. However, there is a race window of ~1–5ms between the pre-flight read
and the RPC's DELETE. The `WHERE status = 'pending'` guard in the DELETE closes this
window: if a concurrent `promoteOnDeckMatchInternal` ran in that gap (moving the match
to `in_progress`), the DELETE finds 0 rows and aborts the entire transaction.

This double-check strategy (pre-flight read + RPC CAS delete) provides defence in depth
without requiring pessimistic locks or advisory lock overhead.

---

## 11. Player View Sync & UX Handling

When a swap occurs, four players are affected: four bumped back to waiting, four predicted
players moved to on_deck. All eight need their dashboards to update immediately and
accurately. This section details how that propagation happens and what the player sees.

---

### 11.1 Real-Time Event Propagation

**No custom WebSocket code is required.**

The PostgreSQL RPC `swap_on_deck_match` executes standard DML operations:
`DELETE FROM matches`, `DELETE FROM match_players`, `INSERT INTO matches`,
`INSERT INTO match_players`, and `UPDATE queue_entries` (twice — for bumped and
predicted players). These are plain row-level changes to the tables that the
existing Supabase Realtime subscriptions already watch.

**Subscription coverage in the current codebase:**

| Hook | Subscription | Tables watched |
|---|---|---|
| `useQueue` | `subscribeToQueue` | `queue_entries` |
| `usePlayerMatch` | `subscribeToMatches`, `subscribeToMatchPlayers` | `matches`, `match_players` |
| `useSessionData` | all five subscriptions | `courts`, `queue_entries`, `matches`, `match_players`, `profiles` |

When the RPC commits, Postgres emits WAL events. Supabase's replication slot picks them
up and broadcasts them via the existing WebSocket channels. Every client subscribed to
the affected `session_id` receives the changes within ~100–300ms — without any new
subscription code, custom channels, or additional DB triggers.

**Important:** Supabase Realtime only broadcasts changes on tables with **Row Level Security
(RLS) policies that allow the subscriber's role to read the row**, and only when Realtime
is enabled for the table in the Supabase dashboard. Verify that `matches`, `match_players`,
and `queue_entries` all have Realtime enabled before assuming propagation is automatic.

**Standard DML inside plpgsql functions does fire Realtime events** — this is a common
point of confusion. Supabase Realtime listens at the WAL (Write-Ahead Log) level, not at
the application query level. Changes committed inside a `plpgsql` function are indistinguishable
from changes committed by a direct client query. No special `NOTIFY` calls or trigger
functions are required.

---

### 11.2 Bumped Player Dashboard Behaviour

**Current player state before the swap:**
```
queue_entries.status = "on_deck"
```

The `usePlayerMatch` hook detects the player is in an active/pending match and renders
the **On Deck alert** (the full-width banner showing teammates, opponents, and court info).
The `useQueue` hook shows their position as `null` (on_deck players don't have a waiting
position number).

**After the RPC commits — change sequence as seen by the bumped player's client:**

1. **`queue_entries` UPDATE fires** (status: `on_deck` → `waiting`)
   - `subscribeToQueue` triggers → `useQueue.fetchQueue()` re-runs
   - `myEntry.status` changes to `"waiting"`
   - `myPosition` is recomputed: player reappears in the waiting queue at their original
     position (FIFO ordering by `games_played ASC, joined_at ASC` — `joined_at` was
     preserved by the RPC)

2. **`matches` DELETE fires** (the old On Deck match row is gone)
   - `subscribeToMatches` triggers → `usePlayerMatch.fetchMyMatch()` re-runs
   - The deleted match is no longer returned by the active-match query
   - `currentMatch` becomes `null`

3. **`match_players` DELETE fires** (the old match_players rows are gone)
   - `subscribeToMatchPlayers` triggers → another `fetchMyMatch()` re-run (idempotent)

**Net result on the bumped player's screen:**
- The On Deck banner **disappears** (because `currentMatch` is `null`)
- The player's **queue position reappears** (because `myEntry.status = "waiting"` again)
- The player's wait time continues counting from their original `joined_at` (unchanged)

This is mechanically correct but **visually jarring** without the toast notification in §11.3.
Without explanation, the on-deck banner vanishing looks like a bug or network glitch.

**No additional subscription code is needed** — all three hooks (`useQueue`,
`usePlayerMatch`, `useSessionData`) already subscribe to the relevant tables. The
`useVisibilityRefresh` hook also provides a fallback: if the player's WebSocket had gone
idle (phone screen locked), coming back to the app triggers an immediate re-fetch that
will pick up the post-swap state.

---

### 11.3 Player-Side Toast Notification

**The problem:** The dashboard change (on-deck banner disappearing, queue position
reappearing) happens correctly but silently. A player who was looking at their phone sees
the On Deck card vanish and their queue number reappear with no explanation. The natural
assumption: "The app broke."

This erodes trust in the system, even though the underlying data is perfectly correct.
One confused, anxious player asking "what happened to my match?" in a 16-person session
disrupts the flow for everyone.

**Proposed solution: Status-change driven toast on the Player Dashboard**

The trigger is a transition of `myEntry.status` from `"on_deck"` to `"waiting"`. This
transition can only happen in two scenarios:
1. The organizer ran `clearOnDeckMatch` on the player's match (manual clear).
2. The organizer accepted a predictive swap and the player was bumped.

In both cases, the correct message is the same: the player's match slot was removed and
they have returned to the queue. The distinction between "manual clear" and "predictive
swap" doesn't matter to the player — either way, they need to know they're back in line.

**Detecting the transition in `useQueue`:**

```ts
// Track previous status to detect on_deck → waiting transition.
const prevStatusRef = useRef<string | null>(null);

useEffect(() => {
  const prev = prevStatusRef.current;
  const curr = myEntry?.status ?? null;

  if (prev === "on_deck" && curr === "waiting") {
    // Player was bumped back to the queue — fire the notification.
    onBumpedBack?.();  // callback prop / event emitter
  }

  prevStatusRef.current = curr;
}, [myEntry?.status]);
```

The `onBumpedBack` callback is wired to the Player Dashboard's toast system.

**Toast content:**

```
┌─────────────────────────────────────────────────────┐
│  The organizer has adjusted the queue.              │
│  Your match has been rescheduled — you're back in   │
│  line at position #[X].                             │
│                                              [OK]   │
└─────────────────────────────────────────────────────┘
```

- The position number `#[X]` is live from `myPosition` at the moment the toast fires —
  since the queue re-fetch has already completed by then, this will be accurate.
- The toast must be **dismissible** (`[OK]` button) and must **not auto-hide** — the
  player needs to consciously acknowledge their situation, not have information flash
  away while they're reacting.
- The toast should render **above** (z-index higher than) the queue panel so it's
  immediately visible regardless of scroll position.

**Implementation note — avoiding false positives:**

The `on_deck → waiting` transition also occurs during the normal flow when `clearOnDeckMatch`
is called by the organizer without a predictive swap. The toast is still correct in that
case — the player's match was removed and they're back in line. The message copy is
intentionally generic ("organizer has adjusted the queue") rather than naming the
specific action, so it reads correctly for both the manual clear and predictive swap paths.

The transition does **not** fire on initial page load (when `prevStatusRef.current = null`)
or when a player first joins On Deck (`waiting → on_deck`), so there are no false positive
scenarios to guard against beyond the initial `null` check shown above.

**Optional enhancement (v2):** Add a second toast variant for the `on_deck → playing`
transition: "Your match is starting! Head to Court [X]." This is the natural complement
to the bump notification and completes the player-side status feedback loop.

---

*Generated: 2026-04-17 — Pre-implementation assessment only. No code changes made.*
