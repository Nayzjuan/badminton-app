#!/usr/bin/env tsx
// ============================================================
// Emergency Sandbox Cleanup
// ============================================================
// Wipes the E2E sandbox session immediately.
// Run this before a live session to guarantee a clean slate:
//
//   npx tsx tests/helpers/emergency-cleanup.ts
//
// Same guards as teardown.ts — will refuse to touch any session
// whose name doesn't start with "🤖 E2E SANDBOX".
// ============================================================

import "dotenv/config";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.test") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), override: false });

import { resetSandboxSession } from "./teardown";

async function run() {
  console.log("🧹 Emergency sandbox cleanup starting…");
  const start = Date.now();

  try {
    const result = await resetSandboxSession();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`✅ Cleanup complete in ${elapsed}s:`);
    console.log(`   Matches deleted:       ${result.matchesDeleted}`);
    console.log(`   Queue entries deleted: ${result.queueEntriesDeleted}`);
    console.log(`   Courts deleted:        ${result.courtsDeleted}`);
    console.log(`   Bot users deleted:     ${result.botUsersDeleted}`);
    console.log("   Sandbox session row preserved (stable anchor).");
  } catch (err) {
    console.error("❌ Cleanup failed:", err);
    process.exit(1);
  }
}

void run();
