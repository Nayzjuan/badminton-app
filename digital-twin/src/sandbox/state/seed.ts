// ─────────────────────────────────────────────────────────────────────────────
// Sandbox seed — 10 mock players staggered into a fresh queue.
// Names are intentionally varied (no all-Anglo bias). Skills span all 3 levels.
// ─────────────────────────────────────────────────────────────────────────────
import type { Player, SandboxState, SkillLevel } from "./types";

const SEED_PLAYERS: ReadonlyArray<{ name: string; skill: SkillLevel }> = [
  { name: "Alex", skill: "intermediate" },
  { name: "Bria", skill: "advanced" },
  { name: "Carlos", skill: "beginner" },
  { name: "Dani", skill: "intermediate" },
  { name: "Esmé", skill: "advanced" },
  { name: "Fariq", skill: "beginner" },
  { name: "Gita", skill: "intermediate" },
  { name: "Hiro", skill: "intermediate" },
  { name: "Ivy", skill: "advanced" },
  { name: "Jules", skill: "beginner" },
];

export function initialState(): SandboxState {
  const players: Record<string, Player> = {};
  const queueOrder: string[] = [];
  const now = Date.now();

  SEED_PLAYERS.forEach((p, i) => {
    const id = `p${i + 1}`;
    // Stagger join times: first player joined ~10 min ago, last just now.
    players[id] = {
      id,
      name: p.name,
      skill: p.skill,
      status: "waiting",
      joinedAt: now - (SEED_PLAYERS.length - i) * 60_000,
      gamesPlayed: 0,
    };
    queueOrder.push(id);
  });

  return {
    players,
    queueOrder,
    matches: [],
    log: [
      {
        id: "l_init",
        ts: now,
        level: "info",
        msg: "[sandbox] mock environment seeded — 10 players queued, 0 matches",
      },
    ],
    partnershipCounts: {},
    config: {
      courts: 2,
      maxAutoDrafts: 3,
      maxPartnershipRepeats: 2,
      minFreePoolForOnDeck: 4,
    },
  };
}
