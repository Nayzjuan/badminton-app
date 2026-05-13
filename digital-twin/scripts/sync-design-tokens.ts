/**
 * sync-design-tokens.ts
 *
 * Reads the design tokens from manifest.json (which extract.ts keeps current)
 * and surgically patches the two CSS-variable code blocks inside APP_MANIFEST.md
 * §4.1 — "Semantic tokens — Light mode" and "Semantic tokens — Dark mode".
 *
 * Only the fenced ```css blocks under those two headings are touched.
 * All surrounding prose, tables, and other sections are left intact.
 *
 * Exit codes:
 *   0 — tokens already in sync (or successfully synced)
 *   1 — tokens were stale AND --check flag was passed (CI gate mode)
 *
 * Usage:
 *   tsx scripts/sync-design-tokens.ts          # update in place
 *   tsx scripts/sync-design-tokens.ts --check  # CI dry-run (fail if stale)
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST_ROOT = resolve(__dirname, "../../");
const MANIFEST_PATH = resolve(__dirname, "../src/data/manifest.json");
const APP_MANIFEST_PATH = resolve(HOST_ROOT, "APP_MANIFEST.md");

const CHECK_MODE = process.argv.includes("--check");

// ── Types (mirrors extract.ts) ────────────────────────────────────────────────

interface DesignTokens {
  fonts: Array<{
    cssVar: string;
    tailwindClass: string;
    face: string;
    role: string;
    scope: string;
  }>;
  lightTokens: Record<string, string>;
  darkTokens: Record<string, string>;
}

// ── Token rendering ───────────────────────────────────────────────────────────

/** Tokens to include in the light-mode code block (in declaration order). */
const LIGHT_KEYS = [
  "--background",
  "--foreground",
  "--card",
  "--primary",
  "--primary-foreground",
  "--accent",
  "--accent-foreground",
  "--muted",
  "--muted-foreground",
  "--border",
  "--destructive",
  "--command",
];

/** Tokens to include in the dark-mode code block (in declaration order). */
const DARK_KEYS = [
  "--background",
  "--foreground",
  "--card",
  "--primary",
  "--accent",
  "--muted",
  "--muted-foreground",
  "--border",
  "--destructive",
  "--command",
];

/** Human-readable notes for each semantic token. */
const TOKEN_NOTES: Record<string, string> = {
  "--background": "canvas / page floor",
  "--foreground": "primary text",
  "--card": "card surface",
  "--primary": "emerald — in-queue, success",
  "--primary-foreground": "text on primary",
  "--accent": "amber — on-deck, urgency",
  "--accent-foreground": "text on accent",
  "--muted": "subtle surface",
  "--muted-foreground": "secondary text",
  "--border": "dividers, card outlines",
  "--destructive": "danger, cancel",
  "--command": "organizer teal accent",
};

function renderTokenBlock(tokens: Record<string, string>, keys: string[]): string {
  const lines: string[] = [];
  for (const key of keys) {
    const value = tokens[key];
    if (!value) continue;
    const note = TOKEN_NOTES[key] ?? "";
    const padding = " ".repeat(Math.max(0, 24 - key.length));
    lines.push(`${key}:${padding}${value}${note ? `  /* ${note} */` : ""}`);
  }
  return lines.join("\n");
}

// ── APP_MANIFEST.md patcher ───────────────────────────────────────────────────

/**
 * Find the fenced ```css block immediately following `heading` and replace
 * its content with `newBody`. Returns the updated string (unchanged if not found).
 */
function patchCodeBlock(md: string, heading: string, newBody: string): string {
  // Heading may be followed by optional text before the first ```css fence
  const headingIdx = md.indexOf(heading);
  if (headingIdx === -1) {
    console.warn(`[sync] ⚠ heading not found: "${heading}" — skipping patch`);
    return md;
  }

  // Find the opening fence after the heading
  const fenceOpen = md.indexOf("\n```css\n", headingIdx);
  if (fenceOpen === -1) {
    console.warn(`[sync] ⚠ no \`\`\`css fence found after "${heading}" — skipping`);
    return md;
  }

  const bodyStart = fenceOpen + "\n```css\n".length;
  const fenceClose = md.indexOf("\n```", bodyStart);
  if (fenceClose === -1) {
    console.warn(`[sync] ⚠ no closing fence found after "${heading}" — skipping`);
    return md;
  }

  const oldBody = md.slice(bodyStart, fenceClose);
  if (oldBody === newBody) return md; // already in sync

  return md.slice(0, bodyStart) + newBody + md.slice(fenceClose);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function run(): void {
  // Load manifest
  let tokens: DesignTokens;
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    tokens = manifest.designTokens as DesignTokens;
    if (!tokens?.lightTokens || !tokens?.darkTokens) {
      throw new Error("designTokens missing — run `npm run extract` first");
    }
  } catch (err) {
    console.error(`[sync] ✗ failed to load manifest: ${(err as Error).message}`);
    process.exit(1);
  }

  const original = readFileSync(APP_MANIFEST_PATH, "utf8");
  let updated = original;

  // Patch light-mode block
  updated = patchCodeBlock(
    updated,
    "#### Semantic tokens — Light mode",
    renderTokenBlock(tokens.lightTokens, LIGHT_KEYS)
  );

  // Patch dark-mode block
  updated = patchCodeBlock(
    updated,
    "#### Semantic tokens — Dark mode",
    renderTokenBlock(tokens.darkTokens, DARK_KEYS)
  );

  if (updated === original) {
    console.log("[sync] ✓ APP_MANIFEST.md design tokens are already in sync");
    process.exit(0);
  }

  if (CHECK_MODE) {
    console.error(
      "[sync] ✗ APP_MANIFEST.md design token tables are stale.\n" +
        "       Run `cd digital-twin && npm run sync-tokens` to update them,\n" +
        "       then stage the result before committing."
    );
    process.exit(1);
  }

  writeFileSync(APP_MANIFEST_PATH, updated, "utf8");
  console.log("[sync] ✓ APP_MANIFEST.md updated with current design tokens from globals.css");
}

run();
