// ============================================================
// match-history-filter — pure helpers for organizer player filter
// ============================================================
// All functions are pure (no side effects, no imports of React/Supabase).
// They operate over CompletedMatch[] which is already client-side in
// useMatchHistory — no new network trips are needed.
// ============================================================

import type { CompletedMatch } from "@/hooks/use-match-history";
import type { SkillLevel } from "@/types/database";
import { normalizeName } from "@/lib/normalize-name";

// ── Public types ───────────────────────────────────────────────

export type PlayerOption = {
  player_id: string;
  display_name: string;
  skill_level: SkillLevel;
  count: number;
  /** Short player_id suffix shown when two options share the same display_name. null = no collision. */
  disambiguator: string | null;
};

// ── filterMatchesByPlayer ──────────────────────────────────────

/**
 * Return the subset of matches where the selected player is on the final roster.
 * null id → identity (returns the same array reference, no copy).
 *
 * Predicate keys on player_id (final roster membership).  A player who was
 * swapped out or whose leave triggered the cancellation will NOT appear because
 * their match_players row was deleted before this data was fetched.
 */
export function filterMatchesByPlayer(
  matches: CompletedMatch[],
  id: string | null
): CompletedMatch[] {
  if (!id) return matches;
  return matches.filter((m) => m.players.some((p) => p.player_id === id));
}

// ── derivePlayerOptions ────────────────────────────────────────

/**
 * Build a sorted, deduplicated option list from every player present on any
 * match roster.  Only players who finished at least one match appear — this
 * guarantees every selectable name yields ≥1 result.
 *
 * When two distinct player_ids share the same display_name a short
 * disambiguator (last 4 chars of the player_id) is set on each colliding
 * entry so the picker can render "Maria Santos · a1b2" vs "Maria Santos · c3d4".
 *
 * Collisions are keyed on `normalizeName` — the repo's single source of truth
 * for name identity (parity-locked to the SQL index expression). Do not fork a
 * local `.trim().toLowerCase()` here: the whole point of that module is that
 * one definition answers "same name?" everywhere.
 *
 * Which collisions actually reach this code: `idx_profiles_unique_active_name`
 * already blocks case/whitespace variants for ordinary profiles, so a plain
 * "Maria Santos" vs "maria santos" pair cannot exist. What CAN exist is a
 * `needs_rename = true` profile — the flagged half of a duplicate identity is
 * exempt from that index precisely so the collision can sit there until the
 * organizer resolves it. That flagged row is the case this handles, and it is
 * exactly the case where a raw-string key would fail: the two rows differ only
 * by case or by collapsed whitespace, both render identically in the picker,
 * and without normalization neither would get a disambiguator.
 */
export function derivePlayerOptions(matches: CompletedMatch[]): PlayerOption[] {
  const byId = new Map<
    string,
    { player_id: string; display_name: string; skill_level: SkillLevel; count: number }
  >();

  for (const m of matches) {
    for (const p of m.players) {
      const cur = byId.get(p.player_id);
      if (cur) {
        cur.count += 1;
      } else {
        byId.set(p.player_id, {
          player_id: p.player_id,
          display_name: p.profile.display_name,
          skill_level: p.profile.skill_level,
          count: 1,
        });
      }
    }
  }

  const sorted = [...byId.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));

  // Detect name collisions and attach a disambiguator to each colliding entry.
  const nameCounts = new Map<string, number>();
  for (const opt of sorted) {
    const key = normalizeName(opt.display_name);
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  return sorted.map((opt) => ({
    ...opt,
    disambiguator:
      (nameCounts.get(normalizeName(opt.display_name)) ?? 1) > 1 ? opt.player_id.slice(-4) : null,
  }));
}

// ── resolvePartnerIds ──────────────────────────────────────────

/**
 * Return the player_ids of teammates (same team, different id) of the
 * selected player within a single match.
 * Returns [] if the selected player is not on this match's roster.
 */
export function resolvePartnerIds(match: CompletedMatch, id: string): string[] {
  const selfRow = match.players.find((p) => p.player_id === id);
  if (!selfRow) return [];
  const selfTeam = selfRow.team;
  return match.players
    .filter((p) => p.team === selfTeam && p.player_id !== id)
    .map((p) => p.player_id);
}

// ── selectionStillValid ────────────────────────────────────────

/**
 * True iff the given player_id appears on at least one roster in matches.
 *
 * Checks RAW matches roster membership (never the derived playerOptions array),
 * so future filtering of the option list cannot hide a still-valid selection.
 *
 * Used in the reconcile effect inside MatchHistoryPanel to detect when a
 * filter has become stale (e.g. after an identity merge rewrites player_id, or
 * all of a player's matches are reverted to in_progress via FixRecordSheet).
 * The reconcile keeps the chip visible (safety-net) rather than auto-clearing.
 */
export function selectionStillValid(matches: CompletedMatch[], id: string): boolean {
  return matches.some((m) => m.players.some((p) => p.player_id === id));
}
