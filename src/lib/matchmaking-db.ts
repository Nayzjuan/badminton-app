// ============================================================
// Matchmaking DB — Database-coupled data helpers
// ============================================================
//
// All functions accept a Supabase service-role client and perform
// the DB queries that feed the pure matchmaking algorithm in
// matchmaking-core.ts.
//
// Separated from matchmaking-core.ts so that:
//   1. The pure algorithm (runAlgorithm) is testable with zero DB mocking.
//   2. These DB helpers are independently mockable via vi.mock('@/lib/matchmaking-db').
//
// Exports:
//   fetchActivePool            — waiting players, paused-filtered, unscored
//   fetchRecentClearedRosters  — READ: organizer-cleared rosters (rejection memory)
//   fetchSessionMatchSnapshot  — READ: this session's committed matches + rosters
//   deriveRecentRosters        — pure: recent rosters for diversity checks
//   derivePairCounts           — pure: same-team + cross-net pair counts
//   deriveOverlapMap           — pure: per-anchor co-player familiarity weights
//   deriveLastOpponents        — pure: who each player faced in their LAST match
//   fetchPartnershipCounts     — snapshot + derivePairCounts, for non-engine callers
//   executeMatch               — write: commit a MatchProposal via RPC
//
// The three derive* functions used to be three separate DB helpers issuing
// eight queries per engine slot over overlapping slices of the same two
// tables. They are now one snapshot read plus pure functions — see the
// SESSION MATCH SNAPSHOT block below for the arithmetic and the ordering
// invariant that makes the derivations safe.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, QueueWithWaitTime } from "@/types/database";
import { skillLevelToInt } from "@/types/database";
import {
  ANTI_REPEAT_LOOKBACK,
  COMMITTED_MATCH_STATUSES,
  CROSS_COURT_MAX_UNREADY_HOLDS,
  MATCH_REST_GAP_MINUTES,
  MIN_REST_MINUTES,
  OVERLAP_WEIGHT_OPPONENT,
  OVERLAP_WEIGHT_TEAMMATE,
  PLAYERS_PER_MATCH,
  REJECTED_ROSTER_FETCH_LIMIT,
  REJECTED_ROSTER_TTL_MINUTES,
  ROSTER_LOOKBACK_COUNT,
  SESSION_MATCH_SNAPSHOT_CEILING,
} from "@/lib/constants";
import { pairKey, type MatchProposal } from "@/lib/matchmaking-core";

// Convenience alias: all engine helpers run under the service-role client.
export type DbClient = SupabaseClient<Database>;

// Result shape returned by executeMatch to the orchestrator in matchmaking.ts.
// Kept intentionally narrow — callers build the public MatchmakingResult from this.
export type ExecuteMatchResult = {
  success: boolean;
  matchId?: string;
  message: string;
};

// ─────────────────────────────────────────────────────────────
// fetchActivePool
// ─────────────────────────────────────────────────────────────
// Returns the current "waiting" player pool for a session,
// excluding soft-paused players.
//
// Returns raw QueueWithWaitTime rows — NOT scored or sorted.
// Scoring and sorting is done by scoreAndSortPool() in
// matchmaking-core.ts so that step is independently testable.

export async function fetchActivePool(
  supabase: DbClient,
  sessionId: string
): Promise<QueueWithWaitTime[]> {
  const { data: rawPool, error: poolError } = await supabase
    .from("v_queue_with_wait_time")
    .select("*")
    .eq("session_id", sessionId)
    .eq("status", "waiting")
    .order("games_played", { ascending: true })
    .order("joined_at", { ascending: true });

  if (poolError) {
    console.warn("[matchmaking-db] fetchActivePool: query failed:", poolError.message);
    return [];
  }

  // v_queue_with_wait_time DOES expose is_paused (verified in the view def and
  // the QueueWithWaitTime type), so filter in memory — the old supplemental
  // queue_entries query was dead weight (one extra round trip per pool fetch).
  // Paused players are strictly invisible to the matchmaking engine.
  const active = (rawPool ?? []).filter((p) => !p.is_paused);

  // Minimum rest filter: exclude players who just finished a game and haven't
  // rested long enough. wait_minutes reflects time since re-entering the queue.
  // First-time players (games_played=0) are always eligible — no rest needed.
  // Fallback: if the filter would leave fewer than PLAYERS_PER_MATCH players,
  // waive it so very small sessions can still form matches.
  const rested = active.filter(
    (p) => p.games_played === 0 || (p.wait_minutes ?? 0) >= MIN_REST_MINUTES
  );
  return rested.length >= PLAYERS_PER_MATCH ? rested : active;
}

// ─────────────────────────────────────────────────────────────
// fetchRecentClearedRosters
// ─────────────────────────────────────────────────────────────
// Rejection memory (see REJECTED_ROSTER_TTL_MINUTES): the player-ID sets of
// drafts an organizer recently cleared, read from the match_events audit trail
// the clear actions already write (reason on_deck_cleared / batch_clear_unpublished,
// full roster in the payload — the cleared match row itself is deleted). The
// promote-path taint auto-clear calls the RPC directly without logging an
// event, so "player left" sweeps never enter rejection memory.
//
// Fail OPEN — the opposite posture from the match snapshot, deliberately: a
// missing snapshot would make repeats look fresh (dangerous), while missing
// rejection memory merely re-deals a hand the organizer can clear again
// (annoying). An error here must never stop the engine.

/** Reasons written by the organizer's clear actions in match-drafts.ts. */
const REJECTION_CLEAR_REASONS = new Set(["on_deck_cleared", "batch_clear_unpublished"]);

export async function fetchRecentClearedRosters(
  supabase: DbClient,
  sessionId: string
): Promise<string[][]> {
  const cutoff = new Date(Date.now() - REJECTED_ROSTER_TTL_MINUTES * 60_000).toISOString();
  const { data, error } = await supabase
    .from("match_events")
    .select("payload")
    .eq("session_id", sessionId)
    .eq("event_type", "cancelled")
    .eq("phase", "draft")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(REJECTED_ROSTER_FETCH_LIMIT);

  if (error) {
    console.warn("[matchmaking-db] fetchRecentClearedRosters: query failed:", error.message);
    return [];
  }

  const rosters: string[][] = [];
  for (const row of data ?? []) {
    // payload is Json — parse defensively; a malformed event is skipped, never thrown.
    const payload = row.payload as {
      reason?: string;
      roster?: Array<{ player_id?: string }>;
    } | null;
    if (!payload?.reason || !REJECTION_CLEAR_REASONS.has(payload.reason)) continue;
    const rosterField = Array.isArray(payload.roster) ? payload.roster : [];
    // Dedupe: a corrupt payload with duplicate ids (["a","a","b","c"]) would
    // otherwise pass the length check with only 3 distinct players, silently
    // degrading isRejectedRoster's exact-set match into a ≥3-overlap rule.
    const ids = [
      ...new Set(
        rosterField.map((p) => p?.player_id).filter((id): id is string => typeof id === "string")
      ),
    ];
    // Only complete foursomes: isRejectedRoster matches on the exact set, and a
    // partial roster snapshot could never legitimately equal a proposed four.
    if (ids.length === PLAYERS_PER_MATCH) rosters.push(ids);
  }
  return rosters;
}

// ═════════════════════════════════════════════════════════════
// SESSION MATCH SNAPSHOT — one read, three derivations
// ═════════════════════════════════════════════════════════════
//
// fetchRecentRosters (2 queries), fetchPartnershipCounts (2) and buildOverlapMap
// (3) were three separate helpers issuing SEVEN queries per engine slot, and all
// seven were re-reading overlapping slices of the same two tables: this session's
// committed matches, and their match_players rows. Every slot of every burst paid
// for that three times over. With fetchActivePool's one read of
// v_queue_with_wait_time — a different table, kept as-is — the slot's read phase
// was 8 queries deep.
//
// The three helpers are now ONE read of both tables plus three PURE derivations,
// taking the read phase to 3. Per slot:
//
//              queries        sequential depth
//   before        8                  8
//   after         3                  2        (snapshot's 2 run in parallel
//                                              with fetchActivePool's 1)
//
// Counting the commit RPC, a slot is 9 requests → 4. Deep bursts win most: a
// maximum burst is MAX_AUTO_DRAFTS_XLARGE = 6 slots (getDynamicDraftCap at 30+
// waiting; the organizer override is a ceiling, so it can only lower this), and
// that drops from 54 requests to 24.
//
// ── The ordering invariant (load-bearing, do not weaken) ──────────────────
// `matchIds` is returned in the order Postgres produced it: created_at DESC,
// id DESC. Both derivations that need recency (deriveRecentRosters,
// deriveOverlapMap) slice a prefix of that array and do NOT re-sort. Two
// consequences:
//
//   1. The `id DESC` tiebreak is not decoration. `created_at` is written by
//      the same statement for every row of a burst, so ties are the NORM in
//      this table, not an edge case, and `ORDER BY created_at DESC` alone
//      leaves the tied rows in whatever order the plan happens to emit. That
//      made "the 5 most recent matches" quietly non-deterministic before.
//      Ordering by id as well makes the prefix stable.
//   2. Nothing here sorts timestamps in JS. Comparing ISO-8601 strings looks
//      safe but is not: `localeCompare` is locale- and ICU-dependent, and
//      Postgres emits a variable number of fractional-second digits, so
//      "…T10:00:00+00" and "…T10:00:00.000+00" are the same instant with
//      different string lengths. Leave the ordering in SQL.
//
// The snapshot is fetched fresh PER SLOT, not once per run: sibling drafts
// committed by earlier slots of the same burst must be visible to the
// diversity check, the partnership cap, and the overlap map alike.

/** One session's committed matches and their rosters, newest-first. */
export type SessionMatchSnapshot = {
  /** Committed match IDs in created_at DESC, id DESC order. */
  matchIds: string[];
  /** match_id → its roster rows. Matches with no rows are absent. */
  rowsByMatch: Map<string, { player_id: string; team: string }[]>;
};

/**
 * Fail-closed result. `ok: false` means "the engine must not draft against
 * this" — either a query errored or the session exceeded the row ceiling.
 * It never carries a partial snapshot, because a partial view of who has
 * already played whom produces confidently-wrong pairings rather than none.
 */
export type SessionMatchSnapshotResult =
  | { ok: true; snapshot: SessionMatchSnapshot }
  | { ok: false; reason: string };

const EMPTY_SNAPSHOT: SessionMatchSnapshot = { matchIds: [], rowsByMatch: new Map() };

export async function fetchSessionMatchSnapshot(
  supabase: DbClient,
  sessionId: string
): Promise<SessionMatchSnapshotResult> {
  const { data: matchRows, error: matchErr } = await supabase
    .from("matches")
    .select("id")
    .eq("session_id", sessionId)
    .in("status", COMMITTED_MATCH_STATUSES)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (matchErr) {
    return { ok: false, reason: `matches query failed: ${matchErr.message}` };
  }

  // { data: null, error: null } is not a real PostgREST response for a select —
  // an empty result is []. It is still handled as "no matches", because a null
  // here is unambiguous about intent and treating it as an error would turn a
  // harmless shape difference into a refusal to draft.
  const matchIds = (matchRows ?? []).map((m) => m.id);
  if (matchIds.length === 0) return { ok: true, snapshot: EMPTY_SNAPSHOT };

  if (matchIds.length > SESSION_MATCH_SNAPSHOT_CEILING) {
    return {
      ok: false,
      reason:
        `session has ${matchIds.length} committed matches, above the ` +
        `${SESSION_MATCH_SNAPSHOT_CEILING} snapshot ceiling`,
    };
  }

  const { data: rows, error: rowsErr } = await supabase
    .from("match_players")
    .select("match_id, player_id, team")
    .in("match_id", matchIds);

  if (rowsErr) {
    return { ok: false, reason: `match_players query failed: ${rowsErr.message}` };
  }

  const rowsByMatch = new Map<string, { player_id: string; team: string }[]>();
  for (const row of rows ?? []) {
    const list = rowsByMatch.get(row.match_id);
    if (list) list.push({ player_id: row.player_id, team: row.team });
    else rowsByMatch.set(row.match_id, [{ player_id: row.player_id, team: row.team }]);
  }

  return { ok: true, snapshot: { matchIds, rowsByMatch } };
}

// ─────────────────────────────────────────────────────────────
// deriveRecentRosters (pure)
// ─────────────────────────────────────────────────────────────
// The last ROSTER_LOOKBACK_COUNT match rosters (completed, in_progress AND
// pending) as arrays of player IDs, newest-first. Feeds the
// diversity-violation check in runAlgorithm.
//
// Including in_progress and pending means the engine sees players who are
// CURRENTLY paired, not only those who have already finished — so it will not
// form the same pairing "again" just because the first game is still live.

export function deriveRecentRosters(snapshot: SessionMatchSnapshot): string[][] {
  const rosters: string[][] = [];
  for (const id of snapshot.matchIds.slice(0, ROSTER_LOOKBACK_COUNT)) {
    const rows = snapshot.rowsByMatch.get(id);
    if (rows && rows.length > 0) rosters.push(rows.map((r) => r.player_id));
  }
  return rosters;
}

// ─────────────────────────────────────────────────────────────
// derivePairCounts (pure)
// ─────────────────────────────────────────────────────────────
// Same-team (partnership) AND cross-team (opponent) pair counts across every
// committed match in the session.
//
//   partnershipCounts: Map<pairKey, count> of same-team co-appearances.
//   opponentCounts:    Map<pairKey, count> of cross-net appearances.
//
// Covers pending matches too, so the caps apply the moment a draft exists
// rather than only after publish.

export function derivePairCounts(snapshot: SessionMatchSnapshot): {
  partnershipCounts: Map<string, number>;
  opponentCounts: Map<string, number>;
} {
  const partnershipCounts = new Map<string, number>();
  const opponentCounts = new Map<string, number>();

  for (const rows of snapshot.rowsByMatch.values()) {
    // Bucket this match's roster by team. row.team is typed Team (non-nullable).
    const byTeam = new Map<string, string[]>();
    for (const row of rows) {
      const bucket = byTeam.get(row.team);
      if (bucket) bucket.push(row.player_id);
      else byTeam.set(row.team, [row.player_id]);
    }

    // Same-team pairs — within each bucket.
    for (const teammates of byTeam.values()) {
      for (let i = 0; i < teammates.length; i++) {
        for (let j = i + 1; j < teammates.length; j++) {
          const k = pairKey(teammates[i], teammates[j]);
          partnershipCounts.set(k, (partnershipCounts.get(k) ?? 0) + 1);
        }
      }
    }

    // Cross-team pairs — only meaningful for a well-formed two-sided match.
    const buckets = [...byTeam.values()];
    if (buckets.length === 2) {
      const [teamA, teamB] = buckets;
      for (const a of teamA) {
        for (const b of teamB) {
          const k = pairKey(a, b);
          opponentCounts.set(k, (opponentCounts.get(k) ?? 0) + 1);
        }
      }
    } else if (process.env.DEBUG_MATCHMAKING === "true") {
      console.warn(
        `[matchmaking-db] derivePairCounts: match has ${buckets.length} team bucket(s) — ` +
          "opponent pairs skipped (expected 2)"
      );
    }
  }

  return { partnershipCounts, opponentCounts };
}

// ─────────────────────────────────────────────────────────────
// deriveOverlapMap (pure)
// ─────────────────────────────────────────────────────────────
// Map<player_id, weight> of how "familiar" each co-player is to the anchor
// across the anchor's ANTI_REPEAT_LOOKBACK most recent matches in this
// session. Consumed by scoreCandidates as an anti-repeat penalty.
//
//   Teammate appearance → OVERLAP_WEIGHT_TEAMMATE
//   Opponent appearance → OVERLAP_WEIGHT_OPPONENT
//
// (Equal as of the 2026-07 diversity pass: re-facing is avoided as hard as
// re-partnering, the primary round-2 opponent lever.)
//
// This replaces a three-query join that started by pulling the anchor's
// match_players rows GLOBALLY — across every session they had ever played —
// under an unordered `.limit(200)`, then intersecting with this session. That
// cap was silent and mis-ordered: a heavy regular past 200 lifetime rows could
// have this session's matches truncated away by rows from unrelated sessions,
// and the engine would then treat a genuine repeat as a fresh pairing. Scoping
// to the session snapshot removes both the extra queries and that failure mode.

export function deriveOverlapMap(
  snapshot: SessionMatchSnapshot,
  anchorPlayerId: string
): Map<string, number> {
  const overlapMap = new Map<string, number>();
  let seen = 0;

  for (const id of snapshot.matchIds) {
    if (seen >= ANTI_REPEAT_LOOKBACK) break;
    const rows = snapshot.rowsByMatch.get(id);
    if (!rows) continue;

    const anchorRow = rows.find((r) => r.player_id === anchorPlayerId);
    if (!anchorRow) continue;
    seen++;

    for (const row of rows) {
      if (row.player_id === anchorPlayerId) continue;
      const weight =
        row.team === anchorRow.team ? OVERLAP_WEIGHT_TEAMMATE : OVERLAP_WEIGHT_OPPONENT;
      overlapMap.set(row.player_id, (overlapMap.get(row.player_id) ?? 0) + weight);
    }
  }

  return overlapMap;
}

// ─────────────────────────────────────────────────────────────
// deriveLastOpponents (pure)
// ─────────────────────────────────────────────────────────────
// Map<player_id, Set<player_id>> — for every player in the session, the people
// they faced ACROSS THE NET in their single most recent match.
//
// This is the exact shape of the complaint the engine is judged on: "I faced
// them again, immediately." A repeat is only a repeat if the previous meeting
// was cross-net AND it was the previous game. Two blind spots in
// deriveOverlapMap above make that invisible to the engine otherwise:
//
//   (a) no recency gradient — a meeting 5 matches ago weighs exactly as much
//       as the immediately-previous match, so "again, right now" is
//       indistinguishable from "earlier tonight";
//   (b) anchor-relative only — relationships AMONG the three non-anchor
//       candidates are not represented at all, so three players who just
//       faced each other can be drafted together freely. Measured: 79.3% of
//       consecutive-opponent repeats are between two NON-anchor co-players,
//       which is why reweighting deriveOverlapMap cannot fix this at any
//       weight, and why this map is whole-pool rather than anchor-relative.
//
// Deliberately NOT a weighted count: the metric is binary per player, so this
// is too.
//
// Ordering invariant: snapshot.matchIds is newest-first (created_at DESC), so
// the FIRST match containing a player is that player's most recent. Pending and
// in-progress matches are in the snapshot, so a player currently on court — or
// sitting in an unreviewed draft — already has their "last" opponents recorded
// and the engine will not re-serve them.
//
// A malformed roster — anything that is not exactly two teams of TWO, so a 4-0
// and a 3-1 alike — still marks its players as seen, with an EMPTY opponent set:
// it IS their most recent match, and walking past it to an older one would
// report a stale, wrong set of opponents.
//
// Cost: unlike deriveOverlapMap (ANTI_REPEAT_LOOKBACK) and deriveRecentRosters
// (ROSTER_LOOKBACK_COUNT) this takes no lookback window, because "last match"
// is per-player and a bounded window can miss a player who has not played
// recently. It is not unbounded work: fetchSessionMatchSnapshot refuses any
// session above SESSION_MATCH_SNAPSHOT_CEILING (200) matches, so this is
// O(≤200 × 4) with a per-player early-out.

export function deriveLastOpponents(snapshot: SessionMatchSnapshot): Map<string, Set<string>> {
  const lastOpponents = new Map<string, Set<string>>();

  for (const id of snapshot.matchIds) {
    const rows = snapshot.rowsByMatch.get(id);
    if (!rows || rows.length === 0) continue;

    const byTeam = new Map<string, string[]>();
    for (const row of rows) {
      const bucket = byTeam.get(row.team);
      if (bucket) bucket.push(row.player_id);
      else byTeam.set(row.team, [row.player_id]);
    }

    const buckets = [...byTeam.values()];
    // Exactly two teams AND two bodies per team. Checking only the bucket COUNT
    // let a corrupt 3v1 roster through as well-formed, recording three players
    // as one player's genuine "last opponent" set — which contradicts the
    // malformed-roster contract documented above. PLAYERS_PER_MATCH is 4 and
    // there is no singles mode, so any other shape is bad data, not a variant.
    if (buckets.length === 2 && buckets[0].length === 2 && buckets[1].length === 2) {
      const [teamA, teamB] = buckets;
      for (const [own, other] of [
        [teamA, teamB],
        [teamB, teamA],
      ] as const) {
        for (const playerId of own) {
          // First (newest) match wins — later iterations are older matches.
          if (lastOpponents.has(playerId)) continue;
          lastOpponents.set(playerId, new Set(other));
        }
      }
    } else {
      for (const row of rows) {
        if (!lastOpponents.has(row.player_id)) lastOpponents.set(row.player_id, new Set());
      }
    }
  }

  return lastOpponents;
}

// ─────────────────────────────────────────────────────────────
// fetchPartnershipCounts
// ─────────────────────────────────────────────────────────────
// Snapshot + derive, for callers OUTSIDE the engine loop (the organizer's
// manual-match repeat warning). The engine takes one snapshot per slot and
// derives all three products from it instead of calling this.
//
// Fails soft, deliberately: an unavailable snapshot yields empty maps rather
// than an error, because the only consumer is an advisory "you've paired these
// two before" badge. use-pair-counts.ts drops non-success results without
// surfacing anything, so the organizer sees the previous counts or a blank
// badge — never a broken dialog. The engine's fail-CLOSED handling of the same
// condition lives at its call site, where a wrong pairing is the real cost.

export async function fetchPartnershipCounts(
  supabase: DbClient,
  sessionId: string
): Promise<{ partnershipCounts: Map<string, number>; opponentCounts: Map<string, number> }> {
  const result = await fetchSessionMatchSnapshot(supabase, sessionId);
  if (!result.ok) {
    console.warn("[matchmaking-db] fetchPartnershipCounts:", result.reason);
    return { partnershipCounts: new Map(), opponentCounts: new Map() };
  }
  return derivePairCounts(result.snapshot);
}

// ─────────────────────────────────────────────────────────────
// executeMatch
// ─────────────────────────────────────────────────────────────
// Commits a MatchProposal to the database via the atomic
// create_match_with_players RPC.
//
// Accepts a proposal from the pure runAlgorithm (players + teams +
// mixed-level flag) plus execution context (courtId, isOnDeck) that
// is irrelevant to the algorithm itself.
//
// NULL return convention:
//   { data: null, error: null }       → TOCTOU guard fired → graceful skip
//   { data: null, error: PostgrestError } → hard DB error → surface to caller

export async function executeMatch(
  supabase: DbClient,
  sessionId: string,
  courtId: string | null,
  proposal: MatchProposal,
  isOnDeck: boolean,
  autoPublish = false
): Promise<ExecuteMatchResult> {
  const now = new Date().toISOString();
  const { teamA, teamB, isMixedLevel } = proposal;

  const { data: matchId, error: rpcError } = await supabase.rpc("create_match_with_players", {
    p_session_id: sessionId,
    p_court_id: isOnDeck ? null : courtId,
    p_status: isOnDeck ? "pending" : "in_progress",
    p_is_mixed_level: isMixedLevel,
    p_started_at: isOnDeck ? null : now,
    p_is_on_deck: isOnDeck,
    p_team_a_ids: teamA.map((p) => p.player_id),
    p_team_b_ids: teamB.map((p) => p.player_id),
    p_origin: "auto" as const,
    // Draft mode (autoPublish=false, default): is_published=false → the match
    // lands as a DRAFT for organizer review. "Publish All" or per-match Publish
    // promotes it to On Deck. Manually-created matches also start unpublished.
    //
    // Auto-publish mode (autoPublish=true): is_published=true → the RPC promotes
    // the roster straight to 'on_deck' and the match skips the review gate. The
    // engine fires ON_DECK_WARNING itself (the push lives in the publish action,
    // which this path bypasses).
    p_is_published: autoPublish,
  });

  if (rpcError) {
    return {
      success: false,
      message: `Failed to create match: ${rpcError.message}`,
    };
  }

  if (!matchId) {
    // RPC returned NULL: the DB-level TOCTOU guard detected a conflict.
    // This is a graceful slot-skip, not a hard error.
    console.warn(
      "[matchmaking-db] executeMatch: RPC returned NULL — concurrent matchmaking " +
        "run already committed one or more of these players. Skipping slot gracefully.",
      {
        sessionId,
        teamA: teamA.map((p) => p.display_name),
        teamB: teamB.map((p) => p.display_name),
      }
    );
    return {
      success: false,
      message: "Slot skipped: player already committed by a concurrent matchmaking run.",
    };
  }

  return {
    success: true,
    matchId,
    message: isOnDeck ? "On-deck match created!" : "Match created successfully!",
  };
}

// ═════════════════════════════════════════════════════════════
// CROSS-COURT DIVERSITY DRAFTING — DB helpers (Phase 4)
// ═════════════════════════════════════════════════════════════

// A currently-PLAYING body that may be pulled into a held draft, enriched with
// everything the engine needs: a QueueWithWaitTime-shaped row + the eligibility
// context (consecutive-games streak, already-in-a-held-draft) + the started_at of
// its current in_progress match (for the pickEarliestFinishing tiebreak).
export type PullableBody = QueueWithWaitTime & {
  streak: number;
  alreadyHeld: boolean;
  /** id of the body's current in_progress match — passed as p_pulled_from_match_id. */
  currentMatchId: string;
  currentMatchStartedAt: string;
};

// ─────────────────────────────────────────────────────────────
// hasFeedableCapacity — the courts-stay-fed guard
// ─────────────────────────────────────────────────────────────
// A held draft cannot take a court when it is created: it waits for its pulled
// body to finish and rest. So it must never be the ONLY thing standing between
// a freeing court and a match, or that court idles until the next engine tick.
//
// This replaces the `i > 0` proxy that previously guarded the cross-court
// branch. That proxy asked "did we already commit something this run?", which
// is far stricter than the invariant it was protecting — 91% of production
// engine runs commit exactly one draft, so it made the whole branch
// unreachable (0 held drafts in 945 matches). The real question is whether a
// promotable match already EXISTS, from this run or any earlier one, and 60.8%
// of auto matches were created while one did.
//
// Deliberately counts pending non-held matches regardless of is_published:
//   * auto-publish mode — pending non-held matches are published, so the count
//     is exactly the set a freeing court can promote.
//   * draft mode — nothing promotes without organizer review anyway, and the
//     failure this guards against there is a review queue holding nothing but
//     un-promotable held drafts, which reads as "the engine did nothing".
//
// Read fresh at the moment a held draft is about to commit rather than cached
// per run: a concurrent promotion can consume the spare mid-run, and erring
// permissive here is precisely the idle court this exists to prevent.
//
// CAPACITY, not existence. Asking only "does a feedable match exist?" lets held
// drafts STACK: a held draft is is_held, so it is excluded from the feedable
// side and never consumes the spare it was authorised against. One pending
// match would then authorise every slot in the run — 12 waiting with a cap of 3
// yields 1 promotable match + 2 held drafts holding 6 players. Requiring
// strictly more feedable than held bounds that to at most one held draft per
// feedable match.
//
// ⚠️ Be precise about what this does NOT promise. The count is read PRE-commit,
// so `feedable > held` permits post-commit parity: 1 feedable + 0 held passes,
// and commits to 1 + 1. An earlier version of this comment claimed the guard
// prevents "one court promotes and the other idles" outright — it does not, and
// that example was misleading for a second reason too: a held draft is not dead
// capacity. It becomes promotable precisely when the pulled body's source court
// frees, so the two-courts-free case only strands a court when the second court
// to free is NOT that source. Tightening to `feedable > held + 1` would close
// the parity window, but it would also demand two spare matches before any
// reach — a real narrowing of a feature whose whole history is never firing —
// to fix a case that is not established as reachable. Left as stacking control.
//
// ── Second bound: CROSS_COURT_MAX_UNREADY_HOLDS ──────────────
// `feedable > held` is a RATIO, and it is pinned to the wrong quantity. feedable
// counts pending non-held matches regardless of is_published, so in draft mode
// every match the organizer publishes to the on-deck queue raises the ceiling by
// one. That was harmless while the review-queue cap also counted held drafts —
// runEngineInternal's draft-mode branch now excludes unready ones, because a
// draft the organizer cannot publish must not occupy a review slot — but with
// that gone, the ratio alone lets holds grow with the on-deck backlog: courts
// busy, four matches queued, and five or six holds are authorised, parking three
// waiting players each. So the gate now also refuses once the session already
// has CROSS_COURT_MAX_UNREADY_HOLDS unready holds. Absolute, not a ratio.
//
// Only UNREADY holds count toward that ceiling. A stamped hold is publishable
// and promotable — ordinary on-deck inventory, not a reservation — so it stays
// on the `held` side of the ratio (it still seats nobody until promoted) but is
// not part of the reservation budget.
export async function hasFeedableCapacity(supabase: DbClient, sessionId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("matches")
    .select("is_held, held_ready_at")
    .eq("session_id", sessionId)
    .eq("status", "pending");

  // Fail CLOSED: an unreadable count must not authorise a held draft. Skipping
  // the cross-court reach costs a slightly staler match; wrongly authorising it
  // costs an idle court, which is the one thing this gate exists to prevent.
  if (error) {
    console.warn(`[matchmaking] hasFeedableCapacity: read failed — ${error.message}`);
    return false;
  }
  if (!data) return false;

  let feedable = 0;
  let held = 0;
  let unreadyHeld = 0;
  for (const row of data) {
    // ⚠️ This deliberately does NOT fail closed, unlike the error path above.
    // A reviewer read that as an inconsistency, so, precisely:
    //
    // `is_held` is `GENERATED ALWAYS AS (cardinality(pulled_player_ids) > 0)`,
    // and information_schema reports the generated column itself as nullable —
    // `cardinality(NULL)` is NULL. A NULL still cannot arrive, and the reason is
    // the SOURCE column: `pulled_player_ids` is `uuid[] NOT NULL DEFAULT '{}'`
    // (migration 20260607000000, verified identical on prod). The NOT NULL is
    // what forbids it; the default is not, since a default applies only when the
    // column is OMITTED, so with NOT NULL gone an explicit `VALUES (..., NULL)`
    // or a plain `UPDATE ... SET pulled_player_ids = NULL` would reach NULL.
    // `src/types/database.ts` is consistent with that (is_held: plain
    // `boolean`), and all 945 production rows read false.
    //
    // ⚠️ Earlier revisions of this comment got the schema counterfactual wrong in
    // two different directions, so state both halves separately — they do
    // NOT share an antecedent. For a NULL to appear AT ALL takes only the NOT
    // NULL dropped plus something writing one. For EVERY ordinary pending match
    // to read NULL takes the default dropped as well, because the ordinary
    // writer — `create_match_with_players` — does not name this column, so while
    // the default stands it keeps filling in '{}'.
    //
    // Given all that, the branch is unreachable and the choice is academic — but
    // `else feedable++` is still the semantically correct arm rather than merely
    // the permissive one: a NULL flag would mean pulled_player_ids is NULL, i.e.
    // the row is not a held draft, i.e. it is feedable. Fail-closed inverts that,
    // and in the both-dropped case it would read `0 > N` for every ordinary
    // pending match and ship cross-court dead a second time. A transient read
    // error costing one skipped reach is not the same risk as a schema condition
    // killing the feature outright. CCT-FEED-7 pins this arm.
    if (row.is_held === true) {
      held++;
      // Same predicate as isHeldAwaitingReadiness, spelled out rather than
      // called: the NULL-is_held arm above is deliberate and load-bearing, and
      // routing this through a helper typed `is_held: boolean` would quietly
      // launder it. Reachable only from the true arm, so is_held is settled.
      if (row.held_ready_at === null) unreadyHeld++;
    } else feedable++;
  }
  return feedable > held && unreadyHeld < CROSS_COURT_MAX_UNREADY_HOLDS;
}

// ─────────────────────────────────────────────────────────────
// fetchPullablePlayers
// ─────────────────────────────────────────────────────────────
// Returns the playing bodies eligible to be CONSIDERED for a held draft. The
// engine still filters these through isPullEligible (streak/cooldown/already-held)
// and the algorithm's skill window — this helper just gathers the candidate set.
// Called lazily — only once the waiting-only four has already been judged stale
// (a forced repeat, or at least one player facing a last-game opponent again) —
// so its handful of queries don't run on every engine tick.
export async function fetchPullablePlayers(
  supabase: DbClient,
  sessionId: string
): Promise<PullableBody[]> {
  // 1. In-progress matches → player → currentMatchStartedAt. Manual join: this
  //    codebase declares Relationships:[] (CLAUDE.md), so PostgREST embeds aren't typed.
  const { data: activeMatchRows } = await supabase
    .from("matches")
    .select("id, started_at")
    .eq("session_id", sessionId)
    .eq("status", "in_progress");
  const activeMatchIds = (activeMatchRows ?? []).map((m) => m.id);
  if (activeMatchIds.length === 0) return [];
  const activeStartedAt = new Map((activeMatchRows ?? []).map((m) => [m.id, m.started_at]));

  const { data: activePlayers } = await supabase
    .from("match_players")
    .select("match_id, player_id")
    .in("match_id", activeMatchIds);

  const playingMap = new Map<string, { matchId: string; startedAt: string }>();
  for (const mp of activePlayers ?? []) {
    const startedAt = activeStartedAt.get(mp.match_id);
    if (startedAt) playingMap.set(mp.player_id, { matchId: mp.match_id, startedAt });
  }
  if (playingMap.size === 0) return [];

  const playingIds = [...playingMap.keys()];

  // 2-4. Queue rows + profiles + already-held set + recent match timing (parallel).
  const [
    { data: queueRows },
    { data: profileRows },
    { data: heldDrafts },
    { data: recentMatchRows },
  ] = await Promise.all([
    supabase
      .from("queue_entries")
      .select("id, player_id, games_played, joined_at, created_at, is_paused")
      .eq("session_id", sessionId)
      .in("player_id", playingIds),
    supabase.from("profiles").select("id, display_name, skill_level").in("id", playingIds),
    supabase
      .from("matches")
      .select("pulled_player_ids")
      .eq("session_id", sessionId)
      .eq("status", "pending")
      .eq("is_held", true),
    supabase
      .from("matches")
      .select("id, started_at, completed_at")
      .eq("session_id", sessionId)
      .in("status", ["in_progress", "completed"])
      .order("started_at", { ascending: false })
      .limit(16),
  ]);

  const profileMap = new Map((profileRows ?? []).map((p) => [p.id, p]));
  const queueMap = new Map((queueRows ?? []).map((q) => [q.player_id, q]));
  const alreadyHeld = new Set(
    (heldDrafts ?? []).flatMap(
      (m) => (m as { pulled_player_ids: string[] }).pulled_player_ids ?? []
    )
  );

  // Recent rosters (manual join) → match_id → Set(player_id), for the streak.
  const recentMatchIds = (recentMatchRows ?? []).map((m) => m.id);
  const { data: recentRoster } =
    recentMatchIds.length > 0
      ? await supabase
          .from("match_players")
          .select("match_id, player_id")
          .in("match_id", recentMatchIds)
      : { data: [] as { match_id: string; player_id: string }[] };
  const rosterByMatch = new Map<string, Set<string>>();
  for (const mp of recentRoster ?? []) {
    const set = rosterByMatch.get(mp.match_id) ?? new Set<string>();
    set.add(mp.player_id);
    rosterByMatch.set(mp.match_id, set);
  }

  // Per-player consecutive-games streak (R3-C): walk their recent matches
  // newest-first; count the unbroken run where each game starts within
  // MATCH_REST_GAP_MINUTES of the previous one finishing (no real rest between).
  const gapMs = MATCH_REST_GAP_MINUTES * 60_000;
  const streakFor = (playerId: string): number => {
    const theirs = (recentMatchRows ?? []).filter((m) => rosterByMatch.get(m.id)?.has(playerId));
    if (theirs.length === 0) return 0;
    let streak = 1;
    for (let i = 1; i < theirs.length; i++) {
      const newer = theirs[i - 1];
      const older = theirs[i];
      if (!newer.started_at || !older.completed_at) break;
      const gap = new Date(newer.started_at).getTime() - new Date(older.completed_at).getTime();
      if (gap <= gapMs) streak++;
      else break;
    }
    return streak;
  };

  // 5. Assemble. priorityScore:-1 (C-3) so a pulled body never out-anchors a
  //    waiting player; isPulled flags it for the ≤1-pulled composition guard.
  const result: PullableBody[] = [];
  for (const playerId of playingIds) {
    const prof = profileMap.get(playerId);
    const q = queueMap.get(playerId);
    if (!prof || !q || q.is_paused) continue;
    result.push({
      id: q.id,
      session_id: sessionId,
      player_id: playerId,
      joined_at: q.joined_at,
      games_played: q.games_played,
      status: "playing",
      position: null,
      is_paused: false,
      paused_at: null,
      created_at: q.created_at,
      display_name: prof.display_name,
      skill_level: prof.skill_level,
      skill_level_int: skillLevelToInt(prof.skill_level),
      wait_minutes: 0,
      is_bottleneck: false,
      streak: streakFor(playerId),
      alreadyHeld: alreadyHeld.has(playerId),
      currentMatchId: playingMap.get(playerId)!.matchId,
      currentMatchStartedAt: playingMap.get(playerId)!.startedAt,
    });
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// executeHeldMatch
// ─────────────────────────────────────────────────────────────
// Commits a held cross-court draft via the create_held_cross_court_match RPC.
// Same NULL-return convention as executeMatch: NULL = a TOCTOU/reservation guard
// fired → graceful slot-skip (not a hard error).
export async function executeHeldMatch(
  supabase: DbClient,
  sessionId: string,
  proposal: MatchProposal,
  pulledPlayerId: string,
  pulledFromMatchId: string
): Promise<ExecuteMatchResult> {
  const { teamA, teamB, isMixedLevel } = proposal;

  const { data: matchId, error: rpcError } = await supabase.rpc("create_held_cross_court_match", {
    p_session_id: sessionId,
    p_is_mixed_level: isMixedLevel,
    p_team_a_ids: teamA.map((p) => p.player_id),
    p_team_b_ids: teamB.map((p) => p.player_id),
    p_pulled_player_id: pulledPlayerId,
    p_pulled_from_match_id: pulledFromMatchId,
    p_origin: "auto" as const,
  });

  if (rpcError) {
    return { success: false, message: `Failed to create held match: ${rpcError.message}` };
  }

  if (!matchId) {
    console.warn(
      "[matchmaking-db] executeHeldMatch: RPC returned NULL — a TOCTOU/reservation guard " +
        "fired (waiting member taken, pulled body no longer playing, or already in a held draft). " +
        "Skipping slot gracefully.",
      { sessionId, pulledPlayerId }
    );
    return { success: false, message: "Slot skipped: held-draft guard fired." };
  }

  return { success: true, matchId, message: "Held cross-court draft created!" };
}
