// apply-dual-state-migrations.mjs
// Applies the 5 dual-state player fix migrations to local Supabase.
// Usage: node scripts/apply-dual-state-migrations.mjs

import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "../supabase/migrations");

const MIGRATIONS = [
  "20260512200000_fix_swap_player_toctou.sql",
  "20260512200001_atomicize_clear_on_deck_match.sql",
  "20260512200002_fix_remove_from_queue.sql",
  "20260512200003_atomicize_revert_match.sql",
  "20260512200004_fix_clear_on_deck_lock_order.sql",
];

const client = new pg.Client({
  connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
});

await client.connect();
console.log("Connected to local Supabase Postgres.\n");

for (const filename of MIGRATIONS) {
  const filepath = path.join(migrationsDir, filename);
  const sql = fs.readFileSync(filepath, "utf-8");
  console.log(`Applying: ${filename} ...`);
  try {
    await client.query(sql);
    console.log(`  ✓ Done\n`);
  } catch (err) {
    console.error(`  ✗ Failed: ${err.message}\n`);
    process.exit(1);
  }
}

await client.end();
console.log("All migrations applied successfully.");
