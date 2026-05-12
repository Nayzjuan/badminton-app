// ─────────────────────────────────────────────────────────────────────────────
// Sandbox state machine — types
//
// Mirrors the real app's domain (Player, Match, Queue, Draft Mode) closely
// enough that the simulated organizer flow feels authentic, but lives entirely
// in client memory. Nothing here ever talks to Supabase.
// ─────────────────────────────────────────────────────────────────────────────

export type SkillLevel = "beginner" | "intermediate" | "advanced";

export type PlayerStatus =
  | "waiting" // in the queue, eligible to be drafted
  | "drafted" // earmarked in an unpublished draft; excluded from the waiting pool
  | "on_deck" // assigned to a published pending match
  | "in_progress" // playing right now
  | "paused" // soft-paused by organizer (skipped by engine)
  | "left"; // checked out

export type Player = {
  id: string;
  name: string;
  skill: SkillLevel;
  status: PlayerStatus;
  joinedAt: number;
  gamesPlayed: number;
};

export type MatchStatus =
  | "draft" // engine-generated but not yet visible to players
  | "pending" // published, on_deck, awaiting court
  | "in_progress" // playing
  | "completed"
  | "cancelled";

export type Team = readonly [string, string]; // exactly two player IDs

export type Match = {
  id: string;
  teamA: Team;
  teamB: Team;
  status: MatchStatus;
  isPublished: boolean; // mirrors Draft Mode in the real app
  origin: "engine" | "manual";
  createdAt: number;
  scoreA?: number;
  scoreB?: number;
};

export type LogLevel = "info" | "warn" | "error" | "debug" | "engine";

export type LogEntry = {
  id: string;
  ts: number;
  level: LogLevel;
  msg: string;
};

export type SandboxConfig = {
  courts: number; // active courts (controls capacity)
  maxAutoDrafts: number; // mirrors MAX_AUTO_DRAFTS in the real engine
  maxPartnershipRepeats: number; // mirrors MAX_PARTNERSHIP_REPEATS
  minFreePoolForOnDeck: number; // mirrors MIN_FREE_POOL_FOR_ON_DECK
};

export type SandboxState = {
  players: Record<string, Player>; // by id
  queueOrder: string[]; // ordered ids of players currently associated with the queue
  matches: Match[];
  log: LogEntry[];
  partnershipCounts: Record<string, number>; // pairKey -> count
  config: SandboxConfig;
};

// ── Action types (discriminated union) ───────────────────────────────────────
export type SandboxAction =
  | { type: "RESET" }
  | { type: "REORDER_QUEUE"; from: number; to: number }
  | { type: "TOGGLE_PAUSE"; playerId: string }
  | { type: "LEAVE_QUEUE"; playerId: string }
  | { type: "JOIN_QUEUE"; player: Player }
  | { type: "GENERATE_MATCHES" }
  | { type: "PUBLISH_MATCH"; matchId: string }
  | { type: "PUBLISH_ALL_DRAFTS" }
  | { type: "CANCEL_MATCH"; matchId: string }
  | { type: "START_MATCH"; matchId: string }
  | { type: "SUBMIT_SCORE"; matchId: string; scoreA: number; scoreB: number }
  | { type: "CLEAR_LOG" }
  | { type: "LOG"; entry: Omit<LogEntry, "id" | "ts"> };

// ── Helpers shared across state + engine ─────────────────────────────────────
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
