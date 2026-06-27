// ============================================================
// Month helpers — Manila-calendar month math + labels
// ============================================================
// Pure, side-effect-free utilities shared by the monthly leaderboard
// server action (labels) and the useLeaderboard hook (default month).
// The "current month" is always computed in CLUB_TIMEZONE (Asia/Manila),
// never the runtime/browser timezone, so it matches the DB's month
// definition (get_monthly_leaderboard / get_leaderboard_months).
// ============================================================

import { CLUB_TIMEZONE } from "@/lib/constants";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** A 1-based calendar month in the club timezone. */
export type YearMonth = { year: number; month: number };

/** "June 2026". `month` is 1-based; out-of-range months render "?". */
export function formatMonthLabel(year: number, month: number): string {
  const name = MONTH_NAMES[month - 1] ?? "?";
  return `${name} ${year}`;
}

/**
 * The current calendar month in CLUB_TIMEZONE (Asia/Manila), regardless of the
 * runtime/browser timezone. Returns a 1-based month. `now` is injectable for tests.
 */
export function getCurrentManilaMonth(now: Date = new Date()): YearMonth {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CLUB_TIMEZONE,
    year: "numeric",
    month: "numeric",
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  return { year, month };
}

/** True when the given year/month is the current Manila month. */
export function isCurrentManilaMonth(year: number, month: number, now: Date = new Date()): boolean {
  const cur = getCurrentManilaMonth(now);
  return cur.year === year && cur.month === month;
}
