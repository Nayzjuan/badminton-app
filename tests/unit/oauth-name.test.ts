// ============================================================
// Unit Tests: OAuth display-name derivation
// ============================================================
// Verifies a new Google user's name is coerced into the
// displayNameSchema allow-list ([a-zA-Z0-9 ], 3–30) before the
// uniqueness check / rename gate run.
// ============================================================

import { describe, it, expect } from "vitest";
import { sanitizeToDisplayName, deriveDisplayName } from "@/lib/oauth-name";
import { normalizeName } from "@/lib/normalize-name";

describe("sanitizeToDisplayName", () => {
  it("strips accents via NFKD (José → Jose)", () => {
    expect(sanitizeToDisplayName("José")).toBe("Jose");
    expect(sanitizeToDisplayName("Renée Søder")).toBe("Renee Soder");
  });

  it("replaces non-allow-listed chars with spaces and collapses (apostrophe, hyphen, dot)", () => {
    expect(sanitizeToDisplayName("John O'Brien-Smith")).toBe("John O Brien Smith");
    expect(sanitizeToDisplayName("miggy.0107")).toBe("miggy 0107");
  });

  it("drops emoji and non-Latin scripts", () => {
    expect(sanitizeToDisplayName("🎉Party")).toBe("Party");
    expect(sanitizeToDisplayName("李明")).toBe(""); // fully stripped → caller falls back
  });

  it("trims and collapses internal whitespace", () => {
    expect(sanitizeToDisplayName("  Bob   Lee  ")).toBe("Bob Lee");
  });

  it("clamps to 30 chars and re-trims a trailing partial space", () => {
    const out = sanitizeToDisplayName("a".repeat(40));
    expect(out.length).toBe(30);
    expect(sanitizeToDisplayName("abcdefghijklmnopqrstuvwxyz1234 5").length).toBeLessThanOrEqual(
      30
    );
  });

  it("only ever emits allow-listed characters", () => {
    const out = sanitizeToDisplayName("Zoë–Mae 🏸 #1");
    expect(out).toMatch(/^[a-zA-Z0-9 ]*$/);
  });
});

describe("deriveDisplayName", () => {
  it("prefers full_name", () => {
    expect(deriveDisplayName({ full_name: "José Cruz", name: "ignored", email: "x@y.com" })).toBe(
      "Jose Cruz"
    );
  });

  it("falls back to name when full_name sanitizes below 3 chars", () => {
    expect(deriveDisplayName({ full_name: "李", name: "Mike Chen" })).toBe("Mike Chen");
  });

  it("falls back to email local-part when names are unusable", () => {
    expect(deriveDisplayName({ full_name: "👍", email: "alice.wong@gmail.com" })).toBe(
      "alice wong"
    );
  });

  it("falls back to 'Player' when nothing usable is present", () => {
    expect(deriveDisplayName({})).toBe("Player");
    expect(deriveDisplayName({ full_name: "  ", name: "Jo" })).toBe("Player");
  });

  it("output always satisfies the schema length + charset (3–30, allow-listed)", () => {
    for (const meta of [
      { full_name: "José" },
      { email: "x.y.z@a.com" },
      { name: "A very long display name that exceeds thirty characters easily" },
      {},
    ]) {
      const out = deriveDisplayName(meta);
      expect(out.length).toBeGreaterThanOrEqual(3);
      expect(out.length).toBeLessThanOrEqual(30);
      expect(out).toMatch(/^[a-zA-Z0-9 ]+$/);
    }
  });

  it("derived names normalize consistently for the uniqueness check", () => {
    // The derived name flows straight into normalizeName/isNameTaken downstream.
    expect(normalizeName(deriveDisplayName({ full_name: "José  Cruz" }))).toBe("jose cruz");
  });
});
