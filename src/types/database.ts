// ============================================================
// Badminton App — TypeScript Interfaces
// Auto-generated from the Supabase PostgreSQL schema (v2).
//
// IMPORTANT: All row types use `type` (not `interface`).
// TypeScript 5.9 treats `interface` as "open" (mergeable),
// which prevents them from satisfying Record<string, unknown>
// in generic constraints — breaking the Supabase client's
// Schema generic. `type` aliases are sealed and work correctly.
// ============================================================

// ------------------------------------------------------------
// Enums (mirror the PostgreSQL custom types)
// ------------------------------------------------------------

export type SkillLevel =
  | "beginner"
  | "lower_intermediate"
  | "intermediate"
  | "upper_intermediate"
  | "lower_advanced"
  | "advanced";

/** Ordered array for UI dropdowns and display. Index = numeric level (0-based). */
export const SKILL_LEVELS: { value: SkillLevel; label: string; numeric: number }[] = [
  { value: "beginner",           label: "Beginner",           numeric: 1 },
  { value: "lower_intermediate", label: "Lower Intermediate", numeric: 2 },
  { value: "intermediate",       label: "Intermediate",       numeric: 3 },
  { value: "upper_intermediate", label: "Upper Intermediate", numeric: 4 },
  { value: "lower_advanced",     label: "Lower Advanced",     numeric: 5 },
  { value: "advanced",           label: "Advanced",           numeric: 6 },
];

/** Convert a SkillLevel enum to its numeric value (1–7). */
export function skillLevelToInt(level: SkillLevel): number {
  const entry = SKILL_LEVELS.find((s) => s.value === level);
  return entry?.numeric ?? 1;
}

export type CourtStatus = "available" | "in_use" | "closed";

export type QueueStatus = "waiting" | "on_deck" | "playing" | "left";

export type MatchStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type ScoringFormat = "single" | "best_of_3" | "best_of_5";

export type Team = "a" | "b";

// ------------------------------------------------------------
// Table Row Types  (type aliases — NOT interfaces)
// ------------------------------------------------------------

/** profiles table */
export type Profile = {
  id: string; // uuid — references auth.users
  display_name: string;
  skill_level: SkillLevel;
  pin: string | null; // 4-digit reconnect PIN
  created_at: string; // ISO 8601 timestamptz
  updated_at: string;
};

/** sessions table */
export type Session = {
  id: string;
  name: string;
  created_by: string; // uuid — references profiles.id
  organizer_passcode: string | null;
  scoring: ScoringFormat;
  is_active: boolean;
  is_auto_matchmaking_on: boolean; // organizer toggle — auto-fill courts on match completion
  created_at: string;
  ended_at: string | null;
};

/** session_organizers table */
export type SessionOrganizer = {
  id: string;
  session_id: string;
  user_id: string;
  granted_at: string;
};

/** courts table */
export type Court = {
  id: string;
  session_id: string;
  name: string;
  status: CourtStatus;
  created_at: string;
};

/** queue_entries table */
export type QueueEntry = {
  id: string;
  session_id: string;
  player_id: string;
  joined_at: string;
  games_played: number;
  status: QueueStatus;
  position: number | null;
  /** Soft-pause: player stays visible but is excluded from matchmaking. */
  is_paused: boolean;
  created_at: string;
};

/** matches table */
export type Match = {
  id: string;
  session_id: string;
  court_id: string | null;
  status: MatchStatus;
  team_a_score: number | null;
  team_b_score: number | null;
  is_mixed_level: boolean;
  sort_order: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

/** match_games table (for multi-set scoring) */
export type MatchGame = {
  id: string;
  match_id: string;
  game_number: number;
  team_a_score: number;
  team_b_score: number;
  completed_at: string;
};

/** match_players table */
export type MatchPlayer = {
  id: string;
  match_id: string;
  player_id: string;
  team: Team;
};

// ------------------------------------------------------------
// View Types (enriched / computed)
// ------------------------------------------------------------

/** v_queue_with_wait_time view */
export type QueueWithWaitTime = QueueEntry & {
  display_name: string;
  skill_level: SkillLevel;
  skill_level_int: number;
  wait_minutes: number;
  is_bottleneck: boolean;
};

/** Individual game score object (inside v_match_history.game_scores) */
export type GameScore = {
  game_number: number;
  team_a_score: number;
  team_b_score: number;
};

/** v_match_history view */
export type MatchHistory = {
  player_id: string;
  session_id: string;
  match_id: string;
  court_id: string | null;
  court_name: string | null;
  team: Team;
  team_a_score: number | null;
  team_b_score: number | null;
  match_status: MatchStatus;
  completed_at: string | null;
  game_scores: GameScore[] | null;
  teammates: string[] | null;
  opponents: string[] | null;
};

/** v_recent_pairings view */
export type RecentPairing = {
  player_a: string;
  player_b: string;
  session_id: string;
  completed_at: string;
  relationship: "teammate" | "opponent";
};

// ------------------------------------------------------------
// Insert / Update Types
// (Omit auto-generated fields for create operations)
// ------------------------------------------------------------

export type ProfileInsert = Pick<Profile, "id" | "display_name"> &
  Partial<Pick<Profile, "skill_level" | "pin">>;

export type ProfileUpdate = Partial<Pick<Profile, "display_name" | "skill_level" | "pin">>;

export type SessionInsert = Pick<Session, "name" | "created_by"> &
  Partial<Pick<Session, "organizer_passcode" | "scoring">>;

export type SessionUpdate = Partial<
  Pick<Session, "name" | "organizer_passcode" | "scoring" | "is_active" | "is_auto_matchmaking_on" | "ended_at">
>;

export type CourtInsert = Pick<Court, "session_id" | "name"> &
  Partial<Pick<Court, "status">>;

export type CourtUpdate = Partial<Pick<Court, "name" | "status">>;

export type QueueEntryInsert = Pick<QueueEntry, "session_id" | "player_id"> &
  Partial<Pick<QueueEntry, "status" | "joined_at" | "games_played" | "position">>;

export type QueueEntryUpdate = Partial<
  Pick<QueueEntry, "status" | "joined_at" | "games_played" | "position" | "player_id" | "is_paused">
>;

export type MatchInsert = Pick<Match, "session_id"> &
  Partial<Pick<Match, "court_id" | "status" | "started_at" | "is_mixed_level">>;

export type MatchUpdate = Partial<
  Pick<Match, "court_id" | "status" | "team_a_score" | "team_b_score" | "is_mixed_level" | "sort_order" | "started_at" | "completed_at">
>;

export type MatchGameInsert = Pick<MatchGame, "match_id" | "game_number" | "team_a_score" | "team_b_score">;

export type MatchGameUpdate = Partial<Pick<MatchGame, "team_a_score" | "team_b_score">>;

export type MatchPlayerInsert = Pick<MatchPlayer, "match_id" | "player_id" | "team">;

/** session_wrapped_stats table */
export type SessionWrappedStats = {
  id:             string;
  session_id:     string;
  player_id:      string;
  computed_at:    string;
  games_played:   number;
  wins:           number;
  losses:         number;
  points_for:     number;
  points_against: number;
  point_diff:     number;   // GENERATED ALWAYS AS (points_for - points_against)
  win_pct:        number;
  win_streak:     number;
  session_rank:   number | null;
  earned_awards:  string[];
  award_data:     Record<string, Record<string, unknown>>;
};

export type SessionWrappedStatsInsert = Omit<SessionWrappedStats, "id" | "point_diff" | "computed_at"> &
  Partial<Pick<SessionWrappedStats, "computed_at">>;

export type SessionWrappedStatsUpdate = Partial<Omit<SessionWrappedStats, "id" | "session_id" | "player_id" | "point_diff">>;

/** push_subscriptions table */
export type PushSubscription = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth_key: string;
  user_agent: string | null;
  created_at: string;
  updated_at: string;
};

export type PushSubscriptionInsert = Pick<
  PushSubscription,
  "user_id" | "endpoint" | "p256dh" | "auth_key"
> & Partial<Pick<PushSubscription, "user_agent">>;

export type PushSubscriptionUpdate = Partial<
  Pick<PushSubscription, "p256dh" | "auth_key" | "user_agent">
>;

// ------------------------------------------------------------
// Supabase Database Type
// (Required shape for createClient<Database>)
//
// Requirements for @supabase/supabase-js v2 + TypeScript 5.9:
//   1. All Row/Insert/Update types must be `type` aliases (not
//      `interface`) so they satisfy Record<string, unknown>.
//   2. Every table and view entry must include Relationships: [].
//   3. Tables that are append-only use Record<string, never>
//      for Update (not `never` directly).
//   4. The schema must have CompositeTypes for completeness.
// ------------------------------------------------------------

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: ProfileInsert;
        Update: ProfileUpdate;
        Relationships: [];
      };
      sessions: {
        Row: Session;
        Insert: SessionInsert;
        Update: SessionUpdate;
        Relationships: [];
      };
      session_organizers: {
        Row: SessionOrganizer;
        Insert: Pick<SessionOrganizer, "session_id" | "user_id">;
        Update: Record<string, never>;
        Relationships: [];
      };
      courts: {
        Row: Court;
        Insert: CourtInsert;
        Update: CourtUpdate;
        Relationships: [];
      };
      queue_entries: {
        Row: QueueEntry;
        Insert: QueueEntryInsert;
        Update: QueueEntryUpdate;
        Relationships: [];
      };
      matches: {
        Row: Match;
        Insert: MatchInsert;
        Update: MatchUpdate;
        Relationships: [];
      };
      match_games: {
        Row: MatchGame;
        Insert: MatchGameInsert;
        Update: MatchGameUpdate;
        Relationships: [];
      };
      match_players: {
        Row: MatchPlayer;
        Insert: MatchPlayerInsert;
        Update: Partial<Pick<MatchPlayer, "player_id">>;
        Relationships: [];
      };
      push_subscriptions: {
        Row: PushSubscription;
        Insert: PushSubscriptionInsert;
        Update: PushSubscriptionUpdate;
        Relationships: [];
      };
      session_wrapped_stats: {
        Row: SessionWrappedStats;
        Insert: SessionWrappedStatsInsert;
        Update: SessionWrappedStatsUpdate;
        Relationships: [];
      };
    };
    Views: {
      v_queue_with_wait_time: {
        Row: QueueWithWaitTime;
        Relationships: [];
      };
      v_match_history: {
        Row: MatchHistory;
        Relationships: [];
      };
      v_recent_pairings: {
        Row: RecentPairing;
        Relationships: [];
      };
      v_session_leaderboard: {
        Row: {
          player_id: string;
          session_id: string;
          display_name: string;
          games_played: number;
          wins: number;
          losses: number;
          points_for: number;
          points_against: number;
          point_diff: number;
          win_pct: number;
        };
        Relationships: [];
      };
      v_alltime_leaderboard_mat: {
        Row: {
          player_id: string;
          display_name: string;
          games_played: number;
          wins: number;
          losses: number;
          points_for: number;
          points_against: number;
          point_diff: number;
          win_pct: number;
        };
        Relationships: [];
      };
    };
    Functions: {
      elevate_to_organizer: {
        Args: { p_session_id: string; p_passcode: string };
        Returns: boolean;
      };
      rejoin_queue: {
        Args: { p_session_id: string };
        Returns: void;
      };
      skill_level_to_int: {
        Args: { lvl: SkillLevel };
        Returns: number;
      };
      get_player_streaks: {
        Args: { p_session_id?: string | null };
        Returns: { player_id: string; win_streak: number }[];
      };
      get_alltime_snapshot_before: {
        Args: { p_cutoff: string };
        Returns: {
          player_id: string;
          display_name: string;
          games_played: number;
          wins: number;
          losses: number;
          points_for: number;
          points_against: number;
          point_diff: number;
          win_pct: number;
        }[];
      };
      refresh_alltime_leaderboard: {
        Args: Record<string, never>;
        Returns: void;
      };
      swap_player_in_match: {
        Args: {
          p_match_id:      string;
          p_out_player_id: string;
          p_in_player_id:  string;
          p_session_id:    string;
          p_team:          "a" | "b";
        };
        Returns: void;
      };
      create_match_with_players: {
        Args: {
          p_session_id:     string;
          p_court_id:       string | null;
          p_status:         string;
          p_is_mixed_level: boolean;
          p_started_at:     string | null;
          p_is_on_deck:     boolean;
          p_team_a_ids:     string[];
          p_team_b_ids:     string[];
        };
        Returns: string; // UUID of the new match
      };
      compute_session_wrapped: {
        Args: { p_session_id: string };
        Returns: void;
      };
    };
    Enums: {
      skill_level: SkillLevel;
      court_status: CourtStatus;
      queue_status: QueueStatus;
      match_status: MatchStatus;
      scoring_format: ScoringFormat;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};
