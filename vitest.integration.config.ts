import { defineConfig } from "vitest/config";
import { existsSync } from "fs";
import path from "path";

// ============================================================
// Vitest Configuration — Integration Tests
// ============================================================
// Separate from vitest.config.ts (unit tests).
// Run with: npm run test:integration
//
// Key decisions:
//   • pool: 'forks' + fileParallelism: false — test FILES run
//     sequentially (one at a time) in separate forked processes.
//     Prevents parallel DB write conflicts. Parallelism is opt-in
//     once proper schema isolation is in place (Phase 3).
//   • testTimeout: 30s — real DB roundtrips + Supabase RPCs
//     can take a few seconds each.
//   • No jsdom — Server Actions are pure async functions.
//     No DOM required.
//   • setupFiles loads per-worker env + installs the auth mock.
//   • globalSetup checks Supabase health + applies migrations.
// ============================================================

/**
 * Fails config load if any coverage target has been renamed or deleted.
 *
 * This exists because the silent-rot failure is invisible in every direction
 * you would normally look: the suite passes, the thresholds "hold", and the
 * coverage report simply omits the file. Throwing here is the only place the
 * divergence becomes loud.
 */
function assertAllExist(files: string[]): string[] {
  const missing = files.filter((f) => !existsSync(path.resolve(__dirname, f)));
  if (missing.length > 0) {
    throw new Error(
      `[vitest.integration.config] coverage.include names ${missing.length} file(s) that do not exist:\n` +
        missing.map((f) => `  - ${f}`).join("\n") +
        `\n\nA non-existent entry contributes no coverage and no threshold, so the ` +
        `per-file floor silently protects nothing. Update the list to the file's new name.`
    );
  }
  return files;
}

/**
 * Fails config load if a coverage target has no measured ratchet of its own.
 *
 * This replaces the global lines/functions/branches/statements block that used
 * to sit alongside the per-file entries. That block did NOT act as a fallback:
 * Vitest applies the global thresholds to EVERY file, "even if they are
 * included by glob patterns" (vitest/dist/chunks/coverage.*.js, resolveThresholds),
 * so a strict global silently overrode every per-file ratchet beneath it and
 * the run failed on 85% for files whose real, deliberate floor was 35%.
 *
 * With no global block, an include[] entry added without a ratchet would be
 * measured against nothing at all. So the requirement moves here, where it is
 * loud: add the file, run the suite, read the number, write it down.
 */
function assertEveryTargetRatcheted(
  files: string[],
  thresholds: Record<string, unknown>
): string[] {
  const unratcheted = files.filter((f) => !(f in thresholds));
  if (unratcheted.length > 0) {
    throw new Error(
      `[vitest.integration.config] coverage.include names ${unratcheted.length} file(s) with no ` +
        `per-file threshold entry:\n` +
        unratcheted.map((f) => `  - ${f}`).join("\n") +
        `\n\nThere is no global fallback (see assertEveryTargetRatcheted). Run ` +
        `\`npm run test:integration:coverage\`, read the measured percentages, and add an entry ` +
        `rounded DOWN with a few points of headroom.`
    );
  }
  return files;
}

/**
 * Per-file coverage ratchets, set from MEASURED coverage — not aspiration.
 *
 * The previous block asserted a flat 85/85/70/85 with `perFile: true`. Measured
 * 2026-08-21 on the full 27-file suite, NOT ONE of these files met it:
 * sessions.ts sits at 38% statements, matchmaking.ts at 74%. Because CI ran
 * `test:integration` (no --coverage) nothing ever evaluated them, so nothing
 * ever said so.
 *
 * These are a RATCHET: raise a number when the real one moves up, never lower
 * one to make a run pass. match-drafts.ts is the worst covered AND is the
 * cross-court held-draft publish path this repo has shipped broken twice — its
 * floor is low because that is the truth, and it is the first thing to raise.
 *
 *   measured        stmts / branch / funcs / lines
 *   match-drafts    38.00 / 26.66 / 35.29 / 38.70
 *   match-lifecycle 75.70 / 61.64 / 87.50 / 77.67
 *   matchmaking     74.21 / 62.59 / 79.31 / 74.71
 *   sessions        38.83 / 33.48 / 40.00 / 41.35
 */
const RATCHETS = {
  "src/app/actions/match-drafts.ts": { statements: 35, branches: 24, functions: 32, lines: 35 },
  "src/app/actions/match-lifecycle.ts": { statements: 72, branches: 58, functions: 84, lines: 74 },
  "src/app/actions/matchmaking.ts": { statements: 71, branches: 59, functions: 76, lines: 71 },
  "src/app/actions/sessions.ts": { statements: 35, branches: 30, functions: 37, lines: 38 },
} as const;

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/integration/setup.ts"],
    globalSetup: ["./tests/integration/global-setup.ts"],

    // Real DB roundtrips need headroom
    testTimeout: 30_000,
    hookTimeout: 30_000,

    // Serial by default — prevents parallel writes from
    // different tests colliding on the same DB state.
    // fileParallelism: false means one test FILE runs at a time.
    // Once proper schema isolation is in place (Phase 3),
    // this can be enabled per-suite.
    pool: "forks",
    fileParallelism: false,

    reporters: ["verbose"],

    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/integration",

      // Targeted file coverage — the highest blast-radius action files.
      // Guarded by assertAllExist: this list named "src/app/actions/match.ts"
      // for months after 6355c41 split it into match-lifecycle.ts and
      // match-drafts.ts. A coverage include[] entry that matches no file is
      // not an error to v8 — it simply contributes nothing — so the 85%
      // per-file floor written to protect the match lifecycle was, in fact,
      // protecting nothing, silently. match-drafts.ts is the cross-court
      // held-draft publish path this repo has shipped broken twice.
      include: assertEveryTargetRatcheted(
        assertAllExist([
          "src/app/actions/sessions.ts",
          "src/app/actions/matchmaking.ts",
          "src/app/actions/match-lifecycle.ts",
          "src/app/actions/match-drafts.ts",
        ]),
        RATCHETS
      ),
      exclude: ["**/*.d.ts", "**/node_modules/**", "**/__tests__/**"],

      // Per-file only — see RATCHETS and assertEveryTargetRatcheted above for
      // why there is deliberately no global lines/functions/branches/statements
      // block here.
      thresholds: {
        perFile: true,
        ...RATCHETS,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Same stub the unit config uses (vitest.config.ts). `server-only` is a
      // Next build-time guard with no Vitest resolution and is not an installed
      // package, so any integration test that reaches a module importing it
      // died with ERR_MODULE_NOT_FOUND. Does not affect `next build`.
      "server-only": path.resolve(__dirname, "./tests/setup/server-only-stub.ts"),
    },
  },
});
