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
//   RPB-1 postBroadcast marks every message private
//   RPB-2 the emitted topic/event/payload shape is unchanged otherwise
//   RPB-3 the channel is opened with { config: { private: true } }
//   RPB-4 the join is deferred until whenRealtimeAuthReady() settles
//   RPB-5 unsubscribing before the JWT resolves never joins at all
//   RPB-6 no INSERT path exists — the client never sends on this channel
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock the Realtime auth gate ───────────────────────────────
let releaseAuth: () => void;
let authReady: Promise<void>;

vi.mock("@/utils/supabase/client", () => ({
  whenRealtimeAuthReady: () => authReady,
}));

import { broadcastSessionClosed, broadcastOrganizerIntervention } from "@/lib/broadcast";
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
    await broadcastSessionClosed(SESSION_ID);
    expect(lastFetchBody().messages[0].private).toBe(true);

    await broadcastOrganizerIntervention(SESSION_ID, "match_cancelled", ["p1"], {
      id: "org-1",
      name: "Org",
    });
    expect(lastFetchBody().messages[0].private).toBe(true);
  });

  it("RPB-2 leaves the topic, event and payload shape untouched", async () => {
    await broadcastSessionClosed(SESSION_ID);
    const msg = lastFetchBody().messages[0];
    expect(msg.topic).toBe(`realtime:session-events:${SESSION_ID}`);
    expect(msg.event).toBe("session_closed");
    expect(msg.payload).toEqual({ sessionId: SESSION_ID });
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

  it("RPB-6 registers listeners only — the client never sends on this channel", async () => {
    const { client, chan } = makeFakeClient();
    const unsub = subscribeToOrganizerBroadcast(client as never, SESSION_ID, {
      onIntervention: vi.fn(),
    });

    releaseAuth();
    await flush();

    expect(chan.on).toHaveBeenCalledTimes(6);
    expect(chan.send).not.toHaveBeenCalled();
    unsub();
    expect(client.removeChannel).toHaveBeenCalledTimes(1);
  });
});
