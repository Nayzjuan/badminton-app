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
  player_id: string; // uuid
  session_id: string; // uuid
  display_name: string;
  games_played: number;
  wins: number;
  losses: number;
  points_for: number;
  points_against: number;
  point_diff: number;
  win_pct: number; // e.g. 71.4
  vip_tag: string | null; // folded into the RPC (2026-07 DB audit) — no separate buildVipMap query
  vip_theme: string | null;
};

/** Row returned by v_alltime_leaderboard_mat */
export type AllTimeLeaderboardEntry = {
  player_id: string; // uuid
  display_name: string;
  games_played: number;
  wins: number;
  losses: number;
  points_for: number;
  points_against: number;
  point_diff: number;
  win_pct: number; // e.g. 71.4
};

/** Row returned by get_monthly_leaderboard(year, month) — same columns as
 *  the all-time view (no session_id); the month is fixed by the RPC args. */
export type MonthlyLeaderboardEntry = {
  player_id: string; // uuid
  display_name: string;
  games_played: number;
  wins: number;
  losses: number;
  points_for: number;
  points_against: number;
  point_diff: number;
  win_pct: number; // e.g. 71.4
  vip_tag: string | null; // folded into the RPC (2026-07 DB audit)
  vip_theme: string | null;
};

/** A selectable month in the Monthly leaderboard picker.
 *  year/month are the Manila calendar year + 1-based month; label is "June 2026". */
export type LeaderboardMonth = {
  year: number;
  month: number; // 1–12
  label: string; // "June 2026"
};

/** Row returned by get_player_streaks() */
export type PlayerStreak = {
  player_id: string; // uuid
  win_streak: number; // consecutive wins; 0 if most recent match was a loss
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
  rank: number; // 1-based position after tie-breaker sort
  win_streak: number; // 0 if no active streak or most recent match was a loss

  /**
   * All-time tab only. Delta vs. 7 days ago.
   *   positive  → moved up   (show ↑N in green)
   *   negative  → moved down (show ↓N in red)
   *   0         → no change  (show —)
   *   null      → new entrant this week (show ✦ NEW)
   */
  rank_movement: number | null;

  // VIP badge — fetched from profiles in the server action
  vip_tag: string | null;
  vip_theme: string | null;
};

// ------------------------------------------------------------
// Action Return Types
// ------------------------------------------------------------

export type GetSessionLeaderboardResult =
  | {
      success: true;
      rows: LeaderboardRow[];
    }
  | {
      success: false;
      error: string;
    };

export type GetAllTimeLeaderboardResult =
  | {
      success: true;
      rows: LeaderboardRow[];
    }
  | {
      success: false;
      error: string;
    };

/**
 * Return type for getPlayerStats().
 * row = null means the player has zero games in this scope (no row in the view).
 * row.rank = 0 means the player has games but hasn't hit the minimum GP threshold.
 */
export type GetPlayerStatsResult =
  | {
      success: true;
      row: LeaderboardRow | null;
    }
  | {
      success: false;
      error: string;
    };

/** Return type for getMonthlyLeaderboard(year, month). */
export type GetMonthlyLeaderboardResult =
  | { success: true; rows: LeaderboardRow[] }
  | { success: false; error: string };

/** Return type for getLeaderboardMonths(). Newest month first; always includes
 *  the current Manila month even if it has no matches yet. */
export type GetLeaderboardMonthsResult =
  | { success: true; months: LeaderboardMonth[] }
  | { success: false; error: string };

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
