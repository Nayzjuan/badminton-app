import { describe, it, expect } from "vitest";
import { idleScoreModalDecision, toastForTerminalMatchStatus } from "@/lib/idle-score-modal";
import { settledMatchToast } from "@/lib/settled-match-toast";

const MATCH_A = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const MATCH_B = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";

describe("idleScoreModalDecision", () => {
  it("ISM-1: ignores a closed modal", () => {
    expect(
      idleScoreModalDecision({
        scoringMatchId: null,
        liveMatchIds: [MATCH_A],
        endingMatchId: null,
      })
    ).toBe("ignore");
  });

  it("ISM-2: ignores while the scored match is still live", () => {
    expect(
      idleScoreModalDecision({
        scoringMatchId: MATCH_A,
        liveMatchIds: [MATCH_A, MATCH_B],
        endingMatchId: null,
      })
    ).toBe("ignore");
  });

  it("ISM-3: in-flight submit owns the toast even after the id drops", () => {
    expect(
      idleScoreModalDecision({
        scoringMatchId: MATCH_A,
        liveMatchIds: [MATCH_B],
        endingMatchId: MATCH_A,
      })
    ).toBe("in_flight");
  });

  it("ISM-4: idle disappearance settles", () => {
    expect(
      idleScoreModalDecision({
        scoringMatchId: MATCH_A,
        liveMatchIds: [MATCH_B],
        endingMatchId: null,
      })
    ).toBe("settle");
  });

  it("ISM-5: a different in-flight end does not suppress this modal", () => {
    expect(
      idleScoreModalDecision({
        scoringMatchId: MATCH_A,
        liveMatchIds: [],
        endingMatchId: MATCH_B,
      })
    ).toBe("settle");
  });
});

describe("toastForTerminalMatchStatus", () => {
  it("ISM-6: completed keeps the already-scored copy", () => {
    expect(toastForTerminalMatchStatus("completed")).toEqual(settledMatchToast("already_scored"));
  });

  it("ISM-7: cancelled keeps the cancelled copy — distinct from scored", () => {
    const cancelled = toastForTerminalMatchStatus("cancelled");
    const scored = toastForTerminalMatchStatus("completed");
    expect(cancelled).toEqual(settledMatchToast("match_cancelled"));
    expect(cancelled?.title).not.toBe(scored?.title);
    expect(cancelled?.body).not.toBe(scored?.body);
  });

  it("ISM-8: unknown status stays neutral — it does not claim a score was kept", () => {
    const unknown = toastForTerminalMatchStatus(null);
    expect(unknown.title).toMatch(/ended/i);
    expect(unknown.body.toLowerCase()).not.toMatch(/score they entered was kept/);
  });
});
