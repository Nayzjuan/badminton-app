// ============================================================
// Early-session diversity — unit tests
// ============================================================
// Covers the pure mechanisms added by the first-round / early-session
// diversity work (2026-07):
//
//   ED-SC  scoreCandidates fresh-first rule (games-ahead penalty)
//   ED-OPP opponent-diversity weighting (round-2 re-facing lever)
//   ED-RN  deriveReuseNotice (organizer-facing equity signal)
// ============================================================

import { describe, expect, it } from "vitest";
import { runAlgorithm, scoreCandidates, type ScoredPlayer } from "@/lib/matchmaking-core";
import { deriveReuseNotice, type ReuseQueueRow } from "@/lib/derive-reuse-notice";
import {
  GAMES_AHEAD_PENALTY,
  OVERLAP_WEIGHT_OPPONENT,
  OVERLAP_WEIGHT_TEAMMATE,
  RED_ZONE_SCORE_FLOOR,
} from "@/lib/constants";

// ── Helpers ────────────────────────────────────────────────────

function player(
  id: string,
  opts: { games?: number; priority?: number; skill?: number } = {}
): ScoredPlayer {
  return {
    id: `qe-${id}`,
    session_id: "session-1",
    player_id: id,
    joined_at: "2026-07-05T04:00:00Z",
    games_played: opts.games ?? 0,
    status: "waiting",
    position: null,
    is_paused: false,
    created_at: "2026-07-05T04:00:00Z",
    display_name: id,
    skill_level: "intermediate",
    skill_level_int: opts.skill ?? 3,
    wait_minutes: 5,
    is_bottleneck: false,
    priorityScore: opts.priority ?? 5,
  } as ScoredPlayer;
}

function queueRow(
  id: string,
  opts: { games?: number; status?: string; paused?: boolean } = {}
): ReuseQueueRow {
  return {
    player_id: id,
    games_played: opts.games ?? 0,
    status: opts.status ?? "waiting",
    is_paused: opts.paused ?? false,
  };
}

// ── ED-SC: scoreCandidates fresh-first ────────────────────────

describe("scoreCandidates — fresh-first (games-ahead penalty)", () => {
  it("ED-SC1: without poolMinGames, behaviour is unchanged (no games penalty)", () => {
    const fresh = player("fresh", { games: 0, priority: 2 });
    const alum = player("alum", { games: 3, priority: 10 });
    const scored = scoreCandidates([fresh, alum], new Map());
    // Higher priorityScore wins when no poolMinGames is supplied.
    expect(scored[0].candidate.player_id).toBe("alum");
  });

  it("ED-SC2: with poolMinGames, a fresher candidate outranks a higher-priority alum", () => {
    const fresh = player("fresh", { games: 0, priority: 2 });
    const alum = player("alum", { games: 1, priority: 25 }); // rested 25 min, 1 game
    const scored = scoreCandidates([fresh, alum], new Map(), 0);
    // alum: -25 + 1×10_000 = 9_975 · fresh: -2 + 0 = -2 → fresh first.
    expect(scored[0].candidate.player_id).toBe("fresh");
    expect(scored[1].score).toBe(-25 + GAMES_AHEAD_PENALTY);
  });

  it("ED-SC3: equal games (all at pool minimum) → zero penalty, order by priority", () => {
    const a = player("a", { games: 2, priority: 8 });
    const b = player("b", { games: 2, priority: 12 });
    const scored = scoreCandidates([a, b], new Map(), 2);
    expect(scored[0].candidate.player_id).toBe("b");
    expect(scored[0].score).toBe(-12);
  });

  it("ED-SC4: Red Zone candidate keeps priority over fresher normal candidates", () => {
    const urgent = player("urgent", { games: 2, priority: RED_ZONE_SCORE_FLOOR + 15 });
    const fresh = player("fresh", { games: 0, priority: 5 });
    const scored = scoreCandidates([urgent, fresh], new Map(), 0);
    // urgent: -(1015) + 2×100 = -815 · fresh: -5 → urgent still first.
    expect(scored[0].candidate.player_id).toBe("urgent");
  });

  it("ED-SC5: candidate below the supplied minimum gets no negative penalty", () => {
    const below = player("below", { games: 0, priority: 3 });
    const scored = scoreCandidates([below], new Map(), 2);
    expect(scored[0].score).toBe(-3); // Math.max(0, 0-2) = 0 → no bonus, no penalty
  });

  it("ED-SC6: games-ahead penalty stacks with the overlap penalty", () => {
    const p = player("p", { games: 1, priority: 4 });
    const scored = scoreCandidates([p], new Map([["p", 2]]), 0);
    expect(scored[0].score).toBe(-4 + 2 * 10_000 + 1 * GAMES_AHEAD_PENALTY);
  });

  it("ED-SC7: pulled bodies are exempt from the games-ahead penalty (C-3 ordering preserved)", () => {
    // A pulled body's ordering is governed by priorityScore -1 alone — it must
    // never gain OR lose rank from the fresh-first term. Games ABOVE the
    // baseline so the exemption branch is genuinely exercised: without the
    // isPulled exemption this body would score +1 + 1×10_000.
    const pulled = { ...player("pulled", { games: 2, priority: -1 }), isPulled: true as const };
    const waiter = player("waiter", { games: 1, priority: 3 });
    const scored = scoreCandidates([pulled, waiter], new Map(), 1);
    // waiter: -3 + 0 (at baseline) · pulled: -(-1) + 0 (exempt) = exactly +1.
    expect(scored[0].candidate.player_id).toBe("waiter");
    expect(scored[1].score).toBe(1);
  });

  it("ED-SC8: runAlgorithm baseline excludes pulled bodies — augmented pool drafts waiting-only when fresh waiters exist", () => {
    // Regression tripwire for the poolMinGames reduce: waiters all at 1 game,
    // pulled body mid-game reads 0. If the reduce counted the pulled body, the
    // baseline would drop to 0, every waiter would eat +10_000, and the pulled
    // body (+1) would jump the candidate queue into the drafted group.
    const pool = [
      player("anchor", { games: 1, priority: 10 }),
      player("w2", { games: 1, priority: 8 }),
      player("w3", { games: 1, priority: 6 }),
      player("w4", { games: 1, priority: 4 }),
      { ...player("pulled", { games: 0, priority: -1 }), isPulled: true as const },
    ];
    const result = runAlgorithm(pool, new Map(), new Map(), [], new Map());
    expect(result.proposal).not.toBeNull();
    const four = [...result.proposal!.teamA, ...result.proposal!.teamB].map((p) => p.player_id);
    expect(four).toHaveLength(4);
    expect(four).not.toContain("pulled");
    expect(new Set(four)).toEqual(new Set(["anchor", "w2", "w3", "w4"]));
  });
});

// ── ED-OPP: opponent-diversity weighting (round-2 lever) ───────
// buildOverlapMap (DB layer) contributes OVERLAP_WEIGHT_TEAMMATE per same-team
// meeting and OVERLAP_WEIGHT_OPPONENT per cross-net meeting; scoreCandidates
// then multiplies the resulting overlap by the overlap unit. These tests pin
// the round-2 behaviour at the pure layer using the real constants.

describe("opponent-diversity weighting", () => {
  it("ED-OPP1: a round-1 opponent is deprioritised as strongly as a round-1 teammate", () => {
    // With teammate/opponent weights equal, an ex-opponent and an ex-teammate
    // carry the same overlap penalty; both sit behind a fresh candidate.
    const overlap = new Map([
      ["exTeam", OVERLAP_WEIGHT_TEAMMATE],
      ["exOpp", OVERLAP_WEIGHT_OPPONENT],
    ]);
    const scored = scoreCandidates(
      [
        player("exTeam", { games: 1, priority: 5 }),
        player("exOpp", { games: 1, priority: 5 }),
        player("fresh", { games: 1, priority: 5 }),
      ],
      overlap,
      1
    );
    expect(scored[0].candidate.player_id).toBe("fresh"); // never-encountered → front
    const t = scored.find((s) => s.candidate.player_id === "exTeam")!;
    const o = scored.find((s) => s.candidate.player_id === "exOpp")!;
    expect(o.score).toBe(t.score); // re-facing penalised exactly as hard as re-teaming
    expect(OVERLAP_WEIGHT_OPPONENT).toBe(OVERLAP_WEIGHT_TEAMMATE); // intent tripwire
  });

  it("ED-OPP2: a fresh candidate outranks a higher-priority round-1 opponent", () => {
    // The exact round-2 scenario: someone you faced in round 1 is next in line
    // (rested longer, higher priority) — but re-facing avoidance still wins.
    const overlap = new Map([["exOpp", OVERLAP_WEIGHT_OPPONENT]]);
    const scored = scoreCandidates(
      [player("exOpp", { games: 1, priority: 30 }), player("fresh", { games: 1, priority: 4 })],
      overlap,
      1
    );
    // exOpp: -30 + 2×10_000 = 19_970 · fresh: -4 → fresh first despite lower priority.
    expect(scored[0].candidate.player_id).toBe("fresh");
  });
});

// ── ED-RN: deriveReuseNotice ───────────────────────────────────

describe("deriveReuseNotice", () => {
  it("ED-RN1: flags a draft seating played players while enough fresher players wait", () => {
    const roster = ["a", "b", "c", "d"];
    const queue = [
      // roster (drafted) — a and b already played, c and d fresh
      queueRow("a", { games: 2, status: "drafted" }),
      queueRow("b", { games: 1, status: "drafted" }),
      queueRow("c", { games: 0, status: "drafted" }),
      queueRow("d", { games: 0, status: "drafted" }),
      // waiting pool — three fresh players sitting at 0 games
      queueRow("w1", { games: 0 }),
      queueRow("w2", { games: 0 }),
      queueRow("w3", { games: 0 }),
    ];
    const notice = deriveReuseNotice(roster, queue);
    expect(notice).toEqual({ overMinCount: 2, fresherWaiting: 3, poolMinGames: 0 });
  });

  it("ED-RN2: null when the fresher cohort is too small to have replaced the over-min seats", () => {
    const roster = ["a", "b", "c", "d"];
    const queue = [
      queueRow("a", { games: 2, status: "drafted" }),
      queueRow("b", { games: 2, status: "drafted" }),
      queueRow("c", { games: 2, status: "drafted" }),
      queueRow("d", { games: 0, status: "drafted" }),
      queueRow("w1", { games: 0 }), // only 1 fresh waiting < 3 over-min
    ];
    expect(deriveReuseNotice(roster, queue)).toBeNull();
  });

  it("ED-RN3: null when the roster is already the freshest cohort", () => {
    const roster = ["a", "b"];
    const queue = [
      queueRow("a", { games: 1, status: "drafted" }),
      queueRow("b", { games: 1, status: "drafted" }),
      queueRow("w1", { games: 1 }),
      queueRow("w2", { games: 2 }),
    ];
    expect(deriveReuseNotice(roster, queue)).toBeNull();
  });

  it("ED-RN4: paused and non-waiting rows are excluded from the waiting pool", () => {
    const roster = ["a"];
    const queue = [
      queueRow("a", { games: 3, status: "drafted" }),
      queueRow("paused", { games: 0, paused: true }), // excluded
      queueRow("playing", { games: 0, status: "playing" }), // excluded
      queueRow("w1", { games: 1 }), // pool min = 1
    ];
    // a (3 games) > poolMin (1), 1 fresher waiting ≥ 1 over-min → flagged.
    expect(deriveReuseNotice(roster, queue)).toEqual({
      overMinCount: 1,
      fresherWaiting: 1,
      poolMinGames: 1,
    });
  });

  it("ED-RN5: null when there are no waiting players at all", () => {
    const roster = ["a"];
    const queue = [queueRow("a", { games: 2, status: "drafted" })];
    expect(deriveReuseNotice(roster, queue)).toBeNull();
  });

  it("ED-RN6: roster members without a visible queue row are skipped, not guessed", () => {
    const roster = ["ghost", "a"];
    const queue = [queueRow("a", { games: 0, status: "drafted" }), queueRow("w1", { games: 0 })];
    // ghost unknown → skipped; a is at pool min → no over-min seats → null.
    expect(deriveReuseNotice(roster, queue)).toBeNull();
  });
});
