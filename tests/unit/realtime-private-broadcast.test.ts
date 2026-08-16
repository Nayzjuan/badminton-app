// @vitest-environment node
// ============================================================
// Unit Tests — private session-events broadcast (tenancy #7)
// ============================================================
// The two halves of the private-channel contract have to stay in lockstep,
// and each half fails SILENTLY if the other is dropped:
//
//   • server marks the message private, client joins public → the public
//     subscriber never sees it;
//   • client joins private, server sends public → the private subscriber
//     never sees it.
//
// Neither shows up as an error anywhere. These tests pin both halves, plus
// the JWT-before-join ordering, which stopped being an optimisation and
// became a hard requirement once the channel went private (the policy is
// `TO authenticated`; a join evaluated as `anon` is refused outright).
//
// There is a third silent-failure mode, and it cost months: the topic strings
// on the two halves simply not matching. The REST broadcast endpoint answers
// 202 for ANY topic, so a send to a topic nobody joined is indistinguishable
// from a delivered one. RPB-2 therefore asserts the sent topic against the
// name the client actually passes to `.channel()` rather than against a
// literal, so the two halves cannot drift apart again. RPB-3 keeps a literal
// so this pair can't agree on a wrong value and both pass. See APP_MANIFEST
// §3.27.
//
//   RPB-1 postBroadcast marks every message private
//   RPB-2 the send targets the exact topic the client subscribes to
//   RPB-3 the channel is opened with the literal name, { config: { private: true } }
//   RPB-4 the join is deferred until whenRealtimeAuthReady() settles
//   RPB-5 unsubscribing before the JWT resolves never joins at all
//   RPB-6 no INSERT path exists — the client never sends on this channel
//   RPB-7 draft_cap_phase uses the same private topic + carries lease metadata
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock the Realtime auth gate ───────────────────────────────
let releaseAuth: () => void;
let authReady: Promise<void>;

vi.mock("@/utils/supabase/client", () => ({
  whenRealtimeAuthReady: () => authReady,
}));

import {
  broadcastSessionClosed,
  broadcastOrganizerIntervention,
  broadcastDraftCapPhase,
  broadcastQueueNotice,
} from "@/lib/broadcast";
import { subscribeToOrganizerBroadcast } from "@/lib/realtime";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

// ── Fake Supabase client ──────────────────────────────────────
type ChannelCall = { name: string; opts: unknown };

function makeFakeClient() {
  const channelCalls: ChannelCall[] = [];
  const removed: unknown[] = [];
  const chan = {
    on: vi.fn(() => chan),
    subscribe: vi.fn(() => chan),
    send: vi.fn(),
  };
  const client = {
    channel: vi.fn((name: string, opts?: unknown) => {
      channelCalls.push({ name, opts });
      return chan;
    }),
    removeChannel: vi.fn((c: unknown) => {
      removed.push(c);
    }),
  };
  return { client, chan, channelCalls, removed };
}

/** Flush the microtask queue so the deferred `.then()` runs. */
const flush = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => {
  authReady = new Promise<void>((r) => {
    releaseAuth = r;
  });
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 202, text: async () => "" }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function lastFetchBody(): { messages: Array<Record<string, unknown>> } {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  const [, init] = fetchMock.mock.calls.at(-1) as [string, { body: string }];
  return JSON.parse(init.body);
}

describe("private session-events broadcast", () => {
  // ── Server half ─────────────────────────────────────────────

  it("RPB-1 marks every emitted message private", async () => {
    await broadcastSessionClosed(SESSION_ID, true);
    expect(lastFetchBody().messages[0].private).toBe(true);

    await broadcastOrganizerIntervention(SESSION_ID, "match_cancelled", ["p1"], {
      id: "org-1",
      name: "Org",
    });
    expect(lastFetchBody().messages[0].private).toBe(true);
  });

  it("RPB-2 sends to the exact topic the client subscribes to", async () => {
    // Regression guard. This assertion used to pin the topic to
    // `realtime:session-events:{id}`, which the Realtime REST API accepts with
    // a 202 and then routes to a channel no client ever joins — every event
    // was silently discarded in production. Assert the two halves against each
    // other rather than against a literal, so the pair cannot drift apart
    // again without a test failing.
    //
    // A relative assertion alone would pass if BOTH halves moved to the same
    // wrong value, so it is only safe while RPB-3 still pins the client's
    // channel name to the literal `session-events:{id}`. Do not relax that
    // assertion without replacing the anchor here.
    await broadcastSessionClosed(SESSION_ID, true);
    const msg = lastFetchBody().messages[0];

    const { client, channelCalls } = makeFakeClient();
    const unsub = subscribeToOrganizerBroadcast(client as never, SESSION_ID, {
      onIntervention: vi.fn(),
    });
    releaseAuth();
    await flush();
    unsub();

    expect(msg.topic).toBe(channelCalls[0].name);
    expect(msg.event).toBe("session_closed");
    expect(msg.payload).toEqual({ sessionId: SESSION_ID, wrappedReady: true });
  });

  // ── Client half ─────────────────────────────────────────────

  it("RPB-3 opens the channel as private", async () => {
    const { client, channelCalls } = makeFakeClient();
    const unsub = subscribeToOrganizerBroadcast(client as never, SESSION_ID, {
      onIntervention: vi.fn(),
    });

    releaseAuth();
    await flush();

    expect(channelCalls).toHaveLength(1);
    expect(channelCalls[0].name).toBe(`session-events:${SESSION_ID}`);
    expect(channelCalls[0].opts).toEqual({ config: { private: true } });
    unsub();
  });

  it("RPB-4 does not join before the Realtime JWT is set", async () => {
    const { client } = makeFakeClient();
    const unsub = subscribeToOrganizerBroadcast(client as never, SESSION_ID, {
      onIntervention: vi.fn(),
    });

    await flush();
    expect(client.channel).not.toHaveBeenCalled();

    releaseAuth();
    await flush();
    expect(client.channel).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("RPB-5 never joins when unsubscribed before the JWT resolves", async () => {
    const { client } = makeFakeClient();
    const unsub = subscribeToOrganizerBroadcast(client as never, SESSION_ID, {
      onIntervention: vi.fn(),
    });

    unsub();
    releaseAuth();
    await flush();

    expect(client.channel).not.toHaveBeenCalled();
    expect(client.removeChannel).not.toHaveBeenCalled();
  });

  it("RPB-7 draft_cap_phase rides the same private topic, with its lease metadata", async () => {
    // The lockout overlay's entire contract is on this one message. It was
    // emitted from a "use client" hook until 2026-08-04, where the service-role
    // key does not exist, so postBroadcast bailed at its missing-key guard and
    // no co-organizer was ever locked out. Pinning topic + private + payload
    // here means a future move back into a client module fails loudly: the
    // module now imports "server-only", so it cannot even be bundled.
    await broadcastDraftCapPhase(SESSION_ID, "clearing", 3, {
      opId: "op-1",
      actorId: "org-1",
      actorName: "Org",
      ttlMs: 45_000,
    });
    const msg = lastFetchBody().messages[0];

    const { client, channelCalls } = makeFakeClient();
    const unsub = subscribeToOrganizerBroadcast(client as never, SESSION_ID, {
      onIntervention: vi.fn(),
    });
    releaseAuth();
    await flush();
    unsub();

    expect(msg.topic).toBe(channelCalls[0].name);
    expect(msg.private).toBe(true);
    expect(msg.event).toBe("draft_cap_phase");
    // ttlMs is what lets a client self-unlock if the terminal "done" is lost;
    // opId is what stops the initiator's own echo from re-locking it.
    expect(msg.payload).toEqual({
      phase: "clearing",
      override: 3,
      opId: "op-1",
      actorId: "org-1",
      actorName: "Org",
      ttlMs: 45_000,
    });
  });

  it("RPB-8 queue_notice rides the same private topic", async () => {
    await broadcastQueueNotice(SESSION_ID, {
      kind: "player_left",
      playerId: "p1",
      playerName: "Alex",
      cancelledDraft: true,
    });
    const msg = lastFetchBody().messages[0];

    const { client, channelCalls } = makeFakeClient();
    const unsub = subscribeToOrganizerBroadcast(client as never, SESSION_ID, {
      onIntervention: vi.fn(),
    });
    releaseAuth();
    await flush();
    unsub();

    expect(msg.topic).toBe(channelCalls[0].name);
    expect(msg.private).toBe(true);
    expect(msg.event).toBe("queue_notice");
    expect(msg.payload).toEqual({
      kind: "player_left",
      playerId: "p1",
      playerName: "Alex",
      cancelledDraft: true,
    });
  });

  it("RPB-6 registers listeners only — the client never sends on this channel", async () => {
    const { client, chan } = makeFakeClient();
    const unsub = subscribeToOrganizerBroadcast(client as never, SESSION_ID, {
      onIntervention: vi.fn(),
    });

    releaseAuth();
    await flush();

    expect(chan.on).toHaveBeenCalledTimes(7);
    expect(chan.send).not.toHaveBeenCalled();
    unsub();
    expect(client.removeChannel).toHaveBeenCalledTimes(1);
  });
});
