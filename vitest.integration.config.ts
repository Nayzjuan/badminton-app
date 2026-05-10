import { defineConfig } from "vitest/config";
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

      // Targeted file coverage — the three highest blast-radius action files
      include: [
        "src/app/actions/sessions.ts",
        "src/app/actions/matchmaking.ts",
        "src/app/actions/match.ts",
      ],
      exclude: ["**/*.d.ts", "**/node_modules/**", "**/__tests__/**"],

      // Phase 3: Tightened thresholds.
      // Phase 2 target was 70%; Phase 3 raises to 85% per-file on the three
      // highest blast-radius action files. perFile: true means each included
      // file must independently meet the threshold — a well-covered file cannot
      // mask a poorly-covered one as include[] grows.
      // branches: 70 — error paths and rarely-hit guards are harder to reach;
      //   80-85% would require forcing Supabase network errors in every test.
      thresholds: {
        perFile: true,
        lines: 85,
        functions: 85,
        branches: 70,
        statements: 85,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
