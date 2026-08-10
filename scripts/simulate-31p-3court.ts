#!/usr/bin/env -S npx tsx
/**
 * simulate-31p-3court.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Event-driven simulation using the REAL Saturday 06/06 roster (31 players).
 * Pulled from session bc3fd4bd-acc6-4b3a-beaa-affa2cee5d3f.
 *
 * Courts: C1=18min  C2=20min  C3=22min  |  Session cap: 240 min
 *
 * Constants (tuned):
 *   GAME_PENALTY    = 8    (matches production constant — no floor so scores can go negative)
 *   MIN_REST        = 0    (removed — on-deck buffer provides natural rest)
 *   MAX_OPPONENT_REPEATS = 3  (kept — prevents Clark/Gessa-style repeats)
 *
 * Real join times are modelled. Session reference = 07:12:02 (when the main
 * group arrived). Michael Yan joined 95 min early → huge priority at T=0.
 * Lei, Clark, Aim, Kate joined at 08:49 (T≈97 min) — late joiner event.
 *
 * Usage: npx tsx scripts/simulate-31p-3court.ts
 */

import {
  computePriorityScore,
  scoreCandidates,
  buildCombinationGroup,
  snakeDraft,
  rotatedDraft,
  getEffectiveLookback,
  isDiversityViolation,
  pairKey,
  type ScoredPlayer,
} from "../src/lib/matchmaking-core";
import {
  SKILL_VARIANCE_TARGET,
  SKILL_VARIANCE_MAX,
  FALLBACK_WAIT_MINUTES,
  MAX_PARTNERSHIP_REPEATS,
  MAX_OPPONENT_REPEATS,
  ROSTER_LOOKBACK_COUNT,
  GATE_POOL_THRESHOLD,
  GATE_HOLD_MINUTES,
  CRITICAL_WAIT_MINUTES,
} from "../src/lib/constants";

// ─── Override for this sim run ────────────────────────────────────────────────
// GAME_PENALTY_SIM matches production GAME_PENALTY_MINUTES (8).
// Formula: NO Math.max(0,...) floor — scores can go negative so
// a 6-game player always loses to a 4-game player at the same wait time.
// Red Zone also subtracts game penalty so fewer-games players stay preferred
// even once both players exceed CRITICAL_WAIT_MINUTES.
// Penalty=8: ~8-min disadvantage per extra game → closes gap in ~8 extra
// minutes of waiting. Keeps max wait under ~40m vs ~51m at penalty=16.
const GAME_PENALTY_SIM = 8; // matches production constant
const MIN_REST_SIM = 0; // removed — priority score handles this naturally

// ─── Terminal colours ────────────────────────────────────────────────────────
const W = (s: string) => `\x1b[1m${s}\x1b[0m`;
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const B = (s: string) => `\x1b[34m${s}\x1b[0m`;
const C = (s: string) => `\x1b[36m${s}\x1b[0m`;
const M = (s: string) => `\x1b[35m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pad(s: string, n: number) {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
function rpad(s: string, n: number) {
  return s.length >= n ? s.slice(-n) : " ".repeat(n - s.length) + s;
}
function sep(char = "─", len = 92) {
  return D(char.repeat(len));
}
function skillLabel(s: number) {
  return (["?", "Beg", "L-Int", "Int", "U-Int", "L-Adv", "Adv"] as const)[s] ?? "?";
}
function minStr(m: number) {
  return `T+${String(Math.round(m)).padStart(3, "0")}m`;
}
function clockStr(m: number) {
  return `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, "0")}m`;
}

// ─── Real Saturday 06/06 roster ───────────────────────────────────────────────
// joinMin = minutes from session reference (07:12:02 UTC).
// Negative  → already in queue before session started (early arrival).
// Positive  → joins the queue mid-session (late joiner event).
interface PlayerDef {
  id: string;
  name: string;
  skill: number;
  joinMin: number;
}

const ROSTER: PlayerDef[] = [
  // ── Early arrival ─────────────────────────────────────────────────────────
  { id: "e4669891-1f1f-40e2-8c73-49125e9eeb69", name: "Michael Yan", skill: 4, joinMin: -95.66 },
  // ── Main group arrives at T≈0 ─────────────────────────────────────────────
  { id: "757a93e9-514f-4d4f-8b68-82fc8cf6f661", name: "Gelo", skill: 3, joinMin: 0.01 },
  { id: "bf10c1c0-f886-4ce0-9d54-894bfb018149", name: "Jeff", skill: 3, joinMin: 0.01 },
  { id: "8ecf82c1-2918-4329-8d84-0d216b51f9a0", name: "Chu", skill: 6, joinMin: 5.55 },
  { id: "8d8dc213-84fd-4422-8f4f-4eead22bef01", name: "Barts", skill: 5, joinMin: 10.87 },
  { id: "9215b10f-c64b-4e6e-ae2d-5dc84ef265e8", name: "Veejay", skill: 4, joinMin: 10.87 },
  { id: "77005375-4040-4fed-8138-77908ddd86de", name: "Stelle", skill: 4, joinMin: 10.87 },
  { id: "750a3b1e-beb9-4a78-a9ba-c567ba38566a", name: "Dexter", skill: 4, joinMin: 13.33 },
  { id: "8db8a64d-33e0-4edc-910c-0542db83bd9a", name: "Carlo", skill: 4, joinMin: 13.33 },
  { id: "9c3a6676-bea7-49b4-9784-1b96899720cd", name: "Eduard", skill: 2, joinMin: 22.73 },
  { id: "99f49d77-1491-410e-b895-cf4deb64ab37", name: "Miguel T", skill: 1, joinMin: 22.73 },
  { id: "f06ce3c8-0f88-4d8a-a931-7a34d4404914", name: "Madrid", skill: 4, joinMin: 22.73 },
  { id: "39ddb52f-372a-4180-ae65-4a0886baff77", name: "JCG", skill: 2, joinMin: 26.31 },
  { id: "080dccf2-73f5-43e9-a1ec-7c88c335744c", name: "Jackie B", skill: 3, joinMin: 26.31 },
  { id: "0fc00f04-04d7-4bff-ade7-ee0935fdecf7", name: "Rae", skill: 2, joinMin: 26.31 },
  { id: "77c03a5b-1c4d-4a3e-b07c-b3bb8cf3ac07", name: "Enid", skill: 3, joinMin: 37.97 },
  { id: "56d954dd-61e9-40cb-b161-5e60a3209502", name: "Bri", skill: 4, joinMin: 37.97 },
  { id: "64044d4b-f8f3-479a-9037-5d68fe4af5b4", name: "Don Gao", skill: 6, joinMin: 37.97 },
  { id: "d59c4a24-6811-4922-a005-1dd57fabcead", name: "Marc", skill: 2, joinMin: 37.97 },
  { id: "3cda1cf9-6c7c-4535-a4a7-0abeb502d960", name: "Hannah", skill: 2, joinMin: 39.77 },
  { id: "e62d20fb-bc1a-4b00-98b0-0d49fab4b4b1", name: "Gessa", skill: 1, joinMin: 39.77 },
  { id: "8ef4b364-e187-4d6b-9b92-286fdf90edae", name: "Jason", skill: 2, joinMin: 39.77 },
  { id: "8c90917f-9cc6-4c04-b2a4-241f8765e39c", name: "KARLO", skill: 2, joinMin: 39.77 },
  { id: "499b5fb7-b7d6-4429-b35e-c77df4e30930", name: "Miggy", skill: 5, joinMin: 45.01 },
  { id: "9bb6fd8f-fa7e-44e9-b311-ddd9175d1e41", name: "Paul", skill: 6, joinMin: 45.01 },
  { id: "50d9fb43-55dd-46fc-8cb4-9b6c4f999093", name: "Alvin DG", skill: 4, joinMin: 45.01 },
  { id: "1cc01052-f77e-42c6-8a88-f8201acfd117", name: "Marcus", skill: 5, joinMin: 45.01 },
  // ── Late joiners — arrive T≈97 min ────────────────────────────────────────
  { id: "31ba86eb-b0ba-4b6f-9919-82b21c91fbca", name: "Lei", skill: 1, joinMin: 97.37 },
  { id: "5f1a1b3e-4107-4b4c-9e79-bef91246aa39", name: "Clark", skill: 1, joinMin: 97.37 },
  { id: "fd5ff256-0499-4bae-ad6b-845e276bf9ac", name: "Aim", skill: 2, joinMin: 97.37 },
  { id: "2c098465-b70f-4a85-ad96-e156e490b7cd", name: "Kate C", skill: 2, joinMin: 97.37 },
];

const COURTS = [
  { id: 1, dur: 18 },
  { id: 2, dur: 20 },
  { id: 3, dur: 22 },
];
const SESSION = 240;

// ─── Player state ─────────────────────────────────────────────────────────────
interface SimPlayer {
  player_id: string;
  display_name: string;
  skill_level_int: number;
  games_played: number;
  joinedQueueAt: number; // sim-minutes when they entered/re-entered the wait queue
  lastGameEndAt: number | null;
  inSession: boolean; // false until they actually arrive (late joiners)
}

interface CourtState {
  id: number;
  dur: number;
  freeAt: number;
  occupants: string[] | null;
}

interface MatchRecord {
  matchNum: number;
  courtId: number;
  startTime: number;
  endTime: number;
  teamA: string[];
  teamB: string[];
  teamANames: string[];
  teamBNames: string[];
  teamASkill: number[];
  teamBSkill: number[];
  isMixed: boolean;
  isRedZone: boolean;
  isFallback: boolean;
}

interface GameEntry {
  matchNum: number;
  courtId: number;
  startTime: number;
  endTime: number;
  waitBefore: number | null; // null = first game of session
}

// ─── Simulation state ─────────────────────────────────────────────────────────
const allPlayers = new Map<string, SimPlayer>(
  ROSTER.map((r) => [
    r.id,
    {
      player_id: r.id,
      display_name: r.name,
      skill_level_int: r.skill,
      games_played: 0,
      joinedQueueAt: r.joinMin, // negative = already waiting at T=0
      lastGameEndAt: null,
      inSession: r.joinMin <= 0, // late joiners start out-of-session
    },
  ])
);

const courts: CourtState[] = COURTS.map((c) => ({
  id: c.id,
  dur: c.dur,
  freeAt: 0,
  occupants: null,
}));
const matchLog: MatchRecord[] = [];
const playerGameHistory = new Map<string, GameEntry[]>(ROSTER.map((r) => [r.id, []]));

const partnershipCounts = new Map<string, number>();
const opponentCounts = new Map<string, number>();
const recentRosters: string[][] = [];

let nextMatchNum = 1;

// ─── Collect all events upfront (court-free events added dynamically) ─────────
// Late joiner times (unique)
const lateJoinTimes = [...new Set(ROSTER.filter((r) => r.joinMin > 0).map((r) => r.joinMin))].sort(
  (a, b) => a - b
);

// ─── Core matchmaking ─────────────────────────────────────────────────────────
function tryFormMatch(simTime: number): {
  teamA: SimPlayer[];
  teamB: SimPlayer[];
  isMixed: boolean;
  isRedZone: boolean;
  isFallback: boolean;
  ids: string[];
} | null {
  const playingSet = new Set(courts.flatMap((c) => c.occupants ?? []));
  const waiting = [...allPlayers.values()].filter(
    (p) => p.inSession && !playingSet.has(p.player_id)
  );
  if (waiting.length < 4) return null;

  // Compute scores using the corrected production formula (no floor).
  // score = wait − (games × PENALTY) + 1000 if Red Zone.
  // No Math.max(0,...): negative scores are valid and necessary so that
  // a 6-game player at 30 min (-66) loses to a 4-game player at 30 min (-34).
  type Enriched = SimPlayer & { wait_minutes: number; priorityScore: number };
  const enriched: Enriched[] = waiting.map((p) => {
    const wait = simTime - p.joinedQueueAt;
    const gamePenalty = p.games_played * GAME_PENALTY_SIM;
    const ps =
      wait >= CRITICAL_WAIT_MINUTES
        ? 1000 + wait - gamePenalty // Red Zone: urgency boost + game equity
        : wait - gamePenalty; // Normal: unbounded below
    return { ...p, wait_minutes: wait, priorityScore: ps };
  });

  // (MIN_REST_SIM = 0, so no pool filter needed — priority score handles it)
  const sorted = [...enriched].sort((a, b) =>
    b.priorityScore !== a.priorityScore
      ? b.priorityScore - a.priorityScore
      : a.joinedQueueAt - b.joinedQueueAt
  );
  if (sorted.length < 4) return null;

  // Soft gate
  const maxWait = Math.max(...sorted.map((p) => p.wait_minutes));
  const gateExpired = maxWait >= GATE_HOLD_MINUTES;
  const activeCt = courts.filter((c) => c.occupants !== null).length;
  if (sorted.length <= GATE_POOL_THRESHOLD && activeCt > 0 && !gateExpired) return null;

  const anchor = sorted[0];
  const isRedZone = anchor.priorityScore >= 1000;
  const isFallback = anchor.wait_minutes >= FALLBACK_WAIT_MINUTES;
  const maxVar = isFallback ? SKILL_VARIANCE_MAX : SKILL_VARIANCE_TARGET;

  const candidates = sorted
    .slice(1)
    .filter((p) => Math.abs(p.skill_level_int - anchor.skill_level_int) <= maxVar);
  if (candidates.length < 3) return null;

  const eligibleSize = candidates.length + 1;
  const effectiveLookback = getEffectiveLookback(eligibleSize);
  const slicedRosters = recentRosters.slice(-effectiveLookback);

  const overlapMap = new Map<string, number>();
  for (const c of candidates) {
    let cnt = 0;
    for (const r of slicedRosters)
      if (r.includes(anchor.player_id) && r.includes(c.player_id)) cnt++;
    overlapMap.set(c.player_id, cnt);
  }

  const scored = scoreCandidates(candidates as unknown as ScoredPlayer[], overlapMap);
  const group = buildCombinationGroup(anchor as unknown as ScoredPlayer, scored, maxVar);
  if (!group.length) return null;

  const four = [anchor, ...group] as unknown as ScoredPlayer[];
  const ids = four.map((p) => p.player_id);

  const draft = isDiversityViolation(ids, slicedRosters)
    ? rotatedDraft(
        four,
        slicedRosters,
        partnershipCounts,
        MAX_PARTNERSHIP_REPEATS,
        opponentCounts,
        MAX_OPPONENT_REPEATS
      )
    : snakeDraft(
        four,
        partnershipCounts,
        MAX_PARTNERSHIP_REPEATS,
        opponentCounts,
        MAX_OPPONENT_REPEATS
      );
  if (!draft) return null;

  const teamA = draft.teamA.map((p) => allPlayers.get(p.player_id)!);
  const teamB = draft.teamB.map((p) => allPlayers.get(p.player_id)!);

  return { teamA, teamB, isMixed: maxVar > SKILL_VARIANCE_TARGET, isRedZone, isFallback, ids };
}

function bookMatch(
  court: CourtState,
  res: NonNullable<ReturnType<typeof tryFormMatch>>,
  simTime: number
): MatchRecord {
  const { teamA, teamB, isMixed, isRedZone, isFallback, ids } = res;
  const endTime = simTime + court.dur;

  const rec: MatchRecord = {
    matchNum: nextMatchNum++,
    courtId: court.id,
    startTime: simTime,
    endTime,
    teamA: teamA.map((p) => p.player_id),
    teamB: teamB.map((p) => p.player_id),
    teamANames: teamA.map((p) => p.display_name),
    teamBNames: teamB.map((p) => p.display_name),
    teamASkill: teamA.map((p) => p.skill_level_int),
    teamBSkill: teamB.map((p) => p.skill_level_int),
    isMixed,
    isRedZone,
    isFallback,
  };

  court.freeAt = endTime;
  court.occupants = ids;

  // Update partnership / opponent counts
  const [tA, tB] = [teamA, teamB];
  for (let i = 0; i < tA.length - 1; i++)
    for (let j = i + 1; j < tA.length; j++) {
      const k = pairKey(tA[i].player_id, tA[j].player_id);
      partnershipCounts.set(k, (partnershipCounts.get(k) ?? 0) + 1);
    }
  for (let i = 0; i < tB.length - 1; i++)
    for (let j = i + 1; j < tB.length; j++) {
      const k = pairKey(tB[i].player_id, tB[j].player_id);
      partnershipCounts.set(k, (partnershipCounts.get(k) ?? 0) + 1);
    }
  for (const a of tA)
    for (const b of tB) {
      const k = pairKey(a.player_id, b.player_id);
      opponentCounts.set(k, (opponentCounts.get(k) ?? 0) + 1);
    }

  recentRosters.push(ids);
  if (recentRosters.length > ROSTER_LOOKBACK_COUNT) recentRosters.shift();

  // Record game history
  for (const p of [...tA, ...tB]) {
    const hist = playerGameHistory.get(p.player_id)!;
    const waitBefore = p.lastGameEndAt !== null ? simTime - p.lastGameEndAt : null;
    hist.push({
      matchNum: rec.matchNum,
      courtId: court.id,
      startTime: simTime,
      endTime,
      waitBefore,
    });
  }

  matchLog.push(rec);
  return rec;
}

function returnPlayers(court: CourtState, simTime: number) {
  if (!court.occupants) return;
  for (const pid of court.occupants) {
    const p = allPlayers.get(pid)!;
    p.games_played++;
    p.lastGameEndAt = simTime;
    p.joinedQueueAt = simTime;
  }
  court.occupants = null;
}

function fillFreeCourts(simTime: number) {
  const free = courts.filter((c) => !c.occupants).sort((a, b) => a.id - b.id);
  for (const court of free) {
    const m = tryFormMatch(simTime);
    if (!m) break;
    bookMatch(court, m, simTime);
  }
}

// ─── Main simulation loop (event-driven) ─────────────────────────────────────
function runSimulation() {
  // Build a sorted list of all "interesting" time points:
  //  - T=0 (session start)
  //  - Late joiner arrival times
  //  - Court-free times (added dynamically below)
  const pendingJoinTimes = [...lateJoinTimes];

  // Initial fill
  fillFreeCourts(0);

  while (true) {
    const occupied = courts.filter((c) => c.occupants !== null);

    // Determine next event time
    const nextCourtFreeAt =
      occupied.length > 0 ? Math.min(...occupied.map((c) => c.freeAt)) : Infinity;
    const nextJoinAt = pendingJoinTimes.length > 0 ? pendingJoinTimes[0] : Infinity;

    const nextTime = Math.min(nextCourtFreeAt, nextJoinAt);

    if (nextTime === Infinity || nextTime > SESSION) break;

    // Process late joiner arrivals at this time (or before next court event)
    if (nextJoinAt <= nextCourtFreeAt && pendingJoinTimes.length > 0) {
      const joinTime = pendingJoinTimes.shift()!;
      const arrivals = ROSTER.filter((r) => Math.abs(r.joinMin - joinTime) < 0.01);
      for (const r of arrivals) {
        const p = allPlayers.get(r.id)!;
        p.inSession = true;
        p.joinedQueueAt = joinTime;
      }
      // Try to fill any free courts now that new players arrived
      fillFreeCourts(joinTime);
      continue;
    }

    // Process court-free event(s)
    const simTime = nextCourtFreeAt;
    for (const c of courts) {
      if (c.occupants !== null && c.freeAt === simTime) {
        returnPlayers(c, simTime);
      }
    }
    fillFreeCourts(simTime);
  }
}

// ─── Output ───────────────────────────────────────────────────────────────────
function printHeader() {
  console.log(
    W(
      "\n╔══════════════════════════════════════════════════════════════════════════════════════════╗"
    )
  );
  console.log(
    W("║   SIMULATION — Saturday 06/06 Real Roster · 31 Players · 3 Courts · 240 min            ║")
  );
  console.log(
    W("║   C1=18min  C2=20min  C3=22min  |  Session ref: 07:12:02                               ║")
  );
  console.log(
    W(
      "╚══════════════════════════════════════════════════════════════════════════════════════════╝\n"
    )
  );
  console.log(
    D(
      `  Constants: GAME_PENALTY=${GAME_PENALTY_SIM}m  ·  MIN_REST=none  ·  NO_FLOOR=true  ·  MAX_OPPONENT_REPEATS=${MAX_OPPONENT_REPEATS}  ·  MAX_PARTNERSHIP_REPEATS=${MAX_PARTNERSHIP_REPEATS}\n`
    )
  );
}

function printRoster() {
  console.log(W("Roster (31 players, sorted by arrival):"));
  console.log(sep());
  const header = `  ${"Name".padEnd(14)} ${"Skill".padEnd(7)}  Arrived`;
  console.log(D(header));
  console.log(sep("·"));

  for (const r of ROSTER) {
    const nameCol = pad(r.name, 14);
    const skillCol = pad(skillLabel(r.skill), 7);
    const arrCol =
      r.joinMin <= 0
        ? G(`T=000m (waited ${Math.round(-r.joinMin)}m before session)`)
        : r.joinMin > 90
          ? Y(`T=${String(Math.round(r.joinMin)).padStart(3, "0")}m  ← LATE JOINER`)
          : D(`T=${String(Math.round(r.joinMin)).padStart(3, "0")}m`);
    console.log(`  ${nameCol} ${Y(skillCol)}  ${arrCol}`);
  }
  console.log(sep());
}

function printMatchList() {
  console.log(
    `\n${W("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  MATCH LOG  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")}\n`
  );
  console.log(
    D(
      `  ${"#".padEnd(3)}  ${"Start→End".padEnd(16)}  ${"Ct".padEnd(4)}  Team A                              vs  Team B`
    )
  );
  console.log(sep("·"));

  for (const m of matchLog) {
    const numCol = rpad(String(m.matchNum), 3);
    const timeCol = `${minStr(m.startTime)}→${clockStr(m.endTime)}`;
    const courtCol = `C${m.courtId}`;

    const fmtTeam = (names: string[], skills: number[], colorFn: (s: string) => string) =>
      names.map((n, i) => `${colorFn(n)}${D(`(${skillLabel(skills[i])})`)}`).join(D("+"));

    const tA = fmtTeam(m.teamANames, m.teamASkill, G);
    const tB = fmtTeam(m.teamBNames, m.teamBSkill, B);

    const tag = m.isRedZone
      ? R("[RED] ")
      : m.isFallback
        ? Y("[FALL]")
        : m.isMixed
          ? M("[MIX] ")
          : D("[OK]  ");

    console.log(`  ${W(numCol)}  ${D(timeCol)}  ${C(courtCol)}   ${tA}  ${D("vs")}  ${tB}  ${tag}`);
  }

  console.log(sep("·"));
  console.log(D(`  ${matchLog.length} matches · 240-min session · 3 courts\n`));
}

function printWaitTimes() {
  console.log(
    `\n${W("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  WAIT TIMES  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")}\n`
  );

  interface Row {
    name: string;
    skill: number;
    gp: number;
    waits: number[];
    avgWait: number;
    maxWait: number;
    minWait: number;
    gameHistory: GameEntry[];
  }

  const rows: Row[] = [];
  for (const [pid, hist] of playerGameHistory) {
    const p = allPlayers.get(pid)!;
    const waits = hist.map((g) => g.waitBefore).filter((w): w is number => w !== null);
    rows.push({
      name: p.display_name,
      skill: p.skill_level_int,
      gp: hist.length,
      waits,
      avgWait: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0,
      maxWait: waits.length ? Math.max(...waits) : 0,
      minWait: waits.length ? Math.min(...waits) : 0,
      gameHistory: hist,
    });
  }

  rows.sort((a, b) => (a.skill !== b.skill ? a.skill - b.skill : a.name.localeCompare(b.name)));

  // ── Summary table ──────────────────────────────────────────────────────────
  console.log(W("  Summary:\n"));
  console.log(
    D(
      `  ${"Player".padEnd(12)} ${"Skill".padEnd(7)} GP   AvgWait  MaxWait  MinWait  Gaps (wait before each game)`
    )
  );
  console.log(`  ${sep("·", 88)}`);

  for (const r of rows) {
    const gapStr = r.waits
      .map((w) => {
        const s = `${w.toFixed(0)}m`;
        return w <= 15 ? Y(s) : w <= 30 ? G(s) : Y(s); // green ≤30, yellow >30
      })
      .join(" ");

    const noGame = r.gp === 0 ? D(" (sat out)") : "";
    console.log(
      `  ${pad(r.name, 12)} ${Y(pad(skillLabel(r.skill), 7))} ` +
        `${W(rpad(String(r.gp), 2))}   ` +
        `${rpad(r.avgWait > 0 ? r.avgWait.toFixed(1) + "m" : "—", 7)}  ` +
        `${rpad(r.maxWait > 0 ? r.maxWait.toFixed(1) + "m" : "—", 7)}  ` +
        `${rpad(r.minWait > 0 ? r.minWait.toFixed(1) + "m" : "—", 7)}  ` +
        `${gapStr}${noGame}`
    );
  }

  // ── Detail: per-player timeline ────────────────────────────────────────────
  console.log(`\n\n${W("  Detailed game timelines:\n")}`);
  console.log(
    D(
      `  ${"Player".padEnd(12)} ${"Skill".padEnd(6)} Game  Court  Start → End         Wait before game`
    )
  );
  console.log(`  ${sep("·", 78)}`);

  for (const r of rows) {
    if (r.gp === 0) {
      console.log(
        `  ${pad(r.name, 12)} ${Y(pad(skillLabel(r.skill), 6))} ${D("(no games played)")}`
      );
      continue;
    }
    for (let i = 0; i < r.gameHistory.length; i++) {
      const g = r.gameHistory[i];
      const namePart = i === 0 ? pad(r.name, 12) : " ".repeat(12);
      const skPart = i === 0 ? Y(pad(skillLabel(r.skill), 6)) : " ".repeat(6);
      const gameNum = W(`G${i + 1}`.padEnd(5));
      const ct = C(`C${g.courtId}`.padEnd(6));
      const timeStr = D(`${minStr(g.startTime)} → ${clockStr(g.endTime)}`);
      const waitStr =
        g.waitBefore === null
          ? D("— (first game)")
          : g.waitBefore <= 10
            ? Y(`${g.waitBefore.toFixed(0)}m  ← very short`)
            : g.waitBefore <= 30
              ? G(`${g.waitBefore.toFixed(0)}m`)
              : Y(`${g.waitBefore.toFixed(0)}m  ← long wait`);
      console.log(`  ${namePart} ${skPart} ${gameNum} ${ct} ${timeStr}  ${waitStr}`);
    }
  }
}

function printSummary() {
  const allWaits: number[] = [];
  for (const [, hist] of playerGameHistory)
    for (const g of hist) if (g.waitBefore !== null) allWaits.push(g.waitBefore);

  const totalSlots = matchLog.length * 4;
  const gamesPerP = [...playerGameHistory.values()].map((h) => h.length);
  const minGP = Math.min(...gamesPerP);
  const maxGP = Math.max(...gamesPerP);
  const avgGP = (totalSlots / ROSTER.length).toFixed(1);

  const avgWait = allWaits.length ? allWaits.reduce((a, b) => a + b) / allWaits.length : 0;
  const maxWait = allWaits.length ? Math.max(...allWaits) : 0;
  const above30 = allWaits.filter((w) => w > 30).length;
  const above25 = allWaits.filter((w) => w > 25).length;
  const below10 = allWaits.filter((w) => w < 10).length;

  const topOpp = [...opponentCounts.entries()]
    .map(([k, v]) => {
      const [a, b] = k.split(":");
      return {
        pair: `${allPlayers.get(a)?.display_name} vs ${allPlayers.get(b)?.display_name}`,
        count: v,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const topPart = [...partnershipCounts.entries()]
    .map(([k, v]) => {
      const [a, b] = k.split(":");
      return {
        pair: `${allPlayers.get(a)?.display_name} + ${allPlayers.get(b)?.display_name}`,
        count: v,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  console.log(
    `\n\n${W("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  SESSION SUMMARY  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")}\n`
  );
  console.log(`  ${W("Matches:")}          ${matchLog.length}`);
  console.log(
    `  ${W("Player-slots:")}     ${totalSlots}  (avg ${avgGP} games/player, range ${minGP}–${maxGP})`
  );
  const satOut = ROSTER.filter((r) => (playerGameHistory.get(r.id)?.length ?? 0) === 0);
  if (satOut.length)
    console.log(`  ${R("Sat out:")}          ${satOut.map((r) => r.name).join(", ")}`);
  console.log();
  console.log(`  ${W("Wait time between games (all gaps):")}`);
  console.log(
    `    Avg:          ${avgWait <= 30 ? G(avgWait.toFixed(1) + "m") : Y(avgWait.toFixed(1) + "m")}`
  );
  console.log(
    `    Max:          ${maxWait <= 30 ? G(maxWait.toFixed(1) + "m") : Y(maxWait.toFixed(1) + "m")}`
  );
  console.log(`    Above 30m:    ${above30 === 0 ? G("0  ✓") : Y(`${above30} gaps`)}`);
  console.log(`    Above 25m:    ${above25 === 0 ? G("0  ✓") : Y(`${above25} gaps`)}`);
  console.log(
    `    Below 10m:    ${below10 === 0 ? G("0  ✓") : Y(`${below10} gaps  ← very short rest`)}`
  );

  if (topOpp.length) {
    console.log(`\n  ${W("Top opponent pairs (cross-net repeats):")}`);
    for (const e of topOpp) {
      const flag = e.count >= MAX_OPPONENT_REPEATS ? Y("  ← at soft cap") : "";
      console.log(`    ${e.count}×  ${e.pair}${flag}`);
    }
  }
  if (topPart.length) {
    console.log(`\n  ${W("Top partnership pairs (same-team repeats):")}`);
    for (const e of topPart) {
      const flag = e.count >= MAX_PARTNERSHIP_REPEATS ? R("  ← at HARD cap") : "";
      console.log(`    ${e.count}×  ${e.pair}${flag}`);
    }
  }

  console.log(`\n${sep()}`);
  console.log(G(`\n✓ Simulation complete.\n`));
}

// ─── Run ─────────────────────────────────────────────────────────────────────
printHeader();
printRoster();
runSimulation();
printMatchList();
printWaitTimes();
printSummary();
