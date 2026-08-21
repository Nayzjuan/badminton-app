/**
 * Shared font class strings for Stadium leaderboard components.
 *
 * These resolve through the Tailwind theme tokens declared in
 * src/app/globals.css (`@theme inline`), which are themselves wired to the
 * next/font variables registered in src/app/layout.tsx:
 *   font-display -> --font-display -> var(--font-barlow)
 *   font-mono    -> --font-mono    -> var(--font-jetbrains)
 *
 * Go through the tokens rather than the raw next/font variables: the tokens
 * carry the fallback stacks, and they are the names the rest of the app uses.
 *
 * A custom property that is declared NOWHERE makes the whole declaration
 * invalid at computed-value time, and font-family inherits — so a typo here
 * does not fail loudly, it silently renders the component in whatever the body
 * font is. That is not a mutation `npx tsc --noEmit` can catch; it is caught by
 * tests/unit/fonts.test.ts, which resolves every token these strings name back
 * to a real declaration in globals.css or layout.tsx.
 */

export const barlowFont = "font-display";

export const monoFont = "font-mono";
