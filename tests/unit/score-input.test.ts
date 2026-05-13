import { describe, it, expect } from "vitest";
import { sanitizeScore } from "@/lib/score-input";

describe("sanitizeScore", () => {
  describe("basic input", () => {
    it("preserves empty string", () => {
      expect(sanitizeScore("")).toBe("");
    });

    it("preserves single digit", () => {
      expect(sanitizeScore("0")).toBe("0");
      expect(sanitizeScore("5")).toBe("5");
      expect(sanitizeScore("9")).toBe("9");
    });

    it("preserves two-digit valid scores", () => {
      expect(sanitizeScore("21")).toBe("21");
      expect(sanitizeScore("29")).toBe("29");
      expect(sanitizeScore("30")).toBe("30");
    });
  });

  describe("the bug we're fixing — values > 30 must be ALLOWED through onChange", () => {
    it("allows typing 31", () => {
      expect(sanitizeScore("31")).toBe("31");
    });

    it("allows typing 32", () => {
      expect(sanitizeScore("32")).toBe("32");
    });

    it("allows typing 33", () => {
      expect(sanitizeScore("33")).toBe("33");
    });

    it("allows typing larger numbers (validation happens on submit)", () => {
      expect(sanitizeScore("99")).toBe("99");
      expect(sanitizeScore("100")).toBe("100");
    });
  });

  describe("the editing trap — lowering numbers must work freely", () => {
    // Reproduces the video scenario: user types 30, then wants to lower
    // to 29. Old clamp logic broke this because intermediate cursor states
    // pushed values >30 which got re-clamped back to 30.

    it("backspacing 30 → 3 works", () => {
      // User has "30" displayed, backspaces the '0', input becomes "3"
      expect(sanitizeScore("3")).toBe("3");
    });

    it("backspacing 3 → empty works", () => {
      expect(sanitizeScore("")).toBe("");
    });

    it("retyping after backspace: '' → 2 → 29", () => {
      expect(sanitizeScore("2")).toBe("2");
      expect(sanitizeScore("29")).toBe("29");
    });

    it("editing mid-string: cursor before '0' in '30', type '2' → '230'", () => {
      // This is the killer case the clamp broke: typing into the middle
      // of a value pushes it above 30 momentarily. We MUST let it through
      // so the user can then delete digits to land on their real target.
      expect(sanitizeScore("230")).toBe("230");
    });
  });

  describe("sanitization", () => {
    it("strips letters", () => {
      expect(sanitizeScore("abc")).toBe("");
      expect(sanitizeScore("21a")).toBe("21");
      expect(sanitizeScore("a21")).toBe("21");
    });

    it("strips whitespace", () => {
      expect(sanitizeScore("  21  ")).toBe("21");
      expect(sanitizeScore("2 1")).toBe("21");
    });

    it("strips minus sign (negative becomes positive of magnitude)", () => {
      expect(sanitizeScore("-5")).toBe("5");
    });

    it("strips decimal point", () => {
      expect(sanitizeScore("21.5")).toBe("215");
    });

    it("strips emoji and unicode digits", () => {
      expect(sanitizeScore("21🏸")).toBe("21");
    });

    it("returns empty when only non-digits", () => {
      expect(sanitizeScore("abc")).toBe("");
      expect(sanitizeScore("...")).toBe("");
      expect(sanitizeScore("---")).toBe("");
    });
  });

  describe("3-digit safety cap (prevents pathological input)", () => {
    it("caps 4-digit input to 3 digits", () => {
      expect(sanitizeScore("9999")).toBe("999");
    });

    it("caps very long input", () => {
      expect(sanitizeScore("1234567890")).toBe("123");
    });

    it("does not affect 3-digit input", () => {
      expect(sanitizeScore("100")).toBe("100");
      expect(sanitizeScore("999")).toBe("999");
    });
  });
});
