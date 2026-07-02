// ============================================================
// Unit tests: src/lib/club-slug.ts  (case ids: CS-*)
// Pure functions — no DB/network. Parity target = the SQL CHECK on
// clubs.slug (migration 20260630000000).
// ============================================================

import { describe, it, expect } from "vitest";
import { slugifyClubName, isValidClubSlug, CLUB_SLUG_MIN, CLUB_SLUG_MAX } from "@/lib/club-slug";

describe("slugifyClubName", () => {
  it("CS-1: lowercases and hyphenates a normal name", () => {
    expect(slugifyClubName("Chillax Badminton")).toBe("chillax-badminton");
  });

  it("CS-2: collapses punctuation and whitespace runs to single hyphens", () => {
    expect(slugifyClubName("  Chillax   @  Badminton!! ")).toBe("chillax-badminton");
  });

  it("CS-3: strips accents to ASCII base letters", () => {
    expect(slugifyClubName("Café Smash")).toBe("cafe-smash");
  });

  it("CS-4: trims leading/trailing hyphens", () => {
    expect(slugifyClubName("!!Manila!!")).toBe("manila");
  });

  it("CS-5: keeps digits", () => {
    expect(slugifyClubName("Court 16 Club")).toBe("court-16-club");
  });

  it("CS-6: a name with no ascii-able chars yields empty string", () => {
    expect(slugifyClubName("！！！")).toBe("");
  });

  it("CS-7: caps at CLUB_SLUG_MAX and leaves no trailing hyphen", () => {
    const slug = slugifyClubName("a".repeat(40) + " " + "b".repeat(40));
    expect(slug.length).toBeLessThanOrEqual(CLUB_SLUG_MAX);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("CS-8: output of slugify (when non-empty and ≥ min) is always valid", () => {
    for (const name of ["Chillax Badminton", "Café 16", "The   Smashers", "A1 B2 C3"]) {
      const slug = slugifyClubName(name);
      if (slug.length >= CLUB_SLUG_MIN) {
        expect(isValidClubSlug(slug)).toBe(true);
      }
    }
  });
});

describe("isValidClubSlug", () => {
  it("CS-9: accepts a simple valid slug", () => {
    expect(isValidClubSlug("chillax")).toBe(true);
  });

  it("CS-10: accepts hyphenated words and digits", () => {
    expect(isValidClubSlug("chillax-badminton-16")).toBe(true);
  });

  it("CS-11: rejects shorter than the minimum", () => {
    expect(isValidClubSlug("ab")).toBe(false);
    expect(isValidClubSlug("a".repeat(CLUB_SLUG_MIN))).toBe(true);
  });

  it("CS-12: rejects longer than the maximum", () => {
    expect(isValidClubSlug("a".repeat(CLUB_SLUG_MAX))).toBe(true);
    expect(isValidClubSlug("a".repeat(CLUB_SLUG_MAX + 1))).toBe(false);
  });

  it("CS-13: rejects leading, trailing, and double hyphens", () => {
    expect(isValidClubSlug("-chillax")).toBe(false);
    expect(isValidClubSlug("chillax-")).toBe(false);
    expect(isValidClubSlug("chil--lax")).toBe(false);
  });

  it("CS-14: rejects uppercase and spaces", () => {
    expect(isValidClubSlug("Chillax")).toBe(false);
    expect(isValidClubSlug("chillax club")).toBe(false);
  });

  it("CS-15: rejects underscores and other symbols", () => {
    expect(isValidClubSlug("chillax_club")).toBe(false);
    expect(isValidClubSlug("chillax.club")).toBe(false);
  });
});
