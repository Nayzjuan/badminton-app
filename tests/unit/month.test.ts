// ============================================================
// Unit tests: src/lib/month.ts — Manila-month helpers
// ============================================================
// The "current month" must be derived in Asia/Manila (UTC+8, no DST),
// NOT the runtime timezone, so it matches the DB month definition.
// Case ids: MON-*
// ============================================================

import { describe, it, expect } from "vitest";
import { formatMonthLabel, getCurrentManilaMonth, isCurrentManilaMonth } from "@/lib/month";

describe("formatMonthLabel", () => {
  it("MON-1: formats a 1-based month + year as 'June 2026'", () => {
    expect(formatMonthLabel(2026, 6)).toBe("June 2026");
  });
  it("MON-2: January is month 1, December is month 12", () => {
    expect(formatMonthLabel(2026, 1)).toBe("January 2026");
    expect(formatMonthLabel(2026, 12)).toBe("December 2026");
  });
  it("MON-3: out-of-range month renders '?'", () => {
    expect(formatMonthLabel(2026, 0)).toBe("? 2026");
    expect(formatMonthLabel(2026, 13)).toBe("? 2026");
  });
});

describe("getCurrentManilaMonth — anchored in Asia/Manila (UTC+8)", () => {
  it("MON-4: a UTC instant still inside the previous month maps to the NEXT month in Manila", () => {
    // 2026-06-30 16:00 UTC == 2026-07-01 00:00 Manila → July (month 7).
    const at = new Date("2026-06-30T16:00:00Z");
    expect(getCurrentManilaMonth(at)).toEqual({ year: 2026, month: 7 });
  });

  it("MON-5: one minute earlier (UTC) is still June in Manila", () => {
    // 2026-06-30 15:59 UTC == 2026-06-30 23:59 Manila → June (month 6).
    const at = new Date("2026-06-30T15:59:00Z");
    expect(getCurrentManilaMonth(at)).toEqual({ year: 2026, month: 6 });
  });

  it("MON-6: year boundary — 2026-12-31 16:00 UTC is January 2027 in Manila", () => {
    const at = new Date("2026-12-31T16:00:00Z");
    expect(getCurrentManilaMonth(at)).toEqual({ year: 2027, month: 1 });
  });

  it("MON-7: midday UTC resolves to the same calendar month in Manila", () => {
    const at = new Date("2026-06-15T04:00:00Z"); // noon Manila
    expect(getCurrentManilaMonth(at)).toEqual({ year: 2026, month: 6 });
  });
});

describe("isCurrentManilaMonth", () => {
  it("MON-8: true only for the Manila month of the given instant", () => {
    const at = new Date("2026-06-30T16:00:00Z"); // July in Manila
    expect(isCurrentManilaMonth(2026, 7, at)).toBe(true);
    expect(isCurrentManilaMonth(2026, 6, at)).toBe(false);
    expect(isCurrentManilaMonth(2027, 7, at)).toBe(false);
  });
});
