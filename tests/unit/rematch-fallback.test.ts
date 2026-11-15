import { describe, expect, it } from "vitest";
import {
  REMATCH_FALLBACK_SUNSET_MANILA,
  isRematchFallbackEnabled,
  shouldRetryRematchFallback,
} from "@/lib/matchmaking-slots";

/** Last inclusive Manila minute of 2026-11-21 = 15:59 UTC. */
const SATURDAY_MANILA = new Date("2026-11-21T15:59:00.000Z");
/** First Manila minute of 2026-11-22 = 16:00 UTC Nov 21. */
const SUNDAY_MANILA = new Date("2026-11-21T16:00:00.000Z");
const BEFORE_SATURDAY = new Date("2026-11-15T10:00:00.000Z");

describe("isRematchFallbackEnabled", () => {
  it("unset / empty / off is hard rematch even before the Saturday sunset", () => {
    expect(isRematchFallbackEnabled(undefined, BEFORE_SATURDAY)).toBe(false);
    expect(isRematchFallbackEnabled("", BEFORE_SATURDAY)).toBe(false);
    expect(isRematchFallbackEnabled("off", BEFORE_SATURDAY)).toBe(false);
    expect(isRematchFallbackEnabled("false", BEFORE_SATURDAY)).toBe(false);
    expect(isRematchFallbackEnabled("0", BEFORE_SATURDAY)).toBe(false);
  });

  it("on/true/1 restores the yield through the first Saturday inclusive", () => {
    expect(REMATCH_FALLBACK_SUNSET_MANILA).toBe("2026-11-21");
    expect(isRematchFallbackEnabled("on", BEFORE_SATURDAY)).toBe(true);
    expect(isRematchFallbackEnabled("ON", SATURDAY_MANILA)).toBe(true);
    expect(isRematchFallbackEnabled("true", SATURDAY_MANILA)).toBe(true);
    expect(isRematchFallbackEnabled("1", SATURDAY_MANILA)).toBe(true);
  });

  it("goes off after the first Saturday even if the env is still on", () => {
    expect(isRematchFallbackEnabled("on", SUNDAY_MANILA)).toBe(false);
    expect(isRematchFallbackEnabled("true", new Date("2026-11-22T00:00:00.000Z"))).toBe(false);
  });
});

describe("shouldRetryRematchFallback", () => {
  const blocked = {
    hasProposal: false,
    rematchBlocked: true as const,
    noImmediateRematch: true,
  };

  it("retries only a rematch-blocked miss when the kill switch is on", () => {
    expect(shouldRetryRematchFallback({ ...blocked, rematchFallbackEnabled: true })).toBe(true);
    expect(shouldRetryRematchFallback({ ...blocked, rematchFallbackEnabled: false })).toBe(false);
  });

  it("does not retry a served four, a non-rematch miss, or R1-off", () => {
    expect(
      shouldRetryRematchFallback({
        hasProposal: true,
        rematchBlocked: true,
        noImmediateRematch: true,
        rematchFallbackEnabled: true,
      })
    ).toBe(false);
    expect(
      shouldRetryRematchFallback({
        hasProposal: false,
        rematchBlocked: undefined,
        noImmediateRematch: true,
        rematchFallbackEnabled: true,
      })
    ).toBe(false);
    expect(
      shouldRetryRematchFallback({
        ...blocked,
        noImmediateRematch: false,
        rematchFallbackEnabled: true,
      })
    ).toBe(false);
  });
});
