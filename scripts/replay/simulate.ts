// ============================================================
// Replay harness — offline re-run of the CURRENT engine
// ============================================================
//
// Discrete-event replay of one real session. Players arrive at their real
// times, courts turn over at their real durations, and every match is composed
// by the production algorithm — not a paraphrase of it. The pipeline below is
// the same read → derive → runAlgorithm sequence as runEngineInternal:
//
//   fetchActivePool's rest filter → scoreAndSortPool → deriveRecentRosters
//   → derivePairCounts → deriveOverlapMap → deriveLastOpponents → runAlgorithm
//
// so a change to any of those shows up here without the harness being touched.
//
// Deliberate simplifications, all stated so the numbers are read honestly:
//
//   1. Default mode collapses the draft queue: a match is composed the instant
//      a court frees (the bypassGate / "Call Next" path). Pass
//      `{ draftQueue: true }` to use the same planSlots / softGate /
//      shouldContinueSlot helpers as runEngineInternal: drafts sit on deck,
//      drafted players leave the pool, FIFO promote onto a free court. That
//      is the freshness gate's required mode — production drafts ahead, which
//      is what pushes a player's last game past the session lookback.
//   2. Real fixtures have no recoverable departures or pauses. Synthetics may
//      set `leaveMin`; a player not on court and not drafted then leaves.
//   3. No cross-court draft augmentation. Stated limitation — the replay has
//      no notion of a HELD draft.
//   4. Rejection memory is empty: no organizer clears drafts in a replay.
//
// Because of (1) the default replay runs the full [0, horizon] window at 100%
// court occupancy and so plays MORE matches than the night did. Compare rates,
// not absolute counts, when reading it against the REAL column.

import {
  isBackToBackRepeat,
  isRedZonePlayer,
  runAlgorithm,
  runAlgorithmWithFreshness,
  scoreAndSortPool,
  type FreshnessResult,
  type MatchProposal,
  type ScoredPlayer,
} from "../../src/lib/matchmaking-core";
import {
  deriveRecentRosters,
  derivePairCounts,
  deriveOverlapMap,
  deriveLastSides,
  type SessionMatchSnapshot,
} from "../../src/lib/matchmaking-db";
import {
  isFreshnessRefreshEnabled,
  planSlots,
  shouldContinueSlot,
  softGateDecision,
} from "../../src/lib/matchmaking-slots";
import {
  HARD_CAP_GAMES_CEILING,
  HARD_WAIT_CAP_MINUTES,
  MIN_REST_MINUTES,
  PLAYERS_PER_MATCH,
} from "../../src/lib/constants";
import type { QueueWithWaitTime, SkillLevel } from "../../src/types/database";
import { hasAdmissibleFresherFour } from "./freshness-brute";
import type {
  PlayedMatch,
  ReplayDiagnostics,
  ReplayOptions,
  ReplayResult,
  SessionFixture,
} from "./types";

type SimPlayer = {
  player_id: string;
  display_name: string;
  skill_level: SkillLevel;
  skill_level_int: number;
  joinMin: number;
  leaveMin?: number;
  games_played: number;
  /** Minutes from t0 when they (re-)entered the queue — drives wait_minutes. */
  queuedAtMin: number;
  /** Set once joinMin passes; until then the player is not in the session at all. */
  arrived: boolean;
  left: boolean;
};

type SimCourt = {
  id: string;
  durations: number[];
  /** Index into `durations`; wraps so a long replay keeps the court's rhythm. */
  nextDuration: number;
  freeAtMin: number;
  occupants: string[] | null;
};

type Draft = {
  matchId: string;
  teamA: ScoredPlayer[];
  teamB: ScoredPlayer[];
  composedAtMin: number;
  forcedRepeat?: boolean;
  isMixedLevel?: boolean;
};

/** Floating-point slop tolerated when matching two event times. */
const EPSILON_MIN = 1e-6;

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function emptyDiagnostics(): ReplayDiagnostics {
  return {
    noMatchEvents: 0,
    capSaturationEvents: 0,
    forcedRepeats: 0,
    thinPoolEvents: 0,
    stallEpisodes: 0,
    backToBackServed: 0,
    avoidableNearIdentical: 0,
    refreshAttempts: 0,
    refreshSuccesses: 0,
    draftWaits: [],
    redZoneEntries: 0,
    hardCapEntries: 0,
    mixedLevelMatches: 0,
    skillSpread2Matches: 0,
    teamSkillGaps: [],
    wrapperMs: [],
  };
}

function isHardCapPlayer(p: ScoredPlayer): boolean {
  if (p.isPulled) return false;
  return (p.wait_minutes ?? 0) >= HARD_WAIT_CAP_MINUTES && p.games_played < HARD_CAP_GAMES_CEILING;
}

function skillSpread(four: ScoredPlayer[]): number {
  let max = 0;
  for (let i = 0; i < four.length; i++) {
    for (let j = i + 1; j < four.length; j++) {
      max = Math.max(max, Math.abs(four[i].skill_level_int - four[j].skill_level_int));
    }
  }
  return max;
}

function teamSkillGap(teamA: ScoredPlayer[], teamB: ScoredPlayer[]): number {
  const mean = (side: ScoredPlayer[]) =>
    side.reduce((s, p) => s + p.skill_level_int, 0) / side.length;
  return Math.abs(mean(teamA) - mean(teamB));
}

export function replaySession(fixture: SessionFixture, options: ReplayOptions = {}): ReplayResult {
  const t0Ms = new Date(fixture.t0).getTime();
  const isoAt = (min: number) => new Date(t0Ms + min * 60_000).toISOString();
  const freshnessOn = options.freshness ?? isFreshnessRefreshEnabled();
  const draftQueueMode = options.draftQueue === true;
  const waitSlack = options.waitSlackMinutes;
  const jitterRnd = options.durationJitter ? mulberry32(options.durationJitter.seed) : null;
  const jitterPct = options.durationJitter?.pct ?? 0;

  const players = new Map<string, SimPlayer>(
    fixture.players.map((p) => [
      p.player_id,
      {
        player_id: p.player_id,
        display_name: p.display_name,
        skill_level: p.skill_level as SkillLevel,
        skill_level_int: p.skill_level_int,
        joinMin: p.joinMin,
        leaveMin: p.leaveMin,
        games_played: 0, // stamped at the session floor on arrival — see admitArrivals
        queuedAtMin: p.joinMin,
        arrived: false,
        left: false,
      },
    ])
  );

  const courts: SimCourt[] = fixture.courts.map((c) => {
    // fetch.ts drops any court with no observed match, so this cannot be empty
    // unless a stale fixture predates that rule — fail loudly rather than
    // inventing capacity the session never had.
    if (c.durationsMin.length === 0) {
      throw new Error(`court ${c.id} has no observed durations — re-fetch the fixture (--refresh)`);
    }
    return {
      id: c.id,
      durations: c.durationsMin,
      nextDuration: 0,
      freeAtMin: 0,
      occupants: null,
    };
  });

  const matches: PlayedMatch[] = [];
  const diagnostics = emptyDiagnostics();
  const onDeck: Draft[] = [];
  let stallOpen = false;
  let matchSeq = 0;

  // ── Snapshot, built incrementally ───────────────────────────
  // Shape-identical to fetchSessionMatchSnapshot's output: matchIds newest-first
  // (created_at DESC), rowsByMatch keyed by id. The derive helpers below are the
  // production ones, so this must be right or every diversity input is wrong.
  const snapshot: SessionMatchSnapshot = { matchIds: [], rowsByMatch: new Map() };

  function queueRow(p: SimPlayer, nowMin: number): QueueWithWaitTime {
    const joinedAt = isoAt(p.queuedAtMin);
    return {
      id: `qe-${p.player_id}`,
      session_id: fixture.sessionId,
      player_id: p.player_id,
      joined_at: joinedAt,
      games_played: p.games_played,
      status: "waiting",
      position: null,
      is_paused: false,
      paused_at: null,
      created_at: joinedAt,
      display_name: p.display_name,
      skill_level: p.skill_level,
      skill_level_int: p.skill_level_int,
      wait_minutes: nowMin - p.queuedAtMin,
      is_bottleneck: false,
    };
  }

  /**
   * Admit everyone whose arrival time has passed, stamping games_played at the
   * SESSION FLOOR — the minimum games_played across everyone already in the
   * session. That is what joinQueueAction does on both the insert and the
   * re-join update (src/app/actions/queue.ts), and it is load-bearing: a late
   * arrival left at 0 games looks like the most-owed player in the room, and
   * GAMES_AHEAD_PENALTY (10_000 per game above the pool minimum) then charges
   * every established player 30–40k — several times the weight of a prior
   * encounter. Every session here has players arriving after the first match,
   * so getting this wrong skews every composition for the rest of the night.
   *
   * Simultaneous arrivals all take the pre-arrival floor; admitting a player AT
   * the floor cannot lower it, so this matches production's one-at-a-time order.
   */
  function admitArrivals(nowMin: number) {
    const pending: SimPlayer[] = [];
    let floor = Infinity;
    for (const p of players.values()) {
      if (p.arrived && !p.left) floor = Math.min(floor, p.games_played);
      else if (!p.arrived && p.joinMin <= nowMin + EPSILON_MIN) pending.push(p);
    }
    if (pending.length === 0) return;
    const stamp = Number.isFinite(floor) ? floor : 0; // first arrivals: nobody to inherit from
    for (const p of pending) {
      p.arrived = true;
      p.games_played = stamp;
    }
  }

  function draftedIds(): Set<string> {
    return new Set(onDeck.flatMap((d) => [...d.teamA, ...d.teamB].map((p) => p.player_id)));
  }

  function processLeaves(nowMin: number) {
    const reserved = draftedIds();
    const onCourt = new Set(courts.flatMap((c) => c.occupants ?? []));
    for (const p of players.values()) {
      if (!p.arrived || p.left || p.leaveMin === undefined) continue;
      if (p.leaveMin > nowMin + EPSILON_MIN) continue;
      if (onCourt.has(p.player_id) || reserved.has(p.player_id)) continue;
      p.left = true;
    }
  }

  /** Everyone waiting — no rest filter. Production's waitingRows for planSlots / soft gate. */
  function waitingQueue(nowMin: number): QueueWithWaitTime[] {
    const onCourt = new Set(courts.flatMap((c) => c.occupants ?? []));
    const reserved = draftedIds();
    const waiting: QueueWithWaitTime[] = [];
    for (const p of players.values()) {
      if (!p.arrived || p.left) continue;
      if (onCourt.has(p.player_id) || reserved.has(p.player_id)) continue;
      waiting.push(queueRow(p, nowMin));
    }
    return waiting;
  }

  /** fetchActivePool's in-memory half: arrived, not on court, rested (or waived). */
  function activePool(nowMin: number): QueueWithWaitTime[] {
    const active = waitingQueue(nowMin);
    const rested = active.filter(
      (p) => p.games_played === 0 || (p.wait_minutes ?? 0) >= MIN_REST_MINUTES
    );
    return rested.length >= PLAYERS_PER_MATCH ? rested : active;
  }

  function takeDuration(court: SimCourt): number {
    const base = court.durations[court.nextDuration % court.durations.length];
    court.nextDuration++;
    if (!jitterRnd || jitterPct === 0) return base;
    return Math.max(1, base * (1 + (jitterRnd() - 0.5) * 2 * jitterPct));
  }

  function recordSnapshot(matchId: string, teamA: ScoredPlayer[], teamB: ScoredPlayer[]) {
    snapshot.matchIds.unshift(matchId);
    snapshot.rowsByMatch.set(matchId, [
      ...teamA.map((p) => ({ player_id: p.player_id, team: "a" as const })),
      ...teamB.map((p) => ({ player_id: p.player_id, team: "b" as const })),
    ]);
  }

  function recordServedQuality(proposal: MatchProposal) {
    const four = [...proposal.teamA, ...proposal.teamB];
    for (const p of four) {
      diagnostics.draftWaits.push(p.wait_minutes ?? 0);
      if (isRedZonePlayer(p)) diagnostics.redZoneEntries++;
      if (isHardCapPlayer(p)) diagnostics.hardCapEntries++;
    }
    if (proposal.isMixedLevel) diagnostics.mixedLevelMatches++;
    if (skillSpread(four) === 2) diagnostics.skillSpread2Matches++;
    diagnostics.teamSkillGaps.push(teamSkillGap(proposal.teamA, proposal.teamB));
  }

  function compose(nowMin: number): Draft | null {
    const rawPool = activePool(nowMin);
    if (rawPool.length < PLAYERS_PER_MATCH) {
      diagnostics.thinPoolEvents++;
      return null;
    }

    const pool = scoreAndSortPool(rawPool);
    const recentRosters = deriveRecentRosters(snapshot);
    const { partnershipCounts, opponentCounts } = derivePairCounts(snapshot);
    const overlapMap = deriveOverlapMap(snapshot, pool[0].player_id);
    // REPLAY_NO_LAST_OPPONENTS=true feeds the engine an empty map, which
    // disables the split-preview search entirely (buildCombinationGroup gates
    // on a NON-EMPTY map). That is the A/B control: it must reproduce the
    // pre-freshness baseline exactly, so any drift in the "before" column is a
    // porting bug rather than a measurement.
    const lastSides =
      process.env.REPLAY_NO_LAST_OPPONENTS === "true"
        ? {
            lastOpponents: new Map<string, Set<string>>(),
            lastPartners: new Map<string, Set<string>>(),
          }
        : deriveLastSides(snapshot);
    const { lastOpponents, lastPartners } = lastSides;
    const bruteArgs = {
      partnershipCounts,
      overlapMap,
      recentRosters,
      opponentCounts,
      rejectedRosters: [] as string[][],
      lastOpponents,
      lastPartners,
      waitSlackMinutes: waitSlack,
    };

    const started = performance.now();
    const result: FreshnessResult = freshnessOn
      ? runAlgorithmWithFreshness(
          pool,
          partnershipCounts,
          overlapMap,
          recentRosters,
          opponentCounts,
          [],
          lastOpponents,
          lastPartners,
          { waitSlackMinutes: waitSlack }
        )
      : runAlgorithm(
          pool,
          partnershipCounts,
          overlapMap,
          recentRosters,
          opponentCounts,
          [],
          lastOpponents,
          lastPartners
        );
    if (freshnessOn) diagnostics.wrapperMs.push(performance.now() - started);

    if (!result.proposal) {
      diagnostics.noMatchEvents++;
      if (result.capSaturation) diagnostics.capSaturationEvents++;
      if (rawPool.length >= PLAYERS_PER_MATCH) {
        if (!stallOpen) {
          diagnostics.stallEpisodes++;
          stallOpen = true;
        }
      }
      return null;
    }
    stallOpen = false;
    if (result.forcedRepeat) diagnostics.forcedRepeats++;
    if (freshnessOn && (result.refreshed || result.backToBackRepeat || result.forcedRepeat)) {
      diagnostics.refreshAttempts++;
      if (result.refreshed) diagnostics.refreshSuccesses++;
    }

    const servedIds = [...result.proposal.teamA, ...result.proposal.teamB].map((p) => p.player_id);
    if (isBackToBackRepeat(servedIds, lastOpponents, lastPartners)) {
      diagnostics.backToBackServed++;
      if (hasAdmissibleFresherFour(pool, result.proposal, bruteArgs)) {
        diagnostics.avoidableNearIdentical++;
      }
    }

    recordServedQuality(result.proposal);
    matchSeq++;
    const matchId = `sim-${String(matchSeq).padStart(4, "0")}`;
    recordSnapshot(matchId, result.proposal.teamA, result.proposal.teamB);
    return {
      matchId,
      teamA: result.proposal.teamA,
      teamB: result.proposal.teamB,
      composedAtMin: nowMin,
      forcedRepeat: result.forcedRepeat ?? false,
      isMixedLevel: result.proposal.isMixedLevel,
    };
  }

  function seatOnCourt(court: SimCourt, draft: Draft, nowMin: number) {
    const duration = takeDuration(court);
    const rosterIds = [...draft.teamA, ...draft.teamB].map((p) => p.player_id);
    court.occupants = rosterIds;
    court.freeAtMin = nowMin + duration;
    matches.push({
      seq: matches.length + 1,
      courtId: court.id,
      startMin: nowMin,
      endMin: nowMin + duration,
      teamA: draft.teamA.map((p) => p.player_id),
      teamB: draft.teamB.map((p) => p.player_id),
      forcedRepeat: draft.forcedRepeat ?? false,
      isMixedLevel: draft.isMixedLevel,
    });
  }

  function releaseFinishedCourts(nowMin: number) {
    for (const court of courts) {
      if (court.occupants === null) continue;
      if (court.freeAtMin > nowMin + EPSILON_MIN) continue;
      for (const pid of court.occupants) {
        const p = players.get(pid);
        if (!p) continue;
        p.games_played++;
        if (p.leaveMin !== undefined && p.leaveMin <= nowMin + EPSILON_MIN) {
          p.left = true;
        } else {
          p.queuedAtMin = nowMin;
        }
      }
      court.occupants = null;
    }
  }

  function promoteDrafts(nowMin: number) {
    for (const court of courts) {
      if (court.occupants !== null) continue;
      const next = onDeck.shift();
      if (!next) break;
      seatOnCourt(court, next, nowMin);
    }
  }

  /** One engine run per free court, mirroring a bypassGate ("Call Next") fill. */
  function fillFreeCourts(nowMin: number) {
    admitArrivals(nowMin);
    processLeaves(nowMin);
    for (const court of courts) {
      if (court.occupants !== null) continue;
      const draft = compose(nowMin);
      if (!draft) break;
      seatOnCourt(court, draft, nowMin);
    }
  }

  /** Production-shaped on-deck fill: shared slot helpers, FIFO promote. */
  function fillDraftSlots(nowMin: number) {
    admitArrivals(nowMin);
    processLeaves(nowMin);
    const waiting = waitingQueue(nowMin);
    const waitingCount = waiting.length;
    const pendingRows = onDeck.map(() => ({
      is_published: true,
      is_held: false,
      held_ready_at: null,
    }));
    const { slotsAvailable } = planSlots({
      waitingCount,
      override: null,
      autoPublish: true,
      pendingRows,
    });
    if (slotsAvailable <= 0) return;

    const maxWait = waitingCount > 0 ? Math.max(...waiting.map((p) => p.wait_minutes ?? 0)) : 0;
    const inProgress = courts.filter((c) => c.occupants !== null).length;
    if (
      softGateDecision({ bypassGate: false, waitingCount, maxWait }) === "needs-active-count" &&
      inProgress > 0
    ) {
      return;
    }

    let estimatedWaiting = waitingCount;
    for (let i = 0; i < slotsAvailable; i++) {
      if (!shouldContinueSlot({ slotIndex: i, estimatedWaiting, bypassGate: false })) break;
      const draft = compose(nowMin);
      if (!draft) break;
      onDeck.push(draft);
      estimatedWaiting -= PLAYERS_PER_MATCH;
    }
  }

  function tickDraftQueue(nowMin: number) {
    releaseFinishedCourts(nowMin);
    promoteDrafts(nowMin);
    fillDraftSlots(nowMin);
    promoteDrafts(nowMin);
  }

  // ── Event loop ──────────────────────────────────────────────
  // Events are court-free instants, player arrivals, and (synthetics) leaves,
  // processed in time order. Ties resolve arrivals first so a player who lands
  // exactly as a court frees is eligible for that fill.
  const arrivals = [...new Set(fixture.players.map((p) => p.joinMin))]
    .filter((m) => m > 0)
    .sort((a, b) => a - b);
  const departures = [
    ...new Set(
      fixture.players.map((p) => p.leaveMin).filter((m): m is number => m !== undefined && m > 0)
    ),
  ].sort((a, b) => a - b);

  if (draftQueueMode) {
    tickDraftQueue(0);
  } else {
    fillFreeCourts(0);
  }

  while (true) {
    const busy = courts.filter((c) => c.occupants !== null);
    const nextCourtFree = busy.length > 0 ? Math.min(...busy.map((c) => c.freeAtMin)) : Infinity;
    const nextArrival = arrivals.length > 0 ? arrivals[0] : Infinity;
    const nextLeave = departures.length > 0 ? departures[0] : Infinity;
    const next = Math.min(nextCourtFree, nextArrival, nextLeave);

    if (!Number.isFinite(next) || next > fixture.horizonMin) break;

    if (
      nextArrival <= next + EPSILON_MIN &&
      nextArrival <= nextCourtFree &&
      nextArrival <= nextLeave
    ) {
      arrivals.shift();
      if (draftQueueMode) tickDraftQueue(nextArrival);
      else fillFreeCourts(nextArrival);
      continue;
    }

    if (nextLeave <= next + EPSILON_MIN && nextLeave < nextCourtFree) {
      departures.shift();
      if (draftQueueMode) tickDraftQueue(nextLeave);
      else {
        processLeaves(nextLeave);
        fillFreeCourts(nextLeave);
      }
      continue;
    }

    if (draftQueueMode) {
      tickDraftQueue(next);
    } else {
      releaseFinishedCourts(next);
      fillFreeCourts(next);
    }
  }

  return { fixture, matches, diagnostics };
}
