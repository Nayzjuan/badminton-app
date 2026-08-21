// @vitest-environment node
// ============================================================
// Unit Tests — every migrated object is named by a test (static analysis)
// ============================================================
// This file exists because of a defect class, not a defect. Three times in
// four days a migration shipped a table, a function, or a trigger that NO
// test referenced even once, and nothing anywhere went red:
//
//   • 20260815 queue_status_audit    — log_queue_status_change: 0 tests. Its
//     body swallows every exception (`EXCEPTION WHEN OTHERS THEN NULL`) so a
//     permanently broken audit trail is indistinguishable from a quiet one.
//   • 20260817 queue_leave_notices   — v_queue_full_with_wait_time: 0 tests.
//   • 20260818 session_notifications — the table, the RPC, the RLS policy and
//     both partial-unique indexes: 0 tests, while five server actions and a
//     player-facing screen were built on top of them.
//
// The cross-court reach had already taught this exact lesson the expensive
// way: it generated 12 held drafts in production and published none of them,
// because "0 rows in prod" had been read as "feature unused" when it actually
// meant "feature cannot complete". Nobody asked whether the created row could
// finish its lifecycle. A suite that never says the name of a thing cannot be
// asked that question at all.
//
// So this asserts the weakest possible property — the one that is still worth
// enforcing: if a migration creates a queryable object, some test must at
// least MENTION it. That is not proof of coverage and does not pretend to be.
// It is a tripwire for the zero case, which is the case we keep shipping.
//
// Deliberately NOT enforced:
//   • Index names. Requiring a test to spell `…_pending_correction_idx` would
//     pin the implementation, which is the other defect class this repo keeps
//     hitting (a test that asserts the mechanism it observed rather than the
//     requirement). Index BEHAVIOUR belongs in a real-DB test that inserts a
//     duplicate; the name is not API.
//   • Trigger names, for the same reason — the function it calls is listed.
//
//   MTC-1  every table / view / function a migration creates is named on a
//          non-comment line of a file that ASSERTS — `*.test.ts(x)` or
//          `*.spec.ts`, never a helper or fixture (see IS_TEST_FILE) — or is
//          allowlisted with a reason
//   MTC-2  the exemption lists ratchet — an exempted object that is now
//          covered, or no longer created, must be deleted from the list
//   MTC-3  the extractor and the comment stripper actually discriminate, so
//          MTC-1 cannot pass by scanning nothing
//
// ── DISCRIMINATOR EVIDENCE ──────────────────────────────────
//   M20  corpus widened back to every .ts under tests/     → kills MTC-2 only
//        (club_invites, co_organizer_join_attempts, match_games each report
//         "now covered, drop the exemption")
//
// M20 is the mutant that came first, and which case catches it MOVED once the
// fix landed — worth stating, because the obvious guess is wrong. The corpus
// originally WAS every .ts file under tests/, and narrowing it to files that
// assert (IS_TEST_FILE) is what turned MTC-1 red on those three tables. All three are named exactly once in
// the whole tree, on a delete line in tests/integration/helpers/truncate.ts.
// Adding a table to that helper is the routine first step for any new table,
// so the gate as first written would have been satisfied by the very act of
// creating the thing it was meant to catch. Measured, not reasoned about: the
// three names came out of the failure message, not out of a guess.
//
// Now that they are grandfathered, MTC-1 skips them before the corpus is ever
// consulted, so re-widening the corpus no longer shows up there — it shows up
// in MTC-2, which sees three exemptions that suddenly look covered and demands
// they be deleted. The ratchet catches the loophole reopening from the other
// side, which is the whole reason MTC-2 exists. Re-measured after the fix, not
// carried over from before it.
// ============================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const TESTS = path.join(ROOT, "tests");

/**
 * Objects that may ship without any test naming them. Every entry needs a
 * reason, and MTC-2 deletes entries that stop being true — an allowlist that
 * only ever grows is how a gate rots into a comment.
 */
const ALLOWLIST: Record<string, string> = {};

/**
 * DEBT, NOT APPROVAL. These objects predate the gate and no test names any of
 * them. The list is a ratchet: MTC-2 fails if an entry becomes covered and is
 * not deleted, so it can only shrink. Do not add to it — a new object that
 * cannot be tested belongs in ALLOWLIST with a written reason.
 *
 * Some of these ARE exercised transitively (an RPC called inside a server
 * action that an integration test drives) — they are simply never named, so
 * no test can be asked whether the object's own contract holds. That is the
 * distinction this gate draws, and it is why "grandfathered" is not "fine".
 *
 * The list grew EXACTLY ONCE, and it is recorded here rather than hidden:
 * `club_invites`, `co_organizer_join_attempts` and `match_games` were added
 * when the corpus was narrowed to files that assert (see IS_TEST_FILE). Each
 * was previously "covered" by a single delete line in
 * tests/integration/helpers/truncate.ts and by nothing else — which is to say,
 * not covered. That was the price of closing the loophole, not a precedent.
 *
 * `club_invites` has since been REMOVED from the list: Suite CM
 * (tests/unit/club-member-management.test.ts) asserts the invite contract
 * itself — the grantable-role cap, expiry, and one-time redemption under a
 * lost consume race. MTC-2 is what forced this edit, exactly as designed.
 */
const GRANDFATHERED: string[] = [
  "_fix_record_partnership_delta",
  "checkout_player_cleanup_drafts",
  "club_milestones",
  "co_organizer_join_attempts",
  "count_completed_matches_by_session",
  "get_h2h_record",
  "get_leaderboard_months",
  "get_monthly_leaderboard",
  "get_primary_club_slug",
  "handle_new_user",
  "identity_migrations",
  "is_club_member",
  "is_match_club_member",
  "is_session_club_member",
  "is_session_organizer",
  "leaderboard_refresh_state",
  "lookup_active_session",
  "match_games",
  "player_renames",
  "push_subscriptions",
  "realtime_topic_session_id",
  "rename_player_identity",
  "reorder_on_deck_matches",
  "requeue_finished_players",
  "revert_match_to_active",
  "set_updated_at",
  "skill_level_to_int",
  "toggle_auto_matchmaking",
  "touch_push_subscription_updated_at",
  "v_recent_pairings",
];

/**
 * This file is excluded from the corpus it scans. Without that, naming an
 * object in ALLOWLIST — or in one of the self-test literals below — would
 * itself satisfy MTC-1, and the gate would certify its own exemptions.
 */
const SELF = path.join(TESTS, "unit", "migration-test-coverage.test.ts");

/** Strips `-- line` and block comments from SQL. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** Strips `// line` and block comments from TS/JS. */
function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * Pulls the identifiers a migration CREATEs, for the object kinds whose name
 * is genuinely part of the API a test would call: tables, views, functions,
 * and materialized views. Schema qualifier is dropped — tests address these
 * through PostgREST, which does not spell `public.`.
 *
 * The qualifier group matches ANY schema, not just `public`. Anchoring it to
 * `public` looked harmless while every migration in the repo was
 * public-qualified, but it made the name capture bind to the SCHEMA for any
 * other one: `create table private.audit_log (…)` yielded `private`, and
 * `\bprivate\b` matches the test corpus trivially, so this gate would report
 * green over a new table that no test names. A coverage gate that can be
 * satisfied by the word before the dot is not a gate.
 */
export function createdObjects(sql: string): string[] {
  const body = stripSqlComments(sql);
  const re =
    /\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?(table|view|function)\s+(?:if\s+not\s+exists\s+)?(?:"?[a-z_][a-z_0-9]*"?\.)?"?([a-z_][a-z_0-9]*)"?/gi;
  const found = new Set<string>();
  for (const m of body.matchAll(re)) found.add(m[2].toLowerCase());
  return [...found];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Only files that actually ASSERT count: `*.test.ts(x)` and the Playwright
 * `*.spec.ts`. Helpers, fixtures, factories and setup files are excluded on
 * purpose — `tests/integration/helpers/truncate.ts` names every table it
 * wipes, and adding a table to that list is the routine first step for any
 * new table, so counting helpers would let an object satisfy this gate with
 * zero assertions anywhere. The gate asks "does a test name it", and a
 * truncate list is not a test.
 */
const IS_TEST_FILE = /\.(test\.tsx?|spec\.ts)$/;

/** Every test file's source with comments removed, concatenated once. */
function testCorpus(): string {
  return walk(TESTS)
    .filter((f) => f !== SELF)
    .filter((f) => IS_TEST_FILE.test(f))
    .map((f) => {
      const src = fs.readFileSync(f, "utf8");
      return stripTsComments(src);
    })
    .join("\n");
}

/** Word-boundary match so `matches` does not satisfy `matches_archive`. */
function isNamed(identifier: string, corpus: string): boolean {
  return new RegExp(`\\b${identifier}\\b`).test(corpus);
}

const migrationFiles = fs
  .readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort();

describe("every migrated object is named by a test — Suite MTC", () => {
  it("MTC-1: no table, view, or function ships without a test naming it", () => {
    const corpus = testCorpus();
    const uncovered: string[] = [];

    for (const file of migrationFiles) {
      const sql = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
      for (const obj of createdObjects(sql)) {
        if (ALLOWLIST[obj] || GRANDFATHERED.includes(obj)) continue;
        if (!isNamed(obj, corpus)) uncovered.push(`${obj}  (${file})`);
      }
    }

    expect(
      uncovered,
      [
        "These objects are created by a migration but no test names them.",
        "Write a test that exercises the object, or add it to ALLOWLIST with a reason:",
        ...uncovered.map((u) => `  • ${u}`),
      ].join("\n")
    ).toEqual([]);
  });

  it("MTC-2: the exemption lists only shrink — no dead entries", () => {
    const corpus = testCorpus();
    const allCreated = new Set(
      migrationFiles.flatMap((f) =>
        createdObjects(fs.readFileSync(path.join(MIGRATIONS, f), "utf8"))
      )
    );

    const dead: string[] = [];
    for (const obj of [...Object.keys(ALLOWLIST), ...GRANDFATHERED]) {
      if (!allCreated.has(obj)) dead.push(`${obj} — no migration creates it any more`);
      else if (isNamed(obj, corpus)) dead.push(`${obj} — now covered, drop the exemption`);
    }

    expect(dead, `Stale ALLOWLIST entries:\n${dead.map((d) => `  • ${d}`).join("\n")}`).toEqual([]);
  });

  // ── The gate must be able to fail ────────────────────────────
  // MTC-1 reads the disk. If the extractor returned [] or the corpus were
  // empty it would pass vacuously and this whole file would be decoration.
  it("MTC-3: the extractor and the comment stripper discriminate", () => {
    // The extractor finds each kind, tolerates OR REPLACE / IF NOT EXISTS /
    // schema qualifiers, and is not fooled by a commented-out CREATE.
    const sample = `
      -- CREATE TABLE public.ghost_table (id uuid);
      /* CREATE FUNCTION public.ghost_fn() RETURNS void AS $$ $$; */
      CREATE TABLE IF NOT EXISTS public.real_table (id uuid);
      CREATE OR REPLACE FUNCTION public.real_fn() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
      CREATE VIEW real_view AS SELECT 1;
      CREATE UNIQUE INDEX real_table_idx ON public.real_table (id);
      CREATE POLICY real_policy ON public.real_table FOR SELECT USING (true);
    `;
    const found = createdObjects(sample).sort();
    expect(found).toEqual(["real_fn", "real_table", "real_view"]);
    expect(found).not.toContain("ghost_table");
    expect(found).not.toContain("ghost_fn");
    // Index and policy names are intentionally NOT enforced — see the header.
    expect(found).not.toContain("real_table_idx");
    expect(found).not.toContain("real_policy");

    // The corpus is real and non-trivial, and a mention that exists only
    // inside a comment does not count as coverage.
    const corpus = testCorpus();
    expect(corpus.length).toBeGreaterThan(100_000);
    expect(isNamed("publish_match", corpus)).toBe(true);
    expect(isNamed("no_such_object_anywhere", corpus)).toBe(false);
    expect(stripTsComments("// queue_status_events\nconst a = 1;")).not.toContain(
      "queue_status_events"
    );
    expect(stripSqlComments("-- ghost\nselect 1;")).not.toContain("ghost");

    // And the migration set itself is real — a mis-set path would make MTC-1
    // iterate nothing.
    expect(migrationFiles.length).toBeGreaterThan(20);
  });

  // ── The qualifier must not become the name ───────────────────
  // Regression: the qualifier group used to be anchored to `public`, so any
  // other schema fell through to the name capture and the SCHEMA was returned
  // as the object. `private` matches the corpus trivially, so MTC-1 would go
  // green over a table nothing tests. Every migration in the repo happens to
  // be public-qualified today, which is exactly why this needs a test rather
  // than an inspection.
  it("MTC-4: a non-public schema yields the object name, never the schema", () => {
    expect(createdObjects("create table private.audit_log (id uuid);")).toEqual(["audit_log"]);
    // Quoted and mixed-case survives too — the extractor lowercases, so the
    // NAME comes back, never `analytics`.
    expect(createdObjects('CREATE TABLE "Analytics"."Daily" (id uuid);')).toEqual(["daily"]);
    expect(createdObjects("create or replace function auth.jwt() returns jsonb as $$ $$;")).toEqual(
      ["jwt"]
    );
    expect(createdObjects("create table bare_table (id uuid);")).toEqual(["bare_table"]);
  });
});
