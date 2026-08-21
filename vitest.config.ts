import { defineConfig } from "vitest/config";
import { existsSync } from "fs";
import path from "path";

/**
 * Fails config load if any coverage target has been renamed or deleted.
 *
 * Mirrors the guard in vitest.integration.config.ts, which was added after
 * `coverage.include` there was found naming a file deleted in 6355c41. A
 * non-existent entry contributes no coverage and no threshold, and v8 does
 * not error — so a perFile floor silently protects nothing.
 */
function assertAllExist(files: string[]): string[] {
  const missing = files.filter((f) => !existsSync(path.resolve(__dirname, f)));
  if (missing.length > 0) {
    throw new Error(
      `[vitest.config] coverage.include names ${missing.length} file(s) that do not exist:\n` +
        missing.map((f) => `  - ${f}`).join("\n") +
        `\n\nUpdate the list to each file's new name, or drop the entry.`
    );
  }
  return files;
}

export default defineConfig({
  test: {
    environment: "node",
    globals: true, // enables describe/it/expect without imports
    // Setup: extends Vitest expect with @testing-library/jest-dom matchers
    // (toBeInTheDocument, toBeVisible, etc.) for component smoke tests.
    setupFiles: ["tests/setup/jest-dom.ts"],
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
    reporters: ["verbose"], // shows each test name in the terminal

    coverage: {
      provider: "v8", // requires @vitest/coverage-v8 devDep
      reporter: ["text", "lcov"], // text → terminal summary; lcov → CI/IDE integration

      // Coverage scope expanded from single-file to all hooks + core actions.
      // Each file that has a companion test suite is listed explicitly so
      // perFile enforcement catches regressions without masking low-coverage
      // files behind high-coverage ones.
      //
      // Thresholds are set conservatively at current actuals — raise them
      // incrementally as new test suites are added.
      //
      // Files NOT yet included (no unit tests):
      //   src/hooks/use-organizer-data.ts      — too complex, integration-tested
      //   src/hooks/use-session-data.ts        — integration-tested
      //   src/hooks/use-organizer-matches.ts   — integration-tested
      //   src/hooks/use-organizer-broadcast.ts — thin wrapper
      //   src/hooks/use-organizer-courts.ts    — thin wrapper
      //   src/hooks/use-organizer-queue.ts     — thin wrapper
      //   src/hooks/use-organizer-session.ts   — no longer a thin wrapper, and
      //     its draft-cap lease IS unit-tested (use-organizer-session-cap-phase),
      //     but the bulk of the file is realtime subscription wiring that no unit
      //     test exercises; adding it here would fail perFile on that alone.
      //   src/hooks/use-visibility-refresh.ts  — browser-only
      //   src/hooks/use-h2h.ts                 — small, E2E-covered
      //
      // READING THE TEXT REPORT: the terminal table OMITS files at 100% on
      // every metric. Their absence is not an include[] miss — score-input.ts,
      // use-score-form.ts and use-fix-record.ts are all 100/100/100/100 and
      // print no row. Confirm with `--coverage.reporter=json-summary` before
      // concluding an entry is not being measured.
      include: assertAllExist([
        // Core matchmaking (original)
        "src/app/actions/matchmaking.ts",
        // Hooks with unit test suites (added this session)
        "src/hooks/use-enriched-matches.ts",
        "src/hooks/use-leaderboard.ts",
        "src/hooks/use-organizer-dashboard.ts",
        "src/hooks/use-player-match.ts",
        "src/hooks/use-queue.ts",
        "src/hooks/use-score-form.ts",
        "src/hooks/use-swap-state.ts",
        "src/hooks/use-match-alerts.ts",
        "src/hooks/use-match-history.ts",
        // Fix Player Record feature
        "src/app/actions/fix-player-record.ts",
        "src/hooks/use-fix-record.ts",
        // Club member management (Suite CM)
        "src/app/actions/clubs.ts",
        // Utilities with unit tests
        "src/lib/matchmaking-core.ts",
        "src/lib/score-input.ts",
        "src/lib/safe-next.ts",
        "src/lib/rename-gate.ts",
      ]),
      exclude: ["**/*.d.ts", "**/__tests__/**", "**/node_modules/**"],

      // perFile: true enforces each file in include[] must independently
      // meet the thresholds. Without it, a well-covered file can mask a
      // poorly-covered one when include[] grows beyond one entry.
      thresholds: {
        perFile: true,
        // RATCHET — set just under the weakest measured file per metric, so a
        // regression in ANY included file trips the build. These were 40/40/30/40,
        // which every file cleared by 30+ points: a floor nothing can fail is a
        // floor that reports nothing. Recompute with `npm run test:unit:coverage`
        // and raise these whenever the weakest file improves; never lower one to
        // make a red build green.
        //
        // Floor-setter per metric (measured 2026-08-21):
        //   statements 75.40  src/app/actions/clubs.ts
        //   branches   70.70  src/app/actions/clubs.ts (use-player-match.ts 70.83)
        //   functions  75.00  src/app/actions/fix-player-record.ts
        //   lines      78.88  src/hooks/use-organizer-dashboard.ts
        lines: 78,
        functions: 75,
        branches: 70,
        statements: 75,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // `server-only` is a Next build-time guard with no Vitest resolution.
      // Map it to a no-op so server modules that import it stay importable
      // in tests. Does not affect `next build`.
      "server-only": path.resolve(__dirname, "./tests/setup/server-only-stub.ts"),
    },
  },
});
