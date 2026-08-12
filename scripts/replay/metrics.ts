// ============================================================
// Replay harness — session quality metrics
// ============================================================
//
// Scores a match list, real or replayed, on the things players actually
// complain about. The headline is CONSECUTIVE opponent repeats: per the
// organizer, complaints arrive when someone faces the same person in
// back-to-back games, not when they face them twice across a whole evening.
// Total repeat counts alone hide that entirely — two meetings 90 minutes apart
// and two meetings in a row score the same. So they are measured separately.
//
// Every metric is computed from (teamA, teamB, startMin) alone, so the real
// session and the replay are scored by identical code.

import { pairKey } from "../../src/lib/matchmaking-core";
import { MAX_OPPONENT_REPEATS, MAX_PARTNERSHIP_REPEATS } from "../../src/lib/constants";
import type { PlayedMatch } from "./types";

export type SessionMetrics = {
  matches: number;
  players: number;

  /** Back-to-back games (per player) that shared ≥1 opponent. */
  consecutiveOpponentRepeats: number;
  /** …as a share of all back-to-back game pairs. The headline number. */
  consecutiveOpponentRate: number;
  /** Back-to-back games that shared the same partner. */
  consecutivePartnerRepeats: number;
  consecutivePartnerRate: number;
  /** Back-to-back games sharing ≥3 of the other 3 players — a near-identical foursome. */
  consecutiveThreeOfFour: number;
  /** Denominator for all three rates above. */
  consecutivePairs: number;

  /** Distinct opponents faced ÷ opponent encounters. 1.0 = never faced twice. */
  opponentVariety: number;
  /** Distinct partners ÷ partner encounters. */
  partnerVariety: number;
  /** Opponent pairs that met more than MAX_OPPONENT_REPEATS times. */
  opponentPairsOverCap: number;
  /** Partnerships formed more than MAX_PARTNERSHIP_REPEATS times. */
  partnershipsOverCap: number;
  maxOpponentRepeats: number;
  maxPartnershipRepeats: number;

  /**
   * Minutes from one game's START to the next one's, across all players — cycle
   * time, NOT queue wait. The wait a player feels is this minus a game length.
   */
  avgCycleMin: number;
  maxCycleMin: number;
  p90CycleMin: number;

  gamesMin: number;
  gamesMax: number;
  gamesAvg: number;
  /** Players who never got on court. */
  satOut: number;

  /** The worst-served players, for the report's detail lines. */
  worstConsecutive: { playerId: string; repeats: number; games: number }[];
};

type PlayerTimeline = {
  playerId: string;
  /** Chronological: one entry per game played. */
  games: { startMin: number; partner: string; opponents: string[] }[];
};

function buildTimelines(matches: PlayedMatch[]): Map<string, PlayerTimeline> {
  const timelines = new Map<string, PlayerTimeline>();
  const ordered = [...matches].sort((a, b) => a.startMin - b.startMin || a.seq - b.seq);

  for (const m of ordered) {
    const sides: [string[], string[]][] = [
      [m.teamA, m.teamB],
      [m.teamB, m.teamA],
    ];
    for (const [own, other] of sides) {
      for (const pid of own) {
        const partner = own.find((p) => p !== pid);
        // A malformed side (a duplicate id, or a solo player) has no partner —
        // record the game so wait/volume metrics stay accurate, but leave the
        // partner slot empty rather than inventing a pairing.
        let tl = timelines.get(pid);
        if (!tl) {
          tl = { playerId: pid, games: [] };
          timelines.set(pid, tl);
        }
        tl.games.push({ startMin: m.startMin, partner: partner ?? "", opponents: [...other] });
      }
    }
  }
  return timelines;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function computeMetrics(matches: PlayedMatch[], rosterSize: number): SessionMetrics {
  const timelines = buildTimelines(matches);

  let consecutiveOpponentRepeats = 0;
  let consecutivePartnerRepeats = 0;
  let consecutiveThreeOfFour = 0;
  let consecutivePairs = 0;

  const cycles: number[] = [];
  const worst: { playerId: string; repeats: number; games: number }[] = [];

  for (const tl of timelines.values()) {
    let playerRepeats = 0;
    for (let i = 1; i < tl.games.length; i++) {
      const prev = tl.games[i - 1];
      const cur = tl.games[i];
      consecutivePairs++;

      const prevOpponents = new Set(prev.opponents);
      const sharedOpponents = cur.opponents.filter((o) => prevOpponents.has(o));
      if (sharedOpponents.length > 0) {
        consecutiveOpponentRepeats++;
        playerRepeats++;
      }
      if (cur.partner !== "" && cur.partner === prev.partner) consecutivePartnerRepeats++;

      // Same three co-players two games running = the foursome barely moved.
      const prevCo = new Set([...prev.opponents, prev.partner].filter(Boolean));
      const curCo = [...cur.opponents, cur.partner].filter(Boolean);
      if (curCo.filter((p) => prevCo.has(p)).length >= 3) consecutiveThreeOfFour++;

      cycles.push(cur.startMin - prev.startMin);
    }
    if (playerRepeats > 0) {
      worst.push({ playerId: tl.playerId, repeats: playerRepeats, games: tl.games.length });
    }
  }

  // ── Session-wide pair counts ────────────────────────────────
  const opponentCounts = new Map<string, number>();
  const partnershipCounts = new Map<string, number>();
  for (const m of matches) {
    for (const team of [m.teamA, m.teamB]) {
      for (let i = 0; i < team.length; i++) {
        for (let j = i + 1; j < team.length; j++) {
          const k = pairKey(team[i], team[j]);
          partnershipCounts.set(k, (partnershipCounts.get(k) ?? 0) + 1);
        }
      }
    }
    for (const a of m.teamA) {
      for (const b of m.teamB) {
        const k = pairKey(a, b);
        opponentCounts.set(k, (opponentCounts.get(k) ?? 0) + 1);
      }
    }
  }

  const opponentEncounters = [...opponentCounts.values()].reduce((s, n) => s + n, 0);
  const partnerEncounters = [...partnershipCounts.values()].reduce((s, n) => s + n, 0);

  const gameCounts = [...timelines.values()].map((t) => t.games.length);
  const satOut = Math.max(0, rosterSize - timelines.size);
  // Players who never played count as 0 games, or the spread reads too flat.
  const allGameCounts = [...gameCounts, ...Array<number>(satOut).fill(0)];

  const sortedCycles = [...cycles].sort((a, b) => a - b);

  return {
    matches: matches.length,
    players: rosterSize,

    consecutiveOpponentRepeats,
    consecutiveOpponentRate:
      consecutivePairs > 0 ? consecutiveOpponentRepeats / consecutivePairs : 0,
    consecutivePartnerRepeats,
    consecutivePartnerRate: consecutivePairs > 0 ? consecutivePartnerRepeats / consecutivePairs : 0,
    consecutiveThreeOfFour,
    consecutivePairs,

    opponentVariety: opponentEncounters > 0 ? opponentCounts.size / opponentEncounters : 0,
    partnerVariety: partnerEncounters > 0 ? partnershipCounts.size / partnerEncounters : 0,
    opponentPairsOverCap: [...opponentCounts.values()].filter((n) => n > MAX_OPPONENT_REPEATS)
      .length,
    partnershipsOverCap: [...partnershipCounts.values()].filter((n) => n > MAX_PARTNERSHIP_REPEATS)
      .length,
    maxOpponentRepeats: opponentCounts.size > 0 ? Math.max(...opponentCounts.values()) : 0,
    maxPartnershipRepeats: partnershipCounts.size > 0 ? Math.max(...partnershipCounts.values()) : 0,

    avgCycleMin: cycles.length > 0 ? cycles.reduce((s, n) => s + n, 0) / cycles.length : 0,
    maxCycleMin: cycles.length > 0 ? Math.max(...cycles) : 0,
    p90CycleMin: percentile(sortedCycles, 90),

    gamesMin: allGameCounts.length > 0 ? Math.min(...allGameCounts) : 0,
    gamesMax: allGameCounts.length > 0 ? Math.max(...allGameCounts) : 0,
    gamesAvg:
      allGameCounts.length > 0
        ? allGameCounts.reduce((s, n) => s + n, 0) / allGameCounts.length
        : 0,
    satOut,

    worstConsecutive: worst.sort((a, b) => b.repeats - a.repeats).slice(0, 5),
  };
}
