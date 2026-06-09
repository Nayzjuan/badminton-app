// ============================================================
// Schema-drift guard: migrate_player_identity copies ALL columns
// ============================================================
// migrate_player_identity (reconnect) re-creates the profile under a new
// auth id via an explicit INSERT column list. If a column is added to the
// `profiles` table / Profile type but NOT to that INSERT, its value is
// silently DROPPED on every reconnect (the exact bug that lost vip_tag /
// vip_theme for months). This test fails the moment that drift appears.
//
// It parses two source files (no DB needed):
//   • the Profile type in src/types/database.ts  → the full column set
//   • the latest migrate_player_identity INSERT   → the carried columns
// and asserts carried ⊇ (Profile columns − intentionally-defaulted ones).
// ============================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Columns deliberately left to DB defaults (NOT copied) — see the migration.
const INTENTIONALLY_DEFAULTED = new Set(["created_at", "updated_at"]);

const ROOT = resolve(__dirname, "..", "..");

function profileColumns(): string[] {
  const src = readFileSync(resolve(ROOT, "src/types/database.ts"), "utf8");
  const start = src.indexOf("export type Profile = {");
  expect(start, "Profile type not found in database.ts").toBeGreaterThan(-1);
  const end = src.indexOf("};", start);
  const body = src.slice(start, end);

  const cols: string[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    // Skip comment / JSDoc lines.
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("export type")
    ) {
      continue;
    }
    const m = trimmed.match(/^([a-z_][a-z0-9_]*)\s*:/i);
    if (m) cols.push(m[1]);
  }
  return cols;
}

function migrateInsertColumns(): string[] {
  const src = readFileSync(
    resolve(ROOT, "supabase/migrations/20260608000000_duplicate_name_resolution.sql"),
    "utf8"
  );
  // The Step-2 INSERT inside migrate_player_identity.
  const insertIdx = src.indexOf("INSERT INTO profiles (");
  expect(insertIdx, "migrate INSERT INTO profiles not found").toBeGreaterThan(-1);
  const open = src.indexOf("(", insertIdx);
  const close = src.indexOf(")", open);
  const colList = src.slice(open + 1, close);
  return colList
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

describe("migrate_player_identity column parity (schema-drift guard)", () => {
  it("carries every non-defaulted profiles column on reconnect", () => {
    const cols = profileColumns();
    const carried = new Set(migrateInsertColumns());

    // Sanity: parsing actually found the columns we expect to exist.
    expect(cols).toContain("display_name");
    expect(cols).toContain("needs_rename");
    expect(cols).toContain("collided_name");
    expect(cols).toContain("flagged_at");

    const missing = cols.filter((c) => !INTENTIONALLY_DEFAULTED.has(c) && !carried.has(c));
    expect(
      missing,
      `migrate_player_identity drops these profile columns on reconnect: ${missing.join(", ")}. ` +
        `Add them to the Step-2 INSERT/SELECT in 20260608000000_duplicate_name_resolution.sql.`
    ).toEqual([]);
  });

  it("does NOT copy the intentionally-defaulted timestamp columns", () => {
    const carried = new Set(migrateInsertColumns());
    expect(carried.has("created_at")).toBe(false);
    expect(carried.has("updated_at")).toBe(false);
  });
});
