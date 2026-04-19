// ============================================================
// Leaderboard TypeScript Types
// ============================================================
// These types mirror the exact column shapes returned by:
//   • public.v_session_leaderboard  (Regular VIEW)
//   • public.v_alltime_leaderboard_mat  (Materialized VIEW)
//   • public.get_player_streaks()   (SQL function)
//
// IMPORTANT: All types use `type` aliases (not `interface`)
// to satisfy Supabase's Record<string, unknown> generic
// constraints — consistent with src/types/database.ts.
// ============================================================

// ------------------------------------------------------------
// Raw DB Row Types (mirror view columns 1-to-1)
// ------------------------------------------------------------

/** Row returned by v_session_leaderboard */
export type SessionLeaderboardEntry = {
  player_id: string;      // uuid
  session_id: string;     // uuid
  display_name: string;
  games_played: number;
  wins: number;
  losses: number;
  points_for: number;
  points_against: number;
  point_diff: number;
  win_pct: number;        // e.g. 71.4
};

/** Row returned by v_alltime_leaderboard_mat */
export type AllTimeLeaderboardEntry = {
  player_id: string;      // uuid
  display_name: string;
  games_played: number;
  wins: number;
  losses: number;
  points_for: number;
  points_against: number;
  point_diff: number;
  win_pct: number;        // e.g. 71.4
};

/** Row returned by get_player_streaks() */
export type PlayerStreak = {
  player_id: string;      // uuid
  win_streak: number;     // consecutive wins; 0 if most recent match was a loss
};

// ------------------------------------------------------------
// Enriched Client-Side Types
// (computed in TypeScript after fetching from DB)
// ------------------------------------------------------------

/**
 * A fully enriched leaderboard row ready for rendering.
 * Derived from SessionLeaderboardEntry | AllTimeLeaderboardEntry
 * after merging streaks, computing rank, and calculating rank delta.
 */
export type LeaderboardRow = {
  // Core stats (from DB view)
  player_id: string;
  display_name: string;
  games_played: number;
  wins: number;
  losses: number;
  points_for: number;
  points_against: number;
  point_diff: number;
  win_pct: number;

  // Computed in TypeScript
  rank: number;           // 1-based position after tie-breaker sort
  win_streak: number;     // 0 if no active streak or most recent match was a loss

  /**
   * All-time tab only. Delta vs. 7 days ago.
   *   positive  → moved up   (show ↑N in green)
   *   negative  → moved down (show ↓N in red)
   *   0         → no change  (show —)
   *   null      → new entrant this week (show ✦ NEW)
   */
  rank_movement: number | null;
};

// ------------------------------------------------------------
// Action Return Types
// ------------------------------------------------------------

export type GetSessionLeaderboardResult = {
  success: true;
  rows: LeaderboardRow[];
} | {
  success: false;
  error: string;
};

export type GetAllTimeLeaderboardResult = {
  success: true;
  rows: LeaderboardRow[];
} | {
  success: false;
  error: string;
};

// ------------------------------------------------------------
// Leaderboard Variant (controls which features render)
// ------------------------------------------------------------

/**
 * Controls which features are visible in LeaderboardPage:
 *   standalone      — /leaderboard/[sessionId] public page; all features
 *   player-panel    — embedded in player dashboard tab; session only, compact
 *   organizer-panel — embedded in organizer dashboard tab; session only, full
 */
export type LeaderboardVariant = "standalone" | "player-panel" | "organizer-panel";

// ------------------------------------------------------------
// Supabase Database type extensions
// (add these to the Database.public.Views map in database.ts
//  and the Functions map when the full Database type is updated)
// ------------------------------------------------------------

/**
 * Minimal shape for supabase.rpc('get_player_streaks', ...) return type.
 * Cast with `as PlayerStreak[]` after the RPC call.
 */
export type GetPlayerStreaksArgs = {
  p_session_id?: string | null;
};
