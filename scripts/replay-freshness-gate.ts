#!/usr/bin/env -S npx tsx
/**
 * Pre-deploy freshness gate — plan §4 (G-1…G-11, G-P1).
 *
 * Replays baseline (feature OFF) vs candidate (feature ON, slack 10) in
 * draft-queue mode, K jittered runs per fixture, plus 50 seeded synthetics.
 * The avoidable-near-identical count comes from scripts/replay/freshness-brute.ts,
 * which does not call findFresherFour.
 *
 *   npx tsx scripts/replay-freshness-gate.ts
 *   npx tsx scripts/replay-freshness-gate.ts --quick
 *   npx tsx scripts/replay-freshness-gate.ts --synthetic 50 --jitter 5
 */

import { DEFAULT_SESSION_IDS, loadFixture, CACHE_DIR } from "./replay/fetch";
import { replaySession } from "./replay/simulate";
import { computeMetrics } from "./replay/metrics";
import { syntheticFixture } from "./replay/synthetic";
import { FRESHNESS_WAIT_SLACK_MINUTES } from "../src/lib/constants";
import type { ReplayDiagnostics, ReplayResult, SessionFixture } from "./replay/types";

const OCT3_ID = "1b7f5a32-1846-4880-9ca0-3144c6385086";
let SLACK = FRESHNESS_WAIT_SLACK_MINUTES;

const W = (s: string) => `\x1b[1m${s}\x1b[0m`;
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;

type Args = {
  quick: boolean;
  synthetic: number;
  jitter: number;
  sessions: string[];
};

function parseArgs(argv: string[]): Args {
  const args: Args = { quick: false, synthetic: 50, jitter: 5, sessions: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--quick") {
      args.quick = true;
      args.synthetic = 8;
      args.jitter = 2;
    } else if (a === "--synthetic") args.synthetic = Number(argv[++i] ?? 50);
    else if (a === "--jitter") args.jitter = Number(argv[++i] ?? 5);
    else if (a === "--slack") SLACK = Number(argv[++i] ?? FRESHNESS_WAIT_SLACK_MINUTES);
    else if (a === "--session") {
      const id = argv[++i];
      if (id) args.sessions.push(id);
    } else if (a === "--help" || a === "-h") {
      console.log(
        [
          "Usage: npx tsx scripts/replay-freshness-gate.ts [options]",
          "  --quick              8 synthetics, K=2 (dev only — not the ship gate)",
          "  --synthetic <n>      synthetic session count (default 50)",
          "  --jitter <k>         duration-jitter runs per fixture (default 5)",
          "  --slack <n>          wait slack minutes (default FRESHNESS_WAIT_SLACK_MINUTES)",
          "  --session <uuid>     include a cached/real fixture (repeatable)",
        ].join("\n")
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

type GateRow = {
  id: string;
  name: string;
  kind: "real" | "synthetic";
  matches: number;
  consecutiveNearIdentical: number;
  consecutivePairs: number;
  avoidableNearIdentical: number;
  stallEpisodes: number;
  waitP90: number;
  waitMax: number;
  redZoneEntries: number;
  hardCapEntries: number;
  gamesSpread: number;
  mixedLevelRate: number;
  skillSpread2Rate: number;
  meanTeamSkillGap: number;
  consecutiveOpponentRate: number;
  partnerCapBreaches: number;
  consecutivePartnerRepeats: number;
  wrapperP99: number;
  backToBackServed: number;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function waitP90(waits: number[]): number {
  return percentile(
    [...waits].sort((a, b) => a - b),
    90
  );
}

function rowFrom(result: ReplayResult, kind: "real" | "synthetic"): GateRow {
  const m = computeMetrics(result.matches, result.fixture.players.length);
  const d: ReplayDiagnostics = result.diagnostics;
  const matchCount = Math.max(1, result.matches.length);
  return {
    id: result.fixture.sessionId,
    name: result.fixture.name,
    kind,
    matches: result.matches.length,
    consecutiveNearIdentical: m.consecutiveNearIdentical,
    consecutivePairs: m.consecutivePairs,
    avoidableNearIdentical: d.avoidableNearIdentical,
    stallEpisodes: d.stallEpisodes,
    waitP90: waitP90(d.draftWaits),
    waitMax: d.draftWaits.length > 0 ? Math.max(...d.draftWaits) : 0,
    redZoneEntries: d.redZoneEntries,
    hardCapEntries: d.hardCapEntries,
    gamesSpread: m.gamesMax - m.gamesMin,
    mixedLevelRate: result.matches.length > 0 ? d.mixedLevelMatches / matchCount : 0,
    skillSpread2Rate: result.matches.length > 0 ? d.skillSpread2Matches / matchCount : 0,
    meanTeamSkillGap:
      d.teamSkillGaps.length > 0
        ? d.teamSkillGaps.reduce((s, n) => s + n, 0) / d.teamSkillGaps.length
        : 0,
    consecutiveOpponentRate: m.consecutiveOpponentRate,
    partnerCapBreaches: m.partnershipsOverCap,
    consecutivePartnerRepeats: m.consecutivePartnerRepeats,
    wrapperP99: percentile(
      [...d.wrapperMs].sort((a, b) => a - b),
      99
    ),
    backToBackServed: d.backToBackServed,
  };
}

function meanRows(rows: GateRow[]): GateRow {
  const n = rows.length;
  const pick = (f: (r: GateRow) => number) => rows.reduce((s, r) => s + f(r), 0) / n;
  return {
    ...rows[0],
    matches: pick((r) => r.matches),
    consecutiveNearIdentical: pick((r) => r.consecutiveNearIdentical),
    consecutivePairs: pick((r) => r.consecutivePairs),
    avoidableNearIdentical: pick((r) => r.avoidableNearIdentical),
    stallEpisodes: pick((r) => r.stallEpisodes),
    waitP90: pick((r) => r.waitP90),
    waitMax: pick((r) => r.waitMax),
    redZoneEntries: pick((r) => r.redZoneEntries),
    hardCapEntries: pick((r) => r.hardCapEntries),
    gamesSpread: pick((r) => r.gamesSpread),
    mixedLevelRate: pick((r) => r.mixedLevelRate),
    skillSpread2Rate: pick((r) => r.skillSpread2Rate),
    meanTeamSkillGap: pick((r) => r.meanTeamSkillGap),
    consecutiveOpponentRate: pick((r) => r.consecutiveOpponentRate),
    partnerCapBreaches: pick((r) => r.partnerCapBreaches),
    consecutivePartnerRepeats: pick((r) => r.consecutivePartnerRepeats),
    wrapperP99: pick((r) => r.wrapperP99),
    backToBackServed: pick((r) => r.backToBackServed),
  };
}

function replayOnce(
  fixture: SessionFixture,
  freshness: boolean,
  jitterSeed: number,
  jitterPct: number
): ReplayResult {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return replaySession(fixture, {
      freshness,
      draftQueue: true,
      waitSlackMinutes: SLACK,
      durationJitter: jitterPct > 0 ? { seed: jitterSeed, pct: jitterPct } : undefined,
    });
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

function meanFixture(
  fixture: SessionFixture,
  kind: "real" | "synthetic",
  freshness: boolean,
  k: number
): GateRow {
  const rows: GateRow[] = [];
  for (let i = 0; i < k; i++) {
    const seed = 9_331 + i * 97 + fixture.sessionId.length * 13;
    rows.push(rowFrom(replayOnce(fixture, freshness, seed, 0.1), kind));
  }
  return meanRows(rows);
}

function sum(rows: GateRow[], f: (r: GateRow) => number): number {
  return rows.reduce((s, r) => s + f(r), 0);
}

type Verdict = { id: string; ok: boolean; detail: string };

function evaluate(
  baseline: GateRow[],
  candidate: GateRow[],
  oct3Base: GateRow | null,
  oct3Cand: GateRow | null
): Verdict[] {
  const bNear = sum(baseline, (r) => r.consecutiveNearIdentical);
  const cNear = sum(candidate, (r) => r.consecutiveNearIdentical);
  const bAvoid = sum(baseline, (r) => r.avoidableNearIdentical);
  const cAvoid = sum(candidate, (r) => r.avoidableNearIdentical);
  const realB = baseline.filter((r) => r.kind === "real");
  const realC = candidate.filter((r) => r.kind === "real");
  const synB = baseline.filter((r) => r.kind === "synthetic");
  const synC = candidate.filter((r) => r.kind === "synthetic");

  const stallRealB = sum(realB, (r) => r.stallEpisodes);
  const stallRealC = sum(realC, (r) => r.stallEpisodes);
  const stallSynB = sum(synB, (r) => r.stallEpisodes);
  const stallSynC = sum(synC, (r) => r.stallEpisodes);

  const waitP90B = sum(baseline, (r) => r.waitP90) / baseline.length;
  const waitP90C = sum(candidate, (r) => r.waitP90) / candidate.length;

  const rzB = sum(baseline, (r) => r.redZoneEntries);
  const rzC = sum(candidate, (r) => r.redZoneEntries);
  const hcB = sum(baseline, (r) => r.hardCapEntries);
  const hcC = sum(candidate, (r) => r.hardCapEntries);

  const spreadB = sum(baseline, (r) => r.gamesSpread) / baseline.length;
  const spreadC = sum(candidate, (r) => r.gamesSpread) / candidate.length;

  const mixedB = sum(baseline, (r) => r.mixedLevelRate) / baseline.length;
  const mixedC = sum(candidate, (r) => r.mixedLevelRate) / candidate.length;
  const spr2B = sum(baseline, (r) => r.skillSpread2Rate) / baseline.length;
  const spr2C = sum(candidate, (r) => r.skillSpread2Rate) / candidate.length;
  const gapB = sum(baseline, (r) => r.meanTeamSkillGap) / baseline.length;
  const gapC = sum(candidate, (r) => r.meanTeamSkillGap) / candidate.length;

  const oppB = sum(baseline, (r) => r.consecutiveOpponentRate) / baseline.length;
  const oppC = sum(candidate, (r) => r.consecutiveOpponentRate) / candidate.length;
  const partnerB = sum(baseline, (r) => r.consecutivePartnerRepeats);
  const partnerC = sum(candidate, (r) => r.consecutivePartnerRepeats);
  const capB = sum(baseline, (r) => r.partnerCapBreaches);
  const capC = sum(candidate, (r) => r.partnerCapBreaches);

  // Ship bar (D1, accepted on deploy): kill every *avoidable* repeat (G-1).
  // The first draft's 50% / +2 min / cap=0 cuts failed because only ~26% of
  // near-identicals have a legal alternative, the refresh is ±2, and today's
  // engine already records partner-cap leftovers.
  const fixtureWaitOk = candidate.every((c, i) => c.waitP90 <= baseline[i].waitP90 + 3.5);
  const fixtureMaxWaitOk = candidate.every((c, i) => c.waitMax <= baseline[i].waitMax + 3.0);
  const wrapperP99 = Math.max(...candidate.map((r) => r.wrapperP99), 0);

  const v: Verdict[] = [];

  const g1agg = bAvoid === 0 ? cAvoid === 0 : cAvoid <= 0.1 * bAvoid;
  const g1oct = !oct3Base || !oct3Cand || oct3Cand.avoidableNearIdentical === 0;
  v.push({
    id: "G-1",
    ok: g1agg && g1oct,
    detail: `avoidable ${cAvoid.toFixed(2)} vs baseline ${bAvoid.toFixed(2)} (need ≤10%)${
      oct3Cand
        ? `; Oct 3 mean ${oct3Cand.avoidableNearIdentical.toFixed(2)} (need 0)`
        : "; Oct 3 fixture absent"
    }`,
  });

  const g2agg = bNear === 0 ? cNear === 0 : cNear <= bNear;
  const g2oct =
    !oct3Base || !oct3Cand || oct3Cand.consecutiveNearIdentical < oct3Base.consecutiveNearIdentical;
  v.push({
    id: "G-2",
    ok: g2agg && g2oct,
    detail: `near-identical ${cNear.toFixed(2)} vs ${bNear.toFixed(2)} (need ≤ baseline)${
      oct3Base && oct3Cand
        ? `; Oct 3 ${oct3Cand.consecutiveNearIdentical.toFixed(2)} < ${oct3Base.consecutiveNearIdentical.toFixed(2)}`
        : "; Oct 3 fixture absent"
    }`,
  });

  const stallSynOk = stallSynB === 0 ? stallSynC <= 0.02 : stallSynC <= stallSynB * 1.02;
  const stallRealOk = realB.length === 0 || stallRealC <= stallRealB * 1.1;
  v.push({
    id: "G-3",
    ok: stallRealOk && stallSynOk,
    detail: `stalls real ${stallRealC.toFixed(2)}/${stallRealB.toFixed(2)} (≤+10%) · synth ${stallSynC.toFixed(2)}/${stallSynB.toFixed(2)}`,
  });

  v.push({
    id: "G-4",
    ok: waitP90C <= waitP90B + 1.0 && fixtureWaitOk,
    detail: `wait p90 ${waitP90C.toFixed(2)} vs ${waitP90B.toFixed(2)} (need ≤ +1.0; no fixture +3.5)`,
  });

  const maxWaitDelta = Math.max(...candidate.map((c, i) => c.waitMax - baseline[i].waitMax), 0);
  v.push({
    id: "G-5",
    ok: fixtureMaxWaitOk,
    detail: `worst fixture max-wait delta +${maxWaitDelta.toFixed(2)} min (need ≤ +3.0)`,
  });

  v.push({
    id: "G-6",
    ok: rzC <= rzB * 1.05 + 1e-9 && hcC <= hcB + 1e-9,
    detail: `red-zone ${rzC.toFixed(1)}/${rzB.toFixed(1)} (≤+5%) · hard-cap ${hcC.toFixed(1)}/${hcB.toFixed(1)} (≤)`,
  });

  v.push({
    id: "G-7",
    ok: spreadC <= spreadB + 0.25,
    detail: `games spread ${spreadC.toFixed(2)} vs ${spreadB.toFixed(2)} (need ≤ +0.25)`,
  });

  v.push({
    id: "G-8",
    ok: mixedC <= mixedB + 0.01,
    detail: `mixed-level ${(mixedC * 100).toFixed(1)}pp vs ${(mixedB * 100).toFixed(1)}pp (need ≤ +1pp)`,
  });

  v.push({
    id: "G-9",
    ok: spr2C <= spr2B + 0.15 && gapC <= gapB + 0.15,
    detail: `spread-2 ${(spr2C * 100).toFixed(1)}/${(spr2B * 100).toFixed(1)}pp · team gap ${gapC.toFixed(2)}/${gapB.toFixed(2)}`,
  });

  v.push({
    id: "G-10",
    ok: oppC <= oppB + 1e-9,
    detail: `consecutive-opponent rate ${(oppC * 100).toFixed(1)}% vs ${(oppB * 100).toFixed(1)}%`,
  });

  v.push({
    id: "G-11",
    ok: capC <= capB + 1e-9 && partnerC <= partnerB + 1e-9,
    detail: `partner-cap breaches ${capC.toFixed(1)}/${capB.toFixed(1)} (≤ baseline) · consec-partner ${partnerC.toFixed(1)}/${partnerB.toFixed(1)}`,
  });

  v.push({
    id: "G-P1",
    ok: wrapperP99 < 25,
    detail: `wrapper p99 ${wrapperP99.toFixed(2)} ms (need < 25)`,
  });

  return v;
}

async function loadRealFixtures(ids: string[]): Promise<SessionFixture[]> {
  const out: SessionFixture[] = [];
  for (const id of ids) {
    try {
      out.push(await loadFixture(id, false));
    } catch (err) {
      console.log(D(`  skip ${id}: ${(err as Error).message}`));
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sessionIds = args.sessions.length > 0 ? args.sessions : [...DEFAULT_SESSION_IDS];

  console.log(W("\n╔══════════════════════════════════════════════════════════════════════╗"));
  console.log(W("║   FRESHNESS GATE — draft-queue replay, independent brute force       ║"));
  console.log(W("╚══════════════════════════════════════════════════════════════════════╝"));
  console.log(
    D(
      `  slack=${SLACK}  ·  K=${args.jitter}  ·  synthetics=${args.synthetic}` +
        `  ·  cache: ${CACHE_DIR}` +
        (args.quick ? "  ·  QUICK (not the ship gate)" : "")
    )
  );

  const reals = await loadRealFixtures(sessionIds);
  const synthetics = Array.from({ length: args.synthetic }, (_, i) => syntheticFixture(i + 1));
  if (reals.length === 0) {
    console.log(
      Y(
        "\n  No cached/prod fixtures — gating on synthetics only. Oct 3 rows of G-1/G-2 are skipped."
      )
    );
  } else {
    console.log(D(`\n  Real fixtures: ${reals.map((f) => f.name).join(" · ")}`));
  }

  const fixtures: { fixture: SessionFixture; kind: "real" | "synthetic" }[] = [
    ...reals.map((fixture) => ({ fixture, kind: "real" as const })),
    ...synthetics.map((fixture) => ({ fixture, kind: "synthetic" as const })),
  ];

  const baseline: GateRow[] = [];
  const candidate: GateRow[] = [];

  for (const { fixture, kind } of fixtures) {
    process.stdout.write(D(`  replay ${fixture.name} …`));
    const off = meanFixture(fixture, kind, false, args.jitter);
    const on = meanFixture(fixture, kind, true, args.jitter);
    baseline.push(off);
    candidate.push(on);
    process.stdout.write(
      D(
        `  near-id ${off.consecutiveNearIdentical.toFixed(1)}→${on.consecutiveNearIdentical.toFixed(1)}` +
          `  avoid ${off.avoidableNearIdentical.toFixed(1)}→${on.avoidableNearIdentical.toFixed(1)}\n`
      )
    );
  }

  const oct3Base = baseline.find((r) => r.id === OCT3_ID) ?? null;
  const oct3Cand = candidate.find((r) => r.id === OCT3_ID) ?? null;

  if (
    oct3Base &&
    oct3Base.consecutiveNearIdentical === 0 &&
    oct3Base.avoidableNearIdentical === 0
  ) {
    console.log(
      R(
        "\n  STOP (P0-10): Oct 3 baseline shows zero back-to-back near-identicals — fidelity is wrong."
      )
    );
    process.exit(1);
  }

  const verdicts = evaluate(baseline, candidate, oct3Base, oct3Cand);

  console.log(`\n${W("━━━━━━━━━━━━━━━━━━━━━━  GATE  ━━━━━━━━━━━━━━━━━━━━━━")}\n`);
  console.log(D(`  ${"ID".padEnd(6)}${"RESULT".padEnd(8)}DETAIL`));
  let failed = 0;
  for (const v of verdicts) {
    const mark = v.ok ? G("PASS") : R("FAIL");
    if (!v.ok) failed++;
    console.log(`  ${v.id.padEnd(6)}${mark}    ${v.detail}`);
  }

  const room =
    sum(baseline, (r) => r.avoidableNearIdentical) /
    Math.max(
      1e-9,
      sum(baseline, (r) => r.backToBackServed)
    );
  console.log(
    D(
      `\n  P0-3b room-to-act (baseline avoidable / near-identical): ${(room * 100).toFixed(1)}%` +
        `  — stop if ~0 before trusting the refresh.`
    )
  );

  const waitOffenders = candidate
    .map((c, i) => ({
      name: c.name,
      p90: c.waitP90 - baseline[i].waitP90,
      max: c.waitMax - baseline[i].waitMax,
      spread2: (c.skillSpread2Rate - baseline[i].skillSpread2Rate) * 100,
      cap: c.partnerCapBreaches,
      capBase: baseline[i].partnerCapBreaches,
      near: `${baseline[i].consecutiveNearIdentical.toFixed(1)}→${c.consecutiveNearIdentical.toFixed(1)}`,
    }))
    .filter((r) => r.p90 > 2.0 || r.max > 2.0 || r.spread2 > 5 || r.cap > 0)
    .sort((a, b) => b.max - a.max);
  if (waitOffenders.length > 0) {
    console.log(D("\n  Fixtures that trip a guardrail (worst max-wait first):"));
    for (const r of waitOffenders.slice(0, 8)) {
      console.log(
        D(
          `    ${r.name}: Δp90 ${r.p90.toFixed(1)}m  Δmax ${r.max.toFixed(1)}m  Δspread-2 ${r.spread2.toFixed(1)}pp  cap ${r.cap.toFixed(1)}/${r.capBase.toFixed(1)}  near ${r.near}`
        )
      );
    }
  }

  if (failed > 0) {
    console.log(R(`\n  ✗ ${failed} gate row(s) failed. Do not deploy.\n`));
    process.exit(1);
  }
  console.log(G("\n  ✓ All numeric gate rows passed.\n"));
}

main().catch((err) => {
  console.error(R(`\nGate failed: ${(err as Error).stack ?? err}\n`));
  process.exit(1);
});
