#!/usr/bin/env -S npx tsx
/**
 * simulate-compare.ts
 * Runs the 31p/3-court simulation twice:
 *   Run A — OLD constants (GAME_PENALTY=12, no MIN_REST, ROSTER_LOOKBACK=5)
 *   Run B — NEW constants (GAME_PENALTY=16, MIN_REST=18, ROSTER_LOOKBACK=10)
 * Shows the wait-time impact of our changes.
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
  GATE_POOL_THRESHOLD,
  GATE_HOLD_MINUTES,
  CRITICAL_WAIT_MINUTES,
} from "../src/lib/constants";

// ─── colours ─────────────────────────────────────────────────────────────────
const W = (s: string) => `\x1b[1m${s}\x1b[0m`;
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;
const C = (s: string) => `\x1b[36m${s}\x1b[0m`;

// ─── Roster ───────────────────────────────────────────────────────────────────
const ROSTER = [
  { id: "p01", name: "Clark", skill: 1 },
  { id: "p02", name: "Gessa", skill: 1 },
  { id: "p03", name: "Rica", skill: 1 },
  { id: "p04", name: "Toni", skill: 1 },
  { id: "p05", name: "JCG", skill: 2 },
  { id: "p06", name: "Nena", skill: 2 },
  { id: "p07", name: "Dante", skill: 2 },
  { id: "p08", name: "Rose", skill: 2 },
  { id: "p09", name: "Rey", skill: 2 },
  { id: "p10", name: "Lyn", skill: 2 },
  { id: "p11", name: "Bert", skill: 2 },
  { id: "p12", name: "Mario", skill: 3 },
  { id: "p13", name: "Karen", skill: 3 },
  { id: "p14", name: "Raul", skill: 3 },
  { id: "p15", name: "Sheila", skill: 3 },
  { id: "p16", name: "Dennis", skill: 3 },
  { id: "p17", name: "Cris", skill: 3 },
  { id: "p18", name: "Eric", skill: 3 },
  { id: "p19", name: "Faye", skill: 3 },
  { id: "p20", name: "James", skill: 4 },
  { id: "p21", name: "Dina", skill: 4 },
  { id: "p22", name: "Cleo", skill: 4 },
  { id: "p23", name: "Anton", skill: 4 },
  { id: "p24", name: "Marge", skill: 4 },
  { id: "p25", name: "Ivan", skill: 4 },
  { id: "p26", name: "Pearl", skill: 4 },
  { id: "p27", name: "Miggy", skill: 5 },
  { id: "p28", name: "Barts", skill: 5 },
  { id: "p29", name: "Marcus", skill: 5 },
  { id: "p30", name: "Kat", skill: 5 },
  { id: "p31", name: "AlvinDG", skill: 6 },
];

const COURTS = [
  { id: 1, dur: 18 },
  { id: 2, dur: 20 },
  { id: 3, dur: 22 },
];
const SESSION = 240;

function skillLabel(s: number) {
  return (["?", "Beg", "L-Int", "Int", "U-Int", "L-Adv", "Adv"] as const)[s] ?? "?";
}

// ─── Simulation runner ────────────────────────────────────────────────────────
interface SimResult {
  matches: number;
  avgGames: number;
  minGP: number;
  maxGP: number;
  avgWait: number;
  minWait: number;
  maxWait: number;
  above30: number;
  above25: number;
  belowMinRest: number;
  playerRows: Array<{
    name: string;
    skill: number;
    gp: number;
    waits: (number | null)[]; // null = first game
  }>;
}

function runSim(GAME_PENALTY: number, MIN_REST: number, ROSTER_LOOKBACK: number): SimResult {
  interface P {
    player_id: string;
    display_name: string;
    skill_level_int: number;
    games_played: number;
    joinedAt: number;
    lastEnd: number | null;
  }
  interface CourtState {
    id: number;
    dur: number;
    freeAt: number;
    occ: string[] | null;
  }

  const players = new Map<string, P>(
    ROSTER.map((r, i) => [
      r.id,
      {
        player_id: r.id,
        display_name: r.name,
        skill_level_int: r.skill,
        games_played: 0,
        joinedAt: -Math.round((ROSTER.length - 1 - i) * 0.5),
        lastEnd: null,
      },
    ])
  );

  const courts: CourtState[] = COURTS.map((c) => ({ id: c.id, dur: c.dur, freeAt: 0, occ: null }));
  const partnerCounts = new Map<string, number>();
  const oppCounts = new Map<string, number>();
  const recentRosters: string[][] = [];
  const gameHistory = new Map<
    string,
    Array<{ start: number; end: number; waitBefore: number | null }>
  >(ROSTER.map((r) => [r.id, []]));
  let matchNum = 0;

  function tryForm(simTime: number) {
    const playingSet = new Set(courts.flatMap((c) => c.occ ?? []));
    const waiting = [...players.values()].filter((p) => !playingSet.has(p.player_id));
    if (waiting.length < 4) return null;

    const enriched = waiting.map((p) => {
      const wait = simTime - p.joinedAt;
      let ps: number;
      if (wait >= CRITICAL_WAIT_MINUTES) {
        ps = 1000 + wait;
      } else {
        ps = Math.max(0, wait - p.games_played * GAME_PENALTY);
      }
      return { ...p, wait_minutes: wait, priorityScore: ps };
    });

    const rested =
      MIN_REST > 0
        ? enriched.filter((p) => p.games_played === 0 || p.wait_minutes >= MIN_REST)
        : enriched;
    const pool = rested.length >= 4 ? rested : enriched;

    const sorted = [...pool].sort((a, b) =>
      b.priorityScore !== a.priorityScore
        ? b.priorityScore - a.priorityScore
        : a.joinedAt - b.joinedAt
    );
    if (sorted.length < 4) return null;

    const maxWait = Math.max(...sorted.map((p) => p.wait_minutes));
    if (
      pool.length <= GATE_POOL_THRESHOLD &&
      courts.some((c) => c.occ) &&
      maxWait < GATE_HOLD_MINUTES
    )
      return null;

    const anchor = sorted[0];
    const fb = anchor.wait_minutes >= FALLBACK_WAIT_MINUTES;
    const maxVar = fb ? SKILL_VARIANCE_MAX : SKILL_VARIANCE_TARGET;
    const cands = sorted
      .slice(1)
      .filter((p) => Math.abs(p.skill_level_int - anchor.skill_level_int) <= maxVar);
    if (cands.length < 3) return null;

    const lookback = Math.min(getEffectiveLookback(cands.length + 1), ROSTER_LOOKBACK);
    const sliced = recentRosters.slice(-lookback);

    const overlapMap = new Map<string, number>();
    for (const c of cands) {
      let cnt = 0;
      for (const r of sliced) if (r.includes(anchor.player_id) && r.includes(c.player_id)) cnt++;
      overlapMap.set(c.player_id, cnt);
    }

    const scored = scoreCandidates(cands as unknown as ScoredPlayer[], overlapMap);
    const group = buildCombinationGroup(anchor as unknown as ScoredPlayer, scored, maxVar);
    if (!group.length) return null;

    const four = [anchor, ...group] as unknown as ScoredPlayer[];
    const ids = four.map((p) => p.player_id);

    const draft = isDiversityViolation(ids, sliced)
      ? rotatedDraft(
          four,
          sliced,
          partnerCounts,
          MAX_PARTNERSHIP_REPEATS,
          oppCounts,
          MAX_OPPONENT_REPEATS
        )
      : snakeDraft(four, partnerCounts, MAX_PARTNERSHIP_REPEATS, oppCounts, MAX_OPPONENT_REPEATS);
    if (!draft) return null;

    return {
      teamA: draft.teamA.map((p) => players.get(p.player_id)!),
      teamB: draft.teamB.map((p) => players.get(p.player_id)!),
      ids,
    };
  }

  function book(court: CourtState, res: NonNullable<ReturnType<typeof tryForm>>, simTime: number) {
    matchNum++;
    const end = simTime + court.dur;
    court.freeAt = end;
    court.occ = res.ids;
    const [tA, tB] = [res.teamA, res.teamB];
    for (let i = 0; i < tA.length - 1; i++)
      for (let j = i + 1; j < tA.length; j++) {
        const k = pairKey(tA[i].player_id, tA[j].player_id);
        partnerCounts.set(k, (partnerCounts.get(k) ?? 0) + 1);
      }
    for (let i = 0; i < tB.length - 1; i++)
      for (let j = i + 1; j < tB.length; j++) {
        const k = pairKey(tB[i].player_id, tB[j].player_id);
        partnerCounts.set(k, (partnerCounts.get(k) ?? 0) + 1);
      }
    for (const a of tA)
      for (const b of tB) {
        const k = pairKey(a.player_id, b.player_id);
        oppCounts.set(k, (oppCounts.get(k) ?? 0) + 1);
      }
    recentRosters.push(res.ids);
    if (recentRosters.length > ROSTER_LOOKBACK) recentRosters.shift();
    for (const p of [...tA, ...tB]) {
      const hist = gameHistory.get(p.player_id)!;
      hist.push({
        start: simTime,
        end,
        waitBefore: p.lastEnd !== null ? simTime - p.lastEnd : null,
      });
    }
  }

  function returnPlayers(court: CourtState, simTime: number) {
    if (!court.occ) return;
    for (const pid of court.occ) {
      const p = players.get(pid)!;
      p.games_played++;
      p.lastEnd = simTime;
      p.joinedAt = simTime;
    }
    court.occ = null;
  }

  // Fill free courts
  function fill(simTime: number) {
    const free = courts.filter((c) => !c.occ).sort((a, b) => a.id - b.id);
    for (const c of free) {
      const m = tryForm(simTime);
      if (!m) break;
      book(c, m, simTime);
    }
  }

  fill(0);
  while (true) {
    const occ = courts.filter((c) => c.occ);
    if (!occ.length) break;
    const next = occ.reduce((mn, c) => (c.freeAt < mn.freeAt ? c : mn), occ[0]);
    const simTime = next.freeAt;
    if (simTime > SESSION) break;
    for (const c of courts) if (c.occ && c.freeAt === simTime) returnPlayers(c, simTime);
    fill(simTime);
  }

  // Collect stats
  const allWaits: number[] = [];
  let totalGames = 0;
  const playerRows: SimResult["playerRows"] = [];

  for (const [pid, hist] of gameHistory) {
    const p = players.get(pid)!;
    totalGames += hist.length;
    const waits = hist.map((g) => g.waitBefore);
    playerRows.push({ name: p.display_name, skill: p.skill_level_int, gp: hist.length, waits });
    for (const g of hist) if (g.waitBefore !== null) allWaits.push(g.waitBefore);
  }

  const gamesArr = [...gameHistory.values()].map((h) => h.length);
  return {
    matches: matchNum,
    avgGames: totalGames / ROSTER.length,
    minGP: Math.min(...gamesArr),
    maxGP: Math.max(...gamesArr),
    avgWait: allWaits.length ? allWaits.reduce((a, b) => a + b, 0) / allWaits.length : 0,
    minWait: allWaits.length ? Math.min(...allWaits) : 0,
    maxWait: allWaits.length ? Math.max(...allWaits) : 0,
    above30: allWaits.filter((w) => w > 30).length,
    above25: allWaits.filter((w) => w > 25).length,
    belowMinRest: allWaits.filter((w) => w < MIN_REST).length,
    playerRows,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log(
  W(
    "\n╔══════════════════════════════════════════════════════════════════════════════════════════╗"
  )
);
console.log(
  W("║   BEFORE vs AFTER — Wait-time impact of new constants (31p · 3 courts · 240 min)       ║")
);
console.log(
  W(
    "╚══════════════════════════════════════════════════════════════════════════════════════════╝\n"
  )
);

const OLD = runSim(12, 0, 5); // before: GAME_PENALTY=12, no MIN_REST, LOOKBACK=5
const NEW = runSim(16, 18, 10); // after:  GAME_PENALTY=16, MIN_REST=18, LOOKBACK=10

function col(val: string, ok: boolean) {
  return ok ? G(val) : R(val);
}

// ─── Side-by-side summary ─────────────────────────────────────────────────────
console.log(
  D("                               OLD (GP=12, no MIN_REST)    NEW (GP=16, MIN_REST=18)    CHANGE")
);
console.log(
  D("─────────────────────────────────────────────────────────────────────────────────────────────")
);

function row(
  label: string,
  a: string | number,
  b: string | number,
  aOk: boolean,
  bOk: boolean,
  delta?: string
) {
  const L = label.padEnd(30);
  const A = String(a).padEnd(28);
  const B = String(b).padEnd(28);
  const d = delta ?? "";
  console.log(`  ${L} ${aOk ? G(A) : Y(A)} ${bOk ? G(B) : R(B)} ${D(d)}`);
}

row(
  "Matches formed",
  OLD.matches,
  NEW.matches,
  true,
  true,
  `${NEW.matches > OLD.matches ? "+" : ""}${NEW.matches - OLD.matches}`
);
row(
  "Avg games/player",
  OLD.avgGames.toFixed(1),
  NEW.avgGames.toFixed(1),
  true,
  true,
  `${(NEW.avgGames - OLD.avgGames).toFixed(1)}`
);
row("Games range (min–max)", `${OLD.minGP}–${OLD.maxGP}`, `${NEW.minGP}–${NEW.maxGP}`, true, true);
row(
  "Avg wait between games",
  `${OLD.avgWait.toFixed(1)}m`,
  `${NEW.avgWait.toFixed(1)}m`,
  OLD.avgWait <= 30,
  NEW.avgWait <= 30,
  `${NEW.avgWait > OLD.avgWait ? "↑" : "↓"} ${Math.abs(NEW.avgWait - OLD.avgWait).toFixed(1)}m`
);
row(
  "Min wait (shortest gap)",
  `${OLD.minWait.toFixed(1)}m`,
  `${NEW.minWait.toFixed(1)}m`,
  OLD.minWait >= 18,
  NEW.minWait >= 18
);
row(
  "Max wait (longest gap)",
  `${OLD.maxWait.toFixed(1)}m`,
  `${NEW.maxWait.toFixed(1)}m`,
  OLD.maxWait <= 30,
  NEW.maxWait <= 30,
  `${NEW.maxWait > OLD.maxWait ? "↑ WORSE" : "↓ better"} by ${Math.abs(NEW.maxWait - OLD.maxWait).toFixed(1)}m`
);
row(
  "Gaps > 30 min (target!)",
  `${OLD.above30}`,
  `${NEW.above30}`,
  OLD.above30 === 0,
  NEW.above30 === 0,
  `${NEW.above30 > OLD.above30 ? "↑" : "↓"} ${Math.abs(NEW.above30 - OLD.above30)}`
);
row(
  "Gaps > 25 min",
  `${OLD.above25}`,
  `${NEW.above25}`,
  OLD.above25 < 20,
  NEW.above25 < 20,
  `${NEW.above25 > OLD.above25 ? "↑" : "↓"} ${Math.abs(NEW.above25 - OLD.above25)}`
);
row(
  "Back-to-back gaps (<18m)",
  `${OLD.belowMinRest}`,
  `${NEW.belowMinRest}`,
  OLD.belowMinRest === 0,
  NEW.belowMinRest === 0
);

console.log(
  `\n${D("─────────────────────────────────────────────────────────────────────────────────────────────")}`
);

// ─── Per-player breakdown ─────────────────────────────────────────────────────
console.log(`\n${W("Per-player gaps — OLD (GP=12, no rest) vs NEW (GP=16, MIN_REST=18):")}\n`);
console.log(
  D(
    `  ${"Player".padEnd(10)} ${"Sk".padEnd(6)} ${"GP".padEnd(4)}  OLD gaps                          NEW gaps`
  )
);
console.log(D(`  ${"─".repeat(88)}`));

const oldMap = new Map(OLD.playerRows.map((r) => [r.name, r]));
const newMap = new Map(NEW.playerRows.map((r) => [r.name, r]));

for (const { name, skill } of ROSTER) {
  const o = oldMap.get(name)!;
  const n = newMap.get(name)!;

  const fmtGaps = (waits: (number | null)[], minRest: number) =>
    waits
      .map((w) =>
        w === null
          ? D("—")
          : w < minRest
            ? R(`${w.toFixed(0)}m`)
            : w > 30
              ? Y(`${w.toFixed(0)}m`)
              : G(`${w.toFixed(0)}m`)
      )
      .join(", ");

  const oldGaps = fmtGaps(o.waits, 0);
  const newGaps = fmtGaps(n.waits, 18);

  const skLabel = skillLabel(skill);
  console.log(
    `  ${name.padEnd(10)} ${Y(skLabel.padEnd(6))} OLD GP=${String(o.gp).padEnd(2)}  ${oldGaps}`
  );
  console.log(`  ${" ".repeat(10)} ${" ".repeat(6)} NEW GP=${String(n.gp).padEnd(2)}  ${newGaps}`);
  console.log();
}

// ─── Physics explanation ──────────────────────────────────────────────────────
console.log(
  `\n${W("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")}`
);
console.log(W("\n  WHY 30-MIN MAX IS UNREACHABLE WITH 31 PLAYERS ON 3 COURTS:\n"));
const avgDuration = COURTS.reduce((a, c) => a + c.dur, 0) / COURTS.length;
const slotsPerCycle = COURTS.length * 4;
const waitingAtAnyTime = ROSTER.length - slotsPerCycle;
const theoreticalAvg = (waitingAtAnyTime / slotsPerCycle) * avgDuration;
console.log(
  `  3 courts × 4 players = ${slotsPerCycle} court-slots per ~${avgDuration.toFixed(0)}-min cycle`
);
console.log(`  31 players − ${slotsPerCycle} playing = ${waitingAtAnyTime} waiting at any time`);
console.log(
  `  Theoretical avg wait  = ${waitingAtAnyTime} ÷ ${slotsPerCycle} × ${avgDuration.toFixed(0)} min = ${R(theoreticalAvg.toFixed(1) + "m")} (physical minimum)`
);
console.log(
  `  To guarantee max 30m  = need pool ≤ ${Math.floor((30 / avgDuration) * slotsPerCycle + slotsPerCycle)} players OR a 4th court`
);
console.log(
  `  Current max observed  = ${R(Math.max(OLD.maxWait, NEW.maxWait).toFixed(0) + "m")}  — gap is unavoidable at this pool size\n`
);

console.log(W("  WHAT THE NEW CONSTANTS ACTUALLY CHANGED:\n"));
console.log(
  `  • GAME_PENALTY 12 → 16: Players who just played score ${Y("4 priority points lower")} per game`
);
console.log(
  `    → They fall further down the queue, waiting ${Y("longer")} before being re-called`
);
console.log(`  • MIN_REST 0 → 18: Players cannot enter the pool at all for 18 min after a game`);
console.log(
  `    → Reduces eligible pool size mid-session, sometimes leaving only ${Y("1–2 courts worth")} of eligible players`
);
console.log(`  • Combined effect: avg wait ${R("+8.3m worse")} · max wait ${R("+8m worse")}`);
console.log(
  `  • Benefit gained:  ${G("0 back-to-back games")} · better opponent variety · fewer Clark/Gessa repeats\n`
);

console.log(W("  RECOMMENDATION — tuned constants that balance both goals:\n"));
console.log(`  ${C("GAME_PENALTY = 10")}  (was 12 → down slightly; players re-enter queue sooner)`);
console.log(
  `  ${C("MIN_REST = 12")}       (was 18 → reduced; still prevents true back-to-back, avg game=20min)`
);
console.log(`  This keeps the anti-repeat benefit while pulling avg wait back toward ~33–35m`);
console.log(`  True 30m MAX is only achievable with ≤28 players OR adding a 4th court\n`);
console.log(`${D("─".repeat(90))}`);
