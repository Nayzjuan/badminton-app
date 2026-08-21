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

    // Vitest's default is 5 s, and the component suites spend most of a test
    // inside userEvent + waitFor. Under CPU contention QRP-S2 exceeded it
    // outright ("Test timed out in 5000ms") while asserting nothing wrong.
    // This ceiling has to stay above the 5 s asyncUtilTimeout set in
    // tests/setup/jest-dom.ts, or a waitFor that is about to report a real
    // failure gets cut off first and reports the wrong reason.
    testTimeout: 20_000,
    hookTimeout: 20_000,

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
      // Files NOT yet included. Recompute the candidate list with:
      //
      //   for f in src/lib/*.ts src/hooks/*.ts; do
      //     b=$(basename "$f" .ts)
      //     grep -rq "/$b\"" tests/unit || echo "$f"
      //   done
      //
      //   src/hooks/use-organizer-data.ts      — too complex, integration-tested
      //   src/hooks/use-organizer-matches.ts   — integration-tested
      //   src/hooks/use-organizer-broadcast.ts — thin wrapper
      //   src/hooks/use-organizer-session.ts   — no longer a thin wrapper, and
      //     its draft-cap lease IS unit-tested (use-organizer-session-cap-phase),
      //     but the bulk of the file is realtime subscription wiring that no unit
      //     test exercises; adding it here would fail perFile on that alone.
      //   src/hooks/use-h2h.ts                 — small, E2E-covered
      //   src/lib/fonts.ts                     — two exported string constants
      //     and no behaviour. There is no mutation of this file that a test
      //     could catch which `npx tsc --noEmit` does not already catch, so a
      //     suite here would assert its own fixture.
      //   src/app/actions/dev.ts               — Suite DV covers the three
      //     guards (NODE_ENV, DEV_TOOLS_ENABLED, auth) and the session binding
      //     on every delete, which is the whole reason the file is dangerous.
      //     The seeding bodies underneath are DB work with no unit surface, so
      //     the file measures 28.57 statements / 26.76 lines and cannot clear
      //     the floor below. Listing it here would fail the build for being
      //     honest about that. Raise it via the integration lane, not by
      //     lowering the floor.
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
        // Server actions that had NO test of any kind until Suites CT / HH /
        // HI / OA / RN / UM / WR. Each measured 100 on every metric except
        // wrapped.ts branches (84.61) — well clear of the floor below, so they
        // are ratcheted here rather than left unmeasured. They print NO ROW in
        // the terminal table for exactly that reason; see the note above.
        "src/app/actions/courts.ts",
        "src/app/actions/h2h.ts",
        "src/app/actions/history.ts",
        "src/app/actions/oauth.ts",
        "src/app/actions/rename.ts",
        "src/app/actions/upcoming-match.ts",
        "src/app/actions/wrapped.ts",
        // Utilities with unit tests
        "src/lib/matchmaking-core.ts",
        "src/lib/score-input.ts",
        "src/lib/safe-next.ts",
        "src/lib/rename-gate.ts",
        // ── The src/lib and src/hooks modules that no test named at all ──
        // Every entry below was written against the same question: if the
        // behaviour this test names were broken, would this test go red? Each
        // one was answered by applying a mutation to the source and watching
        // the named IDs fail, then restoring the source byte-for-byte. They
        // are ratcheted here rather than left unmeasured because an untested
        // module is a bigger hole than a weak test, and nothing but this list
        // stops one from silently becoming untested again.
        //
        // Libraries (Suites CI / RU / LR / TD / VC / OP / NW / WA / VU / LU).
        // All 100 on every metric except wrapped-awards.ts branches (89.47).
        "src/lib/client-ip.ts",
        "src/lib/rpc-utils.ts",
        "src/lib/leaderboard-refresh.ts",
        "src/lib/trailing-debounce.ts",
        "src/lib/vip-config.ts",
        "src/lib/oauth-provision.ts",
        "src/lib/session-notice-write.ts",
        "src/lib/wrapped-awards.ts",
        "src/lib/validate.ts",
        "src/lib/utils.ts",
        // Hooks (Suites CS / SI / PC / VR / EMH / LS / OAL / OC / OQ / SD / CP).
        // The weakest of these is use-organizer-alerts.ts at
        // 79.64/79.51/96.42/81.05 — clear of the floor below, and clear of
        // the existing hook floor-setters, so none of the four thresholds
        // moved. The rest are 100 on every metric except use-live-match-swap
        // (97.67/97.61), use-session-data (96.34/88.46/95.45/98.66) and
        // use-session-completed-players (96.42 branches).
        "src/hooks/use-club-slug.ts",
        "src/hooks/use-score-input.ts",
        "src/hooks/use-pair-counts.ts",
        "src/hooks/use-visibility-refresh.ts",
        "src/hooks/use-edit-match.ts",
        "src/hooks/use-live-match-swap.ts",
        "src/hooks/use-organizer-alerts.ts",
        "src/hooks/use-organizer-courts.ts",
        "src/hooks/use-organizer-queue.ts",
        "src/hooks/use-session-data.ts",
        "src/hooks/use-session-completed-players.ts",
        // Reached only through use-session-data, but measured 100 on every
        // metric via SD-23 — the test that pins TOKEN_REFRESHED triggering a
        // refetch. Listed so a narrowing of that trigger fails the floor here
        // as well as reddening SD-23.
        "src/hooks/use-auth-recovery-refetch.ts",
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
