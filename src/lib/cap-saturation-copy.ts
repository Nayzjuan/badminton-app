// ============================================================
// Cap-saturation notice copy — one row per reason × zone
// ============================================================
// Strings are the organizer-facing stall copy. Adding a reason is adding
// a row; CapSaturationNotice must not grow nested ternaries around them.

import { CRITICAL_WAIT_MINUTES, MAX_PARTNERSHIP_REPEATS } from "@/lib/constants";

export type CapSaturationReason = "immediate_rematch" | "consecutive" | "session_cap";
export type CapSaturationZone = "general" | "red_zone";

type CapSaturationCopyRow = {
  heading: string;
  noticeLabel: string;
  general: (name: string) => string;
  red_zone: (name: string) => string;
};

const COPY: Record<CapSaturationReason, CapSaturationCopyRow> = {
  immediate_rematch: {
    heading: "Immediate rematch blocked",
    noticeLabel: "Immediate-rematch notice",
    general: (name) =>
      `Could not form a match for ${name} — every remaining group would repeat someone's last game. Assign manually or wait for a court to finish.`,
    red_zone: (name) =>
      `${name} has been waiting over ${CRITICAL_WAIT_MINUTES} min, but every available group would put someone back with a player from their last game. Manual assignment needed.`,
  },
  consecutive: {
    heading: "Last partnership blocked",
    noticeLabel: "Last-partnership notice",
    general: (name) =>
      `Could not form a match for ${name} — remaining combinations would reuse last game's teammates. Consider a manual override or wait for ongoing matches to finish.`,
    red_zone: (name) =>
      `${name} has been waiting over ${CRITICAL_WAIT_MINUTES} min but seating them would reuse last game's teammates. Manual assignment needed.`,
  },
  session_cap: {
    heading: "Partner-pair cap reached",
    noticeLabel: "Partner-pair cap notice",
    general: (name) =>
      `Could not form a match for ${name} — all partner combinations have reached the ${MAX_PARTNERSHIP_REPEATS}-game cap. Consider a manual override or wait for ongoing matches to finish.`,
    red_zone: (name) =>
      `${name} has been waiting over ${CRITICAL_WAIT_MINUTES} min but all available teammates have already hit the ${MAX_PARTNERSHIP_REPEATS}-game partner cap. Manual assignment needed.`,
  },
};

const DEFAULT_REASON: CapSaturationReason = "session_cap";

export function capSaturationCopy(args: {
  reason: CapSaturationReason | undefined;
  zone: CapSaturationZone;
  anchorPlayerName: string;
}): { heading: string; body: string; noticeLabel: string } {
  const reason = args.reason && args.reason in COPY ? args.reason : DEFAULT_REASON;
  const row = COPY[reason];
  return {
    heading: row.heading,
    noticeLabel: row.noticeLabel,
    body: row[args.zone](args.anchorPlayerName),
  };
}
