#!/usr/bin/env -S npx tsx
/**
 * replay-sessions.ts — measure the matchmaking engine against real sessions.
 * ─────────────────────────────────────────────────────────────────────────────
 * Replays the CURRENT engine over production sessions (real rosters, real skill
 * levels, real arrival times, real court durations) and scores the result on
 * the things players complain about — chiefly facing the same opponent in
 * back-to-back games.
 *
 * It exists so an engine change can be argued from evidence rather than
 * intuition: save a baseline before the change, compare after it.
 *
 *   npx tsx scripts/replay-sessions.ts                     # replay + report
 *   npx tsx scripts/replay-sessions.ts --refresh           # re-fetch from prod
 *   npx tsx scripts/replay-sessions.ts --save baseline     # freeze this run
 *   npx tsx scripts/replay-sessions.ts --compare baseline  # diff vs a frozen run
 *   npx tsx scripts/replay-sessions.ts --session <uuid>    # one session only
 *
 * The first run needs prod credentials in .env.local; afterwards the fixtures
 * are cached under .replay-cache/ (gitignored — they contain real member names)
 * and every run is offline, free, and byte-identical.
 *
 * The "REAL" column is what the organizer actually ran that night — a mix of
 * engine drafts and manual matches, with auto-matchmaking paused for stretches.
 * It is context, not a target: the engine's job is to beat the night the
 * organizer had to intervene to fix.
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_SESSION_IDS, loadFixture, CACHE_DIR } from "./replay/fetch";
import { replaySession } from "./replay/simulate";
import { computeMetrics, type SessionMetrics } from "./replay/metrics";
import type { SessionFixture } from "./replay/types";

// ─── Terminal formatting ─────────────────────────────────────────────────────
const W = (s: string) => `\x1b[1m${s}\x1b[0m`;
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;

// Colour codes are zero-width on screen, so every width calculation must ignore
// them — otherwise a coloured cell steals ~9 columns from its neighbour.
const ANSI = /\x1b\[[0-9;]*m/g;
const visibleLength = (s: string) => s.replace(ANSI, "").length;

const pad = (s: string, n: number) => {
  const len = visibleLength(s);
  return len >= n ? s : s + " ".repeat(n - len);
};
// Never truncates: a right-aligned cell that outgrows its column pushes the row
// wide, which is ugly. Slicing it would eat the leading digits, which is wrong.
const rpad = (s: string, n: number) => {
  const len = visibleLength(s);
  return len >= n ? s : " ".repeat(n - len) + s;
};
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const sep = (ch = "─", n = 88) => D(ch.repeat(n));

// ─── CLI ─────────────────────────────────────────────────────────────────────
type Args = {
  refresh: boolean;
  save: string | null;
  compare: string | null;
  sessions: string[];
};

function parseArgs(argv: string[]): Args {
  const args: Args = { refresh: false, save: null, compare: null, sessions: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--refresh") args.refresh = true;
    else if (a === "--save") args.save = argv[++i] ?? null;
    else if (a === "--compare") args.compare = argv[++i] ?? null;
    else if (a === "--session") {
      const id = argv[++i];
      if (id) args.sessions.push(id);
    } else if (a === "--help" || a === "-h") {
      console.log(
        [
          "Usage: npx tsx scripts/replay-sessions.ts [options]",
          "  --refresh            re-fetch fixtures from production",
          "  --save <label>       write this run's metrics to .replay-cache/results/<label>.json",
          "  --compare <label>    diff this run against a saved one",
          "  --session <uuid>     replay one session (repeatable)",
        ].join("\n")
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  if (args.sessions.length === 0) args.sessions = [...DEFAULT_SESSION_IDS];
  return args;
}

// ─── Saved-run I/O ───────────────────────────────────────────────────────────
const RESULTS_DIR = path.join(CACHE_DIR, "results");

type SavedRun = {
  label: string;
  /** Caller-supplied at write time — Date is banned inside workflows, not here. */
  savedAt: string;
  gitHead: string;
  /** Fingerprint of the engine source this run exercised — see engineHash. */
  engineHash: string;
  sessions: Record<string, { name: string; fixtureHash: string; replay: SessionMetrics }>;
};

/**
 * Fingerprint of the ALGORITHM under test. gitHead only reports the committed
 * ref, so a save → edit → compare cycle (the intended workflow) prints the same
 * sha on both sides of the table and reads as though nothing changed. Hashing
 * the engine sources instead makes "you compared identical code" detectable,
 * which is the failure mode that would quietly turn a no-op into a claimed win.
 */
const ENGINE_SOURCES = [
  "src/lib/matchmaking-core.ts",
  "src/lib/matchmaking-db.ts",
  "src/lib/constants.ts",
];

function engineHash(): string {
  const h = createHash("sha256");
  for (const rel of ENGINE_SOURCES) {
    try {
      h.update(fs.readFileSync(path.join(__dirname, "..", rel)));
    } catch {
      h.update(`missing:${rel}`);
    }
  }
  return h.digest("hex").slice(0, 12);
}

/**
 * Fingerprint of the fixture a run was scored against. A --refresh between
 * --save and --compare would otherwise fold a *data* delta into what reads as
 * an *engine* delta — the one way this harness could lie outright about a
 * change being an improvement.
 */
function fixtureHash(fixture: SessionFixture): string {
  return createHash("sha256").update(JSON.stringify(fixture)).digest("hex").slice(0, 12);
}

function resultPath(label: string) {
  // Labels land in a filesystem path — keep them to a safe alphabet rather than
  // trusting the shell caller not to pass "../../etc/something".
  if (!/^[A-Za-z0-9._-]+$/.test(label)) {
    console.error(`Invalid label "${label}" — use letters, digits, dot, dash, underscore.`);
    process.exit(1);
  }
  return path.join(RESULTS_DIR, `${label}.json`);
}

function gitHead(): string {
  try {
    // Read the ref directly — no child process, no shell.
    const head = fs.readFileSync(path.join(__dirname, "..", ".git", "HEAD"), "utf8").trim();
    const ref = head.startsWith("ref: ") ? head.slice(5) : null;
    if (!ref) return head.slice(0, 7);
    const sha = fs.readFileSync(path.join(__dirname, "..", ".git", ref), "utf8").trim();
    return `${ref.replace("refs/heads/", "")}@${sha.slice(0, 7)}`;
  } catch {
    return "unknown";
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────

function metricRows(m: SessionMetrics): [string, string][] {
  return [
    ["Matches", String(m.matches)],
    [
      "Consecutive-opponent repeats",
      `${m.consecutiveOpponentRepeats}  (${pct(m.consecutiveOpponentRate)} of back-to-back games)`,
    ],
    [
      "Consecutive-partner repeats",
      `${m.consecutivePartnerRepeats}  (${pct(m.consecutivePartnerRate)})`,
    ],
    ["Near-identical foursomes", `${m.consecutiveThreeOfFour}  (3 of 3 co-players repeated)`],
    ["Opponent variety", pct(m.opponentVariety)],
    ["Partner variety", pct(m.partnerVariety)],
    ["Pairs over cap", `${m.opponentPairsOverCap} opponent · ${m.partnershipsOverCap} partnership`],
    [
      "Worst repeat count",
      `${m.maxOpponentRepeats}× opponent · ${m.maxPartnershipRepeats}× partner`,
    ],
    [
      "Cycle time (start→start)",
      `avg ${m.avgCycleMin.toFixed(1)}m · p90 ${m.p90CycleMin.toFixed(1)}m · max ${m.maxCycleMin.toFixed(1)}m`,
    ],
    [
      "Games per player",
      `${m.gamesMin}–${m.gamesMax} (avg ${m.gamesAvg.toFixed(1)})${m.satOut > 0 ? `, ${m.satOut} sat out` : ""}`,
    ],
  ];
}

function printSession(
  fixture: SessionFixture,
  real: SessionMetrics,
  replay: SessionMetrics,
  diagnostics: {
    noMatchEvents: number;
    capSaturationEvents: number;
    forcedRepeats: number;
    thinPoolEvents: number;
  },
  engineLogLines: number
) {
  const playerCount = fixture.players.length;
  const courtCount = fixture.courts.length;
  const names = new Map(fixture.players.map((p) => [p.player_id, p.display_name]));

  console.log(
    `\n${W(fixture.name)} ${D(`· ${fixture.day} · ${playerCount} players · ${courtCount} courts`)}`
  );
  console.log(sep("─", 108));
  console.log(D(`  ${pad("Metric", 30)}${pad("REAL (what was played)", 38)}ENGINE REPLAY`));
  console.log(sep("·", 108));

  const realRows = metricRows(real);
  const replayRows = metricRows(replay);
  for (let i = 0; i < realRows.length; i++) {
    const [label, realVal] = realRows[i];
    const replayVal = replayRows[i][1];
    console.log(`  ${pad(label, 30)}${D(pad(realVal, 38))}${replayVal}`);
  }

  const notes: string[] = [];
  if (diagnostics.forcedRepeats > 0) notes.push(`${diagnostics.forcedRepeats} forced repeat(s)`);
  if (diagnostics.noMatchEvents > 0)
    notes.push(
      `${diagnostics.noMatchEvents} no-match (${diagnostics.capSaturationEvents} cap-saturated)`
    );
  if (diagnostics.thinPoolEvents > 0) notes.push(`${diagnostics.thinPoolEvents} thin-pool skip(s)`);
  if (engineLogLines > 0) notes.push(`${engineLogLines} engine log line(s) suppressed`);
  if (notes.length > 0) console.log(D(`\n  Engine diagnostics: ${notes.join(" · ")}`));

  // The people who would actually complain, named — an aggregate rate hides
  // whether the pain is spread thin or landing on the same three players.
  if (replay.worstConsecutive.length > 0) {
    const worst = replay.worstConsecutive
      .slice(0, 3)
      .map((w) => `${names.get(w.playerId) ?? w.playerId.slice(0, 8)} ${w.repeats}/${w.games - 1}`)
      .join(" · ");
    console.log(D(`  Worst served (replay, repeats/back-to-back pairs): ${worst}`));
  }
}

/** Column widths for the aggregate table — the header and data rows share them. */
const AGG_W = { label: 22, repeats: 7, pairs: 5, rate: 7, partner: 7, three: 6, cap: 6 };

/** One aggregate line; the header is the same shape with literal column names. */
function aggLine(
  label: string,
  [repeats, pairs, rate, partner, three, cap]: [string, string, string, string, string, string]
) {
  return (
    `  ${pad(label, AGG_W.label)}` +
    `${rpad(repeats, AGG_W.repeats)} / ${rpad(pairs, AGG_W.pairs)}   ` +
    `${rpad(rate, AGG_W.rate)}   ` +
    `${rpad(partner, AGG_W.partner)}   ` +
    `${rpad(three, AGG_W.three)}   ` +
    `${rpad(cap, AGG_W.cap)}`
  );
}

function printAggregate(label: string, all: SessionMetrics[]) {
  const sum = (pick: (m: SessionMetrics) => number) => all.reduce((s, m) => s + pick(m), 0);
  const repeats = sum((m) => m.consecutiveOpponentRepeats);
  const pairs = sum((m) => m.consecutivePairs);
  const rate = pairs > 0 ? repeats / pairs : 0;

  console.log(
    aggLine(label, [
      String(repeats),
      String(pairs),
      pct(rate),
      String(sum((m) => m.consecutivePartnerRepeats)),
      String(sum((m) => m.consecutiveThreeOfFour)),
      String(sum((m) => m.opponentPairsOverCap)),
    ])
  );
}

function printComparison(current: SavedRun, previous: SavedRun) {
  console.log(`\n\n${W("━━━━━━━━━━━━━━━━━━━━━━  COMPARISON  ━━━━━━━━━━━━━━━━━━━━━━")}\n`);
  console.log(
    D(
      `  baseline: ${previous.label} (${previous.gitHead}, engine ${previous.engineHash ?? "?"}, saved ${previous.savedAt})`
    )
  );
  console.log(D(`  current:  ${current.gitHead}, engine ${current.engineHash}\n`));

  if (current.engineHash && previous.engineHash === current.engineHash) {
    console.log(
      Y(
        `  ⚠ Engine source is IDENTICAL to the baseline (${current.engineHash}) —\n` +
          `    this compares the algorithm against itself. Any delta below is noise.\n`
      )
    );
  }

  console.log(
    D(`  ${pad("Session", 26)}${pad("Consec-opp repeats", 24)}${pad("3-of-4", 14)}Avg cycle`)
  );
  console.log(sep("·"));

  let baseTotal = 0;
  let curTotal = 0;
  let compared = 0;

  const driftedFixtures: string[] = [];

  for (const [sessionId, cur] of Object.entries(current.sessions)) {
    const prev = previous.sessions[sessionId];
    if (!prev) {
      console.log(`  ${pad(cur.name, 26)}${D("(not in baseline)")}`);
      continue;
    }
    // A baseline written before fixtureHash existed has none — compare only
    // when both sides carry one, rather than crying drift over a missing field.
    if (prev.fixtureHash && cur.fixtureHash !== prev.fixtureHash) {
      driftedFixtures.push(cur.name);
    }
    const a = prev.replay;
    const b = cur.replay;
    baseTotal += a.consecutiveOpponentRepeats;
    curTotal += b.consecutiveOpponentRepeats;
    compared++;

    const delta = b.consecutiveOpponentRepeats - a.consecutiveOpponentRepeats;
    const arrow = delta < 0 ? G(`▼ ${-delta}`) : delta > 0 ? R(`▲ ${delta}`) : D("=");
    const threeDelta = b.consecutiveThreeOfFour - a.consecutiveThreeOfFour;
    const threeArrow =
      threeDelta < 0 ? G(`▼ ${-threeDelta}`) : threeDelta > 0 ? R(`▲ ${threeDelta}`) : D("=");
    const cycleDelta = b.avgCycleMin - a.avgCycleMin;
    const cycleArrow =
      Math.abs(cycleDelta) < 0.05
        ? D("=")
        : cycleDelta < 0
          ? G(`▼ ${(-cycleDelta).toFixed(1)}m`)
          : Y(`▲ ${cycleDelta.toFixed(1)}m`);

    console.log(
      `  ${pad(cur.name, 26)}` +
        `${pad(`${a.consecutiveOpponentRepeats} → ${b.consecutiveOpponentRepeats}  ${arrow}`, 24)}` +
        `${pad(`${a.consecutiveThreeOfFour} → ${b.consecutiveThreeOfFour} ${threeArrow}`, 14)}` +
        `${cycleArrow}`
    );
  }

  console.log(sep("·"));
  // Scope the verdict to what was actually compared. A --session run diffs one
  // night; saying "across all sessions" there would overclaim the evidence.
  const baselineCount = Object.keys(previous.sessions).length;
  const scope =
    compared === baselineCount
      ? `across all ${compared} session(s)`
      : `across ${compared} of the baseline's ${baselineCount} session(s)`;
  const total = curTotal - baseTotal;
  const verdict =
    total < 0
      ? G(`✓ ${-total} fewer consecutive-opponent repeats ${scope}`)
      : total > 0
        ? R(`✗ ${total} MORE consecutive-opponent repeats ${scope} — the change is a regression`)
        : Y(`= no change in consecutive-opponent repeats ${scope}`);
  console.log(`  ${verdict}`);

  if (driftedFixtures.length > 0) {
    console.log(
      R(
        `\n  ⚠ Fixture data CHANGED since the baseline: ${driftedFixtures.join(", ")}.` +
          `\n    The delta above is not a pure engine delta — re-save the baseline.`
      )
    );
  }
  console.log();
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(W("\n╔══════════════════════════════════════════════════════════════════════╗"));
  console.log(W("║   ENGINE REPLAY — production sessions, current algorithm             ║"));
  console.log(W("╚══════════════════════════════════════════════════════════════════════╝"));
  console.log(
    D(
      `  ${gitHead()}  ·  engine ${engineHash()}  ·  ${args.sessions.length} session(s)` +
        `  ·  cache: ${CACHE_DIR}`
    )
  );

  const realAll: SessionMetrics[] = [];
  const replayAll: SessionMetrics[] = [];
  const saved: SavedRun["sessions"] = {};

  for (const sessionId of args.sessions) {
    let fixture;
    try {
      fixture = await loadFixture(sessionId, args.refresh);
    } catch (err) {
      console.error(R(`\n  ✗ ${sessionId}: ${(err as Error).message}`));
      continue;
    }

    // The engine logs to console as it works ("applying partner rotation…").
    // That is genuine signal, but it lands mid-table and makes the report
    // unpipeable — and the counts it reports are already in the diagnostics
    // line. Capture it instead of letting it interleave.
    const engineLog: string[] = [];
    const realLog = console.log;
    const realWarn = console.warn;
    console.log = (...a: unknown[]) => engineLog.push(a.join(" "));
    console.warn = (...a: unknown[]) => engineLog.push(a.join(" "));
    let result;
    try {
      result = replaySession(fixture);
    } finally {
      console.log = realLog;
      console.warn = realWarn;
    }

    const real = computeMetrics(fixture.realMatches, fixture.players.length);
    const replay = computeMetrics(result.matches, fixture.players.length);

    realAll.push(real);
    replayAll.push(replay);
    saved[sessionId] = { name: fixture.name, fixtureHash: fixtureHash(fixture), replay };

    printSession(fixture, real, replay, result.diagnostics, engineLog.length);
  }

  if (replayAll.length === 0) {
    console.error(R("\n  No sessions replayed — nothing to report.\n"));
    process.exit(1);
  }

  console.log(`\n\n${W("━━━━━━━━━━━━━━━━━━━━━━━━  ALL SESSIONS  ━━━━━━━━━━━━━━━━━━━━━━━━")}\n`);
  console.log(D(aggLine("", ["repeats", "pairs", "rate", "partner", "3-of-4", "o/cap"])));
  console.log(sep("·"));
  printAggregate("REAL (as played)", realAll);
  printAggregate("ENGINE REPLAY", replayAll);
  console.log(sep("·"));
  console.log(
    D(
      "  'repeats' = back-to-back games sharing an opponent. Lower is better;\n" +
        "  'pairs' is the denominator (every adjacent game pair, per player).\n" +
        "\n" +
        "  Compare the RATE, not the counts. The replay runs the whole session\n" +
        "  window at 100% court occupancy, so it plays more matches than the\n" +
        "  night did — the real session had idle courts and a later first serve.\n"
    )
  );

  const current: SavedRun = {
    label: args.save ?? "current",
    savedAt: new Date().toISOString(),
    gitHead: gitHead(),
    engineHash: engineHash(),
    sessions: saved,
  };

  if (args.compare) {
    const file = resultPath(args.compare);
    if (!fs.existsSync(file)) {
      console.error(R(`  ✗ No saved run "${args.compare}" at ${file}`));
      console.error(
        D(`    Create one first:  npx tsx scripts/replay-sessions.ts --save ${args.compare}\n`)
      );
      process.exit(1);
    }
    printComparison(current, JSON.parse(fs.readFileSync(file, "utf8")) as SavedRun);
  }

  if (args.save) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const file = resultPath(args.save);
    fs.writeFileSync(file, JSON.stringify(current, null, 2));
    console.log(G(`  ✓ Saved run "${args.save}" → ${file}\n`));
  }
}

main().catch((err) => {
  console.error(R(`\nReplay failed: ${(err as Error).stack ?? err}\n`));
  process.exit(1);
});
