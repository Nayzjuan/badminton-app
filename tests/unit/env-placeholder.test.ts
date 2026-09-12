// ============================================================
// Unit Tests — env-placeholder
// ============================================================
// Two callers gate on this predicate: the E2E fixture
// (tests/fixtures/auth.ts) refuses to sign the organizer bot in
// without real credentials, and the sandbox initialiser
// (tests/helpers/init-sandbox.ts) refuses to seed with them.
// They previously carried divergent copies of the test, so a
// value one accepted the other rejected.
//
// The regression that matters is a FALSE POSITIVE: flagging a
// genuine secret as a placeholder locks the suite out of a
// correctly-configured checkout. EP-6 and EP-7 pin that down for
// both Supabase key formats, including the non-HS256 header that
// the previous prefix-matching implementation missed.
//
// EP-1  empty string        → placeholder
// EP-2  undefined           → placeholder
// EP-3  <angle-bracketed>   → placeholder
// EP-4  trailing ellipsis   → placeholder
// EP-5  truncated JWT       → placeholder (ends in ellipsis)
// EP-6  real legacy JWT     → NOT a placeholder
// EP-7  real sb_secret_ key → NOT a placeholder
// EP-8  ordinary password   → NOT a placeholder
// EP-9  4-digit PIN         → NOT a placeholder
// EP-10 isFilledValue is exactly the negation
// ============================================================

import { describe, it, expect } from "vitest";
import { isPlaceholderValue, isFilledValue } from "../helpers/env-placeholder";

const PLACEHOLDERS: [string, string | undefined][] = [
  ["EP-1 empty string", ""],
  ["EP-2 undefined", undefined],
  ["EP-3 angle-bracketed prose", "<generate-a-fresh-password>"],
  ["EP-4 angle-bracketed pin", "<generate-a-fresh-4-digit-pin>"],
  ["EP-5 truncated key with literal ellipsis", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."],
];

// Structurally realistic but synthetic — no live credential belongs in a
// committed test. What matters is the shape: no angle brackets, no ellipsis.
const REAL_VALUES: [string, string][] = [
  ["EP-6a legacy HS256 JWT", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.c2ln"],
  ["EP-6b non-HS256 JWT (ES256)", "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.c2ln"],
  ["EP-7 sb_secret_ key", "sb_secret_AbCdEf0123456789AbCdEf"],
  ["EP-8 ordinary password", "E2E_SomeBot_Password!"],
  ["EP-9 four-digit pin", "9999"],
];

describe("env-placeholder", () => {
  describe("isPlaceholderValue — rejects values that were never filled in", () => {
    it.each(PLACEHOLDERS)("%s → placeholder", (_label, value) => {
      expect(isPlaceholderValue(value)).toBe(true);
    });
  });

  describe("isPlaceholderValue — never flags a genuine credential", () => {
    it.each(REAL_VALUES)("%s → not a placeholder", (_label, value) => {
      expect(isPlaceholderValue(value)).toBe(false);
    });
  });

  it("EP-10: isFilledValue is exactly the negation of isPlaceholderValue", () => {
    for (const [, value] of [...PLACEHOLDERS, ...REAL_VALUES]) {
      expect(isFilledValue(value)).toBe(!isPlaceholderValue(value));
    }
  });

  it("EP-11: an angle-bracketed value is rejected even when it looks substantial", () => {
    // Guards the regex against being loosened to a bare `startsWith("<")`
    // check, which a multi-line value could slip past.
    expect(isPlaceholderValue("<paste the service_role key from the dashboard>")).toBe(true);
  });
});
