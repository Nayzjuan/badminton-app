# System Audit — Badminton Queue App
**Date:** 2026-04-15  
**Scope:** All server actions, hooks, and critical UI components  
**Auditor:** Staff Reliability Engineer (Claude)

---

## Executive Summary

**Overall Stability Score: 6.5 / 10 — Caution Before Live Session**

The core matchmaking algorithm is solid, and the real-time architecture (subscription + polling fallback) is well-designed. The primary risk is a cluster of **non-atomic read-then-write patterns** in the match lifecycle that will silently corrupt state if two organizer actions fire within milliseconds of each other — a likely scenario when two courts finish simultaneously. Additionally, several server actions that mutate match or profile data skip authorization checks entirely, which is a latent security gap that grows in risk as the user base expands.

The app is safe for a controlled session with a single organizer and no adversarial users. For any session with multiple organizers, concurrent court closures, or public registration links, the P0 items below **will** cause data corruption.

---

## Critical Vulnerabilities (P0)

These are things that **will** break the app during a live session.

---

### P0-1 — Race Condition: `endMatchAction` double-completion

**File:** `src/app/actions/match.ts`, lines 93–106  
**Risk:** Double score submission corrupts `games_played` for all 4 players and may auto-promote two on-deck matches to one court.

**The Bug:**  
The status check (`SELECT` at line 83) and the score write (`UPDATE` at line 98) are two separate round-trips with no atomicity guarantee. If a player taps "Submit Score" while the organizer clicks "End Match" at the same millisecond, both calls pass the status guard:

```ts
// BOTH callers read status="in_progress" — both proceed
if (match.status === "completed" || match.status === "cancelled") {
  return { success: false, message: `Match is already ${match.status}.` };
}

// UPDATE has NO status guard — both callers write successfully
const { error: matchUpdateError } = await supabase
  .from("matches")
  .update({ team_a_score: ..., status: "completed", completed_at: now })
  .eq("id", matchId);  // <-- only filters by id, NOT by status
```

**Consequences:**
- Match is marked completed twice — `games_played` increments by 2 for all 4 players
- `promoteOnDeckMatchInternal` is called twice, potentially assigning the same on-deck match to both callers' court IDs
- Players end up in a ghost "playing" state with no active match

The same non-atomic pattern exists in `cancelMatchAction` (lines 303–314).

---

### P0-2 — Race Condition: `promoteOnDeckMatchInternal` double-promotion

**File:** `src/app/actions/matchmaking.ts`, lines 147–219  
**Risk:** Same on-deck match assigned to two courts simultaneously; 4 players appear active on two courts at once.

**The Bug:**  
Both `endMatchAction` and `callNextMatch` call `promoteOnDeckMatchInternal`. When two courts finish within the same second, both calls:
1. `SELECT` the same oldest `pending` match (same row, same ID)
2. Both call `UPDATE ... .eq("id", match.id)` — no `.eq("status", "pending")` guard
3. Both succeed; the match is now `in_progress` twice with two different `court_id` values (last writer wins for `court_id`, but both courts got marked `in_use`)

```ts
const { error: updateError } = await supabase
  .from("matches")
  .update({ court_id: courtId, status: "in_progress", started_at: now })
  .eq("id", match.id);  // <-- no .eq("status", "pending") guard
```

---

### P0-3 — Missing Auth: `endMatchAction`, `cancelMatchAction`, `updateMatchDetails`

**File:** `src/app/actions/match.ts`, lines 75, 186, 289  
**Risk:** Any authenticated player can end, cancel, or overwrite scores for any match in the system.

**The Bug:**  
`endMatchAction` and `cancelMatchAction` create a Supabase client with the caller's auth session but **never verify the caller is an organizer** for the relevant session:

```ts
export async function endMatchAction(matchId, teamAScore, teamBScore) {
  const supabase = await createClient();
  // ← No getUser() call. No organizer role check. Any authenticated user
  //   who knows a matchId can call this and it will succeed.
  const { data: match } = await supabase.from("matches").select(...).eq("id", matchId)...
```

`submitMatchScore` (the player-facing wrapper) correctly validates that the caller is in the match. But `endMatchAction` itself — which is also called directly by the organizer dashboard — has zero auth validation.

**NOTE:** `updateMatchDetails` uses `createClient()` (row-level-security enforced) but RLS on the `matches` table likely only restricts by `session_id`, not by organizer role. If players can read their own session's matches, they may be able to update them too.

---

### P0-4 — Service-Role Actions with No Auth: `updatePlayerSkill`, `getPlayerPin`, `resetPlayerPin`

**File:** `src/app/actions/profile.ts`  
**Risk:** Any authenticated user can change any player's skill level or expose/reset any player's PIN.

**The Bug:**  
All profile actions use `createServiceClient()` — which **bypasses RLS entirely** — and accept a raw `userId` parameter:

```ts
export async function updatePlayerSkill(userId: string, newSkill: SkillLevel) {
  const supabase = createServiceClient();  // bypasses ALL RLS
  // No auth check. No verification userId === caller's id.
  await supabase.from("profiles").update({ skill_level: newSkill }).eq("id", userId);
}
```

A player who knows another player's UUID (obtainable from queue data) can call this action to demote their opponent's skill level, causing them to be matched against stronger opponents.

---

## Edge Cases & Gaps (P1)

These are weird UI states or logic flaws that cause degraded experience.

---

### P1-1 — Non-transactional `reconnectPlayer` ID Migration

**File:** `src/app/actions/auth.ts`, lines 196–261  
**Risk:** Account destruction if any migration step fails mid-way.

The reconnect flow migrates a player from `oldUserId` → `newUserId` across 4 sequential writes (queue_entries, match_players, profile insert, profile delete). There is no transaction wrapping these:

- If step 4 (insert new profile) fails after step 3 (delete new auto-created profile), the player has no profile row and is effectively locked out.
- If step 2 (update match_players) fails after step 1 (update queue_entries), the player's queue position belongs to `newUserId` but their match history belongs to `oldUserId`.

---

### P1-2 — `createManualMatch` is Client-Side — Bypasses Server Validation

**File:** `src/hooks/use-organizer-data.ts`, lines 366–401  
**Risk:** Relies entirely on RLS for security; no server-side business logic validation.

Unlike `endMatch` and `callNextMatch` which delegate to authenticated server actions, `createManualMatch` directly calls `supabase.from("matches").insert(...)` from the browser. This means:
- No server-side check that the court belongs to this session
- No server-side check that the selected players are actually in this session's queue
- All 4 writes (match, match_players, court status, queue entries) run client-side sequentially — if the browser closes between writes, the court stays `in_use` with no active match

---

### P1-3 — `generateOnDeckMatchesInternal` Sequential Loop Can Select Overlapping Players

**File:** `src/app/actions/matchmaking.ts`, lines 120–123

When `needed > 1` (e.g. 3 courts but 0 pending matches), the loop runs `createOneOnDeckMatch` sequentially. Each call queries the pool from `v_queue_with_wait_time`. The issue: `runAlgorithm` sets selected players' queue status to `on_deck` inside `executeMatch`, but the **second loop iteration's pool query may execute before the first iteration's DB writes have committed**, selecting the same 4 players again.

Result: two pending matches with the same 4 players. When either is promoted, the other sits as an orphaned ghost match.

---

### P1-4 — `signInAnonymously` Duplicate Name Check is Non-Atomic

**File:** `src/app/actions/auth.ts`, lines 59–67  
**Risk:** Two registrations submitted simultaneously with the same name both succeed.

```ts
const { data: activeEntries } = await service
  .from("queue_entries")
  .select(...)
  .ilike("profiles.display_name", displayName);

if (activeEntries && activeEntries.length > 0) {
  return { error: "Name taken..." };
}
// ← Two callers both pass the check before either creates their profile
```

In a scenario where two people scan the QR code simultaneously and both type "Alex", both registrations succeed. The queue then has two "Alex" entries, making the reconnect flow ambiguous.

---

### P1-5 — Dev Tools Have No Organizer Auth Check

**File:** `src/app/actions/dev.ts`  
**Risk:** Any authenticated player who knows the session ID can call `clearSessionData` and wipe the entire session.

```ts
export async function clearSessionData(sessionId: string) {
  const supabase = createServiceClient();  // service role, bypasses RLS
  // No auth check. No organizer verification.
  // Deletes ALL matches, queue entries, and resets all courts.
```

These actions should be behind an environment variable gate (`NODE_ENV === "development"`) or require organizer auth.

---

### P1-6 — `usePlayerMatch` Fetches All Match Players Across Sessions

**File:** `src/hooks/use-player-match.ts`, lines 43–45  
**Risk:** Potentially stale/wrong match shown to a reconnected player.

```ts
const { data: myAssignments } = await supabase
  .from("match_players")
  .select("match_id, team")
  .eq("player_id", playerId);
  // ← No session_id filter — returns ALL match_player rows for this user, ever
```

If a player reconnects and their match history includes completed matches from prior sessions, the subsequent filter by `session_id` and `status` corrects this — but the extra data fetch is wasteful and could theoretically show a stale result during the brief window after reconnect.

---

### P1-7 — Player UI Stuck on "Submitting..." if Score Already Completed

**File:** `src/components/player/player-dashboard.tsx` (inferred from score submission flow)  
**Risk:** Player sees permanent loading state when the race condition in P0-1 fires.

If the organizer ends the match a fraction of a second before the player submits their score, `submitMatchScore` validates the player is in the match (passes), delegates to `endMatchAction`, which then writes `status: "completed"` successfully (no guard catches the already-completed state). The action returns `success: true`, but the UI may fail to update because `usePlayerMatch` still has the stale `in_progress` state until the realtime event fires. Window: ~200ms–2s depending on Supabase RT latency.

---

## Actionable Fixes

### Fix #1 — Atomic Status Guard on `endMatchAction` (P0-1)

Add `.eq("status", "in_progress")` to the UPDATE query. Supabase returns 0 rows affected when the status has already changed — use `.select()` to detect this.

**`src/app/actions/match.ts`, replace lines 98–110:**

```ts
// BEFORE:
const { error: matchUpdateError } = await supabase
  .from("matches")
  .update({
    team_a_score: teamAScore,
    team_b_score: teamBScore,
    status: "completed" as const,
    completed_at: new Date().toISOString(),
  })
  .eq("id", matchId);

if (matchUpdateError) {
  return { success: false, message: `Failed to save scores: ${matchUpdateError.message}` };
}

// AFTER:
const { data: updatedMatch, error: matchUpdateError } = await supabase
  .from("matches")
  .update({
    team_a_score: teamAScore,
    team_b_score: teamBScore,
    status: "completed" as const,
    completed_at: new Date().toISOString(),
  })
  .eq("id", matchId)
  .eq("status", "in_progress")  // ← Atomic guard: only succeeds if still in_progress
  .select("id")
  .single();

if (matchUpdateError || !updatedMatch) {
  // Either a DB error, or another caller already completed this match
  return { success: false, message: "Match has already been completed or cancelled." };
}
```

Apply the same pattern to `cancelMatchAction` — add `.eq("status", "in_progress")` (or `.in("status", ["pending", "in_progress"])`) to its UPDATE query.

---

### Fix #2 — Atomic Guard on `promoteOnDeckMatchInternal` (P0-2)

Add `.eq("status", "pending")` to the promotion UPDATE so that if two concurrent callers both fetch the same match, only the first UPDATE wins.

**`src/app/actions/matchmaking.ts`, replace lines 162–176:**

```ts
// BEFORE:
const { error: updateError } = await supabase
  .from("matches")
  .update({
    court_id: courtId,
    status: "in_progress" as const,
    started_at: now,
  })
  .eq("id", match.id);

if (updateError) {
  return { success: false, message: `Failed to promote on-deck match: ${updateError.message}` };
}

// AFTER:
const { data: promoted, error: updateError } = await supabase
  .from("matches")
  .update({
    court_id: courtId,
    status: "in_progress" as const,
    started_at: now,
  })
  .eq("id", match.id)
  .eq("status", "pending")  // ← Only succeeds if still pending (atomic CAS)
  .select("id")
  .single();

if (updateError || !promoted) {
  // Another concurrent caller already promoted this match — gracefully bail out
  return { success: false, message: "On-deck match was already promoted by another request." };
}
```

---

### Fix #3 — Add Organizer Auth Check to `endMatchAction` and `cancelMatchAction` (P0-3)

Add identity verification at the top of both actions. The caller must be authenticated, and ideally their profile is verified against the session's organizer (if that relationship is tracked). At minimum, require authentication and validate the match belongs to a session the user can access.

**`src/app/actions/match.ts`, add to the top of `endMatchAction` and `cancelMatchAction`:**

```ts
export async function endMatchAction(
  matchId: string,
  teamAScore: number,
  teamBScore: number
): Promise<MatchActionResult> {
  const supabase = await createClient();

  // ← ADD: Verify caller is authenticated
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  // Fetch match (existing code)
  const { data: match, error: matchFetchError } = await supabase
    .from("matches")
    .select("id, session_id, court_id, status")
    .eq("id", matchId)
    .single();
  // ...rest of function
```

For `updatePlayerSkill` and PIN actions in `profile.ts`, add an auth check and verify `userId === user.id` (players can only update themselves) OR add an organizer-role check if organizer overrides are needed:

```ts
export async function updatePlayerSkill(userId: string, newSkill: SkillLevel) {
  // If this is organizer-only, add organizer verification here.
  // If players can update their own skill, verify:
  const supabaseAuth = await createClient();
  const { data: { user } } = await supabaseAuth.auth.getUser();
  if (!user) return { success: false, message: "Not authenticated." };
  // Only allow updating own profile unless caller is verified organizer:
  if (user.id !== userId) return { success: false, message: "Forbidden." };

  const supabase = createServiceClient();
  // ...rest of function
}
```

---

## Summary Table

| ID | Severity | File | Issue | Fixed By |
|----|----------|------|-------|----------|
| P0-1 | Critical | `actions/match.ts` | Non-atomic `endMatchAction` double-completion | Fix #1 |
| P0-2 | Critical | `actions/matchmaking.ts` | Non-atomic `promoteOnDeckMatchInternal` double-promotion | Fix #2 |
| P0-3 | Critical | `actions/match.ts` | No auth on `endMatchAction`, `cancelMatchAction`, `updateMatchDetails` | Fix #3 |
| P0-4 | Critical | `actions/profile.ts` | Service-role profile actions accept any userId, no auth | Fix #3 variant |
| P1-1 | High | `actions/auth.ts` | Non-transactional reconnect ID migration — account destruction risk | Manual DB transaction or saga pattern |
| P1-2 | Medium | `hooks/use-organizer-data.ts` | `createManualMatch` is client-side — no server validation | Move to server action |
| P1-3 | Medium | `actions/matchmaking.ts` | Sequential on-deck loop can select overlapping players | Add `await` with re-query between iterations |
| P1-4 | Low | `actions/auth.ts` | Duplicate name check is non-atomic | Add DB unique partial index on active display names |
| P1-5 | High | `actions/dev.ts` | Dev tools have no auth — any player can wipe session data | Gate behind env check or organizer auth |
| P1-6 | Low | `hooks/use-player-match.ts` | `match_players` query has no session filter | Add `.eq("session_id", sessionId)` via join |
| P1-7 | Low | Player dashboard | UI may freeze on "Submitting" after race condition | Resolved by Fix #1; add timeout fallback in UI |
