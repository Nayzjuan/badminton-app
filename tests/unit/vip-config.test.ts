// ============================================================
// VIP theme lookup — the only guard between a DB string and a className (VC)
// ============================================================
// `profiles.vip_theme` is a free-form text column. There is no CHECK
// constraint, no enum and no migration behind these themes: the file's own
// header says "To add a new preset: append one entry to VIP_THEMES", so
// whatever string an organizer or a script writes into that column is handed
// straight to getVipThemeConfig() and, from there, into a class attribute.
//
// The consumer makes the contract binary and total. src/components/ui/vip-tag.tsx
// does exactly this:
//
//     const config = getVipThemeConfig(theme);
//     if (!config) return null;
//     ... [ "font-black ...", config.neonClass, "animate-pulse" ].join(" ")
//     ... [ "bg-gradient-to-r", config.holoFrom, config.holoVia, config.holoTo ]
//
// so this module must return a REAL config or null — never a truthy object
// that lacks the five fields. A truthy-but-wrong return is worse than a throw,
// and quieter than it looks: Array.prototype.join maps a missing field to the
// empty string, so `[..., undefined, ...].join(" ")` produces a class attribute
// that is syntactically perfect and simply has nothing in that slot. The tag
// still renders — in the inherited text colour, with no bloom and no gradient —
// which over the coloured court graphic is unreadable rather than merely plain,
// and which nothing in the markup flags as wrong.
//
// KNOWN DEFECT, PINNED BELOW (VC-9 / VC-10). isVipTheme's check is
// `theme in VIP_THEMES`, and `in` walks the prototype chain. Every key on
// Object.prototype — "toString", "constructor", "__proto__", "valueOf",
// "hasOwnProperty" — therefore passes as a valid VipTheme, and
// getVipThemeConfig returns Object.prototype's own member for it: truthy,
// so VipTag's `if (!config)` does not catch it, and field-less, so the class
// list ends up with an empty slot where the styling belongs. VC-9 and VC-10
// assert TODAY's behaviour on
// purpose; the fix is a one-liner
// (`Object.prototype.hasOwnProperty.call(VIP_THEMES, theme)`), and when
// someone applies it those two tests are the ones that must be flipped.
//
// The other half of the file is drift: VIP_THEMES is a Record keyed by a
// hand-written union in the same file, and each entry is five hand-copied
// Tailwind strings. VC-11 … VC-14 are driven by Object.keys and by a
// tsc-enforced exhaustiveness check, so a theme added tomorrow is validated
// without anyone editing this suite.
//
// Tests:
//   VC-1  getVipThemeConfig returns the exact VIP_THEMES entry for every
//         declared key (positive control for VC-2 … VC-5)
//   VC-2  (negative) an unknown string returns null
//   VC-3  (negative) null returns null
//   VC-4  (negative) undefined returns null
//   VC-5  (negative, edge) the empty string returns null
//   VC-6  isVipTheme accepts every declared key (positive control for VC-7)
//   VC-7  (negative) isVipTheme rejects an unknown string, null, undefined and ""
//   VC-8  (negative, edge) near-miss spellings of a real key are rejected
//   VC-9  (edge, KNOWN DEFECT) Object.prototype keys are reported as valid themes
//   VC-10 (edge, KNOWN DEFECT) and getVipThemeConfig hands VipTag a truthy,
//         field-less object for them, so the null guard does not catch it
//   VC-11 every entry carries all five config fields as non-empty strings
//   VC-12 the runtime keys of VIP_THEMES are exactly the VipTheme union members
//   VC-13 (edge) no two entries share a label or a neonClass (a copy-pasted preset)
//   VC-14 every entry's class strings carry the Tailwind prefixes VipTag joins
//         them into
//
// WHAT THIS FILE DOES NOT PROVE
//   • That VipTag renders those classes, or that its `if (!config) return null`
//     early return is reached. That is component behaviour and no unit suite
//     owns it today; this file only proves what the lookup hands the component.
//   • That the Tailwind classes named here exist in the generated stylesheet.
//     A typo'd colour token ("text-cyna-300") satisfies every assertion below
//     and still renders nothing — that is a build/design-token concern.
//   • That any row in `profiles.vip_theme` actually holds one of these keys.
//     Nothing in the database constrains it; VC-2 and VC-9 exist precisely
//     because this function is the only filter in the path.
//   • Anything about the vip-preview page, which iterates VIP_THEMES directly
//     rather than going through these two guards.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  VIP_THEMES,
  getVipThemeConfig,
  isVipTheme,
  type VipTheme,
  type VipThemeConfig,
} from "@/lib/vip-config";

// ── The union, written out once so the runtime can see it ─────
// VIP_THEMES is `Record<VipTheme, VipThemeConfig>`, which makes tsc enforce
// that the OBJECT covers the union — but nothing checks the reverse at runtime,
// and nothing at all catches a key that exists in the object and not the union
// (a Record accepts extras through an index-signature-free spread, and a plain
// `Object.keys` never sees the type). This array closes both directions.
const DECLARED_THEMES = [
  "cyber-neon",
  "gold-prestige",
  "crimson-elite",
  "violet-spark",
  "emerald-legend",
  "solar-flare",
  "arctic-ice",
  "rose-titan",
  "toxic-lime",
  "silver-phantom",
] as const satisfies readonly VipTheme[];

// tsc-enforced half of VC-12: add a member to the VipTheme union without
// adding it here and `MissingFromDeclared` stops being `never`, so this
// annotation resolves to `false` and `npx tsc --noEmit` fails on the literal
// `true`. The `satisfies` above catches the opposite slip — a name in this
// array that is not in the union.
type MissingFromDeclared = Exclude<VipTheme, (typeof DECLARED_THEMES)[number]>;
const UNION_IS_FULLY_DECLARED: [MissingFromDeclared] extends [never] ? true : false = true;

// ── The five fields VipTag dereferences ───────────────────────
const REQUIRED_FIELDS = ["label", "neonClass", "holoFrom", "holoVia", "holoTo"] as const;

// Same trick for the config shape: add a sixth field to VipThemeConfig and
// this stops compiling until the field is listed above and therefore checked
// by VC-11 for every theme.
type MissingFields = Exclude<keyof VipThemeConfig, (typeof REQUIRED_FIELDS)[number]>;
const CONFIG_FIELDS_FULLY_LISTED: [MissingFields] extends [never] ? true : false = true;

// Keys that live on Object.prototype and therefore satisfy `in` against any
// object literal. These are the realistic false positives for a free-form
// text column: "constructor" and "__proto__" in particular are what a
// malformed import or a JSON round-trip can deposit there.
const PROTOTYPE_KEYS = ["toString", "constructor", "__proto__", "valueOf", "hasOwnProperty"];

// The prefixes VipTag concatenates each field into. holoFrom/Via/To are joined
// after "bg-gradient-to-r", so a "from-" string sitting in the holoTo slot
// produces a gradient with two starts and no end — i.e. no gradient at all.
const CLASS_PREFIX: Record<"neonClass" | "holoFrom" | "holoVia" | "holoTo", string> = {
  neonClass: "text-",
  holoFrom: "from-",
  holoVia: "via-",
  holoTo: "to-",
};

/** Reproduces VipTag's neon class list so a missing field shows up as a token. */
function neonClassList(config: VipThemeConfig): string {
  return [
    "font-black tracking-widest uppercase text-[13px] leading-none",
    config.neonClass,
    "animate-pulse",
  ].join(" ");
}

describe("vip-config (VC)", () => {
  it("VC-1: getVipThemeConfig returns the exact VIP_THEMES entry for every declared key", () => {
    for (const key of DECLARED_THEMES) {
      const config = getVipThemeConfig(key);
      expect(
        config,
        `getVipThemeConfig("${key}") returned nothing for a key that IS in VIP_THEMES. VipTag renders null when the lookup fails, so this player's VIP tag silently disappears from the queue, the court graphic and the match alert`
      ).not.toBeNull();
      expect(
        config,
        `getVipThemeConfig("${key}") did not return that key's own entry. A lookup that resolves to a different (or synthesised) config paints every VIP with the wrong colour, and because the fallback is silent nobody reports it as a bug`
      ).toBe(VIP_THEMES[key]);
    }

    // Anchor one value literally, so a mutation that rewrites every entry into
    // the same object cannot satisfy the identity check above by coincidence.
    expect(
      getVipThemeConfig("cyber-neon")?.label,
      "the first preset's label changed — the label is what the organizer picks from in the VIP preview screen"
    ).toBe("Cyber Neon");
  });

  it("VC-2 (negative): an unknown string returns null", () => {
    for (const junk of ["not-a-theme", "cyber", "midnight-blue", "0", "null", "undefined"]) {
      expect(
        getVipThemeConfig(junk),
        `getVipThemeConfig("${junk}") did not return null. Anything non-null here is dereferenced for five fields by VipTag, so an unrecognised vip_theme string stops degrading to "no tag" and starts rendering a tag whose colour, glow and gradient classes are all silently absent`
      ).toBeNull();
    }
  });

  it("VC-3 (negative): null returns null", () => {
    expect(
      getVipThemeConfig(null),
      "a null vip_theme was not rejected. Null is the DEFAULT state of the column — every non-VIP player in the club has it — so a non-null return here puts a broken tag next to every single name in the queue"
    ).toBeNull();
  });

  it("VC-4 (negative): undefined returns null", () => {
    expect(
      getVipThemeConfig(undefined),
      "an undefined vip_theme was not rejected. A profile selected without the vip_theme column — which is most reads in the app — yields undefined rather than null, so this is the same population as VC-3 arriving by a different route"
    ).toBeNull();
  });

  it("VC-5 (negative, edge): the empty string returns null", () => {
    expect(
      getVipThemeConfig(""),
      'an empty vip_theme was not rejected. "" is what an organizer clearing the field in a form actually writes — the column is text, not nullable-only — and it must degrade to no tag, not to a tag with no styling'
    ).toBeNull();
    expect(
      getVipThemeConfig("   "),
      "a whitespace-only vip_theme was not rejected — it is truthy, so it survives the `!theme` guard and has to be caught by the key lookup"
    ).toBeNull();
  });

  it("VC-6: isVipTheme accepts every declared key", () => {
    for (const key of DECLARED_THEMES) {
      expect(
        isVipTheme(key),
        `isVipTheme("${key}") rejected a key that IS in VIP_THEMES. This is the positive control for VC-7: without it, a guard that returns false for everything would satisfy every negative in this file while hiding all ten themes from every player`
      ).toBe(true);
    }
  });

  it("VC-7 (negative): isVipTheme rejects an unknown string, null, undefined and the empty string", () => {
    expect(
      isVipTheme("not-a-theme"),
      "isVipTheme accepted an unrecognised key — the type guard is narrowing `string` to `VipTheme` on a value that has no entry, which is exactly the lie that lets a field-less object reach VipTag"
    ).toBe(false);
    expect(
      isVipTheme(null),
      "isVipTheme accepted null — the default value of the column narrows to a VipTheme"
    ).toBe(false);
    expect(
      isVipTheme(undefined),
      "isVipTheme accepted undefined — an unselected column narrows to a VipTheme"
    ).toBe(false);
    expect(
      isVipTheme(""),
      "isVipTheme accepted the empty string — a cleared form field narrows to a VipTheme"
    ).toBe(false);
  });

  it("VC-8 (negative, edge): near-miss spellings of a real key are rejected", () => {
    // The DB column is text and the keys are kebab-case; these are the shapes a
    // hand-typed or copy-pasted value actually takes.
    for (const near of [
      "Cyber-Neon",
      "CYBER-NEON",
      "cyber neon",
      "cyberneon",
      " cyber-neon",
      "cyber-neon ",
    ]) {
      expect(
        isVipTheme(near),
        `isVipTheme("${near}") accepted a value that is not a key of VIP_THEMES. The lookup is exact by design — if a normalising layer is ever added it belongs on the WRITE path, because loosening the guard here is what makes VIP_THEMES[theme] return undefined and VipTag render a field-less config`
      ).toBe(false);
      expect(
        getVipThemeConfig(near),
        `getVipThemeConfig("${near}") did not return null — see the message on the isVipTheme assertion above`
      ).toBeNull();
    }
  });

  it("VC-9 (edge, KNOWN DEFECT): keys inherited from Object.prototype are reported as valid themes", () => {
    for (const key of PROTOTYPE_KEYS) {
      expect(
        isVipTheme(key),
        `KNOWN DEFECT, pinned deliberately: isVipTheme uses \`theme in VIP_THEMES\`, and \`in\` walks the prototype chain, so "${key}" is currently accepted as a VIP theme. This assertion records today's behaviour, NOT the desired behaviour. If it just went red you have fixed the defect (Object.prototype.hasOwnProperty.call(VIP_THEMES, theme)) — flip VC-9 and VC-10 to expect false/null rather than reverting the fix`
      ).toBe(true);
    }
  });

  it("VC-10 (edge, KNOWN DEFECT): getVipThemeConfig hands VipTag a truthy, field-less object for those keys", () => {
    for (const key of PROTOTYPE_KEYS) {
      const config = getVipThemeConfig(key);

      expect(
        config,
        `KNOWN DEFECT, pinned deliberately: getVipThemeConfig("${key}") currently returns Object.prototype's own member instead of null, which is truthy and therefore survives VipTag's \`if (!config) return null\`. If this went red the defect is fixed — flip VC-9 and VC-10 rather than reverting`
      ).not.toBeNull();

      const fields = config as unknown as Partial<VipThemeConfig>;
      expect(
        fields.neonClass,
        `"${key}" resolved to something that HAS a neonClass. That is a stronger claim than this file expects and means the object's contents changed — reread VIP_THEMES before trusting either branch of this test`
      ).toBeUndefined();

      // The concrete production harm, spelled out: this is the class attribute
      // VipTag would put on the DOM node for such a value. Array.join maps the
      // missing field to "", so the damage is an EMPTY SLOT, not a visible
      // "undefined" token — nothing in the markup looks wrong on inspection.
      const rendered = neonClassList(config as VipThemeConfig);
      expect(
        rendered,
        `the class list VipTag builds for "${key}" no longer has an empty slot where the theme class belongs. Either the defect was fixed (flip VC-9/VC-10) or VipTag's join was changed — this assertion is the record of WHY the prototype leak matters: Array.join turns the missing neonClass into "", so React writes a perfectly valid-looking class attribute with nothing in it`
      ).toContain("  ");
      expect(
        rendered,
        `"${key}" produced a class list that DOES carry the neon bloom. The whole harm of the prototype leak is that the tag renders in the inherited text colour with no glow — visible, unstyled, and unreadable over the coloured court graphic — rather than being hidden by the null guard`
      ).not.toContain("[text-shadow:");
    }
  });

  it("VC-11: every theme carries all five config fields as non-empty strings", () => {
    expect(
      CONFIG_FIELDS_FULLY_LISTED,
      "VipThemeConfig gained a field that REQUIRED_FIELDS does not list, so this test silently stopped checking it — see the tsc guard above (this assertion cannot actually fail at runtime; tsc fails first)"
    ).toBe(true);

    // Driven by Object.keys, not by DECLARED_THEMES, so a preset appended to
    // VIP_THEMES is validated by this test the moment it is added.
    const keys = Object.keys(VIP_THEMES) as VipTheme[];
    expect(keys.length, "VIP_THEMES is empty — no VIP tag can render at all").toBeGreaterThan(0);

    for (const key of keys) {
      const config = VIP_THEMES[key];
      for (const field of REQUIRED_FIELDS) {
        const value = config[field];
        expect(
          typeof value,
          `VIP_THEMES["${key}"].${field} is not a string. VipTag joins the four class fields into a class attribute and renders label as text, so a non-string here is stringified straight into the DOM — an object arrives as "[object Object]" and becomes a class token Tailwind never emitted`
        ).toBe("string");
        expect(
          value.trim(),
          `VIP_THEMES["${key}"].${field} is empty. A half-filled preset is the exact failure mode the file invites — its header says a new theme is one appended entry and no migration — and an empty class string is invisible: the tag renders, with one of its four styling classes silently missing`
        ).not.toBe("");
      }
    }
  });

  it("VC-12: the runtime keys of VIP_THEMES are exactly the members of the VipTheme union", () => {
    expect(
      UNION_IS_FULLY_DECLARED,
      "the VipTheme union gained a member that DECLARED_THEMES does not list (this assertion cannot fail at runtime; tsc fails first)"
    ).toBe(true);

    expect(
      [...Object.keys(VIP_THEMES)].sort(),
      "the VipTheme union and the VIP_THEMES object have drifted apart. A union member with no entry means getVipThemeConfig returns undefined for a key the type system swears is valid; an entry with no union member means a theme nothing can ever be typed as. Both ship green — `Record<VipTheme, VipThemeConfig>` only checks one direction, and neither shows up until a player has that value in profiles.vip_theme"
    ).toEqual([...DECLARED_THEMES].sort());

    expect(
      Object.keys(VIP_THEMES).length,
      "the number of presets changed. That is fine — add the new key to DECLARED_THEMES above and this test goes green again; it is here so the union and the object cannot drift apart unnoticed"
    ).toBe(DECLARED_THEMES.length);
  });

  it("VC-13 (edge): no two themes share a label or a neonClass", () => {
    const keys = Object.keys(VIP_THEMES) as VipTheme[];

    const labels = keys.map((k) => VIP_THEMES[k].label);
    expect(
      new Set(labels).size,
      `two presets share a display label (${labels.join(", ")}). The organizer picks a theme by its label in the VIP preview screen, so duplicates make two different themes indistinguishable in the only UI that selects them`
    ).toBe(labels.length);

    const neons = keys.map((k) => VIP_THEMES[k].neonClass);
    expect(
      new Set(neons).size,
      "two presets share a neonClass — the file's header says a new theme is one appended entry, and an entry copy-pasted from its neighbour without editing the colours is the way that goes wrong. Both keys then render identically in dark mode and the new preset is dead on arrival"
    ).toBe(neons.length);
  });

  it("VC-14: every theme's class strings carry the Tailwind prefixes VipTag joins them into", () => {
    for (const key of Object.keys(VIP_THEMES) as VipTheme[]) {
      const config = VIP_THEMES[key];

      for (const [field, prefix] of Object.entries(CLASS_PREFIX) as [
        keyof typeof CLASS_PREFIX,
        string,
      ][]) {
        expect(
          config[field],
          `VIP_THEMES["${key}"].${field} does not start with "${prefix}". VipTag concatenates these positionally after "bg-gradient-to-r", so a gradient class in the wrong slot — a "from-" string sitting in holoTo, say — yields a gradient with two starts and no end, which Tailwind renders as no gradient and the light-mode tag as transparent text on a transparent background: invisible, not merely wrong`
        ).toMatch(new RegExp(`^${prefix}`));
      }

      expect(
        config.neonClass,
        `VIP_THEMES["${key}"].neonClass has no [text-shadow:…] arbitrary variant. The layered text-shadow IS the dark-mode neon bloom — without it the tag is flat coloured text and the entire visual point of the preset is gone, while every other assertion in this file still passes`
      ).toContain("[text-shadow:");
    }
  });
});
