/**
 * Host-app paths the extractor reads. Single source for watch.ts.
 *
 * `.husky/pre-commit` and `.github/workflows/digital-twin.yml` cannot import
 * this file. They copy EXTRACT_INPUT_GREP — KEEP IN SYNC with that string.
 *
 * Why the union is this wide from day one: later extractor stages add
 * channels (hooks, realtime.ts), components, routes (src/app), and gotchas
 * (APP_MANIFEST.md). A Stage-0-only trigger list makes `extract --check`
 * fail on edits nothing regenerates.
 */

export const HOST_EXTRACT_INPUTS: string[] = [
  "src/types/database.ts",
  "src/lib/constants.ts",
  "src/lib/broadcast.ts",
  "src/lib/realtime.ts",
  "src/lib/matchmaking-core.ts",
  "src/app/actions",
  "src/app/globals.css",
  "src/app/layout.tsx",
  "src/app/organizer/layout.tsx",
  "src/hooks",
  "src/components",
  "src/app",
  "src/middleware.ts",
  "supabase/migrations",
  "APP_MANIFEST.md",
];

export const DESIGN_TOKEN_INPUTS: string[] = [
  "src/app/globals.css",
  "src/app/layout.tsx",
  "src/app/organizer/layout.tsx",
];

/**
 * grep -E pattern for pre-commit / CI path filters.
 * KEEP IN SYNC with HOST_EXTRACT_INPUTS.
 */
export const EXTRACT_INPUT_GREP =
  "^src/types/database\\.ts$|^src/lib/constants\\.ts$|^src/lib/broadcast\\.ts$|^src/lib/realtime\\.ts$|^src/lib/matchmaking-core\\.ts$|^src/app/|^src/hooks/|^src/components/|^src/middleware\\.ts$|^supabase/migrations/|^APP_MANIFEST\\.md$";
