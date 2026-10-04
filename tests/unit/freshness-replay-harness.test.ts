// ============================================================
// Freshness replay harness — unit tests
// ============================================================
// Intent: the pre-deploy gate's inputs are deterministic and the
// draft-queue simulator actually composes matches. The numeric
// G-1…G-11 table is scripts/replay-freshness-gate.ts (not CI).
// ============================================================

import { describe, expect, it } from "vitest";
import { replaySession } from "../../scripts/replay/simulate";
import { syntheticFixture } from "../../scripts/replay/synthetic";

describe("synthetic fixtures", () => {
  it("same seed is byte-identical", () => {
    expect(syntheticFixture(7)).toEqual(syntheticFixture(7));
    expect(syntheticFixture(7).sessionId).not.toBe(syntheticFixture(8).sessionId);
  });

  it("has 16–30 players, 2–4 courts, and at least one duration per court", () => {
    const f = syntheticFixture(3);
    expect(f.players.length).toBeGreaterThanOrEqual(16);
    expect(f.players.length).toBeLessThanOrEqual(30);
    expect(f.courts.length).toBeGreaterThanOrEqual(2);
    expect(f.courts.length).toBeLessThanOrEqual(4);
    for (const c of f.courts) expect(c.durationsMin.length).toBeGreaterThan(0);
  });
});

describe("draft-queue replay", () => {
  it("composes matches and never stalls the whole synthetic session", () => {
    const fixture = syntheticFixture(1);
    const off = replaySession(fixture, { freshness: false, draftQueue: true });
    const on = replaySession(fixture, { freshness: true, draftQueue: true });
    expect(off.matches.length).toBeGreaterThan(0);
    expect(on.matches.length).toBeGreaterThan(0);
    expect(on.diagnostics.stallEpisodes).toBeLessThanOrEqual(off.diagnostics.stallEpisodes + 1);
  });

  it("draft-queue waitingCount is unfiltered so both courts refill together", () => {
    const players = Array.from({ length: 16 }, (_, i) => ({
      player_id: `p${i}`,
      display_name: `P${i}`,
      skill_level_int: 3,
      skill_level: "intermediate",
      joinMin: 0,
    }));
    const fixture = {
      sessionId: "pair-refill",
      name: "pair-refill",
      day: "synthetic",
      t0: "2026-01-01T00:00:00.000Z",
      players,
      courts: [
        { id: "c0", name: "C0", durationsMin: Array(10).fill(20) },
        { id: "c1", name: "C1", durationsMin: Array(10).fill(20) },
      ],
      horizonMin: 80,
      realMatches: [],
    };
    const result = replaySession(fixture, { freshness: false, draftQueue: true });
    expect(result.matches.filter((m) => Math.abs(m.startMin - 40) < 1e-6).length).toBe(2);
  });

  it("ON cannot return a match when OFF cannot (per-call fail-open on a thin tick)", () => {
    const fixture = syntheticFixture(2);
    fixture.players = fixture.players.slice(0, 3);
    const off = replaySession(fixture, { freshness: false, draftQueue: true });
    const on = replaySession(fixture, { freshness: true, draftQueue: true });
    expect(off.matches.length).toBe(0);
    expect(on.matches.length).toBe(0);
  });
});
