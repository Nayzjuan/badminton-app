// ============================================================
// Replay harness — production fetch + on-disk fixture cache
// ============================================================
//
// Pulls one real session into a SessionFixture and caches it under
// .replay-cache/ (gitignored — these files carry real member names).
//
// Read-only against production, deliberately: the harness exists to measure
// engine changes against sessions that actually happened, and a cached fixture
// makes every subsequent run both free and byte-identical, which is what makes
// a before/after comparison trustworthy.

import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";
import { skillLevelToInt, type SkillLevel } from "../../src/types/database";
import type { SessionFixture, FixtureCourt, FixturePlayer, PlayedMatch } from "./types";

const REPO = path.resolve(__dirname, "..", "..");
// Same precedence as scripts/prod-snapshot.ts: .env.test first, then .env.local,
// neither overriding what is already set. Two prod-touching scripts disagreeing
// about which file wins is how you fetch the wrong database.
dotenv.config({ path: path.join(REPO, ".env.test"), quiet: true });
dotenv.config({ path: path.join(REPO, ".env.local"), override: false, quiet: true });

export const CACHE_DIR = process.env.REPLAY_CACHE_DIR ?? path.join(REPO, ".replay-cache");
const FIXTURE_DIR = path.join(CACHE_DIR, "sessions");

/**
 * The sessions the harness replays by default: every 2-court Thursday of the
 * shape the organizer actually runs (16–18 players), plus one 4-court Saturday
 * as a stress case so a change that helps small pools but hurts large ones
 * cannot hide.
 */
export const DEFAULT_SESSION_IDS = [
  "a710713e-17e4-4aab-a5b6-7187ce7af615", // 08/06 Thursday — 17p / 2ct (the clear-burst night)
  "f22c021f-dec1-4064-93c4-0515468ffb7e", // 07/30 Thursday — 18p / 2ct
  "69d8a21b-b685-404c-8111-2ce25dd88ae6", // 07/09 Thursday — 18p / 2ct
  "bcf19499-d5b8-4fba-9dcf-dd9e411621aa", // 06/25 Thursday — 18p / 2ct
  "c1c4439c-8d60-40a9-a41a-a49e76442a21", // 07/25 Saturday — 39p / 4ct (stress)
];

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. " +
        "Populate .env.local, or run with a cached fixture (omit --refresh)."
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

const minutesBetween = (fromIso: string, toIso: string) =>
  (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000;

export function fixturePath(sessionId: string): string {
  return path.join(FIXTURE_DIR, `${sessionId}.json`);
}

/** Cached fixture if present, otherwise a fresh fetch. `refresh` forces the fetch. */
export async function loadFixture(sessionId: string, refresh = false): Promise<SessionFixture> {
  const file = fixturePath(sessionId);
  if (!refresh && fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8")) as SessionFixture;
  }
  const fixture = await fetchFixture(sessionId);
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(fixture, null, 2));
  return fixture;
}

async function fetchFixture(sessionId: string): Promise<SessionFixture> {
  const supabase = serviceClient();

  const { data: session, error: sessionErr } = await supabase
    .from("sessions")
    .select("id, name, created_at")
    .eq("id", sessionId)
    .single();
  if (sessionErr || !session) {
    throw new Error(`session ${sessionId}: ${sessionErr?.message ?? "not found"}`);
  }

  // Arrival time is created_at, NOT joined_at.
  //
  // joined_at is a moving cursor: it is rewritten every time a player re-enters
  // the queue, because wait_minutes is (now - joined_at). On a finished session
  // it therefore reads "when this player last came off a court" — the values
  // cluster in groups of four at match-end times, and using them puts every
  // arrival AFTER most of the session's matches. created_at is the row's birth,
  // which is the moment the player actually joined; it precedes the session's
  // first match in every session checked.
  //
  // Departures are not recoverable either: every row in a finished session reads
  // status='left' (end-of-session cleanup), so the replay keeps everyone in.
  const { data: entries, error: entriesErr } = await supabase
    .from("queue_entries")
    .select("player_id, created_at, profiles!inner(display_name, skill_level)")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  if (entriesErr) throw new Error(`queue_entries: ${entriesErr.message}`);
  if (!entries || entries.length === 0) throw new Error(`session ${sessionId} has no players`);

  // Deliberately NOT filtered on status, despite the engine's own court read
  // doing .neq("status", "closed"). courts.status is a LIVE column — the same
  // end-of-session cleanup that stamps every queue_entry 'left' closes every
  // court, so on a finished session all five of these read 100% closed and the
  // filter returns nothing. Which courts were capacity that night is recovered
  // below, from which ones actually hosted a match.
  const { data: courts, error: courtsErr } = await supabase
    .from("courts")
    .select("id, name")
    .eq("session_id", sessionId)
    .order("name", { ascending: true });
  if (courtsErr) throw new Error(`courts: ${courtsErr.message}`);
  if (!courts || courts.length === 0) throw new Error(`session ${sessionId} has no courts`);

  const { data: matches, error: matchesErr } = await supabase
    .from("matches")
    .select("id, court_id, started_at, completed_at, match_players(player_id, team)")
    .eq("session_id", sessionId)
    .eq("status", "completed")
    .not("started_at", "is", null)
    .not("completed_at", "is", null)
    .order("started_at", { ascending: true });
  if (matchesErr) throw new Error(`matches: ${matchesErr.message}`);

  const t0 = entries[0].created_at as string;

  const players: FixturePlayer[] = entries.map((e) => {
    // PostgREST types an embedded !inner join as an array; at runtime a to-one
    // relationship is a single object. Normalise both shapes.
    const profRaw = (e as unknown as { profiles: unknown }).profiles;
    const prof = (Array.isArray(profRaw) ? profRaw[0] : profRaw) as
      | { display_name: string; skill_level: SkillLevel }
      | undefined;
    if (!prof) {
      throw new Error(`queue_entries: player ${e.player_id} has no profile row`);
    }
    return {
      player_id: e.player_id as string,
      display_name: prof.display_name,
      skill_level: prof.skill_level,
      skill_level_int: skillLevelToInt(prof.skill_level),
      joinMin: minutesBetween(t0, e.created_at as string),
    };
  });

  const realMatches: PlayedMatch[] = [];
  const durationsByCourt = new Map<string, number[]>();

  for (const m of matches ?? []) {
    const rows = (m.match_players ?? []) as { player_id: string; team: string }[];
    const teamA = rows.filter((r) => r.team === "a").map((r) => r.player_id);
    const teamB = rows.filter((r) => r.team === "b").map((r) => r.player_id);
    // A match missing a side cannot contribute an opponent pair; keeping it
    // would silently deflate every repeat metric it touches.
    if (teamA.length !== 2 || teamB.length !== 2) continue;

    const startMin = minutesBetween(t0, m.started_at as string);
    const endMin = minutesBetween(t0, m.completed_at as string);
    const courtId = (m.court_id as string | null) ?? "unknown";

    realMatches.push({ seq: realMatches.length + 1, courtId, startMin, endMin, teamA, teamB });

    // Sub-minute matches are mis-clicks (a court ended seconds after starting),
    // not real games — they would make the replay's court turnover nonsense.
    const duration = endMin - startMin;
    if (duration >= 1) {
      const list = durationsByCourt.get(courtId);
      if (list) list.push(duration);
      else durationsByCourt.set(courtId, [duration]);
    }
  }

  // A court that hosted no completed match is not capacity the session actually
  // had — it was closed, never opened, or added by mistake. Synthesising a
  // duration for it would hand the replay 33–50% more court time than the night
  // had, and every metric downstream would inherit that. This is also the only
  // reliable open/closed signal available after the fact (see the courts read).
  //
  // It recovers WHICH courts ran, not for how long: a court closed at 9pm is
  // indistinguishable from one that ran to the final whistle, so the replay
  // keeps it turning over to the horizon.
  const fixtureCourts: FixtureCourt[] = courts
    .filter((c) => durationsByCourt.has(c.id as string))
    .map((c) => ({
      id: c.id as string,
      name: c.name as string,
      durationsMin: durationsByCourt.get(c.id as string) as number[],
    }));

  if (fixtureCourts.length === 0) {
    throw new Error(
      `session ${sessionId} has no court that hosted a completed match — nothing to replay`
    );
  }

  const horizonMin = realMatches.reduce((max, m) => Math.max(max, m.endMin), 0);
  if (horizonMin <= 0) {
    throw new Error(`session ${sessionId} has no completed matches — nothing to replay`);
  }

  return {
    sessionId,
    name: session.name as string,
    day: (session.created_at as string).slice(0, 10),
    t0,
    players,
    courts: fixtureCourts,
    horizonMin,
    realMatches,
  };
}
