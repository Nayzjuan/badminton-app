#!/usr/bin/env -S npx tsx
/**
 * simulate-scenarios.ts — Multi-scenario parametric simulation
 * ─────────────────────────────────────────────────────────────────────────────
 * Validates HARD_WAIT_CAP mechanism across 3 session configurations:
 *   A: 31 players / 3 courts / 240 min  (Saturday 06/06 real roster)
 *   B: 18 players / 2 courts / 240 min  (smaller session)
 *   C: 50 players / 5 courts / 240 min  (large session)
 *
 * Proposed algorithm changes vs. current production:
 *   GAME_PENALTY   = 8   (unchanged)
 *   CRITICAL_WAIT  = 20  (was 25 — Red Zone triggers 5 min sooner)
 *   HARD_WAIT_CAP  = 25  (NEW) — after 25m in eligible pool, score = 2000
 *     └─ Only applies to players at/below their session-pace-adjusted threshold,
 *        so high-game-count players can't use it to jump lower-game players.
 *   TARGET_GAMES   = round(courts × duration / avgGameMin × 4 / players)
 *
 * Usage: npx tsx scripts/simulate-scenarios.ts
 */

// ─── Types ────────────────────────────────────────────────────────────────────

type Skill = 0 | 1 | 2 | 3 | 4 | 5; // beg, l-int, int, u-int, l-adv, adv
const SKILL_LABEL = ["Beg", "L-Int", "Int", "U-Int", "L-Adv", "Adv"] as const;

interface SimPlayer {
  name: string;
  skill: Skill;
  arrivedAt: number; // minutes from session start
}

interface SimConfig {
  sessionDuration: number;
  courts: number[]; // game duration per court in minutes
  penalty: number; // GAME_PENALTY
  critWait: number; // CRITICAL_WAIT_MINUTES
  hardCap: number; // HARD_WAIT_CAP_MINUTES (0 = disabled)
  targetGames: number; // for hard-cap eligibility gating
  skillVarianceMax: number; // normal match tolerance
  skillFallbackMax: number; // fallback tolerance when no group found
  maxPartnerRepeats: number;
  maxOpponentRepeats: number;
}

interface PlayerState {
  games: number;
  eligibleAt: number; // when they can next play (Infinity until arrived)
  lastGameEnd: number;
  gaps: number[]; // game-to-game gaps (minutes)
  inQueue: boolean;
}

interface MatchRecord {
  num: number;
  startTime: number;
  endTime: number;
  court: number;
  players: string[]; // 4 player names
  teamA: [string, string];
  teamB: [string, string];
  flag: string; // [OK], [FALL], [RED], [HARD]
}

interface SimResult {
  matches: MatchRecord[];
  playerStats: Map<
    string,
    { name: string; skill: Skill; arrived: number; games: number; gaps: number[] }
  >;
  totalGames: number;
  avgGames: number;
}

// ─── Terminal colours ─────────────────────────────────────────────────────────
const W = (s: string) => `\x1b[1m${s}\x1b[0m`;
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const C = (s: string) => `\x1b[36m${s}\x1b[0m`;
const M = (s: string) => `\x1b[35m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;

function pad(s: string, n: number) {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

// ─── Priority Scoring ─────────────────────────────────────────────────────────

function computeScore(
  waitFromEligible: number,
  gamesPlayed: number,
  currentTime: number,
  cfg: SimConfig
): number {
  // Hard cap eligibility:
  //  1. Player must not have reached the session target yet (hard ceiling — no 6-game
  //     players in a 5-game-target session; once you hit the target you rely on normal
  //     scoring and Red Zone, not the absolute override).
  //  2. Player must be at/below their expected pace + 1 buffer (progressive threshold).
  //     This prevents players who burst early from claiming the cap over slower ones.
  const sessionProgress = Math.min(currentTime / cfg.sessionDuration, 1.0);
  const expectedGames = sessionProgress * cfg.targetGames;
  const capThreshold = Math.floor(expectedGames) + 1;
  const isCapEligible = gamesPlayed < cfg.targetGames && gamesPlayed <= capThreshold;

  if (isCapEligible && waitFromEligible >= cfg.hardCap) {
    // Progressive hard cap: score grows with additional wait beyond the threshold.
    // This prevents flat score=2000 ties (which cause arrival-time tiebreaks to
    // systematically deprioritize late joiners). Whoever has waited longest beyond
    // the cap gets absolute priority — no flat pool competition.
    // Score at exactly hardCap = 2000; grows by 10 per extra minute.
    return 2000 + Math.round((waitFromEligible - cfg.hardCap) * 10);
  }

  const gamePenalty = gamesPlayed * cfg.penalty;
  if (waitFromEligible >= cfg.critWait) {
    return 1000 + waitFromEligible - gamePenalty; // Red Zone
  }
  return waitFromEligible - gamePenalty; // Normal
}

// ─── Match Formation ──────────────────────────────────────────────────────────

function pKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

function tryFormGroup(
  candidates: Array<{
    name: string;
    skill: Skill;
    score: number;
    arrivedAt: number;
    waitFromEligible: number;
  }>,
  anchor: {
    name: string;
    skill: Skill;
    score: number;
    arrivedAt: number;
    waitFromEligible: number;
  },
  tolerance: number,
  cfg: SimConfig,
  partnerCounts: Map<string, number>,
  opponentCounts: Map<string, number>
): string[] | null {
  const eligible = candidates.filter(
    (p) => p.name !== anchor.name && Math.abs(p.skill - anchor.skill) <= tolerance
  );
  if (eligible.length < 3) return null;

  // Sort by score desc, then wait-duration desc (longer wait = higher priority)
  eligible.sort((a, b) => b.score - a.score || b.waitFromEligible - a.waitFromEligible);

  // Pick best 3, trying to find fresh partnerships
  // Pass 1: prefer fresh partner pairs (count=0)
  for (let i = 0; i < eligible.length - 1; i++) {
    for (let j = i + 1; j < eligible.length - 1; j++) {
      for (let k = j + 1; k < eligible.length; k++) {
        const group = [eligible[i], eligible[j], eligible[k]];
        const all4 = [anchor, ...group];
        const splits = getTeamSplits(all4.map((p) => p.skill));
        for (const [teamA, teamB] of splits) {
          const aNames = teamA.map((i) => all4[i].name);
          const bNames = teamB.map((i) => all4[i].name);
          const aKey = pKey(aNames[0], aNames[1]);
          const bKey = pKey(bNames[0], bNames[1]);
          if (
            (partnerCounts.get(aKey) ?? 0) < cfg.maxPartnerRepeats &&
            (partnerCounts.get(bKey) ?? 0) < cfg.maxPartnerRepeats
          ) {
            // Check opponent counts (soft)
            return [anchor.name, ...group.map((p) => p.name)];
          }
        }
      }
    }
  }

  // Pass 2: relax partnership freshness, just avoid hard cap
  for (let i = 0; i < eligible.length - 2; i++) {
    for (let j = i + 1; j < eligible.length - 1; j++) {
      for (let k = j + 1; k < eligible.length; k++) {
        const group = [eligible[i], eligible[j], eligible[k]];
        const all4 = [anchor, ...group];
        const splits = getTeamSplits(all4.map((p) => p.skill));
        for (const [teamA, teamB] of splits) {
          const aNames = teamA.map((i) => all4[i].name);
          const bNames = teamB.map((i) => all4[i].name);
          if (
            (partnerCounts.get(pKey(aNames[0], aNames[1])) ?? 0) < cfg.maxPartnerRepeats &&
            (partnerCounts.get(pKey(bNames[0], bNames[1])) ?? 0) < cfg.maxPartnerRepeats
          ) {
            return [anchor.name, ...group.map((p) => p.name)];
          }
        }
      }
    }
  }

  // Pass 3: last resort — take top 3 by score regardless
  return [anchor.name, eligible[0].name, eligible[1].name, eligible[2].name];
}

// Returns valid team split indices for 4 players (all combos of 2+2)
function getTeamSplits(skills: number[]): Array<[[number, number], [number, number]]> {
  const splits: Array<[[number, number], [number, number]]> = [
    [
      [0, 1],
      [2, 3],
    ],
    [
      [0, 2],
      [1, 3],
    ],
    [
      [0, 3],
      [1, 2],
    ],
  ];
  // Sort by team skill balance (smaller difference = better)
  return splits.sort((a, b) => {
    const diff = (s: [number, number]) => Math.abs(skills[s[0]] - skills[s[1]]);
    const balance = (s: [[number, number], [number, number]]) =>
      Math.abs(skills[s[0][0]] + skills[s[0][1]] - skills[s[1][0]] - skills[s[1][1]]);
    return balance(a) - balance(b);
  });
}

function formMatch(
  currentTime: number,
  states: Map<string, PlayerState>,
  roster: SimPlayer[],
  cfg: SimConfig,
  partnerCounts: Map<string, number>,
  opponentCounts: Map<string, number>
): { players: string[]; teamA: [string, string]; teamB: [string, string]; flag: string } | null {
  // Build pool of eligible waiting players.
  // Two-tier design: players below targetGames form the primary pool.
  // Players at targetGames are "overflow" and only included when the primary pool
  // has < 4 players — preventing them from taking slots away from under-served players.
  const allWaiting = roster
    .map((p) => {
      const s = states.get(p.name)!;
      if (!s.inQueue) return null;
      const waitFromEligible = Math.max(0, currentTime - s.eligibleAt);
      const score = computeScore(waitFromEligible, s.games, currentTime, cfg);
      return {
        name: p.name,
        skill: p.skill,
        score,
        arrivedAt: p.arrivedAt,
        games: s.games,
        waitFromEligible,
      };
    })
    .filter(Boolean) as Array<{
    name: string;
    skill: Skill;
    score: number;
    arrivedAt: number;
    games: number;
    waitFromEligible: number;
  }>;

  const primaryPool = allWaiting.filter((p) => p.games < cfg.targetGames);
  const pool = primaryPool.length >= 4 ? primaryPool : allWaiting;

  if (pool.length < 4) return null;

  // Sort: score desc; tiebreak by wait-duration desc (longer wait = higher priority).
  // Wait-duration tiebreak is fairer than arrival-time — it ensures a late joiner who has
  // been in the eligible pool longer than an early-arrival is served before them when both
  // have the same priority score, rather than systematically deprioritizing late joiners.
  pool.sort((a, b) => b.score - a.score || b.waitFromEligible - a.waitFromEligible);

  const anchor = pool[0];

  // Try normal tolerance, then fallback
  for (const tolerance of [cfg.skillVarianceMax, cfg.skillFallbackMax]) {
    const group = tryFormGroup(pool, anchor, tolerance, cfg, partnerCounts, opponentCounts);
    if (group && group.length === 4) {
      const p = group.map((name) => roster.find((r) => r.name === name)!);
      const skills = p.map((pl) => pl.skill);
      const splits = getTeamSplits(skills);
      const [teamAIdx, teamBIdx] = splits[0];

      // Check opponent repeat (soft — relax if needed)
      const aNames: [string, string] = [p[teamAIdx[0]].name, p[teamAIdx[1]].name];
      const bNames: [string, string] = [p[teamBIdx[0]].name, p[teamBIdx[1]].name];

      // Determine flag
      const anyHardCap = pool
        .filter((pl) => group.includes(pl.name))
        .some((pl) => pl.score === 2000);
      const anyRedZone = pool
        .filter((pl) => group.includes(pl.name))
        .some((pl) => pl.score >= 1000 && pl.score < 2000);
      const flag = anyHardCap
        ? "[HARD]"
        : tolerance > cfg.skillVarianceMax
          ? "[FALL]"
          : anyRedZone
            ? "[RED]"
            : "[OK]";

      return { players: group, teamA: aNames, teamB: bNames, flag };
    }
  }
  return null;
}

// ─── Core Simulation ──────────────────────────────────────────────────────────

function simulate(scenario: { name: string; players: SimPlayer[]; config: SimConfig }): SimResult {
  const { players, config: cfg } = scenario;
  const states = new Map<string, PlayerState>();

  for (const p of players) {
    states.set(p.name, {
      games: 0,
      eligibleAt: Infinity, // until they arrive
      lastGameEnd: -Infinity,
      gaps: [],
      inQueue: false,
    });
  }

  // Track partnership / opponent counts
  const partnerCounts = new Map<string, number>();
  const opponentCounts = new Map<string, number>();

  // Court availability: time when each court next frees
  const courtFreeAt = cfg.courts.map(() => 0); // all free at T=0
  const matches: MatchRecord[] = [];
  let matchNum = 0;

  // Event-driven simulation: process events in time order
  type Event =
    | { time: number; type: "COURT_FREE"; court: number }
    | { time: number; type: "PLAYER_JOIN"; name: string };
  const eventQueue: Event[] = [];

  // Seed initial court-free events
  for (let c = 0; c < cfg.courts.length; c++) {
    eventQueue.push({ time: 0, type: "COURT_FREE", court: c });
  }
  // Seed player-join events
  for (const p of players) {
    eventQueue.push({ time: p.arrivedAt, type: "PLAYER_JOIN", name: p.name });
  }

  const sortEvents = () =>
    eventQueue.sort((a, b) => a.time - b.time || (a.type === "PLAYER_JOIN" ? -1 : 1));

  sortEvents();

  while (eventQueue.length > 0) {
    const event = eventQueue.shift()!;
    const t = event.time;

    if (t > cfg.sessionDuration) break;

    if (event.type === "PLAYER_JOIN") {
      const s = states.get(event.name)!;
      s.eligibleAt = t; // immediately eligible when they arrive (no rest for first game)
      s.inQueue = true;
      continue;
    }

    // COURT_FREE event
    const court = event.court;
    const gameDuration = cfg.courts[court];

    // Try to form a match
    const match = formMatch(t, states, players, cfg, partnerCounts, opponentCounts);
    if (!match) {
      // No match possible — try again in 1 min
      if (t + 1 <= cfg.sessionDuration) {
        eventQueue.push({ time: t + 1, type: "COURT_FREE", court });
        sortEvents();
      }
      continue;
    }

    // Check if the match can end within session
    const matchEnd = t + gameDuration;
    if (matchEnd > cfg.sessionDuration + 5) {
      // Too late to complete — stop scheduling on this court
      continue;
    }

    matchNum++;
    const rec: MatchRecord = {
      num: matchNum,
      startTime: t,
      endTime: matchEnd,
      court,
      players: match.players,
      teamA: match.teamA,
      teamB: match.teamB,
      flag: match.flag,
    };
    matches.push(rec);

    // Update player states
    for (const name of match.players) {
      const s = states.get(name)!;
      if (s.games > 0) {
        const gap = t - s.lastGameEnd;
        s.gaps.push(Math.round(gap * 10) / 10);
      }
      s.games++;
      s.inQueue = false;
      s.lastGameEnd = matchEnd;
      s.eligibleAt = matchEnd; // eligible immediately after game ends (sim uses no rest)
    }

    // Update partnership/opponent counts
    const [a1, a2] = match.teamA;
    const [b1, b2] = match.teamB;
    const aKey = pKey(a1, a2);
    const bKey = pKey(b1, b2);
    partnerCounts.set(aKey, (partnerCounts.get(aKey) ?? 0) + 1);
    partnerCounts.set(bKey, (partnerCounts.get(bKey) ?? 0) + 1);
    for (const opp of [
      [a1, b1],
      [a1, b2],
      [a2, b1],
      [a2, b2],
    ]) {
      const k = pKey(opp[0], opp[1]);
      opponentCounts.set(k, (opponentCounts.get(k) ?? 0) + 1);
    }

    // Re-enqueue players and schedule next court-free event
    for (const name of match.players) {
      eventQueue.push({ time: matchEnd, type: "PLAYER_JOIN", name });
    }
    // Court is occupied until matchEnd
    eventQueue.push({ time: matchEnd, type: "COURT_FREE", court });
    sortEvents();
  }

  // Collect final stats
  const playerStats = new Map<
    string,
    { name: string; skill: Skill; arrived: number; games: number; gaps: number[] }
  >();
  for (const p of players) {
    const s = states.get(p.name)!;
    playerStats.set(p.name, {
      name: p.name,
      skill: p.skill,
      arrived: p.arrivedAt,
      games: s.games,
      gaps: s.gaps,
    });
  }

  const totalGames = [...playerStats.values()].reduce((sum, p) => sum + p.games, 0);

  return {
    matches,
    playerStats,
    totalGames,
    avgGames: totalGames / players.length,
  };
}

// ─── Reporting ────────────────────────────────────────────────────────────────

function report(
  scenario: { name: string; players: SimPlayer[]; config: SimConfig },
  result: SimResult
) {
  const { config: cfg } = scenario;
  const { matches, playerStats } = result;

  const BAR = "━".repeat(84);
  console.log();
  console.log(
    W(`╔═══════════════════════════════════════════════════════════════════════════════════╗`)
  );
  console.log(W(`║  SCENARIO: ${pad(scenario.name, 66)}║`));
  console.log(
    W(
      `║  ${pad(`${scenario.players.length} players / ${cfg.courts.length} courts (${cfg.courts.join("+")}min) / ${cfg.sessionDuration} min session`, 80)}║`
    )
  );
  console.log(
    W(
      `║  ${pad(`PENALTY=${cfg.penalty}  CRITICAL_WAIT=${cfg.critWait}  HARD_WAIT_CAP=${cfg.hardCap}  TARGET_GAMES=${cfg.targetGames}`, 80)}║`
    )
  );
  console.log(
    W(`╚═══════════════════════════════════════════════════════════════════════════════════╝`)
  );

  // Match log (condensed)
  console.log();
  console.log(W(`  ${BAR}`));
  console.log(W(`  MATCH LOG`));
  console.log(W(`  ${BAR}`));
  console.log(D(`  #    Start→End       Ct  Team A            vs  Team B            Flag`));
  console.log(
    D(`  ────────────────────────────────────────────────────────────────────────────────`)
  );

  for (const m of matches) {
    const startH = `T+${String(Math.round(m.startTime)).padStart(3, "0")}m`;
    const endH = `${String(Math.floor(m.endTime / 60)).padStart(1)}h${String(Math.round(m.endTime % 60)).padStart(2, "0")}m`;
    const teamA = m.teamA.join("+");
    const teamB = m.teamB.join("+");
    const flagColor =
      m.flag === "[HARD]" ? M : m.flag === "[RED]" ? Y : m.flag === "[FALL]" ? Y : G;
    console.log(
      `  ${W(String(m.num).padStart(2))}  ${D(`${startH}→${endH}`)}  ${C(`C${m.court + 1}`)}  ${pad(teamA, 18)} vs  ${pad(teamB, 18)} ${flagColor(m.flag)}`
    );
  }

  // Wait time analysis
  console.log();
  console.log(W(`  ${BAR}`));
  console.log(W(`  WAIT TIME ANALYSIS`));
  console.log(W(`  ${BAR}`));
  console.log(D(`  Player        Skill    GP   MaxWait  AvgWait  Gaps`));
  console.log(D(`  ─────────────────────────────────────────────────────────────────────────────`));

  const sorted = [...playerStats.values()].sort(
    (a, b) => a.skill - b.skill || a.name.localeCompare(b.name)
  );

  for (const p of sorted) {
    const maxGap = p.gaps.length > 0 ? Math.max(...p.gaps) : 0;
    const avgGap = p.gaps.length > 0 ? p.gaps.reduce((s, g) => s + g, 0) / p.gaps.length : 0;
    const isLate = p.arrived > 30;

    const gapStrs = p.gaps
      .map((g) => {
        if (g > cfg.hardCap + 5) return R(`${Math.round(g)}m`);
        if (g > 30) return Y(`${Math.round(g)}m`);
        return G(`${Math.round(g)}m`);
      })
      .join(" ");

    const gpColor = p.games >= cfg.targetGames ? G : p.games >= cfg.targetGames - 1 ? Y : R;
    const maxColor = maxGap > cfg.hardCap + 5 ? R : maxGap > 30 ? Y : G;

    console.log(
      `  ${pad(p.name + (isLate ? "*" : ""), 14)}${D(pad(SKILL_LABEL[p.skill], 8))}` +
        `${gpColor(W(String(p.games).padStart(3)))}   ${maxColor(pad(Math.round(maxGap) + "m", 8))} ` +
        `${D(pad(Math.round(avgGap) + "m", 8))} ${gapStrs}`
    );
  }
  console.log(D(`  * = late joiner`));

  // Summary
  const allGaps = [...playerStats.values()].flatMap((p) => p.gaps);
  const nonLate = [...playerStats.values()].filter((p) => p.arrived <= 30);
  const lateJoiners = [...playerStats.values()].filter((p) => p.arrived > 30);
  const nonLateGames = nonLate.map((p) => p.games);
  const minGames = Math.min(...nonLateGames);
  const maxGames = Math.max(...nonLateGames);
  const maxWait = allGaps.length > 0 ? Math.max(...allGaps) : 0;
  const avgWait = allGaps.length > 0 ? allGaps.reduce((s, g) => s + g, 0) / allGaps.length : 0;
  const over30 = allGaps.filter((g) => g > 30).length;
  const overCap = allGaps.filter((g) => g > cfg.hardCap + cfg.courts[cfg.courts.length - 1]).length;

  console.log();
  console.log(W(`  ${BAR}`));
  console.log(W(`  SESSION SUMMARY`));
  console.log(W(`  ${BAR}`));
  console.log(`  Matches:        ${W(String(matches.length))}`);
  console.log(
    `  Total slots:    ${W(String(result.totalGames))} (avg ${result.avgGames.toFixed(1)} games/player)`
  );
  console.log(`  Target games:   ${W(String(cfg.targetGames))}`);
  console.log();
  console.log(
    `  Non-late-joiner games range: ${nonLateGames.length > 0 ? (minGames === maxGames ? G(`all ${minGames}`) : maxGames - minGames <= 1 ? G(`${minGames}–${maxGames} (±1 ✅)`) : Y(`${minGames}–${maxGames} (±${maxGames - minGames})`)) : D("n/a")}`
  );
  console.log(
    `  Late joiner games: ${lateJoiners.map((p) => `${p.name}=${p.games}`).join(", ") || D("none")}`
  );
  console.log();
  console.log(
    `  Max wait (all):      ${maxWait > 30 ? Y(maxWait.toFixed(1) + "m") : G(maxWait.toFixed(1) + "m")} ${maxWait > 30 ? Y("⚠ above 30m target") : G("✅ within 30m")}`
  );
  console.log(`  Avg wait:            ${G(avgWait.toFixed(1) + "m")}`);
  console.log(`  Gaps > 30m:          ${over30 > 0 ? Y(String(over30)) : G("0")}`);
  console.log(
    `  Gaps > hard_cap+maxCourt: ${overCap > 0 ? R(String(overCap)) : G("0")} ${overCap > 0 ? R("← hard cap violated") : ""}`
  );

  // Hard cap flags
  const hardMatches = matches.filter((m) => m.flag === "[HARD]");
  if (hardMatches.length > 0) {
    console.log();
    console.log(
      M(`  [HARD] cap triggered ${hardMatches.length}x — matches where 25m wait override fired:`)
    );
    for (const m of hardMatches) {
      console.log(
        M(
          `    M${m.num}: T+${Math.round(m.startTime)}m — ${m.teamA.join("+")} vs ${m.teamB.join("+")}`
        )
      );
    }
  }

  console.log(
    D(`\n  ─────────────────────────────────────────────────────────────────────────────\n`)
  );
}

// ─── Scenario Definitions ────────────────────────────────────────────────────

const BASE_CONFIG = {
  penalty: 8,
  critWait: 20,
  hardCap: 25,
  skillVarianceMax: 2,
  skillFallbackMax: 4,
  maxPartnerRepeats: 2,
  maxOpponentRepeats: 3,
};

// ── Scenario A: 31 players / 3 courts / 240 min (Saturday 06/06 real roster) ─

const ROSTER_31P: SimPlayer[] = [
  { name: "Michael Yan", skill: 3, arrivedAt: 0 },
  { name: "Gelo", skill: 2, arrivedAt: 0 },
  { name: "Jeff", skill: 2, arrivedAt: 0 },
  { name: "Chu", skill: 5, arrivedAt: 6 },
  { name: "Barts", skill: 4, arrivedAt: 11 },
  { name: "Veejay", skill: 3, arrivedAt: 11 },
  { name: "Stelle", skill: 3, arrivedAt: 11 },
  { name: "Dexter", skill: 3, arrivedAt: 13 },
  { name: "Carlo", skill: 3, arrivedAt: 13 },
  { name: "Eduard", skill: 1, arrivedAt: 23 },
  { name: "Miguel T", skill: 0, arrivedAt: 23 },
  { name: "Madrid", skill: 3, arrivedAt: 23 },
  { name: "JCG", skill: 1, arrivedAt: 26 },
  { name: "Jackie B", skill: 2, arrivedAt: 26 },
  { name: "Rae", skill: 1, arrivedAt: 26 },
  { name: "Enid", skill: 2, arrivedAt: 38 },
  { name: "Bri", skill: 3, arrivedAt: 38 },
  { name: "Don Gao", skill: 5, arrivedAt: 38 },
  { name: "Marc", skill: 1, arrivedAt: 38 },
  { name: "Hannah", skill: 1, arrivedAt: 40 },
  { name: "Gessa", skill: 0, arrivedAt: 40 },
  { name: "Jason", skill: 1, arrivedAt: 40 },
  { name: "KARLO", skill: 1, arrivedAt: 40 },
  { name: "Miggy", skill: 4, arrivedAt: 45 },
  { name: "Paul", skill: 5, arrivedAt: 45 },
  { name: "Alvin DG", skill: 3, arrivedAt: 45 },
  { name: "Marcus", skill: 4, arrivedAt: 45 },
  // Late joiners (T+97m)
  { name: "Lei", skill: 0, arrivedAt: 97 },
  { name: "Clark", skill: 0, arrivedAt: 97 },
  { name: "Aim", skill: 1, arrivedAt: 97 },
  { name: "Kate C", skill: 1, arrivedAt: 97 },
];

const SCENARIO_A = {
  name: "31p / 3 courts / 240 min  (Saturday 06/06 real roster)",
  players: ROSTER_31P,
  config: {
    ...BASE_CONFIG,
    sessionDuration: 240,
    courts: [18, 20, 22],
    targetGames: Math.round((((3 * 240) / 20) * 4) / 31), // = 5
  },
};

// ── Scenario B: 18 players / 2 courts / 240 min ───────────────────────────────
// Representative skill spread, no late joiners (clean baseline for small sessions)

const ROSTER_18P: SimPlayer[] = [
  { name: "Gelo", skill: 2, arrivedAt: 0 },
  { name: "Jeff", skill: 2, arrivedAt: 0 },
  { name: "Chu", skill: 5, arrivedAt: 5 },
  { name: "Barts", skill: 4, arrivedAt: 10 },
  { name: "Veejay", skill: 3, arrivedAt: 10 },
  { name: "Stelle", skill: 3, arrivedAt: 10 },
  { name: "Dexter", skill: 3, arrivedAt: 15 },
  { name: "Carlo", skill: 3, arrivedAt: 15 },
  { name: "Eduard", skill: 1, arrivedAt: 20 },
  { name: "Miguel T", skill: 0, arrivedAt: 20 },
  { name: "JCG", skill: 1, arrivedAt: 25 },
  { name: "Jackie B", skill: 2, arrivedAt: 25 },
  { name: "Rae", skill: 1, arrivedAt: 25 },
  { name: "Enid", skill: 2, arrivedAt: 30 },
  { name: "Don Gao", skill: 5, arrivedAt: 30 },
  { name: "Marc", skill: 1, arrivedAt: 30 },
  { name: "Miggy", skill: 4, arrivedAt: 35 },
  { name: "Paul", skill: 5, arrivedAt: 35 },
];

const SCENARIO_B = {
  name: "18p / 2 courts / 240 min",
  players: ROSTER_18P,
  config: {
    ...BASE_CONFIG,
    sessionDuration: 240,
    courts: [20, 22],
    targetGames: Math.round((((2 * 240) / 21) * 4) / 18), // ≈ 5
  },
};

// ── Scenario C: 50 players / 5 courts / 240 min ───────────────────────────────
// 31-player Saturday roster + 19 synthetic players; some late joiners (~20%)

const ROSTER_50P: SimPlayer[] = [
  // Saturday roster
  ...ROSTER_31P,
  // Synthetic additions — realistic skill distribution
  // Beginner
  { name: "Alex B", skill: 0, arrivedAt: 5 },
  { name: "Blake B", skill: 0, arrivedAt: 15 },
  { name: "Casey B", skill: 0, arrivedAt: 60 }, // late-ish
  // Lower Intermediate
  { name: "Dana LI", skill: 1, arrivedAt: 0 },
  { name: "Eve LI", skill: 1, arrivedAt: 10 },
  { name: "Frank LI", skill: 1, arrivedAt: 20 },
  { name: "Grace LI", skill: 1, arrivedAt: 30 },
  { name: "Henry LI", skill: 1, arrivedAt: 50 },
  // Intermediate
  { name: "Ian I", skill: 2, arrivedAt: 0 },
  { name: "Julia I", skill: 2, arrivedAt: 10 },
  { name: "Kevin I", skill: 2, arrivedAt: 30 },
  { name: "Lisa I", skill: 2, arrivedAt: 90 }, // late joiner
  // Upper Intermediate
  { name: "Mike UI", skill: 3, arrivedAt: 0 },
  { name: "Nancy UI", skill: 3, arrivedAt: 15 },
  { name: "Oscar UI", skill: 3, arrivedAt: 35 },
  { name: "Pat UI", skill: 3, arrivedAt: 90 }, // late joiner
  // Lower Advanced
  { name: "Quinn LA", skill: 4, arrivedAt: 10 },
  // Advanced
  { name: "Rachel A", skill: 5, arrivedAt: 0 },
  { name: "Sam A", skill: 5, arrivedAt: 20 },
];

const SCENARIO_C = {
  name: "50p / 5 courts / 240 min",
  players: ROSTER_50P,
  config: {
    ...BASE_CONFIG,
    sessionDuration: 240,
    courts: [18, 20, 22, 20, 22],
    targetGames: Math.round((((5 * 240) / 20) * 4) / 50), // = 5
  },
};

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log(W("\n\n ╔══════════════════════════════════════════════════════════════════════╗"));
console.log(W(" ║   MULTI-SCENARIO SIMULATION — Fairness & Wait Time Analysis         ║"));
console.log(W(" ║   HARD_WAIT_CAP=25m · CRITICAL_WAIT=20m · GAME_PENALTY=8m           ║"));
console.log(W(" ╚══════════════════════════════════════════════════════════════════════╝"));

for (const scenario of [SCENARIO_A, SCENARIO_B, SCENARIO_C]) {
  const result = simulate(scenario);
  report(scenario, result);
}

console.log(G("\n✓ All scenarios complete.\n"));
