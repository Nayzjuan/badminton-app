// ─────────────────────────────────────────────────────────────────────────────
// Mock matchmaking engine — simplified narration of the real algorithm.
//
// Real engine (src/lib/matchmaking-core.ts) does:
//   • N-choose-3 over the candidate pool
//   • partnership cap (MAX_PARTNERSHIP_REPEATS)
//   • diversity overlap penalty
//   • skill balance
//   • dynamic draft cap (MAX_AUTO_DRAFTS) considering both pending + draft
//
// We narrate the same shape so the action logger reads like the real engine,
// but use a simpler greedy approach: take the first 4 waiting players, try
// each of the 3 partner splits, accept the first that clears the cap.
// ─────────────────────────────────────────────────────────────────────────────
import type { LogEntry, Match, SandboxState, Team } from "../state/types";
import { pairKey } from "../state/types";

export type EngineResult = {
  newMatches: Match[];
  logs: Omit<LogEntry, "id" | "ts">[];
};

// Idempotent helper for stable match IDs within a single dispatch.
function makeMatchId(i: number): string {
  // crypto.randomUUID is universal in modern browsers + Node 19+; fall back
  // to a timestamp+counter scheme if unavailable (older test envs, etc).
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `m_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `m_${Date.now().toString(36)}_${i}`;
}

export function runMockEngine(state: SandboxState): EngineResult {
  const logs: Omit<LogEntry, "id" | "ts">[] = [];

  // ── Phase 1: queue scan ────────────────────────────────────────────────────
  const waitingIds = state.queueOrder.filter((id) => state.players[id]?.status === "waiting");
  const pausedCount = state.queueOrder.filter(
    (id) => state.players[id]?.status === "paused"
  ).length;

  logs.push({
    level: "engine",
    msg: `[engine] queue scan: ${waitingIds.length} waiting · ${pausedCount} paused`,
  });

  // ── Phase 2: capacity check (mirrors dynamic draft cap fix) ────────────────
  // The cap counts BOTH pending (on-deck, published) and draft (unpublished)
  // matches — not just drafts. Pending matches occupy a queue slot just as
  // drafts do; they simply haven't been started yet.
  const existingDrafts = state.matches.filter((m) => m.status === "draft").length;
  const existingPending = state.matches.filter((m) => m.status === "pending").length;
  const totalAtCap = existingDrafts + existingPending;
  const slotsAvailable = Math.max(0, state.config.maxAutoDrafts - totalAtCap);

  logs.push({
    level: "engine",
    msg: `[engine] capacity: ${existingPending} on-deck + ${existingDrafts} draft = ${totalAtCap}/${state.config.maxAutoDrafts}, slots=${slotsAvailable}`,
  });

  if (slotsAvailable === 0) {
    // Distinguish the three blocking cases so the action logger gives the
    // organizer an accurate, actionable reason — not a generic "draft cap".
    let blockMsg: string;
    if (existingDrafts === 0) {
      // All slots filled by published on-deck matches — no drafts involved.
      blockMsg =
        `[engine] on-deck queue full (${existingPending} match${existingPending !== 1 ? "es" : ""} waiting) — ` +
        `start a match to open a slot`;
    } else if (existingPending === 0) {
      // All slots filled by unpublished drafts.
      blockMsg =
        `[engine] draft queue full (${existingDrafts} unpublished draft${existingDrafts !== 1 ? "s" : ""}) — ` +
        `publish or cancel drafts to continue`;
    } else {
      // Mixed: some published, some draft.
      blockMsg =
        `[engine] queue full (${existingPending} on-deck + ${existingDrafts} draft = ${totalAtCap}/${state.config.maxAutoDrafts}) — ` +
        `start or publish matches to open a slot`;
    }
    logs.push({ level: "warn", msg: blockMsg });
    return { newMatches: [], logs };
  }

  if (waitingIds.length < 4) {
    logs.push({
      level: "warn",
      msg: `[engine] insufficient waiting players (need 4, have ${waitingIds.length})`,
    });
    return { newMatches: [], logs };
  }

  // ── Phase 3: pool diversity check (MIN_FREE_POOL_FOR_ON_DECK) ──────────────
  // Slot 0 is always exempt (never let the engine stall on a small pool).
  const wouldRemainAfter = waitingIds.length - 4;
  if (existingPending > 0 && wouldRemainAfter < state.config.minFreePoolForOnDeck) {
    logs.push({
      level: "warn",
      msg: `[engine] pool diversity gate: would leave ${wouldRemainAfter} free, threshold ${state.config.minFreePoolForOnDeck} — skipping`,
    });
    return { newMatches: [], logs };
  }

  // ── Phase 4: greedy draft generation ───────────────────────────────────────
  const newMatches: Match[] = [];
  let pool = [...waitingIds];
  let successCount = 0; // numbered "draft N" labels increment only on success

  for (let i = 0; i < slotsAvailable && pool.length >= 4; i++) {
    const candidates = pool.slice(0, 4);
    logs.push({
      level: "engine",
      msg: `[engine] slot ${i + 1}: N-choose-3 over ${pool.length}-player candidate set`,
    });

    // Three possible 2v2 splits of 4 candidates (rotated draft + snake draft).
    const splits: Array<[Team, Team]> = [
      [
        [candidates[0], candidates[1]],
        [candidates[2], candidates[3]],
      ],
      [
        [candidates[0], candidates[2]],
        [candidates[1], candidates[3]],
      ],
      [
        [candidates[0], candidates[3]],
        [candidates[1], candidates[2]],
      ],
    ];

    let chosen: [Team, Team] | null = null;
    for (const [teamA, teamB] of splits) {
      const countA = state.partnershipCounts[pairKey(teamA[0], teamA[1])] ?? 0;
      const countB = state.partnershipCounts[pairKey(teamB[0], teamB[1])] ?? 0;
      const cap = state.config.maxPartnershipRepeats;
      if (countA < cap && countB < cap) {
        chosen = [teamA, teamB];
        logs.push({
          level: "engine",
          msg: `[engine]   partnership cap ok (A=${countA}, B=${countB}, cap=${cap})`,
        });
        break;
      }
    }

    if (!chosen) {
      logs.push({
        level: "warn",
        msg: "[engine]   all 3 splits hit partnership cap — skipping this slot",
      });
      // If the pool is exactly 4, rotation produces the same 3 unordered
      // partner splits (pairKey is symmetric) — no point trying again.
      if (pool.length === 4) {
        logs.push({
          level: "warn",
          msg: "[engine]   pool too small to escape cap — bailing out of remaining slots",
        });
        break;
      }
      // Otherwise rotate one player to the back and try a fresh candidate set.
      pool = [...pool.slice(1), pool[0]];
      continue;
    }

    const aNames = chosen[0].map((id) => state.players[id]?.name ?? "?").join(" + ");
    const bNames = chosen[1].map((id) => state.players[id]?.name ?? "?").join(" + ");

    successCount += 1;
    newMatches.push({
      id: makeMatchId(i),
      teamA: chosen[0],
      teamB: chosen[1],
      status: "draft",
      isPublished: false,
      origin: "engine",
      createdAt: Date.now(),
    });

    logs.push({
      level: "engine",
      msg: `[engine]   ✓ draft ${successCount}: ${aNames}  vs  ${bNames}`,
    });

    // Remove the 4 chosen players from the pool for the next iteration.
    pool = pool.filter((id) => !candidates.includes(id));
  }

  logs.push({
    level: "engine",
    msg: `[engine] complete — ${newMatches.length} draft${newMatches.length === 1 ? "" : "s"} created in memory, awaiting publish`,
  });

  return { newMatches, logs };
}
