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

// Provenance value-types live in the pure logic module (single source of
// truth shared by the RPC payloads, the UI, and the unit tests).
import type {
  MatchCreatedMethod,
  MatchClassification,
  MatchEventType,
  MatchPhase,
  MatchEventActorType,
  MatchMovement,
} from "@/lib/match-provenance";

export type {
  MatchCreatedMethod,
  MatchClassification,
  MatchEventType,
  MatchPhase,
  MatchEventActorType,
  MatchMovement,
};

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
  { value: "beginner", label: "Beginner", numeric: 1 },
  { value: "lower_intermediate", label: "Lower Intermediate", numeric: 2 },
  { value: "intermediate", label: "Intermediate", numeric: 3 },
  { value: "upper_intermediate", label: "Upper Intermediate", numeric: 4 },
  { value: "lower_advanced", label: "Lower Advanced", numeric: 5 },
  { value: "advanced", label: "Advanced", numeric: 6 },
];

/** Convert a SkillLevel enum to its numeric value (1–7). */
export function skillLevelToInt(level: SkillLevel): number {
  const entry = SKILL_LEVELS.find((s) => s.value === level);
  return entry?.numeric ?? 1;
}

export type CourtStatus = "available" | "in_use" | "closed";

export type QueueStatus = "waiting" | "on_deck" | "playing" | "left" | "drafted";

export type MatchStatus = "pending" | "in_progress" | "completed" | "cancelled";

/**
 * @deprecated LEGACY input-only enum. The `matches.origin` COLUMN is dropped by
 * migration 20260617000001. This type survives ONLY because the create RPCs
 * still accept a `p_origin` argument that they map to `created_method`
 * (auto→auto, manual→manual; held drafts hard-set 'held' regardless).
 *
 * Provenance now lives in created_method (immutable birth) + modification_count
 * + the generated final_classification. The old sticky "WHERE origin='auto'"
 * guard is GONE — composition changes now increment modification_count on auto,
 * manual, AND held matches (so manual_modified is trackable). The "modified"
 * value no longer exists as a birth state. Do NOT use this for new analytics.
 */
export type MatchOrigin = "auto" | "manual" | "modified";

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
  /**
   * VIP tag label shown as a floating badge (e.g. "DEV", "MVP").
   * Set directly in the Supabase dashboard. null = no tag.
   */
  vip_tag: string | null;
  /**
   * VIP theme key that controls the visual treatment (neon/holo).
   * Must match a key in VIP_THEMES from @/lib/vip-config.
   */
  vip_theme: string | null;
  /**
   * Duplicate-name resolution (Scope A). true = this profile is a flagged
   * duplicate that must be renamed at the next login/join before proceeding.
   */
  needs_rename: boolean;
  /**
   * The exact display_name this profile collided on. Persisted so R1 ("cannot
   * reuse the duplicated name") holds even after the canonical sibling is
   * merged/renamed away. null when not flagged.
   */
  collided_name: string | null;
  /** When the duplicate flag was set. null when not flagged. */
  flagged_at: string | null;
  created_at: string; // ISO 8601 timestamptz
  updated_at: string;
};

/**
 * profiles columns safe to bulk-select for players OTHER than the caller —
 * excludes `pin`. The authenticated role's column privilege on profiles no
 * longer includes `pin` (column lockdown), so a bare select("*") throws
 * `permission denied for table profiles` (42501). Use with `pin: null` when
 * constructing a `Profile` object so consumers keep a stable shape.
 */
export const PUBLIC_PROFILE_COLUMNS =
  "id, display_name, skill_level, vip_tag, vip_theme, needs_rename, collided_name, flagged_at, created_at, updated_at" as const;

/**
 * Every `sessions` column except `organizer_passcode` — the authenticated
 * role's column privilege no longer includes it, so a bare select("*") throws
 * `permission denied for table sessions` (42501). Use with
 * `organizer_passcode: null` when constructing a `Session` object.
 */
export const PUBLIC_SESSION_COLUMNS =
  "id, name, created_by, scoring, is_active, is_auto_matchmaking_on, court_time_limit_minutes, max_auto_drafts_override, auto_publish, created_at, ended_at" as const;

/** player_renames audit table — append-only record of name changes. */
export type PlayerRename = {
  id: string;
  player_id: string;
  old_name: string | null;
  new_name: string;
  reason: "duplicate_flag" | "organizer_manual" | "self_reconnect" | "data_fix_merge";
  actor_user_id: string | null;
  session_id: string | null;
  created_at: string;
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
  court_time_limit_minutes: number | null; // per-session court time cap; null = no limit
  /** Organizer cap on auto-draft generation. null = dynamic (3/5/6 by pool size). 1–5 = ceiling. */
  max_auto_drafts_override: number | null;
  /** Auto-publish mode: when true, engine-generated matches skip the draft gate
   *  and go straight to On Deck (is_published=true). false = manual review. */
  auto_publish: boolean;
  created_at: string;
  ended_at: string | null;
};

/** Head-to-head record for an exact 2v2 team pairing */
export type H2HRecord = {
  alltime_a: number;
  alltime_b: number;
  session_a: number;
  session_b: number;
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
  /** How the match was originally created. Immutable — never overwritten. */
  created_method: MatchCreatedMethod;
  /** Count of composition changes (roster/team) net of undos. 0 = clean. */
  modification_count: number;
  /** Generated 6-value ultimate label (created_method × modified?). Read-only. */
  final_classification: MatchClassification;
  /** True for rows backfilled at the audit cutover (no event trail; floored count). */
  provenance_backfilled: boolean;
  /**
   * Draft Mode — false until the organizer explicitly publishes.
   * Auto-engine matches start as false (drafts hidden from players/TV).
   * Manual matches are inserted with true (bypass draft review).
   */
  is_published: boolean;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  // ── Cross-Court Diversity Drafting (held drafts) — migration 20260607000000 ──
  /** Pulled (still-playing) bodies. `[]` = normal draft; exactly one element = held cross-court draft. */
  pulled_player_ids: string[];
  /** The live in_progress match the pulled body is finishing; null for non-held matches or once the source is deleted (ON DELETE SET NULL). */
  pulled_from_match_id: string | null;
  /** Stamped when the held draft first becomes promotable; null while Holding/Resting. */
  held_ready_at: string | null;
  /** GENERATED ALWAYS AS (cardinality(pulled_player_ids) > 0). Read-only — never write. */
  is_held: boolean;
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

/**
 * match_events table — append-only audit log of how a match was made and every
 * composition change it underwent. Written only by SECURITY DEFINER RPCs +
 * best-effort server-action logging; never updated or deleted.
 */
export type MatchEvent = {
  id: string;
  /** Live FK — null after the match row is deleted (snapshot preserves the id). */
  match_id: string | null;
  session_id: string | null;
  match_id_snapshot: string;
  session_id_snapshot: string;
  /** Per-match monotonic order (1,2,3,…). */
  seq: number;
  event_type: MatchEventType;
  /** Match status at the moment of the event. */
  phase: MatchPhase;
  actor_type: MatchEventActorType;
  actor_id: string | null;
  /** display_name snapshotted at write time (durable against profile merges/renames). */
  actor_name: string | null;
  /** Ties the two legs of a cross-match action (on-deck pull / cross-match draft swap). */
  correlation_id: string | null;
  /** For undo events — the event this reverses. */
  reverses_event_id: string | null;
  /** Granular player movements (RosterSwapMovement[] | TeamFlipMovement[]). */
  movements: MatchMovement[];
  /** Event-specific extras (created roster/method, score deltas, secondary_match_id). */
  payload: Record<string, unknown> | null;
  created_at: string;
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

/** v_queue_full_with_wait_time view — organizer/player display layer.
 *  Includes waiting + drafted + on_deck rows (excludes playing/left).
 *  Adds status_priority for sort: on_deck=0, drafted=1, waiting=2. */
export type QueueFullWithWaitTime = QueueWithWaitTime & {
  status_priority: number;
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
  /** Provenance, as exposed by the rebuilt v_match_history (migration 2). */
  created_method: MatchCreatedMethod;
  modification_count: number;
  final_classification: MatchClassification;
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

export type ProfileUpdate = Partial<
  Pick<
    Profile,
    | "display_name"
    | "skill_level"
    | "pin"
    | "vip_tag"
    | "vip_theme"
    | "needs_rename"
    | "collided_name"
    | "flagged_at"
  >
>;

export type SessionInsert = Pick<Session, "name" | "created_by"> &
  Partial<Pick<Session, "organizer_passcode" | "scoring" | "is_auto_matchmaking_on">>;

export type SessionUpdate = Partial<
  Pick<
    Session,
    | "name"
    | "organizer_passcode"
    | "scoring"
    | "is_active"
    | "is_auto_matchmaking_on"
    | "court_time_limit_minutes"
    | "max_auto_drafts_override"
    | "auto_publish"
    | "ended_at"
    | "created_by"
  >
>;

export type CourtInsert = Pick<Court, "session_id" | "name"> & Partial<Pick<Court, "status">>;

export type CourtUpdate = Partial<Pick<Court, "name" | "status">>;

export type QueueEntryInsert = Pick<QueueEntry, "session_id" | "player_id"> &
  Partial<Pick<QueueEntry, "status" | "joined_at" | "games_played" | "position">>;

export type QueueEntryUpdate = Partial<
  Pick<QueueEntry, "status" | "joined_at" | "games_played" | "position" | "player_id" | "is_paused">
>;

export type MatchInsert = Pick<Match, "session_id"> &
  Partial<
    Pick<
      Match,
      "court_id" | "status" | "started_at" | "is_mixed_level" | "created_method" | "is_published"
    >
  >;

export type MatchUpdate = Partial<
  Pick<
    Match,
    | "court_id"
    | "status"
    | "team_a_score"
    | "team_b_score"
    | "is_mixed_level"
    | "sort_order"
    | "started_at"
    | "completed_at"
    | "created_method"
    | "modification_count" // prod maintains this via record_match_event; allowed here for test seeding
    | "is_published"
    // final_classification is GENERATED — never written directly.
    // Cross-court held drafts: readiness stamp + downgrade-clear (is_held is GENERATED, never written).
    | "pulled_player_ids"
    | "pulled_from_match_id"
    | "held_ready_at"
  >
>;

export type MatchGameInsert = Pick<
  MatchGame,
  "match_id" | "game_number" | "team_a_score" | "team_b_score"
>;

export type MatchGameUpdate = Partial<Pick<MatchGame, "team_a_score" | "team_b_score">>;

export type MatchPlayerInsert = Pick<MatchPlayer, "match_id" | "player_id" | "team">;

/** session_wrapped_stats table */
export type SessionWrappedStats = {
  id: string;
  session_id: string;
  player_id: string;
  computed_at: string;
  games_played: number;
  wins: number;
  losses: number;
  points_for: number;
  points_against: number;
  point_diff: number; // GENERATED ALWAYS AS (points_for - points_against)
  win_pct: number;
  win_streak: number;
  session_rank: number | null;
  earned_awards: string[];
  award_data: Record<string, Record<string, unknown>>;
  intro_dismissed_at: string | null;
  /** Small payload written at session close, read by next session's RPC.
   *  Shape: { ended_on_win_streak: number, session_win_pct: number, session_id: string } */
  carry_forward: Record<string, unknown>;
};

export type SessionWrappedStatsInsert = Omit<
  SessionWrappedStats,
  "id" | "point_diff" | "computed_at" | "intro_dismissed_at" | "carry_forward"
> &
  Partial<Pick<SessionWrappedStats, "computed_at" | "intro_dismissed_at" | "carry_forward">>;

export type SessionWrappedStatsUpdate = Partial<
  Omit<SessionWrappedStats, "id" | "session_id" | "player_id" | "point_diff">
>;

/** player_rivalries table — running all-time H2H ledger between players (directional) */
export type PlayerRivalry = {
  player_id: string;
  rival_id: string;
  wins_vs: number;
  losses_vs: number;
  sessions_faced: number;
  last_session_id: string | null;
  last_faced_at: string | null;
  updated_at: string;
};

/** player_partnerships table — running all-time partnership ledger between players (directional) */
export type PlayerPartnership = {
  player_id: string;
  partner_id: string;
  games_together: number;
  wins_together: number;
  losses_together: number;
  sessions_together: number;
  last_session_id: string | null;
  last_played_at: string | null;
  updated_at: string;
};

/** identity_migrations table — audit log of every old → new UUID reconnect */
export type IdentityMigration = {
  id: string;
  old_id: string;
  new_id: string;
  display_name: string;
  migrated_at: string;
};

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
> &
  Partial<Pick<PushSubscription, "user_agent">>;

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
      match_events: {
        Row: MatchEvent;
        // Append-only: writes go through record_match_event RPC, never direct.
        Insert: never;
        Update: never;
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
      player_rivalries: {
        Row: PlayerRivalry;
        Insert: Omit<PlayerRivalry, "updated_at"> & Partial<Pick<PlayerRivalry, "updated_at">>;
        Update: Partial<Omit<PlayerRivalry, "player_id" | "rival_id">>;
        Relationships: [];
      };
      player_partnerships: {
        Row: PlayerPartnership;
        Insert: Omit<PlayerPartnership, "updated_at"> &
          Partial<Pick<PlayerPartnership, "updated_at">>;
        Update: Partial<Omit<PlayerPartnership, "player_id" | "partner_id">>;
        Relationships: [];
      };
      identity_migrations: {
        Row: IdentityMigration;
        Insert: Omit<IdentityMigration, "id" | "migrated_at">;
        Update: Record<string, never>; // append-only, no updates allowed
        Relationships: [];
      };
      player_renames: {
        Row: PlayerRename;
        Insert: Pick<PlayerRename, "player_id" | "new_name"> &
          Partial<Pick<PlayerRename, "old_name" | "reason" | "actor_user_id" | "session_id">>;
        Update: Record<string, never>; // append-only audit log
        Relationships: [];
      };
    };
    Views: {
      v_queue_with_wait_time: {
        Row: QueueWithWaitTime;
        Relationships: [];
      };
      v_queue_full_with_wait_time: {
        Row: QueueFullWithWaitTime;
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
      // Monthly leaderboard (migration 20260626000000). Live aggregation of one
      // Manila-month slice of completed matches. SECURITY INVOKER, public-read.
      get_monthly_leaderboard: {
        Args: { p_year: number; p_month: number };
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
      // Months selectable in the monthly picker — distinct Manila-months with
      // completed matches, plus the current month (always present), newest first.
      get_leaderboard_months: {
        Args: Record<string, never>;
        Returns: { year: number; month: number }[];
      };
      refresh_alltime_leaderboard: {
        Args: Record<string, never>;
        Returns: void;
      };
      rename_player_identity: {
        Args: { p_user_id: string; p_new_name: string };
        // jsonb: { success: true, new_name } | { success: false, error }
        Returns: {
          success: boolean;
          new_name?: string;
          error?: "profile_not_found" | "reused_dup_name" | "name_taken";
        };
      };
      swap_player_in_match: {
        Args: {
          p_match_id: string;
          p_out_player_id: string;
          p_in_player_id: string;
          p_session_id: string;
          p_team: "a" | "b";
          /** Optional — DB default true; pass false when swapping inside an unpublished draft. */
          p_is_published?: boolean;
          p_actor_id?: string | null;
          p_actor_name?: string | null;
          p_is_undo?: boolean;
          p_reverses_event_id?: string | null;
        };
        Returns: void;
      };
      swap_match_players: {
        Args: {
          p_a_match_id: string;
          p_a_player_id: string;
          p_b_match_id: string;
          p_b_player_id: string;
          p_actor_id?: string | null;
          p_actor_name?: string | null;
        };
        Returns: void;
      };
      create_match_with_players: {
        Args: {
          p_session_id: string;
          p_court_id: string | null;
          p_status: MatchStatus;
          p_is_mixed_level: boolean;
          p_started_at: string | null;
          p_is_on_deck: boolean;
          p_team_a_ids: string[];
          p_team_b_ids: string[];
          /** Optional — DB default 'auto' is used when omitted. */
          p_origin?: MatchOrigin;
          /** Optional — DB default false. Pass false (or omit) for engine drafts;
           *  queue_entries update is suppressed until publishMatchAction fires. */
          p_is_published?: boolean;
          /** Optional — organizer profile id for the 'created' audit event (manual matches). */
          p_actor_id?: string | null;
          /** Optional — organizer display_name snapshot for the audit event. */
          p_actor_name?: string | null;
        };
        Returns: string; // UUID of the new match
      };
      compute_session_wrapped: {
        Args: { p_session_id: string };
        Returns: void;
      };
      refresh_cross_session_stats: {
        Args: { p_session_id: string };
        Returns: void;
      };
      get_h2h_record: {
        Args: {
          p_team_a: string[];
          p_team_b: string[];
          p_session_id: string;
        };
        Returns: {
          alltime_a: number;
          alltime_b: number;
          session_a: number;
          session_b: number;
        }[];
      };
      // ── Wave 2 atomicity RPCs (migration 20260429000000) ────────
      toggle_auto_matchmaking: {
        Args: { p_session_id: string };
        /** Returns the NEW value of is_auto_matchmaking_on, or null if the session doesn't exist. */
        Returns: boolean | null;
      };
      migrate_player_identity: {
        Args: { p_old_user_id: string; p_new_user_id: string };
        /** Returns true when the old user is the primary organizer of an active session
         *  (server action must NOT delete their auth user). */
        Returns: boolean;
      };
      // ── QR-code join lookup (migration 20260502093938) ───────────
      lookup_active_session: {
        Args: { p_session_id: string };
        /** Returns at most one row.  Empty when the session does not exist
         *  or is no longer active.  Used by /play/join so anonymous QR-code
         *  visitors can resolve a session without needing direct SELECT
         *  on the underlying `sessions` table (which would expose
         *  organizer_passcode and created_by). */
        Returns: { id: string; name: string; is_active: boolean }[];
      };
      // ── Draft-mode atomicity RPCs ─────────────────────────────────
      revert_match_to_active: {
        Args: { p_match_id: string; p_session_id: string };
        Returns: void;
      };
      clear_on_deck_match_atomic: {
        Args: { p_match_id: string; p_session_id: string };
        Returns: string[];
      };
      publish_match: {
        Args: { p_match_id: string; p_session_id: string; p_user_id: string };
        Returns: string;
      };
      // Engine-initiated publish (no organizer). Auto-publish mode uses this to
      // publish a HELD draft the moment it becomes ready. Keeps left/conflict
      // guards. Returns 'SUCCESS' | 'HAS_LEFT_PLAYERS' | 'CONFLICT' |
      // 'NOT_PENDING' | 'ALREADY_PUBLISHED' | 'NOT_FOUND'.
      auto_publish_match: {
        Args: { p_match_id: string; p_session_id: string };
        Returns: string;
      };
      publish_all_drafts: {
        Args: { p_session_id: string; p_user_id: string };
        Returns: {
          success: boolean;
          error?: string;
          published_count?: number;
          skipped_count?: number;
        };
      };
      checkout_player_cleanup_drafts: {
        Args: { p_session_id: string; p_player_id: string };
        Returns: void;
      };
      // ── Match provenance audit (migration 20260617000000) ──
      // Standalone calls (best-effort lifecycle events) compute seq WITHOUT the
      // match row lock — acceptable for non-counting score/revert/cancel events.
      record_match_event: {
        Args: {
          p_match_id: string;
          p_session_id: string;
          p_event_type: MatchEventType;
          p_phase: MatchPhase;
          p_actor_type: MatchEventActorType;
          p_actor_id: string | null;
          p_actor_name: string | null;
          p_movements?: unknown;
          p_payload?: unknown;
          p_correlation_id?: string | null;
          p_reverses_event_id?: string | null;
        };
        Returns: string; // new event id
      };
      join_queue: {
        Args: { p_session_id: string; p_player_id: string };
        Returns: { success: boolean; error?: string; action?: string; games_played?: number };
      };
      remove_player_from_queue_organizer: {
        Args: { p_session_id: string; p_player_id: string };
        Returns: string[];
      };
      // ── Historical match roster correction (migration 20260522000000) ──
      fix_record_swap_player: {
        Args: {
          p_match_id: string;
          p_out_player_id: string;
          p_in_player_id: string;
          p_session_id: string;
          p_actor_id?: string | null;
          p_actor_name?: string | null;
        };
        Returns: void;
      };
      // ── Live match player swap (migration 20260601000000) ──
      swap_player_in_active_match: {
        Args: {
          p_match_id: string;
          p_out_player_id: string;
          p_in_player_id: string;
          p_session_id: string;
          p_team: string;
          p_actor_id?: string | null;
          p_actor_name?: string | null;
          /** When true, records an 'undo' event (decrements) instead of 'roster_swap'. */
          p_is_undo?: boolean;
          p_reverses_event_id?: string | null;
        };
        Returns: void;
      };
      swap_teams_in_active_match: {
        Args: {
          p_match_id: string;
          p_player_a_id: string;
          p_player_b_id: string;
          p_actor_id?: string | null;
          p_actor_name?: string | null;
          p_is_undo?: boolean;
          p_reverses_event_id?: string | null;
        };
        Returns: void;
      };
      swap_active_from_ondeck: {
        Args: {
          p_active_match_id: string;
          p_out_player_id: string;
          p_ondeck_player_id: string;
          p_ondeck_match_id: string;
          p_fill_player_id: string;
          p_session_id: string;
          p_actor_id?: string | null;
          p_actor_name?: string | null;
        };
        Returns: { o_out_team: string; o_ondeck_team: string }[];
      };
      undo_swap_active_from_ondeck: {
        Args: {
          p_active_match_id: string;
          p_out_player_id: string;
          p_ondeck_player_id: string;
          p_ondeck_match_id: string;
          p_fill_player_id: string;
          p_session_id: string;
          p_out_team: string;
          p_ondeck_team: string;
          p_actor_id?: string | null;
          p_actor_name?: string | null;
        };
        Returns: void;
      };
      // ── Draft cap override (migration 20260602000000) ──
      clear_all_unpublished_drafts: {
        Args: { p_session_id: string };
        Returns: string[]; // array of player UUIDs returned to 'waiting'
      };
      // ── Cross-Court Diversity Drafting (migration 20260607000000) ──
      create_held_cross_court_match: {
        Args: {
          p_session_id: string;
          p_is_mixed_level: boolean;
          p_team_a_ids: string[];
          p_team_b_ids: string[];
          p_pulled_player_id: string;
          p_pulled_from_match_id: string;
          /** Optional — DB default 'auto' (sets legacy origin; created_method is always 'held'). */
          p_origin?: MatchOrigin;
          p_actor_id?: string | null;
          p_actor_name?: string | null;
        };
        /** UUID of the new held draft, or NULL on any TOCTOU/reservation guard (graceful slot-skip). */
        Returns: string;
      };
    };
    Enums: {
      skill_level: SkillLevel;
      court_status: CourtStatus;
      queue_status: QueueStatus;
      match_status: MatchStatus;
      scoring_format: ScoringFormat;
      match_origin: MatchOrigin;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};
