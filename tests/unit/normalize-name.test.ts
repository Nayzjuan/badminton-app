// ============================================================
// Unit Tests: normalizeName / namesMatch
// ============================================================
// The JS normalization key MUST stay byte-identical to the SQL
// index expression:  lower(btrim(regexp_replace(name,E'[ \t]+',' ','g')))
// These cases double as the contract both sides must satisfy.
// ============================================================

import { describe, it, expect } from "vitest";
import { normalizeName, namesMatch } from "@/lib/normalize-name";

describe("normalizeName", () => {
  it("lower-cases", () => {
    expect(normalizeName("Jason")).toBe("jason");
    expect(normalizeName("JASON")).toBe("jason");
    expect(normalizeName("jAsOn")).toBe("jason");
  });

  it("trims leading/trailing spaces", () => {
    expect(normalizeName("  Jason  ")).toBe("jason");
    expect(normalizeName(" Jason")).toBe("jason");
    expect(normalizeName("Jason ")).toBe("jason");
  });

  it("collapses internal whitespace runs to a single space", () => {
    expect(normalizeName("Ja  son")).toBe("ja son");
    expect(normalizeName("Miggy   L")).toBe("miggy l");
  });

  it("collapses ASCII tabs too (parity with the SQL E'[ \\t]+' class)", () => {
    expect(normalizeName("Jason\tL")).toBe("jason l");
    expect(normalizeName("Jason \t L")).toBe("jason l");
  });

  it("combines trim + collapse + lower", () => {
    expect(normalizeName("  MIGGY   L.  ".replace(/\./g, ""))).toBe("miggy l");
    expect(normalizeName("\tTristan  R\t")).toBe("tristan r");
  });

  it("is idempotent", () => {
    const once = normalizeName("  Jason  L  ");
    expect(normalizeName(once)).toBe(once);
  });
});

describe("namesMatch", () => {
  it("true for case / whitespace variants of the same name", () => {
    expect(namesMatch("Jason", "jason")).toBe(true);
    expect(namesMatch("Jason", " JASON ")).toBe(true);
    expect(namesMatch("Miggy  L", "miggy l")).toBe(true);
  });

  it("false for genuinely different names", () => {
    expect(namesMatch("Jason", "Jason L")).toBe(false);
    expect(namesMatch("Tristan", "Tristan R")).toBe(false);
    expect(namesMatch("Bea", "Bex")).toBe(false);
  });
});
