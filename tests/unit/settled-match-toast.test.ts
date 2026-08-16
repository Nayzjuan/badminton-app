// ============================================================
// Unit Tests: settledMatchToast — organizer copy for a lost race
// ============================================================
//
// The organizer's submit can bounce for two settled reasons, and they mean
// opposite things operationally: after `already_scored` the game is done and
// recorded; after `match_cancelled` no score exists and the game has to be
// re-run. Both close the modal identically, which is exactly what invites
// collapsing them into one `settled` boolean with one message — and that
// collapse tells an organizer a score was kept when the match was cancelled.
// SMT-3 is the test that fails if anyone makes it.
//
// SMT-1 already_scored says a score was kept.
// SMT-2 match_cancelled says NO score was recorded — and never claims one was.
// SMT-3 The two are distinguishable (a collapse-to-one-branch regression fails).
// SMT-4 not_completed and undefined fall through to ordinary error handling.
// ============================================================

import { describe, it, expect } from "vitest";
import { settledMatchToast } from "@/lib/settled-match-toast";

describe("settledMatchToast", () => {
  it("SMT-1: already_scored reports that the other submission was kept", () => {
    const t = settledMatchToast("already_scored");
    expect(t).not.toBeNull();
    expect(t!.title).toMatch(/already scored/i);
    expect(t!.body).toMatch(/kept/i);
  });

  it("SMT-2: match_cancelled says no score was recorded, and claims no score was kept", () => {
    const t = settledMatchToast("match_cancelled");
    expect(t).not.toBeNull();
    expect(t!.title).toMatch(/cancelled/i);
    expect(t!.body).toMatch(/no score was recorded/i);
    // The specific regression: the cancelled path must never inherit the
    // already_scored sentence. An organizer told "the score they entered was
    // kept" will not re-run a game that was never played.
    expect(t!.body).not.toMatch(/kept/i);
    expect(t!.body).not.toMatch(/submitted this match first/i);
  });

  it("SMT-3: the two settled outcomes are distinguishable, not one shared string", () => {
    const scored = settledMatchToast("already_scored")!;
    const cancelled = settledMatchToast("match_cancelled")!;
    expect(scored.title).not.toBe(cancelled.title);
    expect(scored.body).not.toBe(cancelled.body);
  });

  it("SMT-4: non-settled codes return null so the caller handles them as errors", () => {
    expect(settledMatchToast("not_completed")).toBeNull();
    expect(settledMatchToast(undefined)).toBeNull();
  });
});
