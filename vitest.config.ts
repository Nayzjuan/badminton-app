import { defineConfig } from "vitest/config";
import path from "path";

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
      //   src/hooks/use-organizer-session.ts   — thin wrapper
      //   src/hooks/use-visibility-refresh.ts  — browser-only
      //   src/hooks/use-h2h.ts                 — small, E2E-covered
      include: [
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
        // Utilities with unit tests
        "src/lib/matchmaking-core.ts",
        "src/lib/score-input.ts",
      ],
      exclude: ["**/*.d.ts", "**/__tests__/**", "**/node_modules/**"],

      // perFile: true enforces each file in include[] must independently
      // meet the thresholds. Without it, a well-covered file can mask a
      // poorly-covered one when include[] grows beyond one entry.
      thresholds: {
        perFile: true,
        // Conservative floor — raise incrementally as coverage improves.
        // New hook files start at lower coverage; thresholds reflect the
        // weakest currently-tested file in the include list.
        lines: 40,
        functions: 40,
        branches: 30,
        statements: 40,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
