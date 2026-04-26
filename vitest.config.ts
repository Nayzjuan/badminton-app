import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,                  // enables describe/it/expect without imports
    include: ["tests/unit/**/*.test.ts"],
    reporters: ["verbose"],         // shows each test name in the terminal

    coverage: {
      provider: "v8",               // requires @vitest/coverage-v8 devDep
      reporter: ["text", "lcov"],   // text → terminal summary; lcov → CI/IDE integration

      // Scope to only the files that actually have unit tests today.
      // Expand this list as new test suites are added.
      include: [
        "src/app/actions/matchmaking.ts",
      ],
      exclude: [
        "**/*.d.ts",
        "**/__tests__/**",
        "**/node_modules/**",
      ],

      // perFile: true enforces each file in include[] must independently
      // meet the thresholds. Without it, a well-covered file can mask a
      // poorly-covered one when include[] grows beyond one entry.
      thresholds: {
        perFile: true,
        // Set just below the current actuals so CI catches regressions
        // without failing on day one.
        // Current: stmts ~59%, branches ~47%, functions ~63%, lines ~60%.
        // Raise these incrementally as coverage improves.
        lines: 55,
        functions: 60,
        branches: 40,
        statements: 55,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
