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
  // Applies any unapplied migrations in supabase/migrations/. Idempotent —
  // only applies what hasn't run yet.
  //
  // TWO THINGS WERE WRONG HERE, and they hid each other:
  //
  //   1. Only a bare `supabase` was tried. This machine has no `supabase` on
  //      PATH at all (the CLI is reached through npx), so BOTH attempts threw
  //      on every local run.
  //   2. The failure was caught and downgraded to a console.warn ending
  //      "Continuing — tests may fail if schema is stale."
  //
  // Together those mean every local integration run has executed against
  // whatever schema happened to already be in the container, with no migration
  // ever applied and nothing louder than a warning to say so. A suite that
  // greens on an unknown schema is worse than a suite that never ran: it is
  // indistinguishable from one that verified something.
  //
  // So: resolve the CLI the way the machine actually has it, and if none of
  // the candidates works, ABORT. CI installs the CLI via supabase/setup-cli@v1,
  // so `supabase` resolves there on the first candidate.
  console.log("\n[global-setup] Applying migrations...");

  // Keep in lockstep with the `version:` pin in
  // .github/workflows/integration-tests.yml — a local run that applies
  // migrations with a different CLI than CI is not reproducing CI.
  const PINNED_CLI = "supabase@2.109.1";
  const candidates = [
    "supabase db push --local",
    "supabase migration up",
    `npx --yes ${PINNED_CLI} db push --local`,
    `npx --yes ${PINNED_CLI} migration up`,
  ];

  let applied: string | null = null;
  const failures: string[] = [];
  for (const cmd of candidates) {
    try {
      execSync(cmd, { stdio: "inherit", cwd: process.cwd() });
      applied = cmd;
      break;
    } catch (err) {
      failures.push(`    ${cmd}\n      → ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!applied) {
    throw new Error(
      "[global-setup] Could not apply migrations — refusing to run the " +
        "integration suite against a schema of unknown vintage.\n\n" +
        "  Every candidate failed:\n" +
        failures.join("\n") +
        "\n\n  Fix your local schema, then re-run:\n" +
        `    npx --yes ${PINNED_CLI} db reset   (resets + re-applies all migrations)\n`
    );
  }
  console.log(`[global-setup] Migrations up to date ✓  (via: ${applied})`);

  console.log("[global-setup] Local Supabase is ready ✓\n");

  // Return a no-op teardown (nothing to clean up at the global level;
  // per-test cleanup is handled by truncate.ts in afterEach hooks)
  return async () => {};
}
