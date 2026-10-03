// ============================================================
// Match History copy — scored / started never render duration
// ============================================================

import { describe, it, expect } from "vitest";
import { describeMatchEvent, describeMatchEventActor } from "@/lib/match-event-copy";
import type { MatchEvent } from "@/types/database";

function ev(over: Partial<MatchEvent>): MatchEvent {
  return {
    id: "e1",
    match_id: "m1",
    session_id: "s1",
    match_id_snapshot: "m1",
    session_id_snapshot: "s1",
    seq: 1,
    event_type: "scored",
    phase: "active",
    actor_type: "player",
    actor_id: "p1",
    actor_name: "Nicole",
    correlation_id: null,
    reverses_event_id: null,
    movements: [],
    payload: {},
    created_at: "2026-10-03T12:26:44.000Z",
    ...over,
  };
}

describe("describeMatchEvent", () => {
  it("MEC-1: scored shows the score and never the duration", () => {
    const text = describeMatchEvent(
      ev({
        payload: { a: 14, b: 31, seconds_since_start: 30, via: "player_submit" },
      })
    );
    expect(text).toBe("Scored 14–31");
    expect(text).not.toMatch(/30|second|duration|min/i);
  });

  it("MEC-2: started after a score names the trigger person, not a duration", () => {
    const text = describeMatchEvent(
      ev({
        event_type: "started",
        actor_type: "system",
        actor_name: null,
        payload: {
          trigger: "after_score",
          court_name: "Court 11",
          trigger_actor_name: "Nicole",
          seconds_since_start: 29,
        },
      })
    );
    expect(text).toMatch(/Court 11/);
    expect(text).toMatch(/Nicole/);
    expect(text).not.toMatch(/29|second|duration/i);
  });

  it("MEC-3: score_edit stays a correction, not a first score", () => {
    expect(
      describeMatchEvent(
        ev({
          event_type: "score_edit",
          payload: { old: { a: 21, b: 15 }, new: { a: 21, b: 19 } },
        })
      )
    ).toBe("Score corrected 21–15 → 21–19");
  });
});

describe("describeMatchEventActor", () => {
  it("MEC-4: a player scorer is labelled as a player", () => {
    expect(describeMatchEventActor(ev({}))).toBe(" · Nicole (player)");
  });

  it("MEC-5: a system start has no actor suffix", () => {
    expect(
      describeMatchEventActor(ev({ event_type: "started", actor_type: "system", actor_name: null }))
    ).toBe("");
  });
});
