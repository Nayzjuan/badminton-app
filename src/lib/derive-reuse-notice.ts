// ============================================================
// deriveReuseNotice — pure equity signal for draft review
// ============================================================
// Flags a draft match that seats players who are AHEAD on games
// while an equally-large (or larger) cohort of fresher players sits
// in the waiting pool. This is the organizer-facing half of the
// early-session diversity work: every court seating is organizer-
// gated (publish → call next match), so the human reviewing a draft
// is the last line of defence against recycling just-played alumni
// while zero-game players wait.
//
// Pure and DB-free (same pattern as cross-court/derive-held-state):
// callers pass the draft's roster ids plus the live queue rows the
// organizer dashboard already holds.
//
// Definition:
//   waiting     = queue rows with status='waiting' and not paused
//   poolMin     = min(games_played) across waiting
//   overMin     = roster members whose games_played > poolMin
//                 (looked up via their own queue row — drafted players
//                 keep a queue row with status='drafted')
//   fresher     = waiting players with games_played === poolMin
//
// Flag when overMin ≥ 1 AND fresher ≥ overMin — i.e. the draft could
// have drawn its over-minimum seats from the fresher cohort instead.
// Null (no notice) otherwise, including when data is insufficient.
// ============================================================

/** Minimal structural slice of a queue row this helper needs. */
export type ReuseQueueRow = {
  player_id: string;
  games_played: number;
  status: string;
  is_paused: boolean | null;
};

export type ReuseNotice = {
  /** Roster members seated with more games than the freshest waiting cohort. */
  overMinCount: number;
  /** Waiting (unpaused) players at the pool-minimum game count. */
  fresherWaiting: number;
  /** The pool-minimum games_played among waiting players. */
  poolMinGames: number;
};

export function deriveReuseNotice(
  rosterPlayerIds: string[],
  queue: ReuseQueueRow[]
): ReuseNotice | null {
  if (rosterPlayerIds.length === 0 || queue.length === 0) return null;

  const gamesById = new Map(queue.map((q) => [q.player_id, q.games_played]));

  const waiting = queue.filter((q) => q.status === "waiting" && !q.is_paused);
  if (waiting.length === 0) return null;

  const poolMinGames = waiting.reduce((min, q) => Math.min(min, q.games_played), Infinity);

  let overMinCount = 0;
  for (const id of rosterPlayerIds) {
    const games = gamesById.get(id);
    // Unknown roster member (no queue row visible) — skip rather than guess.
    if (games === undefined) continue;
    if (games > poolMinGames) overMinCount++;
  }
  if (overMinCount === 0) return null;

  const fresherWaiting = waiting.filter((q) => q.games_played === poolMinGames).length;
  if (fresherWaiting < overMinCount) return null;

  return { overMinCount, fresherWaiting, poolMinGames };
}
