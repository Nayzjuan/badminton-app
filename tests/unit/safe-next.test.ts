// ============================================================
// Suite SN — safeNext open-redirect guard
// ============================================================
// WHY THIS FILE EXISTS
//
// safeNext is the ONLY open-redirect guard in the app. It decides where an
// authenticated user lands after OAuth and after the rename gate, from a
// value that arrives in a query string — i.e. wholly attacker-controlled.
// Until this file was written it had ZERO tests at any altitude: deleting
// the `//evil.com` check outright left the entire unit suite green.
//
// It shipped with a live hole. The original guard was a character test —
// `!next.startsWith("/") || next.startsWith("//")` — and `/\evil.com`
// satisfies it (starts with one slash, not two) while every browser's URL
// parser normalises the backslash to a separator and resolves it to
// https://evil.com/. SN-4 is that exact input.
//
// So the cases below are not decoration. Each hostile string is one the
// character-by-character form got wrong or could get wrong, and SN-13 asserts
// the property that makes the whole class impossible rather than the strings
// one at a time: whatever comes back, resolved against an origin, must still
// be on that origin.
//
//   SN-1..SN-3    empty / null / undefined → fallback
//   SN-4..SN-9    hostile inputs → fallback (SN-4 is the shipped bug)
//   SN-10..SN-12  legitimate internal paths → returned UNCHANGED
//   SN-13         the property: no return value can ever change origin
//   SN-14..SN-15  the fallback argument is honoured, not hard-coded
// ============================================================

import { describe, it, expect } from "vitest";
import { safeNext } from "@/lib/safe-next";

/** An arbitrary origin standing in for the deployment, used to resolve results. */
const APP_ORIGIN = "https://badminton.example.com";

describe("Suite SN — safeNext", () => {
  // ── Absent input ────────────────────────────────────────────
  it("SN-1 (negative): returns the fallback for an empty string", () => {
    expect(safeNext("")).toBe("/clubs");
  });

  it("SN-2 (negative): returns the fallback for null", () => {
    expect(safeNext(null)).toBe("/clubs");
  });

  it("SN-3 (negative): returns the fallback for undefined", () => {
    expect(safeNext(undefined)).toBe("/clubs");
  });

  // ── Hostile input ───────────────────────────────────────────
  // SN-4 is the defect this suite was written for. If it ever goes green
  // again while the others pass, the guard has been reverted to a character
  // test and the open redirect is live.
  it("SN-4 (negative): rejects a backslash-rooted path — browsers read /\\evil.com as protocol-relative", () => {
    expect(safeNext("/\\evil.com")).toBe("/clubs");
    // Prove the premise rather than asserting it: unguarded, this input
    // leaves the deployment entirely.
    expect(new URL("/\\evil.com", APP_ORIGIN).origin).not.toBe(APP_ORIGIN);
  });

  it("SN-5 (negative): rejects a protocol-relative URL", () => {
    expect(safeNext("//evil.com")).toBe("/clubs");
  });

  it("SN-6 (negative): rejects a mixed slash-backslash protocol-relative URL", () => {
    expect(safeNext("/\\/evil.com")).toBe("/clubs");
  });

  it("SN-7 (negative): rejects an absolute external URL", () => {
    expect(safeNext("https://evil.com")).toBe("/clubs");
    expect(safeNext("http://evil.com/path")).toBe("/clubs");
  });

  it("SN-8 (negative): rejects a single-slash scheme form", () => {
    expect(safeNext("http:/evil.com")).toBe("/clubs");
  });

  it("SN-9 (negative): rejects a javascript: payload and a bare relative path", () => {
    expect(safeNext("javascript:alert(1)")).toBe("/clubs");
    // Not hostile, but not a legal destination either — it is not rooted.
    expect(safeNext("clubs")).toBe("/clubs");
  });

  // ── Legitimate input passes through UNCHANGED ───────────────
  // A guard that rejected everything would pass every test above. These are
  // the positive control: query strings and fragments must survive intact,
  // because the callers hand the result straight to redirect().
  it("SN-10: returns a plain internal path unchanged", () => {
    expect(safeNext("/clubs")).toBe("/clubs");
    expect(safeNext("/play")).toBe("/play");
  });

  it("SN-11: preserves the query string and the fragment", () => {
    expect(safeNext("/play?session=abc&x=1")).toBe("/play?session=abc&x=1");
    expect(safeNext("/rename#top")).toBe("/rename#top");
  });

  it("SN-12: returns a club-scoped deep link unchanged", () => {
    const deep = "/c/chillax/play/3367d4c6-0000-0000-0000-000000000000";
    expect(safeNext(deep)).toBe(deep);
  });

  // ── The property, not the strings ───────────────────────────
  it("SN-13: no return value can ever resolve off-origin", () => {
    const candidates = [
      "//evil.com",
      "/\\evil.com",
      "\\/evil.com",
      "/\\/evil.com",
      "https://evil.com",
      "http:/evil.com",
      "javascript:alert(1)",
      "/\t/evil.com",
      "/\n//evil.com",
      " //evil.com",
      "///evil.com",
      "/clubs",
      "/play?x=1",
      "",
      null,
      undefined,
    ];

    // Guard the guard: an empty or accidentally-filtered list would make the
    // loop below assert nothing at all and still report green.
    expect(candidates.length).toBeGreaterThan(10);

    for (const candidate of candidates) {
      const result = safeNext(candidate);
      expect(
        new URL(result, APP_ORIGIN).origin,
        `safeNext(${JSON.stringify(candidate)}) returned ${JSON.stringify(result)}, which leaves the origin`
      ).toBe(APP_ORIGIN);
    }
  });

  // ── The fallback is a parameter, not a constant ─────────────
  it("SN-14: honours a caller-supplied fallback when rejecting", () => {
    expect(safeNext("//evil.com", "/welcome")).toBe("/welcome");
    expect(safeNext(null, "/welcome")).toBe("/welcome");
  });

  it("SN-15: ignores the fallback when the input is already safe", () => {
    expect(safeNext("/play", "/welcome")).toBe("/play");
  });
});
