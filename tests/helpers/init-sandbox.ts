#!/usr/bin/env npx tsx
// ============================================================
// init-sandbox.ts — One-time E2E Sandbox Setup Script
// ============================================================
// Run once (or anytime) to bootstrap the test sandbox session:
//
//   npm run test:setup
//
// What it does:
//   1. Loads credentials from .env.local (or system env).
//   2. Ensures an organizer bot account exists in Supabase auth.
//   3. Checks whether the 🤖 E2E SANDBOX session already exists.
//      - If yes:  reuses the existing UUID.
//      - If no:   inserts a new session row.
//   4. Reads .env.test (or bootstraps it from .env.test.example).
//   5. Injects/updates TEST_SESSION_ID in .env.test and saves it.
//   6. Prints a ready-to-use confirmation.
//
// Idempotent: safe to re-run at any time — it will not create
// duplicate sessions or overwrite unrelated .env.test values.
// ============================================================

import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { isPlaceholderValue } from "./env-placeholder";

// ── Paths ─────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, "../..");
const ENV_LOCAL = path.join(ROOT, ".env.local");
const ENV_TEST = path.join(ROOT, ".env.test");
const ENV_TEST_EXAMPLE = path.join(ROOT, ".env.test.example");

// ── ANSI colours (no deps needed) ────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

function log(symbol: string, msg: string) {
  console.log(`  ${symbol}  ${msg}`);
}
function ok(msg: string) {
  log(`${c.green}✓${c.reset}`, msg);
}
function info(msg: string) {
  log(`${c.cyan}→${c.reset}`, msg);
}
function warn(msg: string) {
  log(`${c.yellow}⚠${c.reset}`, msg);
}
function fail(msg: string) {
  log(`${c.red}✗${c.reset}`, msg);
  process.exit(1);
}

// ── Parse a .env file into a key→value map ────────────────────
function parseEnvFile(filePath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(filePath)) return map;

  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    map.set(key, val);
  }
  return map;
}

// ── Serialise a Map back to a .env file, preserving comments ──
// Replaces the value of an existing key in-place; appends if new.
function upsertEnvFile(filePath: string, updates: Record<string, string>): void {
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";

  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp(`^(${key}\\s*=).*`, "m");
    if (pattern.test(content)) {
      // Replace the existing line
      content = content.replace(pattern, `$1${value}`);
    } else {
      // Append at the end (with a trailing newline guard)
      if (content.length > 0 && !content.endsWith("\n")) content += "\n";
      content += `${key}=${value}\n`;
    }
  }

  fs.writeFileSync(filePath, content, "utf8");
}

// ── Load env: .env.local first, then system env as fallback ───
function loadEnv(): Record<string, string> {
  // Precedence deliberately matches playwright.config.ts, which loads .env.test
  // first and .env.local with `override: false` — so .env.test wins in both.
  // They have to agree. This script seeds the very session the suite then tests;
  // the moment .env.test points at a different project (which is exactly what
  // moving the E2E bot off prod means) a seeder that preferred .env.local would
  // write to one project while the suite ran against another, and the failure
  // would look like missing seed data rather than a config split.
  //
  // Reading .env.test at all is the fix for `npm run test:setup` dying with
  // "TEST_ORGANIZER_EMAIL is not set" while the E2E suite ran fine: the
  // credentials were present, just in the file this function did not open.
  // parseEnvFile returns an empty map for an absent file, so a checkout with
  // no .env.test behaves exactly as before.
  const envTest = parseEnvFile(ENV_TEST);
  const envLocal = parseEnvFile(ENV_LOCAL);
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const found = envTest.get(key) ?? envLocal.get(key) ?? process.env[key];
      if (found) return found;
    }
    return "";
  };
  return {
    NEXT_PUBLIC_SUPABASE_URL: pick("NEXT_PUBLIC_SUPABASE_URL"),
    SUPABASE_SERVICE_ROLE_KEY: pick(
      "SUPABASE_SERVICE_ROLE_KEY",
      "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY"
    ),
    // The organizer bot is a permanent account on a real project — it gets no
    // literal default here, for the same reason as tests/fixtures/auth.ts.
    TEST_ORGANIZER_EMAIL: pick("TEST_ORGANIZER_EMAIL"),
    TEST_ORGANIZER_PASSWORD: pick("TEST_ORGANIZER_PASSWORD"),
    TEST_ORGANIZER_PIN: pick("TEST_ORGANIZER_PIN"),
  };
}

// ── Prompt helper for interactive confirmation ─────────────────
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log();
  console.log(`${c.bold}${c.cyan}🏸 Badminton App — E2E Sandbox Initialiser${c.reset}`);
  console.log(c.dim + "─".repeat(50) + c.reset);
  console.log();

  // ── Step 1: Load credentials ──────────────────────────────
  const env = loadEnv();

  if (!env.NEXT_PUBLIC_SUPABASE_URL) {
    fail(
      "NEXT_PUBLIC_SUPABASE_URL is not set.\n" +
        "    Add it to .env.local: NEXT_PUBLIC_SUPABASE_URL=https://your-ref.supabase.co"
    );
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    fail(
      "SUPABASE_SERVICE_ROLE_KEY is not set.\n" +
        "    Add it to .env.local: SUPABASE_SERVICE_ROLE_KEY=<service_role_key>\n" +
        "    Get it: Supabase Dashboard → Project Settings → API → service_role"
    );
  }

  for (const name of [
    "TEST_ORGANIZER_EMAIL",
    "TEST_ORGANIZER_PASSWORD",
    "TEST_ORGANIZER_PIN",
  ] as const) {
    if (isPlaceholderValue(env[name])) {
      fail(
        `${name} is not set.\n` +
          "    Add it to .env.test or .env.local (both gitignored) — the organizer\n" +
          "    bot has no default credentials."
      );
    }
  }

  ok(`Supabase URL: ${c.dim}${env.NEXT_PUBLIC_SUPABASE_URL}${c.reset}`);

  // ── Step 2: Connect (service role — bypasses RLS) ─────────
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Step 3: Ensure organizer bot account exists ───────────
  const ORGANIZER_EMAIL = env.TEST_ORGANIZER_EMAIL;
  const ORGANIZER_DISPLAY = "E2E_OrganizerBot";
  const ORGANIZER_PASSWORD = env.TEST_ORGANIZER_PASSWORD;

  info("Checking organizer bot account…");

  let organizerUserId: string;

  const { data: listData } = await db.auth.admin.listUsers({ perPage: 1000 });
  const existingOrg = listData?.users?.find((u) => u.email === ORGANIZER_EMAIL);

  if (existingOrg) {
    organizerUserId = existingOrg.id;
    ok(`Organizer bot exists: ${c.dim}${organizerUserId}${c.reset}`);
  } else {
    info("Creating organizer bot account…");
    const { data: newUser, error: createErr } = await db.auth.admin.createUser({
      email: ORGANIZER_EMAIL,
      password: ORGANIZER_PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: ORGANIZER_DISPLAY },
    });

    if (createErr || !newUser.user) {
      fail(`Failed to create organizer bot: ${createErr?.message ?? "unknown"}`);
    }

    organizerUserId = newUser.user!.id;

    // Upsert the profile row
    const { error: profileErr } = await db.from("profiles").upsert(
      {
        id: organizerUserId,
        display_name: ORGANIZER_DISPLAY,
        skill_level: "intermediate",
        pin: env.TEST_ORGANIZER_PIN,
      },
      { onConflict: "id" }
    );

    if (profileErr) {
      warn(`Profile upsert warning: ${profileErr.message}`);
    }

    ok(`Organizer bot created: ${c.dim}${organizerUserId}${c.reset}`);
  }

  // ── Step 4: Check for existing sandbox session ────────────
  const SANDBOX_NAME = "🤖 E2E SANDBOX — DO NOT JOIN";

  info("Checking for existing sandbox session…");

  const { data: existingSessions, error: fetchErr } = await db
    .from("sessions")
    .select("id, name, is_active")
    .like("name", "🤖 E2E SANDBOX%");

  if (fetchErr) {
    fail(`Failed to query sessions table: ${fetchErr.message}`);
  }

  let sandboxSessionId: string;

  if (existingSessions && existingSessions.length > 0) {
    const session = existingSessions[0];
    sandboxSessionId = session.id;
    ok(`Sandbox session already exists: ${c.dim}${sandboxSessionId}${c.reset}`);

    // Ensure it's active (could have been deactivated by a previous test run)
    if (!session.is_active) {
      await db
        .from("sessions")
        .update({ is_active: true, ended_at: null })
        .eq("id", sandboxSessionId);
      ok("Reactivated sandbox session (was marked inactive).");
    }

    if (existingSessions.length > 1) {
      warn(
        `Found ${existingSessions.length} sandbox sessions. Using the first one.\n` +
          "    You may want to clean up extras in Supabase."
      );
    }
  } else {
    // ── Step 5: Create the sandbox session ──────────────────
    info(`Creating sandbox session "${SANDBOX_NAME}"…`);

    const { data: newSession, error: insertErr } = await db
      .from("sessions")
      .insert({
        name: SANDBOX_NAME,
        created_by: organizerUserId,
        is_active: true,
        is_auto_matchmaking_on: false,
        scoring: "single",
        // Keeps the sandbox out of every human-facing session list from the
        // moment it exists — /play, the organizer hub, and the dashboard's
        // session switcher all filter on this. The e2e suite reaches it by
        // id, so hiding it costs the tests nothing.
        is_hidden: true,
      })
      .select("id")
      .single();

    if (insertErr || !newSession) {
      fail(`Failed to insert sandbox session: ${insertErr?.message ?? "no data returned"}`);
    }

    sandboxSessionId = newSession!.id;
    ok(`Sandbox session created: ${c.dim}${sandboxSessionId}${c.reset}`);
  }

  // ── Step 6: Bootstrap .env.test from .env.test.example ────
  if (!fs.existsSync(ENV_TEST)) {
    if (fs.existsSync(ENV_TEST_EXAMPLE)) {
      fs.copyFileSync(ENV_TEST_EXAMPLE, ENV_TEST);
      info("Created .env.test from .env.test.example");
    } else {
      // Create a minimal .env.test from scratch
      fs.writeFileSync(
        ENV_TEST,
        [
          "# Auto-generated by init-sandbox.ts",
          `TEST_BASE_URL=https://your-app.vercel.app`,
          `TEST_SESSION_ID=${sandboxSessionId}`,
          `NEXT_PUBLIC_SUPABASE_URL=${env.NEXT_PUBLIC_SUPABASE_URL}`,
          "SUPABASE_SERVICE_ROLE_KEY=<paste_your_service_role_key>",
          "",
        ].join("\n"),
        "utf8"
      );
      info("Created .env.test (minimal template)");
    }
  }

  // ── Step 7: Inject TEST_SESSION_ID (and Supabase URL) ─────
  const existingTestEnv = parseEnvFile(ENV_TEST);
  const updates: Record<string, string> = {
    TEST_SESSION_ID: sandboxSessionId,
  };

  // Also backfill NEXT_PUBLIC_SUPABASE_URL if it's still the placeholder
  const currentUrl = existingTestEnv.get("NEXT_PUBLIC_SUPABASE_URL") ?? "";
  if (!currentUrl || currentUrl.includes("your-project-ref")) {
    updates.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
  }

  // Also backfill SUPABASE_SERVICE_ROLE_KEY if it's still the placeholder.
  // Detect the placeholder by its truncation marker, not by a hardcoded base64
  // JWT header: the previous check keyed on the exact encoding of
  // {"alg":"HS256","typ":"JWT"}, so an example file that ever switched `alg` --
  // or moved to Supabase's non-JWT `sb_secret_*` key format -- would stop
  // matching and silently leave the placeholder in place. No real secret ends
  // in an ellipsis, so this cannot clobber a genuine key.
  const currentKey = existingTestEnv.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (isPlaceholderValue(currentKey)) {
    updates.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  }

  upsertEnvFile(ENV_TEST, updates);

  ok(`TEST_SESSION_ID injected into .env.test`);

  // Check if TEST_BASE_URL still needs to be set
  const currentBaseUrl = parseEnvFile(ENV_TEST).get("TEST_BASE_URL") ?? "";
  const baseUrlIsPlaceholder = !currentBaseUrl || currentBaseUrl.includes("your-app.vercel.app");

  // ── Step 8: Summary ────────────────────────────────────────
  console.log();
  console.log(c.dim + "─".repeat(50) + c.reset);
  console.log(`${c.bold}${c.green}  ✓ Sandbox ready!${c.reset}`);
  console.log();
  console.log(`  ${c.dim}Session ID:${c.reset}  ${c.bold}${sandboxSessionId}${c.reset}`);
  console.log(`  ${c.dim}Env file:${c.reset}    ${c.bold}.env.test${c.reset} (auto-updated)`);
  console.log();

  if (baseUrlIsPlaceholder) {
    console.log(
      `  ${c.yellow}${c.bold}⚠  One more step:${c.reset}` +
        ` Edit ${c.bold}.env.test${c.reset} and set ${c.bold}TEST_BASE_URL${c.reset}` +
        ` to your Vercel deployment URL.\n`
    );
    console.log(`  ${c.dim}Example:${c.reset}  TEST_BASE_URL=https://badminton-app.vercel.app\n`);

    // Offer interactive prompt if running in a TTY
    if (process.stdin.isTTY) {
      const answer = await prompt(`  Enter your Vercel URL now (or press Enter to skip): `);
      if (answer && answer.startsWith("http")) {
        upsertEnvFile(ENV_TEST, { TEST_BASE_URL: answer });
        ok(`TEST_BASE_URL set to ${answer}`);
        console.log();
      }
    }
  }

  console.log(`  Run your tests with:`);
  console.log(`  ${c.bold}${c.cyan}  npm run test:e2e${c.reset}\n`);
}

main().catch((err) => {
  console.error(`\n  ${c.red}FATAL:${c.reset}`, err.message ?? err);
  process.exit(1);
});
