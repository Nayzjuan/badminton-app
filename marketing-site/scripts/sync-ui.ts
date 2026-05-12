// ─────────────────────────────────────────────────────────────────────────────
// sync-ui.ts — strict whitelist CSS-token sync.
//
// WHAT THIS DOES:
//   Extracts the `@theme {}` block from digital-twin/src/styles/global.css
//   (the source of truth for the OKLCH design system) and injects it into
//   marketing-site/src/styles/global.css, replacing any previous version.
//
// WHAT THIS DOES NOT DO:
//   - It does NOT copy any page components, layouts, or Astro files.
//   - It does NOT copy TypeScript logic, server actions, or DB schemas.
//   - It does NOT touch the main Next.js app's HSL-based shadcn tokens
//     (those are a different colour system and incompatible with OKLCH @theme).
//
// WHY digital-twin AND NOT the main Next.js app:
//   The main Next.js app (src/app/globals.css) uses HSL CSS variables via
//   shadcn/ui convention. The marketing site and digital-twin share an OKLCH
//   design system defined in digital-twin/src/styles/global.css. That file
//   is the single source of truth for OKLCH tokens across both sites.
//
// STRICT WHITELIST:
//   Only the `@theme {}` block is copied — colours, fonts, spacing.
//   No utility classes, no component rules, no animation keyframes.
//   If someone accidentally adds non-token content to @theme {}, this script
//   still only copies that block verbatim (no leakage of other CSS rules).
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

const SOURCE_CSS = resolve(__dir, "../../digital-twin/src/styles/global.css");
const TARGET_CSS = resolve(__dir, "../src/styles/global.css");

// ── Helper: extract the first balanced @theme { … } block ────────────────────
function extractThemeBlock(css: string): string | null {
  const start = css.indexOf("@theme {");
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  return null; // unbalanced braces
}

// ── Helper: replace the managed block (comment + @theme {}) with a fresh one ──
//
// Anchors on the SYNC COMMENT marker, not on `@theme {` directly.
// If we anchored on `@theme {` alone, each run would leave the previous
// comment header in place and prepend a new one — accreting a duplicate
// header on every `npm run sync` invocation.
const SYNC_MARKER = "/* ── AUTO-SYNCED";

function replaceThemeBlock(target: string, freshBlock: string): string {
  // Find the start of any previously-written managed block.
  const commentStart = target.indexOf(SYNC_MARKER);
  const themeStart = target.indexOf("@theme {");

  // Determine where the managed region begins.
  // If the comment precedes @theme, start from the comment; otherwise @theme.
  const regionStart =
    commentStart !== -1 && (themeStart === -1 || commentStart < themeStart)
      ? commentStart
      : themeStart;

  if (regionStart === -1) {
    // Nothing managed yet — inject right after the last @import line.
    const lastImport = target.lastIndexOf("@import");
    const importEnd = target.indexOf("\n", lastImport);
    if (importEnd === -1) return freshBlock + "\n" + target;
    return target.slice(0, importEnd + 1) + "\n" + freshBlock + "\n" + target.slice(importEnd + 1);
  }

  // Walk forward from @theme { to find the closing brace of that block.
  const themePos = target.indexOf("@theme {", regionStart);
  if (themePos === -1) {
    // Comment exists but no @theme block yet — replace from comment onward.
    return (
      target.slice(0, regionStart) + freshBlock + target.slice(regionStart + SYNC_MARKER.length)
    );
  }

  let depth = 0;
  for (let i = themePos; i < target.length; i++) {
    if (target[i] === "{") depth++;
    if (target[i] === "}") {
      depth--;
      if (depth === 0) {
        return target.slice(0, regionStart) + freshBlock + target.slice(i + 1);
      }
    }
  }
  return target; // fallback: malformed block
}

// ── Main ──────────────────────────────────────────────────────────────────────
function run(): void {
  // Guard: source must exist.
  //
  // Two valid cases where it won't:
  //   1. CLI `vercel --prod` deploy — only uploads marketing-site/, not the
  //      full monorepo. The global.css already has synced tokens from the
  //      last local run, so the build is safe to continue unchanged.
  //   2. Shallow or partial clone of the repo.
  //
  // In both cases we skip with a warning (exit 0) rather than failing the
  // build. GitHub-integrated deploys DO get the full monorepo, so sync runs
  // correctly there.
  if (!existsSync(SOURCE_CSS)) {
    console.warn(
      "[sync-ui] WARN: digital-twin CSS not found at",
      SOURCE_CSS,
      "— skipping sync, using committed tokens.",
      "\n         (Expected on CLI-only or partial-clone deploys.)"
    );
    return; // exit 0 — build continues with the last committed tokens
  }

  console.log("[sync-ui] Reading OKLCH tokens from digital-twin…");
  const sourceCss = readFileSync(SOURCE_CSS, "utf-8");
  const themeBlock = extractThemeBlock(sourceCss);

  if (!themeBlock) {
    console.error("[sync-ui] ERROR: No @theme {} block found in", SOURCE_CSS);
    process.exit(1);
  }

  const lineCount = themeBlock.split("\n").length;
  console.log(`[sync-ui] Extracted @theme block — ${lineCount} lines`);

  // Add a sync-header comment so developers know the block is auto-managed.
  const annotated =
    `/* ── AUTO-SYNCED from digital-twin/src/styles/global.css ──────────────────\n` +
    `   Run \`npm run sync\` to refresh. Do not edit this block manually.\n` +
    `   ─────────────────────────────────────────────────────────────────────── */\n` +
    themeBlock;

  const targetCss = existsSync(TARGET_CSS) ? readFileSync(TARGET_CSS, "utf-8") : "";
  const updatedCss = replaceThemeBlock(targetCss, annotated);

  writeFileSync(TARGET_CSS, updatedCss, "utf-8");
  console.log("[sync-ui] ✓ OKLCH tokens written to marketing-site/src/styles/global.css");
}

run();
