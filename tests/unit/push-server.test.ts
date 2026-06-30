// @vitest-environment node
// ============================================================
// Unit Tests — pushToPlayers (server-side Web Push core)
// ============================================================
// Covers src/lib/notifications/push-server.ts:
//   PS-1 No-op on an empty id list (no web-push, no DB)
//   PS-2 De-dupes user ids before querying subscriptions
//   PS-3 COURT_CALL sends with { urgency:high, TTL:600, topic:court-call }
//   PS-4 ON_DECK_WARNING sends with { urgency:high, TTL:300, topic:on-deck }
//   PS-5 Payload carries the type + title/body
//   PS-6 Prunes 410/404 (expired) endpoints; counts the rest
//
// Strategy: mock web-push, the service client, and server-only.
// VAPID env vars are set so ensureVapid() passes.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// ── Mock web-push ─────────────────────────────────────────────
const sendNotificationMock = vi.fn();
const setVapidDetailsMock = vi.fn();
vi.mock("web-push", () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
    setVapidDetails: (...args: unknown[]) => setVapidDetailsMock(...args),
  },
}));

// ── Mock service client ───────────────────────────────────────
type Sub = { endpoint: string; p256dh: string; auth_key: string };
let subscriptions: Sub[] = [];
let selectError: { message: string } | null = null;
let lastSelectInUserIds: string[] | null = null;
let deletedEndpoints: string[] | null = null;

function makeClient() {
  return {
    from: (_table: string) => {
      let mode: "select" | "delete" | "" = "";
      const chain = {
        select: () => {
          mode = "select";
          return chain;
        },
        delete: () => {
          mode = "delete";
          return chain;
        },
        in: (_col: string, vals: string[]) => {
          if (mode === "select") {
            lastSelectInUserIds = vals;
            return Promise.resolve({ data: subscriptions, error: selectError });
          }
          deletedEndpoints = vals;
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  };
}

vi.mock("@/utils/supabase/service", () => ({
  createServiceClient: () => makeClient(),
}));

import { pushToPlayers } from "@/lib/notifications/push-server";

const SUB_A: Sub = { endpoint: "https://push/a", p256dh: "pa", auth_key: "aa" };
const SUB_B: Sub = { endpoint: "https://push/b", p256dh: "pb", auth_key: "ab" };

describe("pushToPlayers — server push core", () => {
  beforeEach(() => {
    process.env.VAPID_PUBLIC_KEY = "pub";
    process.env.VAPID_PRIVATE_KEY = "priv";
    process.env.VAPID_MAILTO = "mailto:test@example.com";
    subscriptions = [];
    selectError = null;
    lastSelectInUserIds = null;
    deletedEndpoints = null;
    sendNotificationMock.mockReset();
    sendNotificationMock.mockResolvedValue(undefined);
  });

  // ── PS-1 ────────────────────────────────────────────────────
  it("PS-1: no-ops on an empty id list", async () => {
    const res = await pushToPlayers([], "COURT_CALL");
    expect(res).toEqual({ sent: 0, errors: 0 });
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(lastSelectInUserIds).toBeNull(); // never queried the DB
  });

  // ── PS-2 ────────────────────────────────────────────────────
  it("PS-2: de-dupes user ids before the subscription query", async () => {
    subscriptions = [SUB_A];
    await pushToPlayers(["u1", "u1", "u2", ""], "ON_DECK_WARNING");
    expect(lastSelectInUserIds).toEqual(["u1", "u2"]); // falsy + dupes removed
  });

  // ── PS-3 ────────────────────────────────────────────────────
  it("PS-3: COURT_CALL sets urgency:high, TTL:600, topic:court-call", async () => {
    subscriptions = [SUB_A];
    await pushToPlayers(["u1"], "COURT_CALL");
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const [, , options] = sendNotificationMock.mock.calls[0];
    expect(options).toEqual({ urgency: "high", TTL: 600, topic: "court-call" });
  });

  // ── PS-4 ────────────────────────────────────────────────────
  it("PS-4: ON_DECK_WARNING sets urgency:high, TTL:300, topic:on-deck", async () => {
    subscriptions = [SUB_A];
    await pushToPlayers(["u1"], "ON_DECK_WARNING");
    const [, , options] = sendNotificationMock.mock.calls[0];
    expect(options).toEqual({ urgency: "high", TTL: 300, topic: "on-deck" });
  });

  // ── PS-5 ────────────────────────────────────────────────────
  it("PS-5: payload carries the type and a title/body", async () => {
    subscriptions = [SUB_A];
    await pushToPlayers(["u1"], "COURT_CALL");
    const [subscription, payloadStr] = sendNotificationMock.mock.calls[0];
    expect(subscription).toEqual({
      endpoint: SUB_A.endpoint,
      keys: { p256dh: SUB_A.p256dh, auth: SUB_A.auth_key },
    });
    const payload = JSON.parse(payloadStr as string);
    expect(payload.type).toBe("COURT_CALL");
    expect(typeof payload.title).toBe("string");
    expect(typeof payload.body).toBe("string");
    expect(payload.data.url).toBe("/clubs"); // club-consistent deep-link default (multi-tenant)
  });

  // ── PS-6 ────────────────────────────────────────────────────
  it("PS-6: prunes 410/404 endpoints and counts the successful sends", async () => {
    subscriptions = [SUB_A, SUB_B];
    sendNotificationMock.mockImplementation((sub: { endpoint: string }) => {
      if (sub.endpoint === SUB_B.endpoint) {
        return Promise.reject({ statusCode: 410 });
      }
      return Promise.resolve(undefined);
    });

    const res = await pushToPlayers(["u1", "u2"], "COURT_CALL");
    expect(res.sent).toBe(1); // SUB_A delivered
    expect(res.errors).toBe(0); // 410 is a prune, not an error
    expect(deletedEndpoints).toEqual([SUB_B.endpoint]);
  });
});
