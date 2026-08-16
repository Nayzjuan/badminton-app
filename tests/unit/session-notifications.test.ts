// ============================================================
// Unit tests: session notice copy, unread rules, broadcast policy
// ============================================================

import { describe, expect, it } from "vitest";
import { CENTER_ALERT_CAP } from "@/lib/constants";
import {
  capCenterQueue,
  countsAsUnread,
  isActionable,
  isPendingCorrectionStatus,
  kindLabel,
  noticeBody,
  noticeTitle,
  shouldBroadcastAfterNoticeInsert,
  shouldInterrupt,
  upsertNotification,
} from "@/lib/session-notifications";
import type { SessionNotification } from "@/types/database";

function row(
  overrides: Partial<SessionNotification> & Pick<SessionNotification, "kind" | "status">
): SessionNotification {
  return {
    id: overrides.id ?? "n1",
    session_id: "s1",
    subject_player_id: "p1",
    match_id: overrides.match_id ?? null,
    payload: {
      playerName: "Alex",
      cancelledDraft: false,
      ...overrides.payload,
    },
    resolved_by: null,
    resolved_at: null,
    created_at: overrides.created_at ?? "2026-08-16T12:00:00.000Z",
    ...overrides,
  };
}

describe("leave vs checkout copy", () => {
  it("names a self-leave and a kick differently", () => {
    expect(noticeTitle(row({ kind: "player_left", status: "unread" }))).toBe("Alex left the queue");
    expect(noticeTitle(row({ kind: "player_checked_out", status: "unread" }))).toBe(
      "Alex was checked out"
    );
    expect(kindLabel("player_left")).toBe("Left");
    expect(kindLabel("player_checked_out")).toBe("Checked out");
  });

  it("mentions the kicking organizer when present", () => {
    expect(
      noticeBody(
        row({
          kind: "player_checked_out",
          status: "unread",
          payload: { playerName: "Alex", actorName: "Miggy" },
        })
      )
    ).toBe("Miggy removed them from the queue.");
  });
});

describe("unread + interrupt rules", () => {
  it("keeps a score correction pending after dismiss-equivalent read", () => {
    const pending = row({ kind: "score_correction", status: "unread", match_id: "m1" });
    const looked = row({ kind: "score_correction", status: "read", match_id: "m1" });
    expect(isPendingCorrectionStatus("read")).toBe(true);
    expect(isActionable(pending)).toBe(true);
    expect(isActionable(looked)).toBe(true);
    expect(countsAsUnread(pending)).toBe(true);
    expect(countsAsUnread(looked)).toBe(true);
    expect(countsAsUnread(row({ kind: "player_left", status: "read" }))).toBe(false);
  });

  it("does not interrupt catch-up pause rows or resolved corrections", () => {
    expect(
      shouldInterrupt(
        row({
          kind: "player_paused_long",
          status: "read",
          payload: { playerName: "Alex", bucket: 1, interrupt: false },
        })
      )
    ).toBe(false);
    expect(
      shouldInterrupt(row({ kind: "score_correction", status: "resolved", match_id: "m1" }))
    ).toBe(false);
    expect(shouldInterrupt(row({ kind: "player_left", status: "unread" }))).toBe(true);
  });
});

describe("inbox upsert + center cap", () => {
  it("replaces by id and keeps newest first", () => {
    const older = row({
      id: "a",
      kind: "player_left",
      status: "unread",
      created_at: "2026-08-16T10:00:00.000Z",
    });
    const newer = row({
      id: "b",
      kind: "player_left",
      status: "unread",
      created_at: "2026-08-16T11:00:00.000Z",
    });
    const updated = { ...older, status: "read" as const };
    expect(upsertNotification([older], newer).map((n) => n.id)).toEqual(["b", "a"]);
    expect(upsertNotification([older, newer], updated)[1]?.status).toBe("read");
  });

  it(`caps the center queue at ${CENTER_ALERT_CAP}`, () => {
    const queued = [1, 2, 3, 4, 5, 6, 7];
    expect(capCenterQueue(queued)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("notice insert broadcast policy", () => {
  it("skips a second fan-out on unique violation and still sends after other failures", () => {
    expect(shouldBroadcastAfterNoticeInsert({ code: "23505" })).toBe(false);
    expect(shouldBroadcastAfterNoticeInsert({ code: "42P01" })).toBe(true);
    expect(shouldBroadcastAfterNoticeInsert(null)).toBe(true);
  });
});
