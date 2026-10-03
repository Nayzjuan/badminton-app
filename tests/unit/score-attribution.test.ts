// ============================================================
// Score + start attribution — pure rules
// ============================================================
// SA-1  player card is always `player`, even when the caller is an organizer
// SA-2  organizer modal + isOrganizer → organizer / organizer_end
// SA-3  organizer modal + in-match non-organizer (club admin as player) → player
// SA-4  call_next pins organizer actor fields
// SA-5  automatic starts pin system + null actor_id
// SA-6  parseJsonRpcResult accepts object and JSON string
// ============================================================

import { describe, it, expect } from "vitest";
import { parseJsonRpcResult, scoreActorType, startActorFields } from "@/lib/score-attribution";

describe("scoreActorType", () => {
  it("SA-1: participantVerified is always player, even when the caller is an organizer", () => {
    expect(scoreActorType({ participantVerified: true, isOrganizer: true })).toEqual({
      actorType: "player",
      via: "player_submit",
    });
  });

  it("SA-2: organizer modal + isOrganizer is organizer_end", () => {
    expect(scoreActorType({ participantVerified: false, isOrganizer: true })).toEqual({
      actorType: "organizer",
      via: "organizer_end",
    });
  });

  it("SA-3: club-admin-as-player on the organizer modal is still player", () => {
    expect(scoreActorType({ participantVerified: false, isOrganizer: false })).toEqual({
      actorType: "player",
      via: "player_submit",
    });
  });
});

describe("startActorFields", () => {
  it("SA-4: call_next pins the organizer on the event", () => {
    expect(
      startActorFields({ trigger: "call_next", actorId: "org-1", actorName: "Miggy" })
    ).toEqual({
      trigger: "call_next",
      actorType: "organizer",
      actorId: "org-1",
      actorName: "Miggy",
      triggerMatchId: null,
      triggerActorId: null,
      triggerActorName: null,
    });
  });

  it("SA-5: after_score / after_cancel are system starts with a null actor id", () => {
    expect(
      startActorFields({
        trigger: "after_score",
        triggerMatchId: "m1",
        triggerActorId: "p1",
        triggerActorName: "Nicole",
      })
    ).toEqual({
      trigger: "after_score",
      actorType: "system",
      actorId: null,
      actorName: null,
      triggerMatchId: "m1",
      triggerActorId: "p1",
      triggerActorName: "Nicole",
    });
  });
});

describe("parseJsonRpcResult", () => {
  it("SA-6: accepts an object and a JSON string, rejects junk", () => {
    expect(parseJsonRpcResult({ success: true })).toEqual({ success: true });
    expect(parseJsonRpcResult('{"success":false,"error":"already_settled"}')).toEqual({
      success: false,
      error: "already_settled",
    });
    expect(parseJsonRpcResult("not-json")).toBeNull();
    expect(parseJsonRpcResult(null)).toBeNull();
    expect(parseJsonRpcResult(12)).toBeNull();
  });
});
