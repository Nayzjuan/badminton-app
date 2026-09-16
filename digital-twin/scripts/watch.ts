/**
 * File watcher. Re-runs extract.ts whenever host-app extractor inputs change.
 * Used by `npm run dev:full` (concurrently with `astro dev`).
 *
 * Debounce: 200ms — prevents storms on multi-file saves.
 */

import chokidar from "chokidar";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { DESIGN_TOKEN_INPUTS, HOST_EXTRACT_INPUTS } from "./extract-inputs.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../../");

const watchPaths = HOST_EXTRACT_INPUTS.map((p) => resolve(root, p));
const designTokenPaths = new Set(DESIGN_TOKEN_INPUTS.map((p) => resolve(root, p)));

let debounce: ReturnType<typeof setTimeout> | null = null;

function runExtract() {
  try {
    execSync("tsx scripts/extract.ts", {
      cwd: resolve(__dirname, ".."),
      stdio: "inherit",
    });
  } catch {
    console.error("[watch] extract failed — showing last good manifest");
  }
}

function runSyncTokens() {
  try {
    execSync("tsx scripts/sync-design-tokens.ts", {
      cwd: resolve(__dirname, ".."),
      stdio: "inherit",
    });
  } catch {
    console.error("[watch] sync-design-tokens failed");
  }
}

console.log("[watch] starting — watching host app source for changes…");
console.log("[watch] Watching:", watchPaths.map((p) => p.replace(root, "…")).join(", "));

runExtract();
runSyncTokens();

chokidar.watch(watchPaths, { ignoreInitial: true }).on("all", (_event, changedPath) => {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    const isDesignToken = [...designTokenPaths].some(
      (tokenPath) => changedPath === tokenPath || changedPath.startsWith(tokenPath + "/")
    );
    console.log(
      `[watch] change detected in ${changedPath.replace(root, "…")} → re-extracting${isDesignToken ? " + syncing tokens" : ""}…`
    );
    runExtract();
    if (isDesignToken) runSyncTokens();
  }, 200);
});
