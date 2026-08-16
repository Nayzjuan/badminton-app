// ============================================================
// Unit tests: organizer pause-bucket math + center-alert queue
// ============================================================

import { describe, expect, it } from "vitest";
import { PAUSE_REMIND_MINUTES } from "@/lib/constants";
import {
  clearPauseSeenForPlayer,
  dismissAlert,
  enqueueAlert,
  leaveAlert,
  minutesPaused,
  pauseAlert,
  pauseRemindBucket,
  pauseSeenKey,
  pausedBadge,
  collectDuePauseAlerts,
  parsePauseAlertId,
  prunePauseSeen,
  type OrganizerAlert,
} from "@/lib/organizer-alerts";

const T0 = Date.parse("2026-08-16T00:00:00.000Z");

describe("minutesPaused", () => {
  it("returns null when the stamp is missing or unparseable", () => {
    expect(minutesPaused(null, T0)).toBeNull();
    expect(minutesPaused(undefined, T0)).toBeNull();
    expect(minutesPaused("not-a-date", T0)).toBeNull();
  });

  it("floors to whole minutes and never goes negative", () => {
    expect(minutesPaused(new Date(T0).toISOString(), T0)).toBe(0);
    expect(minutesPaused(new Date(T0).toISOString(), T0 + 14 * 60_000 + 999)).toBe(14);
    expect(minutesPaused(new Date(T0).toISOString(), T0 + 15 * 60_000)).toBe(15);
    expect(minutesPaused(new Date(T0 + 60_000).toISOString(), T0)).toBe(0);
  });
});

describe("pauseRemindBucket", () => {
  it("is 0 until the first interval, then steps every 15 minutes", () => {
    expect(pauseRemindBucket(0)).toBe(0);
    expect(pauseRemindBucket(14)).toBe(0);
    expect(pauseRemindBucket(15)).toBe(1);
    expect(pauseRemindBucket(29)).toBe(1);
    expect(pauseRemindBucket(30)).toBe(2);
    expect(pauseRemindBucket(45)).toBe(3);
  });

  it("uses PAUSE_REMIND_MINUTES so a constant change moves the buckets", () => {
    expect(pauseRemindBucket(PAUSE_REMIND_MINUTES - 1)).toBe(0);
    expect(pauseRemindBucket(PAUSE_REMIND_MINUTES)).toBe(1);
  });
});

describe("pausedBadge", () => {
  it("stays muted 'Paused' before the first bucket", () => {
    expect(pausedBadge(null)).toEqual({ label: "Paused", tone: "muted" });
    expect(pausedBadge(14)).toEqual({ label: "Paused", tone: "muted" });
  });

  it("shows the floored interval and escalates tone after 15m", () => {
    expect(pausedBadge(15)).toEqual({ label: "Paused 15m", tone: "amber" });
    expect(pausedBadge(29)).toEqual({ label: "Paused 15m", tone: "amber" });
    expect(pausedBadge(30)).toEqual({ label: "Paused 30m", tone: "red" });
    expect(pausedBadge(47)).toEqual({ label: "Paused 45m", tone: "red" });
  });
});

describe("alert queue", () => {
  const leave = leaveAlert("Alex", false, "leave:alex:1");
  const pause = pauseAlert("Alex", 1, "alex");

  it("appends and de-dupes by id", () => {
    const once = enqueueAlert([], leave);
    expect(once).toEqual([leave]);
    expect(enqueueAlert(once, leave)).toBe(once);
    const both = enqueueAlert(once, pause);
    expect(both).toEqual([leave, pause]);
  });

  it("dismiss pops the front so the next card is current", () => {
    const queued = enqueueAlert(enqueueAlert([], leave), pause);
    expect(dismissAlert(queued)).toEqual([pause]);
    expect(dismissAlert([pause])).toEqual([]);
    expect(dismissAlert([])).toEqual([]);
  });

  it("leave copy mentions a cancelled draft only when asked", () => {
    expect(leaveAlert("Alex", false, "a").body).not.toMatch(/draft/i);
    expect(leaveAlert("Alex", true, "b").body).toMatch(/draft/i);
  });

  it("pause copy uses the bucket interval, not raw minutes", () => {
    expect(pauseAlert("Alex", 2, "alex").title).toBe("Alex has been paused for 30 minutes");
  });

  it("parses pause alert ids back into player + bucket", () => {
    expect(parsePauseAlertId(pauseAlert("Alex", 2, "alex").id)).toEqual({
      playerId: "alex",
      bucket: 2,
    });
    expect(parsePauseAlertId("leave:alex")).toBeNull();
  });
});

describe("clearPauseSeenForPlayer", () => {
  it("drops only that player's bucket keys", () => {
    const seen = new Set([pauseSeenKey("a", 1), pauseSeenKey("a", 2), pauseSeenKey("b", 1)]);
    clearPauseSeenForPlayer(seen, "a");
    expect([...seen]).toEqual([pauseSeenKey("b", 1)]);
  });
});

describe("collectDuePauseAlerts", () => {
  const alex = {
    player_id: "alex",
    is_paused: true,
    paused_at: new Date(T0).toISOString(),
    display_name: "Alex",
  };

  it("returns nothing before the first bucket and skips already-seen keys", () => {
    expect(collectDuePauseAlerts([alex], T0 + 14 * 60_000, new Set())).toEqual([]);
    const due = collectDuePauseAlerts([alex], T0 + 15 * 60_000, new Set());
    expect(due).toEqual([pauseAlert("Alex", 1, "alex")]);
    expect(
      collectDuePauseAlerts([alex], T0 + 15 * 60_000, new Set([pauseSeenKey("alex", 1)]))
    ).toEqual([]);
  });

  it("does not mutate seen, so a discarded render cannot swallow a bucket", () => {
    const seen = new Set<string>();
    collectDuePauseAlerts([alex], T0 + 30 * 60_000, seen);
    expect(seen.size).toBe(0);
  });
});

describe("prunePauseSeen", () => {
  it("clears resumed and departed players without mutating the input", () => {
    const seen = new Set([pauseSeenKey("a", 1), pauseSeenKey("b", 1), pauseSeenKey("gone", 1)]);
    const next = prunePauseSeen(seen, [
      { player_id: "a", is_paused: false, paused_at: null, display_name: "A" },
      { player_id: "b", is_paused: true, paused_at: new Date(T0).toISOString(), display_name: "B" },
    ]);
    expect([...next]).toEqual([pauseSeenKey("b", 1)]);
    expect(seen.has(pauseSeenKey("a", 1))).toBe(true);
  });

  it("returns the same Set when nothing changed", () => {
    const seen = new Set([pauseSeenKey("b", 1)]);
    const same = prunePauseSeen(seen, [
      { player_id: "b", is_paused: true, paused_at: new Date(T0).toISOString(), display_name: "B" },
    ]);
    expect(same).toBe(seen);
  });
});

// Keep OrganizerAlert assignable so a later field rename fails here, not in UI.
const _typePin: OrganizerAlert = leaveAlert("x", false, "id");
void _typePin;
