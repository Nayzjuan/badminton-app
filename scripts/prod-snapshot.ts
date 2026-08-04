/**
 * Production snapshot + drift detector.
 *
 * Usage:
 *   npx tsx scripts/prod-snapshot.ts <label>
 *   npx tsx scripts/prod-snapshot.ts diff <labelA> <labelB>
 *
 * Output goes to .prod-baseline/ at the repo root (gitignored), or to
 * $PROD_SNAPSHOT_DIR if set.
 *
 * Dumps every public table to JSON (a real restorable backup) and writes a
 * manifest of per-table row counts + a content checksum. The checksum matters:
 * row counts alone cannot detect an UPDATE to an existing row, which is exactly
 * the kind of damage a bad E2E run could do to real member data.
 */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";

const REPO = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(REPO, ".env.test") });
dotenv.config({ path: path.join(REPO, ".env.local"), override: false });

// Snapshots contain real member data, so they must never land inside the repo
// where a stray `git add` could commit them — `.prod-baseline` is gitignored.
// Override with PROD_SNAPSHOT_DIR to write somewhere outside the tree entirely.
const OUT_ROOT = process.env.PROD_SNAPSHOT_DIR ?? path.join(REPO, ".prod-baseline");

const TABLES = [
  "club_invites",
  "club_members",
  "club_milestones",
  "clubs",
  "co_organizer_join_attempts",
  "courts",
  "identity_migrations",
  "leaderboard_refresh_state",
  "match_events",
  "match_games",
  "match_players",
  "matches",
  "player_partnerships",
  "player_renames",
  "player_rivalries",
  "profiles",
  "push_subscriptions",
  "queue_entries",
  "session_organizers",
  "session_wrapped_stats",
  "sessions",
] as const;

// Stable ordering per table so checksums are deterministic.
// Most tables have a surrogate `id`; the two stat tables use composite PKs.
const ORDER_BY: Record<string, string[]> = {
  player_partnerships: ["player_id", "partner_id"],
  player_rivalries: ["player_id", "rival_id"],
};

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function fetchAll(db: ReturnType<typeof admin>, table: string) {
  const orderCols = ORDER_BY[table] ?? ["id"];
  const rows: unknown[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = db.from(table).select("*");
    for (const col of orderCols) q = q.order(col, { ascending: true });
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`[${table}] ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

function checksum(rows: unknown[]) {
  // Sort keys within each row so JSON key order can't perturb the hash.
  const canonical = JSON.stringify(rows, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

async function snapshot(label: string) {
  const db = admin();
  const dir = path.join(OUT_ROOT, label);
  fs.mkdirSync(dir, { recursive: true });

  const manifest: Record<string, { rows: number; sha: string }> = {};
  for (const table of TABLES) {
    const rows = await fetchAll(db, table);
    fs.writeFileSync(path.join(dir, `${table}.json`), JSON.stringify(rows, null, 2));
    manifest[table] = { rows: rows.length, sha: checksum(rows) };
    console.log(
      `  ${table.padEnd(28)} ${String(rows.length).padStart(6)} rows  sha=${manifest[table].sha}`
    );
  }

  // auth.users is not reachable via PostgREST. The admin API is only a PARTIAL
  // view: GoTrue filters listUsers on instance_id='000...0', hiding rows inserted
  // via raw SQL (20 such rows in prod). The authoritative auth checksum is taken
  // separately via SQL — see _auth_users_sql_baseline.json.
  const authUsers: { id: string; email?: string; created_at: string }[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) throw new Error(`[auth.users] ${error.message}`);
    authUsers.push(
      ...data.users.map((u) => ({
        id: u.id,
        email: u.email,
        created_at: u.created_at,
      }))
    );
    if (data.users.length < 1000) break;
  }
  authUsers.sort((a, b) => a.id.localeCompare(b.id));
  fs.writeFileSync(path.join(dir, `auth_users.json`), JSON.stringify(authUsers, null, 2));
  manifest["auth.users(api-visible-subset)"] = { rows: authUsers.length, sha: checksum(authUsers) };
  console.log(
    `  ${"auth.users(api-subset)".padEnd(28)} ${String(authUsers.length).padStart(6)} rows  sha=${manifest["auth.users(api-visible-subset)"].sha}`
  );

  fs.writeFileSync(path.join(dir, "_manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nSnapshot "${label}" written to ${dir}`);
}

function diff(a: string, b: string) {
  const load = (l: string) =>
    JSON.parse(fs.readFileSync(path.join(OUT_ROOT, l, "_manifest.json"), "utf8")) as Record<
      string,
      { rows: number; sha: string }
    >;
  const ma = load(a);
  const mb = load(b);
  let drift = 0;
  console.log(`\nDrift: ${a} -> ${b}\n`);
  for (const table of Object.keys(ma)) {
    const x = ma[table];
    const y = mb[table];
    if (!y) {
      console.log(`  ?? ${table}: missing in ${b}`);
      drift++;
      continue;
    }
    if (x.sha === y.sha) continue;
    drift++;
    console.log(`  !! ${table.padEnd(28)} rows ${x.rows} -> ${y.rows}  (sha ${x.sha} -> ${y.sha})`);
  }
  if (drift === 0) console.log("  ✅ ZERO DRIFT — every table byte-identical.");
  else
    console.log(
      `\n  ${drift} table(s) changed. Each must be explained by sandbox-scoped rows only.`
    );
  process.exitCode = 0;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "diff") diff(rest[0], rest[1]);
else
  snapshot(cmd ?? "baseline").catch((e) => {
    console.error(e);
    process.exit(1);
  });
