// ============================================================
// Global Setup — Integration Tests
// ============================================================
// Runs ONCE in the main Vitest process before any test workers
// are spawned. Environment variables set here are inherited by
// all forked test workers.
//
// Responsibilities:
//   1. Load tests/integration/.env into process.env
//   2. Assert local Supabase is reachable (fail fast with a
//      helpful message if 'supabase start' hasn't been run)
//   3. Apply pending migrations via the Supabase CLI so local
//      schema stays aligned with supabase/migrations/
// ============================================================

import path from "path";
import { execSync } from "child_process";
import dotenv from "dotenv";

export default async function setup(): Promise<() => Promise<void>> {
  // ── 1. Load integration env ─────────────────────────────────
  // This file is gitignored. Contributors copy env.example → .env
  // and fill in keys from 'supabase status'.
  const envPath = path.resolve(process.cwd(), "tests/integration/.env");
  const { error: envError } = dotenv.config({ path: envPath });

  if (envError) {
    throw new Error(
      "[global-setup] Missing tests/integration/.env\n\n" +
        "  Run: cp tests/integration/env.example tests/integration/.env\n" +
        "  Then fill in the values from: supabase status\n" +
        "  And ensure local Supabase is running: supabase start\n"
    );
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    throw new Error(
      "[global-setup] NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is missing.\n" +
        "  Ensure tests/integration/.env is filled in correctly."
    );
  }

  // ── 2. Assert local Supabase is reachable ──────────────────
  // Pings the REST API health endpoint. Fails fast with a clear
  // message if 'supabase start' hasn't been run.
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
    });
    // 200 = healthy, 400 = healthy but no table (also fine)
    // Anything else (connection refused, 5xx) = not running
    if (!res.ok && res.status !== 400) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[global-setup] Cannot reach local Supabase at ${supabaseUrl}\n\n` +
        "  Start local Supabase with: supabase start\n" +
        "  Then re-run: npm run test:integration\n\n" +
        `  Error: ${message}`
    );
  }

  // ── 3. Apply pending migrations ─────────────────────────────
  // Runs 'supabase db push --local' to apply any unapplied
  // migrations in supabase/migrations/. Idempotent — only applies
  // what hasn't run yet. CI fails fast if a migration errors.
  console.log("\n[global-setup] Applying migrations...");
  try {
    execSync("supabase db push --local", {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    console.log("[global-setup] Migrations up to date ✓");
  } catch {
    // CLI might not be installed in this PATH, or 'db push' might
    // not be available in the installed version. Fall back to
    // 'supabase migration up' (older CLI) or warn and continue.
    try {
      execSync("supabase migration up", {
        stdio: "inherit",
        cwd: process.cwd(),
      });
      console.log("[global-setup] Migrations applied via 'migration up' ✓");
    } catch {
      console.warn(
        "\n[global-setup] ⚠  Could not auto-apply migrations.\n" +
          "  Ensure your local schema is up to date:\n" +
          "    supabase db reset   (resets + re-applies all migrations)\n" +
          "  Continuing — tests may fail if schema is stale.\n"
      );
    }
  }

  console.log("[global-setup] Local Supabase is ready ✓\n");

  // Return a no-op teardown (nothing to clean up at the global level;
  // per-test cleanup is handled by truncate.ts in afterEach hooks)
  return async () => {};
}
