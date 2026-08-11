import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  //
  // Flat config does NOT read .gitignore, so anything generated has to be
  // listed here or eslint lints it. Every path below is git-ignored (or a
  // vendored bundle), which is the test for belonging in this list: if git
  // does not track it, nobody can fix a finding in it — the next build just
  // regenerates the file. Left unlisted they produced 47 of 62 errors and
  // 2,729 of 2,744 warnings, which is enough noise to hide the real ones.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Astro build output and generated content types for the two sub-projects.
    // Both list `dist/` and `.astro/` in their own .gitignore; these globs
    // mirror that. Named explicitly rather than `**/dist/**` so a future
    // hand-written `dist` directory elsewhere is not silently skipped.
    "digital-twin/dist/**",
    "digital-twin/.astro/**",
    "marketing-site/dist/**",
    "marketing-site/.astro/**",
    // Vitest coverage reports (git-ignored).
    "coverage/**",
    // Ephemeral Claude Code agent worktrees (git-ignored) — a second checkout
    // of this repo, so every finding inside is a duplicate of a real one.
    ".claude/worktrees/**",
    // Vendored agent tooling — the one entry here that IS git-tracked, so it
    // earns its place differently: `.agents/skills/impeccable` is a third-party
    // skill checked in wholesale (including a minified UMD bundle). It is not
    // this app's source and any fix here is overwritten the next time the skill
    // is updated upstream. It contributes 0 errors and 95 warnings, so nothing
    // that gates CI is being hidden.
    ".agents/**",
  ]),
  // Project-wide rule overrides.
  {
    rules: {
      // Exempt underscore-prefixed identifiers from the unused-vars rule.
      // Convention: _name signals "intentionally unused" (e.g. destructured
      // but discarded, mock stub params, catch-clause vars).
      // eslint-config-next does not set these patterns by default.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
]);

export default eslintConfig;
