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
//   1. The draft queue is collapsed. The real engine fills on-deck slots that
//      an organizer later promotes; the replay composes a match the instant a
//      court frees and seats it. That is the bypassGate ("Call Next") path —
//      no soft gate, no pool-diversity cap — which is what an auto-run session
//      converges to anyway, and it keeps court occupancy at 100% so the
//      composition metrics are not contaminated by idle courts.
//   2. Nobody leaves early, and nobody pauses. Finished sessions record every
//      queue entry as 'left', so departures are not recoverable; is_paused is
//      likewise only observable live, so it is always false here. This also
//      tugs the session floor down: production's floor query excludes 'left'
//      rows, so a low-games player who goes home stops holding it, while in the
//      replay they hold it all night.
//   3. No cross-court draft augmentation. Production may pull a body off a
//      still-playing court to compose a fresher four. The trigger is NOT
//      forced-repeat-only — it also fires when the reach simply makes the match
//      fresher — but the whole path is gated on `!bypassGate`, and (1) puts the
//      replay permanently on the bypassGate branch, so it never runs here.
//      Forced repeats are counted in the diagnostics; production would have
//      tried to fix some, and would additionally have improved some matches that
//      the replay records as merely acceptable.
//      ⚠️ The replay therefore cannot measure this feature at all — it has no
//      notion of a HELD draft, so it can neither count reaches nor observe the
//      hold-age cancel. Do not read "0 cross-court events" off a replay as
//      evidence about production.
//   4. Rejection memory is empty: no organizer clears drafts in a replay, so
//      this measures what the engine does unaided.
//
// Because of (1) the replay runs the full [0, horizon] window at 100% court
// occupancy and so plays MORE matches than the night did. Compare rates, not
// absolute counts, when reading it against the REAL column.

import { runAlgorithm, scoreAndSortPool, type ScoredPlayer } from "../../src/lib/matchmaking-core";
import {
  deriveRecentRosters,
  derivePairCounts,
  deriveOverlapMap,
  deriveLastOpponents,
  type SessionMatchSnapshot,
} from "../../src/lib/matchmaking-db";
import { MIN_REST_MINUTES, PLAYERS_PER_MATCH } from "../../src/lib/constants";
import type { QueueWithWaitTime, SkillLevel } from "../../src/types/database";
import type { PlayedMatch, ReplayDiagnostics, ReplayResult, SessionFixture } from "./types";

type SimPlayer = {
  player_id: string;
  display_name: string;
  skill_level: SkillLevel;
  skill_level_int: number;
  joinMin: number;
  games_played: number;
  /** Minutes from t0 when they (re-)entered the queue — drives wait_minutes. */
  queuedAtMin: number;
  /** Set once joinMin passes; until then the player is not in the session at all. */
  arrived: boolean;
};

type SimCourt = {
  id: string;
  durations: number[];
  /** Index into `durations`; wraps so a long replay keeps the court's rhythm. */
  nextDuration: number;
  freeAtMin: number;
  occupants: string[] | null;
};

/** Floating-point slop tolerated when matching two event times. */
const EPSILON_MIN = 1e-6;

export function replaySession(fixture: SessionFixture): ReplayResult {
  const t0Ms = new Date(fixture.t0).getTime();
  const isoAt = (min: number) => new Date(t0Ms + min * 60_000).toISOString();

  const players = new Map<string, SimPlayer>(
    fixture.players.map((p) => [
      p.player_id,
      {
        player_id: p.player_id,
        display_name: p.display_name,
        skill_level: p.skill_level as SkillLevel,
        skill_level_int: p.skill_level_int,
        joinMin: p.joinMin,
        games_played: 0, // stamped at the session floor on arrival — see admitArrivals
        queuedAtMin: p.joinMin,
        arrived: false,
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
  const diagnostics: ReplayDiagnostics = {
    noMatchEvents: 0,
    capSaturationEvents: 0,
    forcedRepeats: 0,
    thinPoolEvents: 0,
  };

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
      if (p.arrived) floor = Math.min(floor, p.games_played);
      else if (p.joinMin <= nowMin + EPSILON_MIN) pending.push(p);
    }
    if (pending.length === 0) return;
    const stamp = Number.isFinite(floor) ? floor : 0; // first arrivals: nobody to inherit from
    for (const p of pending) {
      p.arrived = true;
      p.games_played = stamp;
    }
  }

  /** fetchActivePool's in-memory half: arrived, not on court, rested (or waived). */
  function activePool(nowMin: number): QueueWithWaitTime[] {
    const onCourt = new Set(courts.flatMap((c) => c.occupants ?? []));
    const active: QueueWithWaitTime[] = [];
    for (const p of players.values()) {
      if (!p.arrived) continue;
      if (onCourt.has(p.player_id)) continue;
      active.push(queueRow(p, nowMin));
    }
    const rested = active.filter(
      (p) => p.games_played === 0 || (p.wait_minutes ?? 0) >= MIN_REST_MINUTES
    );
    return rested.length >= PLAYERS_PER_MATCH ? rested : active;
  }

  function commit(court: SimCourt, teamA: ScoredPlayer[], teamB: ScoredPlayer[], nowMin: number) {
    const duration = court.durations[court.nextDuration % court.durations.length];
    court.nextDuration++;

    const seq = matches.length + 1;
    const matchId = `sim-${String(seq).padStart(4, "0")}`;
    const rosterIds = [...teamA, ...teamB].map((p) => p.player_id);

    court.occupants = rosterIds;
    court.freeAtMin = nowMin + duration;

    // Newest-first, matching the snapshot's created_at DESC contract.
    snapshot.matchIds.unshift(matchId);
    snapshot.rowsByMatch.set(matchId, [
      ...teamA.map((p) => ({ player_id: p.player_id, team: "a" })),
      ...teamB.map((p) => ({ player_id: p.player_id, team: "b" })),
    ]);

    return { seq, matchId, duration, rosterIds };
  }

  /** One engine run per free court, mirroring a bypassGate ("Call Next") fill. */
  function fillFreeCourts(nowMin: number) {
    admitArrivals(nowMin);
    for (const court of courts) {
      if (court.occupants !== null) continue;

      const rawPool = activePool(nowMin);
      if (rawPool.length < PLAYERS_PER_MATCH) {
        diagnostics.thinPoolEvents++;
        // Every court sees the same pool at this instant — one short pool means
        // no further court can be filled either.
        break;
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
      const lastOpponents =
        process.env.REPLAY_NO_LAST_OPPONENTS === "true"
          ? new Map<string, Set<string>>()
          : deriveLastOpponents(snapshot);

      const result = runAlgorithm(
        pool,
        partnershipCounts,
        overlapMap,
        recentRosters,
        opponentCounts,
        [], // rejectedRosters: none — no organizer in a replay.
        lastOpponents
      );

      if (!result.proposal) {
        diagnostics.noMatchEvents++;
        if (result.capSaturation) diagnostics.capSaturationEvents++;
        break;
      }
      if (result.forcedRepeat) diagnostics.forcedRepeats++;

      const { teamA, teamB, isMixedLevel } = result.proposal;
      const { seq, duration } = commit(court, teamA, teamB, nowMin);

      matches.push({
        seq,
        courtId: court.id,
        startMin: nowMin,
        endMin: nowMin + duration,
        teamA: teamA.map((p) => p.player_id),
        teamB: teamB.map((p) => p.player_id),
        forcedRepeat: result.forcedRepeat ?? false,
        isMixedLevel,
      });
    }
  }

  // ── Event loop ──────────────────────────────────────────────
  // Events are court-free instants and player arrivals, processed in time
  // order. Ties resolve arrivals first so a player who lands exactly as a court
  // frees is eligible for that fill.
  const arrivals = [...new Set(fixture.players.map((p) => p.joinMin))]
    .filter((m) => m > 0)
    .sort((a, b) => a - b);

  fillFreeCourts(0);

  while (true) {
    const busy = courts.filter((c) => c.occupants !== null);
    const nextCourtFree = busy.length > 0 ? Math.min(...busy.map((c) => c.freeAtMin)) : Infinity;
    const nextArrival = arrivals.length > 0 ? arrivals[0] : Infinity;
    const next = Math.min(nextCourtFree, nextArrival);

    if (!Number.isFinite(next) || next > fixture.horizonMin) break;

    if (nextArrival <= nextCourtFree) {
      arrivals.shift();
      fillFreeCourts(nextArrival);
      continue;
    }

    for (const court of courts) {
      if (court.occupants === null) continue;
      if (court.freeAtMin > next + EPSILON_MIN) continue;
      for (const pid of court.occupants) {
        const p = players.get(pid);
        if (!p) continue;
        p.games_played++;
        p.queuedAtMin = next; // re-enters the queue the moment the game ends
      }
      court.occupants = null;
    }
    fillFreeCourts(next);
  }

  return { fixture, matches, diagnostics };
}
