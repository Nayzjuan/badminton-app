/**
 * Shared font class strings for Stadium leaderboard components.
 *
 * Both fonts are loaded via next/font/google in src/app/layout.tsx and
 * exposed as CSS variables:
 *   --font-barlow-condensed
 *   --font-jetbrains-mono
 *
 * Centralising them here avoids copy-pasting across every Stadium component
 * and makes a global font rename a single-line change.
 */

export const barlowFont = "font-[family-name:var(--font-barlow-condensed)]";

export const monoFont = "font-[family-name:var(--font-jetbrains-mono)]";
