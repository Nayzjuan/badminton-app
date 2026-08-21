// ============================================================
// Font class strings — the tokens they name must actually exist (FT)
// ============================================================
// src/lib/fonts.ts exports two class strings that every Stadium leaderboard
// component spreads into a className. They are the only place in the repo that
// names a font token by hand, and the failure they invite is silent by
// construction:
//
//   font-family: var(--nonexistent)
//
// An undeclared custom property makes the whole declaration invalid at
// computed-value time. font-family inherits, so the element does not fall back
// to a default and does not warn — it renders in whatever the body font is,
// which is Inter (set directly by `<body className={inter.className}>` in
// layout.tsx). The component looks fine. It is simply not in the font it
// claims to be in.
//
// That is exactly what shipped: fonts.ts named `--font-barlow-condensed` and
// `--font-jetbrains-mono` while layout.tsx registered `--font-barlow` and
// `--font-jetbrains`. Two disjoint sets, three consumer components, and a
// clean `npx tsc --noEmit` — a string is a string. vitest.config.ts's own
// comment reasoned about this very file and concluded "There is no mutation of
// this file that a test could catch which `npx tsc --noEmit` does not already
// catch". This suite exists because that conclusion was false.
//
// WHAT THIS FILE PROVES: every token the two constants name resolves, through
// the real globals.css and the real layout.tsx, to a declaration that exists.
// It reads both files off disk rather than restating their contents, so a
// rename on either side of the chain reddens it.
//
// WHAT IT DOES NOT PROVE: that the resolved font is the RIGHT one (that Barlow
// is what the design wants), or that Tailwind emits the utility — that is
// Tailwind's job, and the token declaration is the part we control. It also
// cannot see a font that fails to load at runtime.
// ============================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { barlowFont, monoFont } from "@/lib/fonts";

const root = resolve(__dirname, "../..");
const globalsCss = readFileSync(resolve(root, "src/app/globals.css"), "utf8");
const layoutTsx = readFileSync(resolve(root, "src/app/layout.tsx"), "utf8");

/**
 * Every `--custom-property` DECLARED (not merely referenced) in globals.css,
 * i.e. appearing on the left of a colon.
 */
function declaredInCss(): Set<string> {
  const out = new Set<string>();
  for (const m of globalsCss.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) out.add(m[1]);
  return out;
}

/** Every next/font `variable: "--x"` registered in layout.tsx. */
function declaredInLayout(): Set<string> {
  const out = new Set<string>();
  for (const m of layoutTsx.matchAll(/variable:\s*"(--[a-zA-Z0-9-]+)"/g)) out.add(m[1]);
  return out;
}

/** The value side of a `--token: <value>;` declaration in globals.css. */
function cssValueOf(token: string): string | null {
  const m = globalsCss.match(new RegExp(`${token}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

/**
 * Resolve a class string to the set of custom properties it ultimately
 * depends on. Handles both shapes the codebase can produce:
 *   "font-display"                      -> --font-display
 *   "font-[family-name:var(--font-x)]"  -> --font-x
 */
function tokensNamedBy(cls: string): string[] {
  const arbitrary = [...cls.matchAll(/var\((--[a-zA-Z0-9-]+)\)/g)].map((m) => m[1]);
  if (arbitrary.length > 0) return arbitrary;
  const bare = cls.match(/^font-([a-zA-Z0-9-]+)$/);
  return bare ? [`--font-${bare[1]}`] : [];
}

describe("fonts — class strings resolve to real declarations", () => {
  it("FT-1: both constants name at least one resolvable token", () => {
    // A guard on the parser, not on the fonts: if tokensNamedBy silently
    // returns [] the two tests below would pass vacuously, which is the exact
    // failure shape this file exists to prevent.
    expect(
      tokensNamedBy(barlowFont),
      "barlowFont matched neither the bare-utility nor the arbitrary-value shape, so every assertion below is vacuous"
    ).not.toHaveLength(0);
    expect(
      tokensNamedBy(monoFont),
      "monoFont matched neither the bare-utility nor the arbitrary-value shape, so every assertion below is vacuous"
    ).not.toHaveLength(0);
  });

  it.each([
    ["barlowFont", barlowFont],
    ["monoFont", monoFont],
  ])("FT-2: %s's token is declared in globals.css", (name, cls) => {
    const declared = declaredInCss();
    for (const token of tokensNamedBy(cls)) {
      expect(
        declared.has(token),
        `${name} renders \`${cls}\`, which resolves to \`${token}\` — a custom property NOTHING in src/app/globals.css declares. ` +
          `An undeclared property makes the font-family declaration invalid at computed-value time and the element silently inherits the body font instead. ` +
          `Declared font tokens are: ${[...declared].filter((d) => d.startsWith("--font")).join(", ")}`
      ).toBe(true);
    }
  });

  it.each([
    ["barlowFont", barlowFont],
    ["monoFont", monoFont],
  ])("FT-3: %s's token chains to a next/font variable registered in layout.tsx", (name, cls) => {
    const fromLayout = declaredInLayout();
    const fromCss = declaredInCss();

    for (const token of tokensNamedBy(cls)) {
      const value = cssValueOf(token);
      expect(value, `${token} is declared in globals.css but has no value`).not.toBeNull();

      // The token's value is a font stack like
      //   var(--font-barlow), var(--font-inter), ui-sans-serif, ...
      // Every var() inside it must come from somewhere: either next/font in
      // layout.tsx, or another declaration in globals.css.
      const refs = [...(value as string).matchAll(/var\((--[a-zA-Z0-9-]+)\)/g)].map((m) => m[1]);
      expect(
        refs.length,
        `${token} resolves to a stack with no var() reference at all (${value}) — the next/font wiring has been dropped, so the component gets a generic family`
      ).toBeGreaterThan(0);

      for (const ref of refs) {
        expect(
          fromLayout.has(ref) || fromCss.has(ref),
          `${name} -> ${token} -> \`${ref}\`, which is registered NEITHER as a next/font \`variable:\` in src/app/layout.tsx NOR as a declaration in globals.css. ` +
            `Registered next/font variables are: ${[...fromLayout].join(", ")}`
        ).toBe(true);
      }
    }
  });

  it("FT-4: the two constants do not resolve to the same font", () => {
    // A rename that collapsed both onto one token would leave FT-2 and FT-3
    // green while making every mono stat render in the display face.
    const a = tokensNamedBy(barlowFont);
    const b = tokensNamedBy(monoFont);
    expect(
      a,
      "barlowFont and monoFont resolve to the same token — the leaderboard's numerals and its stat pills would render in one face"
    ).not.toEqual(b);
  });
});
