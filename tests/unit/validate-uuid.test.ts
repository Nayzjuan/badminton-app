// ============================================================
// Suite VU — isValidUUID, the first-line guard on every server action
// ============================================================
// WHY THIS FILE EXISTS
//
// `isValidUUID` is the cheapest guard in the app and the most widely
// relied upon. Recompute its call sites with:
//
//     rg -l 'isValidUUID' src/
//
// Every one of those modules uses it the same way: reject a malformed id
// BEFORE any database call, so a caller-supplied string can never reach
// PostgREST. It had no test of any kind. Widen the regex and nothing goes
// red — the actions keep working for well-formed input, which is all any
// other suite in this repo ever hands them.
//
// The failure this file is built to catch is a WIDENED predicate, not a
// broken one. A guard that rejects everything fails loudly on the first
// happy-path test in any suite. A guard that accepts too much fails
// silently, and what leaks through it is a raw string on its way to a
// query. So the negatives below carry the weight, and each one is a shape
// a looser regex would wave through:
//
//   VU-1..VU-4    well-formed ids are accepted (the positive control)
//   VU-5..VU-13   negatives: shapes an anchor-less or laxer regex admits
//   VU-14..VU-18  non-string inputs — the parameter is `unknown` on purpose
//   VU-19         the type predicate actually narrows (a compile-time claim)
//
// WHAT THIS FILE DOES NOT PROVE
//   - That any caller USES the guard. That is each action suite's job; see
//     UH-1 in tests/integration/upcoming-held-draft.test.ts, which proves
//     the guard runs BEFORE the auth gate in one action by observing which
//     error comes back.
//   - Version/variant correctness. The regex deliberately accepts any
//     version nibble (VU-3 pins that), because Postgres `uuid` does too.
// ============================================================

import { describe, it, expect } from "vitest";
import { isValidUUID } from "@/lib/validate";

/** A real v4 id, used as the base for the mutations below. */
const VALID = "3367d4c6-1f2a-4b8e-9c0d-5e6f7a8b9c0d";

describe("Suite VU — isValidUUID", () => {
  // ── Positives ───────────────────────────────────────────────
  it("VU-1: accepts a canonical lower-case v4 id", () => {
    expect(isValidUUID(VALID)).toBe(true);
  });

  it("VU-2: accepts an upper-case id — Postgres round-trips uuids case-insensitively", () => {
    expect(
      isValidUUID(VALID.toUpperCase()),
      "an id read back from a system that upper-cases uuids would be rejected at the guard"
    ).toBe(true);
  });

  it("VU-3: accepts every version nibble, not just 4", () => {
    // The column type is `uuid`, which does not care about the version.
    // Narrowing this to /-4[0-9a-f]{3}-/ would reject the all-zero bootstrap
    // profile used as created_by by the integration factories.
    for (const v of ["1", "3", "4", "5", "7", "0", "f"]) {
      const id = `3367d4c6-1f2a-${v}b8e-9c0d-5e6f7a8b9c0d`;
      expect(isValidUUID(id), `version nibble ${v} was rejected`).toBe(true);
    }
  });

  it("VU-4: accepts the all-zero uuid used as the bootstrap profile id", () => {
    expect(isValidUUID("00000000-0000-0000-0000-000000000000")).toBe(true);
  });

  // ── Negatives: shapes a laxer regex admits ──────────────────
  it("VU-5 (negative): rejects a bare word", () => {
    expect(isValidUUID("not-a-uuid")).toBe(false);
  });

  it("VU-6 (negative): rejects the empty string", () => {
    // A missing route param arrives as "" far more often than as undefined.
    expect(isValidUUID("")).toBe(false);
  });

  it("VU-7 (negative): rejects leading and trailing whitespace", () => {
    // No trim() anywhere in the guard: a copy-pasted id with a stray space
    // must fail here rather than reach the query with the space intact.
    expect(isValidUUID(` ${VALID}`), "a leading space was accepted").toBe(false);
    expect(isValidUUID(`${VALID} `), "a trailing space was accepted").toBe(false);
    expect(isValidUUID(`${VALID}\n`), "a trailing newline was accepted").toBe(false);
  });

  it("VU-8 (negative): rejects an id with extra characters appended", () => {
    // THE ANCHOR TEST. Drop the `$` and this passes: the regex still matches
    // the first 36 characters and the payload rides along.
    expect(
      isValidUUID(`${VALID}x`),
      "the trailing anchor is missing — anything may be appended to a valid id"
    ).toBe(false);
    expect(isValidUUID(`${VALID}' or '1'='1`)).toBe(false);
  });

  it("VU-9 (negative): rejects an id with characters prepended", () => {
    // THE OTHER ANCHOR. Drop the `^` and this passes.
    expect(
      isValidUUID(`x${VALID}`),
      "the leading anchor is missing — anything may be prepended to a valid id"
    ).toBe(false);
  });

  it("VU-10 (negative): rejects an embedded newline before extra content", () => {
    // JavaScript's `$` matches before a trailing newline in multiline mode,
    // and `.` never crosses one. If the `m` flag were ever added, this input
    // would be accepted while VU-8 stayed red — so it is asserted separately.
    expect(isValidUUID(`${VALID}\nDROP TABLE matches;`)).toBe(false);
  });

  it("VU-11 (negative): rejects wrong group lengths", () => {
    expect(isValidUUID("3367d4c-1f2a-4b8e-9c0d-5e6f7a8b9c0d"), "8-group too short").toBe(false);
    expect(isValidUUID("3367d4c67-1f2a-4b8e-9c0d-5e6f7a8b9c0d"), "8-group too long").toBe(false);
    expect(isValidUUID("3367d4c6-1f2a-4b8e-9c0d-5e6f7a8b9c0"), "final group too short").toBe(false);
  });

  it("VU-12 (negative): rejects a non-hex character in a group", () => {
    // `g` is outside [0-9a-f]. A regex widened to \w or [a-z0-9] takes it.
    expect(isValidUUID("3367d4c6-1f2a-4b8e-9c0d-5e6f7a8b9c0g")).toBe(false);
  });

  it("VU-13 (negative): rejects the unhyphenated and brace-wrapped forms", () => {
    // Both are valid uuid renderings elsewhere; neither is what this app's
    // ids look like, and accepting them would mean the guard and the column
    // disagree about what a well-formed id is.
    expect(isValidUUID(VALID.replace(/-/g, "")), "unhyphenated form accepted").toBe(false);
    expect(isValidUUID(`{${VALID}}`), "brace-wrapped form accepted").toBe(false);
  });

  // ── Non-string inputs ───────────────────────────────────────
  // The parameter is `unknown` precisely so callers can hand it a value
  // straight off the wire. Each of these must return false, not throw:
  // a throw inside a server action escapes as an unhandled error, which
  // CLAUDE.md forbids.
  it("VU-14 (negative): null returns false without throwing", () => {
    expect(() => isValidUUID(null)).not.toThrow();
    expect(isValidUUID(null)).toBe(false);
  });

  it("VU-15 (negative): undefined returns false without throwing", () => {
    expect(() => isValidUUID(undefined)).not.toThrow();
    expect(isValidUUID(undefined)).toBe(false);
  });

  it("VU-16 (negative): a number does not pass, even a numeric-looking one", () => {
    expect(isValidUUID(12345)).toBe(false);
    expect(isValidUUID(NaN)).toBe(false);
  });

  it("VU-17 (negative): an object whose toString() is a valid uuid does not pass", () => {
    // The `typeof s === "string"` half is what stops this. Drop it and
    // RegExp.test() coerces the argument, so this object is accepted and a
    // non-string reaches the query builder.
    const coercible = { toString: () => VALID };
    expect(
      isValidUUID(coercible),
      "the typeof check is missing — RegExp.test coerced a non-string to a valid id"
    ).toBe(false);
  });

  it("VU-18 (negative): an array containing a valid uuid does not pass", () => {
    // Same coercion hole as VU-17: String(["<uuid>"]) is the uuid itself.
    expect(isValidUUID([VALID])).toBe(false);
  });

  // ── The type predicate ──────────────────────────────────────
  it("VU-19: the return type narrows `unknown` to `string` in the true branch", () => {
    // This is a COMPILE-TIME assertion wearing a runtime test's clothes: if
    // the signature stops being `s is string`, `npx tsc --noEmit` fails on
    // the `.length` below, because `raw` is still `unknown` outside the
    // branch. It is here rather than in a type-only file so the claim lives
    // next to the behaviour it describes.
    const raw: unknown = VALID;
    let narrowed = "";
    if (isValidUUID(raw)) {
      narrowed = raw.slice(0, 8);
    }
    expect(narrowed).toBe("3367d4c6");
  });
});
