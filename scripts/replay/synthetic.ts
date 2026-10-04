// ============================================================
// Seeded synthetic sessions for the freshness gate
// ============================================================
//
// Deterministic (mulberry32). Skewed skill mixes so thin beginner
// bands show up, plus staggered arrivals and a few early departures.

import type { SessionFixture } from "./types";

const SKILLS = [
  "beginner",
  "lower_intermediate",
  "intermediate",
  "upper_intermediate",
  "lower_advanced",
  "advanced",
] as const;

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function syntheticFixture(seed: number): SessionFixture {
  const rnd = mulberry32(seed);
  const nPlayers = 16 + Math.floor(rnd() * 15); // 16–30
  const nCourts = 2 + Math.floor(rnd() * 3); // 2–4
  const horizonMin = 180 + Math.floor(rnd() * 61); // 180–240

  // Skew: 3 beginners, rest clustered mid-band so ±2 alternatives exist.
  const skillInts: number[] = [];
  for (let i = 0; i < 3; i++) skillInts.push(1);
  for (let i = 3; i < nPlayers; i++) {
    skillInts.push(2 + Math.floor(rnd() * 3)); // 2–4
  }

  const players = skillInts.map((skill, i) => ({
    player_id: `syn-${seed}-p${i}`,
    display_name: `P${i}`,
    skill_level_int: skill,
    skill_level: SKILLS[skill - 1],
    joinMin: i < 8 ? 0 : Math.floor(rnd() * 80),
    leaveMin: i >= nPlayers - 2 && rnd() > 0.4 ? 90 + Math.floor(rnd() * 60) : undefined,
  }));

  const courts = Array.from({ length: nCourts }, (_, c) => ({
    id: `syn-${seed}-c${c}`,
    name: `Court ${c + 1}`,
    durationsMin: Array.from({ length: 12 }, () => 12 + Math.floor(rnd() * 11)),
  }));

  return {
    sessionId: `synthetic-${seed}`,
    name: `synthetic ${seed} (${nPlayers}p/${nCourts}c)`,
    day: "synthetic",
    t0: "2026-01-01T00:00:00.000Z",
    players,
    courts,
    horizonMin,
    realMatches: [],
  };
}
