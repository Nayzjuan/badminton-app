/**
 * Phase 2 — File watcher.
 *
 * Runs extract.ts whenever watched host app source files change.
 * Used by `npm run dev:full` (concurrently with `astro dev`).
 *
 * Debounce: 200ms — prevents storms on multi-file saves.
 */

import chokidar from "chokidar";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../../");

const watchPaths = [
  resolve(root, "src/types/database.ts"),
  resolve(root, "src/lib/constants.ts"),
  resolve(root, "src/lib/broadcast.ts"),
  resolve(root, "src/app/actions"),
  resolve(root, "src/hooks/use-organizer-data.ts"),
  // Design-token sources — trigger both extract + sync when changed
  resolve(root, "src/app/globals.css"),
  resolve(root, "src/app/layout.tsx"),
  resolve(root, "src/app/organizer/layout.tsx"),
  resolve(root, "APP_MANIFEST.md"),
  resolve(root, "MEMORY.md"),
];

let debounce: ReturnType<typeof setTimeout> | null = null;

function runExtract() {
  try {
    execSync("tsx scripts/extract.ts", {
      cwd: resolve(__dirname, ".."),
      stdio: "inherit",
    });
  } catch (e) {
    console.error("[watch] extract failed — showing last good manifest");
  }
}

function runSyncTokens() {
  try {
    execSync("tsx scripts/sync-design-tokens.ts", {
      cwd: resolve(__dirname, ".."),
      stdio: "inherit",
    });
  } catch (e) {
    console.error("[watch] sync-design-tokens failed");
  }
}

console.log("[watch] starting — watching host app source for changes…");
console.log("[watch] Watching:", watchPaths.map((p) => p.replace(root, "…")).join(", "));

// Design-token paths that need the extra sync step
const designTokenPaths = new Set([
  resolve(root, "src/app/globals.css"),
  resolve(root, "src/app/layout.tsx"),
  resolve(root, "src/app/organizer/layout.tsx"),
]);

// Run once on start — extract manifest then sync APP_MANIFEST tokens
runExtract();
runSyncTokens();

chokidar.watch(watchPaths, { ignoreInitial: true }).on("all", (event, changedPath) => {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    const isDesignToken = designTokenPaths.has(changedPath);
    console.log(
      `[watch] change detected in ${changedPath.replace(root, "…")} → re-extracting${isDesignToken ? " + syncing tokens" : ""}…`
    );
    runExtract();
    if (isDesignToken) runSyncTokens();
  }, 200);
});
