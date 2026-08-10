// ============================================================
// Unit tests: src/lib/match-history-filter.ts
// ============================================================
// Case ids: MHF-*
// All helpers are pure functions over CompletedMatch[]; no DB/network/React.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  filterMatchesByPlayer,
  derivePlayerOptions,
  resolvePartnerIds,
  selectionStillValid,
} from "@/lib/match-history-filter";
import type { CompletedMatch } from "@/hooks/use-match-history";

// ── Minimal fixture builder ────────────────────────────────────

type PlayerSpec = { id: string; team: "a" | "b"; name: string; skill?: string };

function makeMatch(
  id: string,
  status: "completed" | "cancelled",
  players: PlayerSpec[]
): CompletedMatch {
  return {
    id,
    session_id: "sess-1",
    status,
    court_id: null,
    team_a_score: status === "completed" ? 21 : null,
    team_b_score: status === "completed" ? 18 : null,
    is_mixed_level: false,
    sort_order: null,
    origin: "auto",
    is_published: true,
    created_at: "2026-01-01T10:00:00Z",
    started_at: "2026-01-01T10:05:00Z",
    completed_at: "2026-01-01T10:20:00Z",
    is_held: false,
    final_classification: null,
    created_method: "auto",
    modification_count: 0,
    pulled_player_ids: [],
    provenance_backfilled: false,
    courtName: null,
    players: players.map((p) => ({
      id: `mp-${p.id}`,
      match_id: id,
      player_id: p.id,
      team: p.team,
      profile: {
        id: p.id,
        display_name: p.name,
        skill_level: (p.skill ??
          "intermediate") as CompletedMatch["players"][number]["profile"]["skill_level"],
        pin: null,
        vip_tag: null,
        vip_theme: null,
        needs_rename: false,
        collided_name: null,
        flagged_at: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    })),
  } as unknown as CompletedMatch;
}

// ── Fixture data ───────────────────────────────────────────────

const PLAYER_MARIA = "player-maria";
const PLAYER_JUN = "player-jun";
const PLAYER_CARL = "player-carl";
const PLAYER_ANNE = "player-anne";
const PLAYER_LEAVER = "player-leaver";

// Normal completed match: Maria+Jun (A) vs Carl+Anne (B)
const matchCompleted = makeMatch("match-1", "completed", [
  { id: PLAYER_MARIA, team: "a", name: "Maria Santos" },
  { id: PLAYER_JUN, team: "a", name: "Jun Dela Cruz" },
  { id: PLAYER_CARL, team: "b", name: "Carl Reyes" },
  { id: PLAYER_ANNE, team: "b", name: "Anne Villanueva" },
]);

// Organizer-cancelled: all 4 players' rows retained
const matchCancelledFull = makeMatch("match-2", "cancelled", [
  { id: PLAYER_MARIA, team: "a", name: "Maria Santos" },
  { id: PLAYER_JUN, team: "a", name: "Jun Dela Cruz" },
  { id: PLAYER_CARL, team: "b", name: "Carl Reyes" },
  { id: PLAYER_ANNE, team: "b", name: "Anne Villanueva" },
]);

// Leave-triggered cancel: leaver's row was DELETED before cancel —
// only the 3 remaining players appear on the match roster.
const matchCancelledLeaveTriggered = makeMatch("match-3", "cancelled", [
  { id: PLAYER_JUN, team: "a", name: "Jun Dela Cruz" },
  { id: PLAYER_CARL, team: "b", name: "Carl Reyes" },
  { id: PLAYER_ANNE, team: "b", name: "Anne Villanueva" },
  // PLAYER_LEAVER is intentionally absent — their row was deleted
]);

// Singles match: Maria (A) only
const matchSingles = makeMatch("match-4", "completed", [
  { id: PLAYER_MARIA, team: "a", name: "Maria Santos" },
  { id: PLAYER_CARL, team: "b", name: "Carl Reyes" },
]);

// Duplicate display_name: two distinct player_ids share "Maria Santos"
const PLAYER_MARIA_2 = "player-maria-2";
const matchDupName = makeMatch("match-5", "completed", [
  { id: PLAYER_MARIA, team: "a", name: "Maria Santos" },
  { id: PLAYER_MARIA_2, team: "b", name: "Maria Santos" },
  { id: PLAYER_CARL, team: "a", name: "Carl Reyes" },
  { id: PLAYER_ANNE, team: "b", name: "Anne Villanueva" },
]);

// Case/whitespace-variant duplicate. `idx_profiles_unique_active_name` blocks
// this for ordinary profiles, but a `needs_rename = true` profile is exempt
// from that index — so the flagged half of a duplicate identity can legitimately
// carry a variant spelling until the organizer resolves it. Both render
// identically in the picker, so both must get a disambiguator.
const PLAYER_MARIA_3 = "player-maria-3";
const matchDupNameVariant = makeMatch("match-6", "completed", [
  { id: PLAYER_MARIA, team: "a", name: "Maria Santos" },
  { id: PLAYER_MARIA_3, team: "b", name: "  maria   SANTOS " },
  { id: PLAYER_CARL, team: "a", name: "Carl Reyes" },
  { id: PLAYER_ANNE, team: "b", name: "Anne Villanueva" },
]);

// ── filterMatchesByPlayer ──────────────────────────────────────

describe("filterMatchesByPlayer", () => {
  const matches = [matchCompleted, matchCancelledFull, matchCancelledLeaveTriggered];

  it("MHF-1: null id returns all matches unchanged (identity passthrough)", () => {
    expect(filterMatchesByPlayer(matches, null)).toBe(matches);
  });

  it("MHF-2: returns matches where the player is on the final roster", () => {
    const result = filterMatchesByPlayer(matches, PLAYER_MARIA);
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.id)).toEqual(["match-1", "match-2"]);
  });

  it("MHF-3: a player not on any match returns empty array", () => {
    expect(filterMatchesByPlayer(matches, "player-nobody")).toHaveLength(0);
  });

  it("MHF-4: cancelled match IS included for players whose row was retained (organizer-cancel path)", () => {
    const result = filterMatchesByPlayer([matchCancelledFull], PLAYER_MARIA);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("match-2");
  });

  it("MHF-5: leave-triggered cancel — leaver is absent from that match roster", () => {
    // The leaver's match_players row was deleted before the match was cancelled.
    const result = filterMatchesByPlayer([matchCancelledLeaveTriggered], PLAYER_LEAVER);
    expect(result).toHaveLength(0);
  });

  it("MHF-6: leave-triggered cancel — remaining players ARE found on that cancelled match", () => {
    const result = filterMatchesByPlayer([matchCancelledLeaveTriggered], PLAYER_JUN);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("match-3");
  });

  it("MHF-7: swapped-out player absent — only the final-roster player is found", () => {
    // A swapped-in player (PLAYER_ANNE) appears; the swapped-out player would have been
    // a different id (simulated by using a player not in the roster).
    const SWAPPED_OUT = "player-swapped-out";
    const result = filterMatchesByPlayer([matchCompleted], SWAPPED_OUT);
    expect(result).toHaveLength(0);
  });

  it("MHF-8: empty matches array returns empty array", () => {
    expect(filterMatchesByPlayer([], PLAYER_MARIA)).toHaveLength(0);
  });
});

// ── derivePlayerOptions ────────────────────────────────────────

describe("derivePlayerOptions", () => {
  it("MHF-9: empty matches returns empty options", () => {
    expect(derivePlayerOptions([])).toHaveLength(0);
  });

  it("MHF-10: deduplicates by player_id across multiple matches", () => {
    // Maria and Jun appear in matchCompleted + matchCancelledFull = 2 matches each
    const options = derivePlayerOptions([matchCompleted, matchCancelledFull]);
    const ids = options.map((o) => o.player_id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids).toContain(PLAYER_MARIA);
    expect(ids).toContain(PLAYER_JUN);
  });

  it("MHF-11: game count reflects number of matches a player appeared in", () => {
    // Maria: match-1 + match-2 = 2
    const options = derivePlayerOptions([matchCompleted, matchCancelledFull]);
    const maria = options.find((o) => o.player_id === PLAYER_MARIA);
    expect(maria?.count).toBe(2);
  });

  it("MHF-12: sorted alphabetically by display_name", () => {
    const options = derivePlayerOptions([matchCompleted]);
    const names = options.map((o) => o.display_name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("MHF-13: duplicate display_name → two distinct entries with non-null disambiguator", () => {
    const options = derivePlayerOptions([matchDupName]);
    const marias = options.filter((o) => o.display_name === "Maria Santos");
    expect(marias).toHaveLength(2);
    // Each must have a disambiguator (they share a normalized name)
    expect(marias[0].disambiguator).not.toBeNull();
    expect(marias[1].disambiguator).not.toBeNull();
    // Disambiguators must be different
    expect(marias[0].disambiguator).not.toBe(marias[1].disambiguator);
  });

  it("MHF-14: unique display_name → disambiguator is null", () => {
    const options = derivePlayerOptions([matchCompleted]);
    for (const opt of options) {
      expect(opt.disambiguator).toBeNull();
    }
  });

  it("MHF-14b: case/whitespace-variant duplicate also collides (normalizeName key)", () => {
    const options = derivePlayerOptions([matchDupNameVariant]);
    const marias = options.filter((o) => [PLAYER_MARIA, PLAYER_MARIA_3].includes(o.player_id));
    expect(marias).toHaveLength(2);
    // Raw strings differ, so a raw-string key would leave both disambiguators null.
    expect(marias[0].display_name).not.toBe(marias[1].display_name);
    expect(marias[0].disambiguator).not.toBeNull();
    expect(marias[1].disambiguator).not.toBeNull();
    expect(marias[0].disambiguator).not.toBe(marias[1].disambiguator);
    // Non-colliding players in the same set are untouched.
    expect(options.find((o) => o.player_id === PLAYER_CARL)?.disambiguator).toBeNull();
    expect(options.find((o) => o.player_id === PLAYER_ANNE)?.disambiguator).toBeNull();
  });

  it("MHF-15: never-played player (not on any roster) does not appear", () => {
    const options = derivePlayerOptions([matchCompleted]);
    expect(options.find((o) => o.player_id === "player-nobody")).toBeUndefined();
  });

  it("MHF-16: leave-triggered cancel — leaver absent from options (deleted row)", () => {
    const options = derivePlayerOptions([matchCancelledLeaveTriggered]);
    expect(options.find((o) => o.player_id === PLAYER_LEAVER)).toBeUndefined();
  });

  it("MHF-17: cancelled match players DO appear (retained rows)", () => {
    const options = derivePlayerOptions([matchCancelledFull]);
    expect(options.find((o) => o.player_id === PLAYER_MARIA)).toBeDefined();
  });
});

// ── resolvePartnerIds ──────────────────────────────────────────

describe("resolvePartnerIds", () => {
  it("MHF-18: returns teammates of the selected player (same team, different id)", () => {
    // Maria and Jun are on Team A; Carl and Anne on Team B.
    const partners = resolvePartnerIds(matchCompleted, PLAYER_MARIA);
    expect(partners).toEqual([PLAYER_JUN]);
  });

  it("MHF-19: selected player not on the match roster → empty array", () => {
    expect(resolvePartnerIds(matchCompleted, "player-nobody")).toHaveLength(0);
  });

  it("MHF-20: singles / no teammate → empty partners", () => {
    // matchSingles: Maria (A) vs Carl (B) — solo on each side
    expect(resolvePartnerIds(matchSingles, PLAYER_MARIA)).toHaveLength(0);
  });

  it("MHF-21: does NOT include the selected player in the partner list", () => {
    const partners = resolvePartnerIds(matchCompleted, PLAYER_MARIA);
    expect(partners).not.toContain(PLAYER_MARIA);
  });

  it("MHF-22: does NOT include opposing-team players as partners", () => {
    const partners = resolvePartnerIds(matchCompleted, PLAYER_MARIA);
    expect(partners).not.toContain(PLAYER_CARL);
    expect(partners).not.toContain(PLAYER_ANNE);
  });

  it("MHF-23: works for Team B player too", () => {
    const partners = resolvePartnerIds(matchCompleted, PLAYER_CARL);
    expect(partners).toEqual([PLAYER_ANNE]);
  });
});

// ── selectionStillValid ────────────────────────────────────────

describe("selectionStillValid", () => {
  const matches = [matchCompleted, matchCancelledLeaveTriggered];

  it("MHF-24: true when player is on at least one match roster", () => {
    expect(selectionStillValid(matches, PLAYER_MARIA)).toBe(true);
  });

  it("MHF-25: false when player id is on no roster (stale after identity merge or revert)", () => {
    expect(selectionStillValid(matches, "player-stale-id")).toBe(false);
  });

  it("MHF-26: false for the leaver whose row was deleted from the cancelled match", () => {
    // PLAYER_LEAVER is absent from matchCancelledLeaveTriggered and not in matchCompleted
    expect(selectionStillValid([matchCancelledLeaveTriggered], PLAYER_LEAVER)).toBe(false);
  });

  it("MHF-27: true when player appears only in a cancelled match (retained rows)", () => {
    // Player only in organizer-cancelled match — still valid
    const anne = makeMatch("match-only-anne", "cancelled", [
      { id: PLAYER_ANNE, team: "b", name: "Anne Villanueva" },
    ]);
    expect(selectionStillValid([anne], PLAYER_ANNE)).toBe(true);
  });

  it("MHF-28: empty matches → always false (no roster to check)", () => {
    expect(selectionStillValid([], PLAYER_MARIA)).toBe(false);
  });
});
