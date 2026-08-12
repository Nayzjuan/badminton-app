// ============================================================
// Replay harness — shared types
// ============================================================
//
// A "fixture" is one real production session frozen to JSON: who was there,
// what skill they were, when each of them joined the queue, how many courts
// ran, and how long each match on each court actually took. It is the input
// to an offline replay of the CURRENT engine over that session's real shape.
//
// A "PlayedMatch" is the common denominator between the real session and a
// replayed one, so the same metrics module can score both. That comparison is
// the whole point: "the engine as it stands would have done X on the night
// people complained" is a measurable claim, and so is "the change makes X
// better".

/** One real session, frozen for offline replay. Cached under .replay-cache/. */
export type SessionFixture = {
  sessionId: string;
  name: string;
  /** Session date (YYYY-MM-DD, Manila) — display only. */
  day: string;
  /** Origin instant for every *Min field below (ISO). = earliest queue join. */
  t0: string;
  players: FixturePlayer[];
  courts: FixtureCourt[];
  /** Minutes from t0 to the last real match completion — the replay's horizon. */
  horizonMin: number;
  /** What actually happened, for the real-vs-replay column. */
  realMatches: PlayedMatch[];
};

export type FixturePlayer = {
  player_id: string;
  display_name: string;
  /** 1–6, via skillLevelToInt — the value the engine's skill window reads. */
  skill_level_int: number;
  /** The raw enum, carried so scored rows are shape-identical to the view's. */
  skill_level: string;
  /** Minutes from t0 when this player entered the queue. 0 = first to arrive. */
  joinMin: number;
};

export type FixtureCourt = {
  id: string;
  name: string;
  /**
   * Real match durations on this court, in the order they were played. The
   * replay consumes them in sequence so court turnover keeps the session's
   * actual rhythm instead of a made-up constant, and wraps to the start of the
   * list if it outlasts them. Never empty: a court with no observed match is
   * dropped from the fixture rather than given a synthetic duration.
   */
  durationsMin: number[];
};

/**
 * A match as played — real or replayed. Teams are player-ID arrays; the metrics
 * module never needs anything else.
 */
export type PlayedMatch = {
  seq: number;
  courtId: string;
  startMin: number;
  endMin: number;
  teamA: string[];
  teamB: string[];
  /** Replay only: the algorithm reported this as a Tier-3 / fallback repeat. */
  forcedRepeat?: boolean;
  /** Replay only: composed under a widened skill window. */
  isMixedLevel?: boolean;
};

/**
 * What a replay reports beyond the match list itself.
 *
 * The two failure counters count ENGINE EVALUATIONS, not distinct stalls: a
 * court that cannot be filled is re-evaluated at every subsequent event until
 * something changes, so one genuine stall can log several. Read them as "how
 * often the engine was asked and came back empty", not "how many times the
 * session got stuck".
 */
export type ReplayDiagnostics = {
  /** Evaluations where the algorithm returned no proposal at all. */
  noMatchEvents: number;
  /** …of those, the ones the partnership cap caused. */
  capSaturationEvents: number;
  /** Proposals flagged forcedRepeat (Tier-3 rotation or last-resort fallback). */
  forcedRepeats: number;
  /** Evaluations skipped because fewer than 4 players were waiting. */
  thinPoolEvents: number;
};

export type ReplayResult = {
  fixture: SessionFixture;
  matches: PlayedMatch[];
  diagnostics: ReplayDiagnostics;
};
