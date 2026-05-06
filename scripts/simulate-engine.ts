#!/usr/bin/env -S npx tsx
/**
 * simulate-engine.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Full multi-round simulation of the matchmaking engine.
 * Uses REAL functions from src/lib/matchmaking-core.ts so every decision
 * (priority scoring, skill filtering, combination search, team split,
 * diversity enforcement, soft gate) is executed by production code.
 *
 * Usage:  npx tsx scripts/simulate-engine.ts [rounds=6]
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import {
  computePriorityScore,
  scoreCandidates,
  buildCombinationGroup,
  snakeDraft,
  rotatedDraft,
  getEffectiveLookback,
  isDiversityViolation,
  type ScoredPlayer,
} from "../src/lib/matchmaking-core";
import {
  SKILL_VARIANCE_TARGET,
  SKILL_VARIANCE_MAX,
  FALLBACK_WAIT_MINUTES,
  ANTI_REPEAT_LOOKBACK,
  ON_DECK_LOOKAHEAD,
  GATE_POOL_THRESHOLD,
  GATE_HOLD_MINUTES,
} from "../src/lib/constants";

// ─── terminal colours ────────────────────────────────────────────────────────
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;   // red
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;   // green
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;   // yellow
const B = (s: string) => `\x1b[34m${s}\x1b[0m`;   // blue
const M = (s: string) => `\x1b[35m${s}\x1b[0m`;   // magenta
const C = (s: string) => `\x1b[36m${s}\x1b[0m`;   // cyan
const W = (s: string) => `\x1b[1m${s}\x1b[0m`;    // bold/white
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;    // dim

const COURT_COUNT = 2;
const CAPACITY    = COURT_COUNT + ON_DECK_LOOKAHEAD; // 3
const SIM_ROUNDS  = parseInt(process.argv[2] ?? "6");
const SESSION_ID  = "70358ca6-176a-46db-ba60-b3dcbb1ac6c5";
// Simulated game duration in minutes
const GAME_MINUTES = 22;

// ─── sim-local player record ─────────────────────────────────────────────────
interface SimPlayer {
  player_id:      string;
  display_name:   string;
  skill_level:    string;
  skill_level_int: number;
  games_played:   number;
  is_paused:      boolean;
  joined_at:      string;   // ISO string — updated as simulation advances
  wait_minutes:   number;   // computed fresh each round
  priorityScore:  number;   // computed fresh each round
  session_id:     string;
  status:         string;
}

interface SimMatch {
  id:      string;
  teamA:   SimPlayer[];
  teamB:   SimPlayer[];
  isMixed: boolean;
}

// ─── helpers ─────────────────────────────────────────────────────────────────
let simNow = Date.now(); // millisecond clock we advance each round

function advanceClock(minutes: number) {
  simNow += minutes * 60_000;
}

function computeWait(joinedAt: string): number {
  return (simNow - new Date(joinedAt).getTime()) / 60_000;
}

function refreshScores(pool: SimPlayer[]): SimPlayer[] {
  return pool.map((p) => {
    const wait = computeWait(p.joined_at);
    // computePriorityScore only reads wait_minutes + games_played — the extra
    // QueueEntry fields (id, position, created_at) are unused by the function.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { ...p, wait_minutes: wait, priorityScore: computePriorityScore({ ...p, wait_minutes: wait } as any) };
  });
}

function sortByPriority(pool: SimPlayer[]): SimPlayer[] {
  return [...pool].sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
    return new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime();
  });
}

function skillLabel(s: SimPlayer): string {
  const map: Record<number, string> = { 1: "BEG", 2: "L-INT", 3: "INT", 4: "U-INT", 5: "L-ADV", 6: "ADV" };
  return map[s.skill_level_int] ?? "?";
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function scoreZone(score: number): string {
  if (score >= 1000) return R(`🔴 ${score.toFixed(1)}`);
  if (score >= 15)   return Y(`🟡 ${score.toFixed(1)}`);
  return G(`🟢 ${score.toFixed(1)}`);
}

function randomScore(): [number, number] {
  const winner = 21;
  const loser  = Math.floor(Math.random() * 16) + 5; // 5–20
  return Math.random() > 0.5 ? [winner, loser] : [loser, winner];
}

function separator(char = "─", len = 78): string {
  return D(char.repeat(len));
}

// ─── core engine logic (mirrors runAlgorithm in matchmaking.ts) ──────────────
function runEngine(
  waiting:       SimPlayer[],
  recentRosters: string[][],
  activeCourts:  number,
  log:           boolean = true
): SimMatch[] {
  const scoredAll = sortByPriority(refreshScores(waiting));
  const results: SimMatch[] = [];

  // ── Soft gate ──
  const maxWait     = Math.max(...scoredAll.map((p) => p.wait_minutes), 0);
  const gateTimedOut = maxWait >= GATE_HOLD_MINUTES;
  if (waiting.length <= GATE_POOL_THRESHOLD && activeCourts > 0 && !gateTimedOut) {
    if (log) console.log(Y(`  ⏸  SOFT GATE: pool=${waiting.length} ≤ ${GATE_POOL_THRESHOLD} & activeCourts=${activeCourts} → holding for more players to return`));
    return [];
  }

  let pool = [...scoredAll];

  for (let slot = 0; slot < CAPACITY; slot++) {
    if (pool.length < 4) {
      if (log) console.log(D(`  [slot ${slot + 1}] not enough players (${pool.length}) — stopping`));
      break;
    }

    const anchor = pool[0];
    const isFallback = anchor.wait_minutes >= FALLBACK_WAIT_MINUTES;
    const maxVariance = isFallback ? SKILL_VARIANCE_MAX : SKILL_VARIANCE_TARGET;

    if (log) {
      const zone = anchor.priorityScore >= 1000 ? R("RED ZONE") : anchor.wait_minutes >= FALLBACK_WAIT_MINUTES ? Y("FALLBACK") : G("NORMAL");
      console.log(`\n  ${W(`Slot ${slot + 1}`)} — Anchor: ${C(pad(anchor.display_name, 14))} skill=${W(skillLabel(anchor))} wait=${anchor.wait_minutes.toFixed(1)}m score=${scoreZone(anchor.priorityScore)} [${zone}] variance=±${maxVariance}`);
    }

    // Eligible candidates
    const candidates = pool
      .slice(1)
      .filter((p) => !p.is_paused && Math.abs(p.skill_level_int - anchor.skill_level_int) <= maxVariance);

    const eligiblePoolSize = candidates.length + 1;
    const effectiveLookback = getEffectiveLookback(eligiblePoolSize);
    const slicedRosters = recentRosters.slice(-effectiveLookback);

    if (log) {
      console.log(`     Candidates: [${candidates.map((p) => `${p.display_name}(${skillLabel(p)})`).join(", ")}]`);
      console.log(`     Pool size=${eligiblePoolSize}, lookback=${effectiveLookback}, recentRosters=${slicedRosters.length}`);
    }

    if (candidates.length < 3) {
      if (log) console.log(Y(`     ⚠ not enough eligible candidates (${candidates.length}) — skipping slot`));
      break;
    }

    // Overlap map
    const overlapMap = new Map<string, number>();
    for (const c of candidates) {
      const count = slicedRosters.reduce((acc, roster) => {
        const anchorIn = roster.includes(anchor.player_id);
        const candIn   = roster.includes(c.player_id);
        return acc + (anchorIn && candIn ? 1 : 0);
      }, 0);
      overlapMap.set(c.player_id, count);
    }

    const scored = scoreCandidates(candidates as ScoredPlayer[], overlapMap);
    const group  = buildCombinationGroup(anchor as ScoredPlayer, scored, maxVariance);

    if (group.length === 0) {
      if (log) console.log(R(`     ✗ buildCombinationGroup returned empty — no valid triple found`));
      break;
    }

    const four = [anchor, ...group] as SimPlayer[];

    // Diversity check
    const ids = four.map((p) => p.player_id);
    if (isDiversityViolation(ids, slicedRosters)) {
      if (log) console.log(Y(`     ⚠ diversity violation — 3+ players met recently. Attempting forced rotation…`));
      // Simulation does not enforce the partner cap — null is unreachable here.
      const rotated = rotatedDraft(four as ScoredPlayer[], slicedRosters);
      if (!rotated) continue;
      const { teamA, teamB } = rotated;
      const match: SimMatch = {
        id: crypto.randomUUID(),
        teamA: teamA as SimPlayer[],
        teamB: teamB as SimPlayer[],
        isMixed: maxVariance > SKILL_VARIANCE_TARGET,
      };
      results.push(match);
      if (log) printMatch(match, slot + 1, "FORCED ROTATION");
      pool = pool.filter((p) => !ids.includes(p.player_id));
      recentRosters.push(ids);
      if (recentRosters.length > ANTI_REPEAT_LOOKBACK) recentRosters.shift();
      continue;
    }

    // Simulation does not enforce the partner cap — null is unreachable here.
    const draft = snakeDraft(four as ScoredPlayer[]);
    if (!draft) continue;
    const { teamA, teamB } = draft;
    const match: SimMatch = {
      id: crypto.randomUUID(),
      teamA: teamA as SimPlayer[],
      teamB: teamB as SimPlayer[],
      isMixed: maxVariance > SKILL_VARIANCE_TARGET,
    };
    results.push(match);
    if (log) printMatch(match, slot + 1);
    pool = pool.filter((p) => !ids.includes(p.player_id));
    recentRosters.push(ids);
    if (recentRosters.length > ANTI_REPEAT_LOOKBACK) recentRosters.shift();
  }

  return results;
}

function printMatch(match: SimMatch, slot: number, tag = "") {
  const ta = match.teamA.map((p) => `${G(p.display_name)}(${skillLabel(p)})`).join(" + ");
  const tb = match.teamB.map((p) => `${B(p.display_name)}(${skillLabel(p)})`).join(" + ");
  const mixed = match.isMixed ? M(" [MIXED]") : "";
  const label = tag ? ` ${R(`[${tag}]`)}` : "";
  console.log(`     ${W("→ Match")} ${ta} ${D("vs")} ${tb}${mixed}${label}`);
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // 1. Reset sim session to clean state ──────────────────────────────────────
  console.log(W("\n╔══════════════════════════════════════════════════════════════════════════════╗"));
  console.log(W("║        MATCHMAKING ENGINE SIMULATION  —  16 Players / 2 Courts             ║"));
  console.log(W("╚══════════════════════════════════════════════════════════════════════════════╝\n"));
  console.log(D("Resetting sim session…"));

  await supabase.from("match_players").delete().in(
    "match_id",
    (await supabase.from("matches").select("id").eq("session_id", SESSION_ID).then((r) => (r.data ?? []).map((m) => m.id)))
  );
  await supabase.from("matches").delete().eq("session_id", SESSION_ID);
  await supabase
    .from("queue_entries")
    .update({ status: "waiting", games_played: 0 })
    .eq("session_id", SESSION_ID);

  // Reset joined_at spread across last 30 min so wait times are realistic
  const { data: entries } = await supabase
    .from("queue_entries")
    .select("id")
    .eq("session_id", SESSION_ID)
    .order("id");
  if (entries) {
    for (let i = 0; i < entries.length; i++) {
      await supabase
        .from("queue_entries")
        .update({ joined_at: new Date(simNow - (16 - i) * 2 * 60_000).toISOString() })
        .eq("id", entries[i].id);
    }
  }

  // 2. Load players ──────────────────────────────────────────────────────────
  const { data: rawPlayers, error } = await supabase
    .from("v_queue_with_wait_time")
    .select("*")
    .eq("session_id", SESSION_ID);

  if (error || !rawPlayers) {
    console.error(R("Failed to load players: " + error?.message));
    process.exit(1);
  }

  // Build in-memory player pool
  let waitingPool: SimPlayer[] = rawPlayers.map((p: Record<string, unknown>) => ({
    player_id:       p.player_id as string,
    display_name:    p.display_name as string,
    skill_level:     p.skill_level as string,
    skill_level_int: p.skill_level_int as number,
    games_played:    0,
    is_paused:       false,
    joined_at:       p.joined_at as string,
    wait_minutes:    p.wait_minutes as number,
    priorityScore:   0,
    session_id:      SESSION_ID,
    status:          "waiting",
  }));

  console.log(G(`✓ Loaded ${waitingPool.length} players from session ${SESSION_ID}\n`));

  // Print initial roster
  console.log(W("Initial Queue:"));
  console.log(separator());
  const fresh = sortByPriority(refreshScores(waitingPool));
  console.log(`  ${"#".padEnd(3)} ${pad("Name", 22)} ${pad("Skill", 8)} ${"Wait".padStart(6)}  Score`);
  console.log(separator("·"));
  fresh.forEach((p, i) => {
    console.log(`  ${String(i + 1).padEnd(3)} ${pad(p.display_name, 22)} ${pad(skillLabel(p), 8)} ${p.wait_minutes.toFixed(1).padStart(6)}m  ${scoreZone(p.priorityScore)}`);
  });
  console.log(separator());

  // 3. Simulation loop ───────────────────────────────────────────────────────
  const recentRosters: string[][] = [];
  const sessionStats: Record<string, { wins: number; losses: number; games: number }> = {};
  for (const p of waitingPool) sessionStats[p.player_id] = { wins: 0, losses: 0, games: 0 };

  for (let round = 1; round <= SIM_ROUNDS; round++) {
    console.log(`\n${W(`━━━━━━━━━━━━━━━━━━━━━━━  ROUND ${round}  ━━━━━━━━━━━━━━━━━━━━━━━`)}`);
    console.log(D(`  Waiting: ${waitingPool.length} players | Simulated time: ${Math.round((simNow - Date.now()) / 60_000 + 0)} min offset`));

    waitingPool = refreshScores(waitingPool);

    const matches = runEngine(waitingPool, recentRosters, 0 /* no active courts at start of each round */);

    if (matches.length === 0) {
      console.log(Y("  Engine returned no matches — pool exhausted or gate held."));
      break;
    }

    // ── Print round header ──
    console.log(`\n  ${W("Generated")} ${matches.length} on-deck match(es) (capacity=${CAPACITY}, courts=${COURT_COUNT}):`);
    console.log(separator("·", 60));

    // ── Play matches & collect scores ──────────────────────────────────────
    const playedThisRound = new Set<string>();

    for (let mi = 0; mi < matches.length; mi++) {
      const m = matches[mi];
      const [scoreA, scoreB] = randomScore();
      const aWins = scoreA > scoreB;

      const courtLabel = mi < COURT_COUNT ? `Court ${mi + 1}` : "On-deck lookahead";
      console.log(`\n  ${W(`[${courtLabel}]`)} ${aWins ? G("Team A wins") : B("Team B wins")} ${W(`${scoreA}–${scoreB}`)}`);
      console.log(`    Team A: ${m.teamA.map((p) => G(p.display_name)).join(", ")}`);
      console.log(`    Team B: ${m.teamB.map((p) => B(p.display_name)).join(", ")}`);

      for (const p of m.teamA) {
        sessionStats[p.player_id].games++;
        if (aWins) sessionStats[p.player_id].wins++;
        else       sessionStats[p.player_id].losses++;
        playedThisRound.add(p.player_id);
      }
      for (const p of m.teamB) {
        sessionStats[p.player_id].games++;
        if (!aWins) sessionStats[p.player_id].wins++;
        else        sessionStats[p.player_id].losses++;
        playedThisRound.add(p.player_id);
      }
    }

    // ── Advance simulated clock ─────────────────────────────────────────────
    advanceClock(GAME_MINUTES);

    // ── Return players to waiting pool ─────────────────────────────────────
    const allPlayed = matches.flatMap((m) => [...m.teamA, ...m.teamB]);
    const playedIds = new Set(allPlayed.map((p) => p.player_id));

    // Players who played: return with games_played++ and fresh joined_at
    for (const p of waitingPool) {
      if (playedIds.has(p.player_id)) {
        p.games_played++;
        p.joined_at = new Date(simNow).toISOString();
      }
    }

    // Players who stayed waiting: they've been waiting the whole time — just refresh scores
    waitingPool = refreshScores(waitingPool);

    // Print updated queue state
    const sorted = sortByPriority(waitingPool);
    console.log(`\n  ${W("Queue after round")} ${round}:`);
    console.log(`  ${"Name".padEnd(20)} ${"Skill".padEnd(8)} ${"GP".padEnd(4)} ${"Wait".padStart(6)}  Score`);
    console.log(separator("·", 60));
    for (const p of sorted) {
      const played = playedIds.has(p.player_id) ? G(" ✓") : D(" —");
      console.log(`  ${pad(p.display_name, 20)} ${pad(skillLabel(p), 8)} ${String(p.games_played).padEnd(4)} ${p.wait_minutes.toFixed(1).padStart(6)}m  ${scoreZone(p.priorityScore)}${played}`);
    }
  }

  // 4. Final session summary ─────────────────────────────────────────────────
  console.log(`\n\n${W("━━━━━━━━━━━━━━━━━━━━━━━  FINAL SESSION SUMMARY  ━━━━━━━━━━━━━━━━━━━━━━━")}`);
  console.log(separator());

  const standings = Object.entries(sessionStats)
    .map(([id, s]) => {
      const p = waitingPool.find((pl) => pl.player_id === id)!;
      return { name: p?.display_name ?? id, skill: skillLabel(p), ...s, winPct: s.games > 0 ? (s.wins / s.games) * 100 : 0 };
    })
    .sort((a, b) => b.wins - a.wins || b.winPct - a.winPct);

  console.log(`  ${"#".padEnd(3)} ${"Player".padEnd(22)} ${"Skill".padEnd(8)} ${"GP".padEnd(4)} ${"W".padEnd(4)} ${"L".padEnd(4)} ${"Win%"}`);
  console.log(separator("·"));
  standings.forEach((s, i) => {
    const pct = s.winPct.toFixed(0).padStart(5) + "%";
    const wPct = s.winPct >= 60 ? G(pct) : s.winPct >= 40 ? Y(pct) : R(pct);
    console.log(`  ${String(i + 1).padEnd(3)} ${pad(s.name, 22)} ${pad(s.skill, 8)} ${String(s.games).padEnd(4)} ${String(s.wins).padEnd(4)} ${String(s.losses).padEnd(4)} ${wPct}`);
  });

  console.log(separator());
  console.log(G("\n✓ Simulation complete.\n"));
}

main().catch((e) => { console.error(R(String(e))); process.exit(1); });
