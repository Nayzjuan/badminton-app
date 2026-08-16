// ============================================================
// Unit tests: the 'published' match-provenance event
// ============================================================
// `published` ("draft → published") was defined in the provenance feature
// (4955fc4) and plumbed end to end — logMatchEvent's eventType union accepts it,
// modificationDelta scores it 0, MatchEventTimeline renders it as "Published to
// players" — and then no caller ever passed it. Verified against prod on
// 2026-08-16: 0 rows of event_type='published' out of 1071 match_events, across
// a corpus that includes the 2 held cross-court drafts which demonstrably
// reached a court in session 3367d4c6. So this was never an unexercised path;
// the write simply did not exist.
//
// Why the gap mattered beyond tidiness: with nothing ever written, a
// match_events query cannot separate "never published" from "published, but
// unrecorded". Both look identical — an absent row. APP_MANIFEST §3.41 and
// MEMORY.md's cross-court section both hedge the 08/15 hand-clears on exactly
// that ambiguity.
//
// These cases assert at the DB boundary — the record_match_event RPC payload —
// rather than at the logPublishedEvents seam, because "the helper was called"
// is the assertion that would have passed for the whole time the ledger was
// empty. What has to be true is that a row reaches the writer.
//
// The complementary negatives matter just as much: a publish that did NOT
// happen must write nothing. ALREADY_PUBLISHED is the sharp one — it returns
// success:true, so an "on success, log" reading of the code writes a second
// event for a match nobody re-published.
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
// after() (fire-and-forget push) runs synchronously in tests.
vi.mock("next/server", () => ({ after: (cb: () => unknown) => cb() }));
vi.mock("@/lib/notifications/push-server", () => ({
  pushToPlayers: vi.fn().mockResolvedValue({ sent: 0, errors: 0 }),
}));
vi.mock("@/app/actions/matchmaking", async (importOriginal) => {
  // recomputeHeldReadiness is under test here, so the module is only PARTIALLY
  // mocked: runEngineForSession is stubbed (match-drafts calls it after every
  // publish and it would re-enter the DB mock), the rest stays real.
  const actual = await importOriginal<typeof import("@/app/actions/matchmaking")>();
  return { ...actual, runEngineForSession: vi.fn() };
});
vi.mock("@/app/actions/_shared", () => ({
  getAuthenticatedUser: vi.fn(),
  isSessionOrganizer: vi.fn(),
  getActorContext: vi.fn(),
}));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { getAuthenticatedUser, isSessionOrganizer, getActorContext } from "@/app/actions/_shared";
import { publishMatchAction, publishAllDraftMatchesAction } from "@/app/actions/match-drafts";
import { recomputeHeldReadiness } from "@/app/actions/matchmaking";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const MATCH_ID = "00000000-0000-4000-8000-000000000002";
const MATCH_ID_2 = "00000000-0000-4000-8000-000000000003";
const USER_ID = "00000000-0000-4000-8000-0000000000aa";
const STAMP = "2026-08-16T00:00:00.000Z";

// ── Table-keyed mock client ────────────────────────────────────
// Deliberately keyed by table name rather than by call position (the shape the
// neighbouring publish suites use). These paths interleave reads from four
// tables and the audit adds more, so a positional queue would make every future
// query insertion silently re-point an unrelated case's fixture at the wrong
// response. Convention: a queue of length > 1 advances per read; a queue of
// length 1 answers every read of that table.

type Resp = { data?: unknown; error?: unknown; count?: number };
type Call = { table: string; method: string; args: unknown[] };
type RpcCall = { name: string; args: Record<string, unknown> };

const CHAIN = [
  "select",
  "eq",
  "neq",
  "in",
  "not",
  "is",
  "gt",
  "gte",
  "lt",
  "lte",
  "or",
  "order",
  "limit",
  "update",
  "insert",
  "upsert",
  "delete",
];

function makeBuilder(table: string, next: () => Resp, log: Call[]) {
  const b: Record<string, unknown> = {};
  const settle = () => Promise.resolve(next());
  b["then"] = (res: (v: Resp) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
  b["catch"] = (rej: (e: unknown) => unknown) => settle().catch(rej);
  b["single"] = settle;
  b["maybeSingle"] = settle;
  for (const m of CHAIN) {
    b[m] = (...args: unknown[]) => {
      log.push({ table, method: m, args });
      return b;
    };
  }
  return b;
}

function makeDb(spec: { tables?: Record<string, Resp[]>; rpc?: Record<string, Resp[]> } = {}) {
  const calls: Call[] = [];
  const rpcCalls: RpcCall[] = [];
  const queues = new Map(Object.entries(spec.tables ?? {}).map(([k, v]) => [k, [...v]]));
  const rpcQueues = new Map(Object.entries(spec.rpc ?? {}).map(([k, v]) => [k, [...v]]));
  const take = (q: Resp[] | undefined): Resp =>
    (q && q.length > 1 ? q.shift() : q?.[0]) ?? { data: null, error: null };

  return {
    calls,
    rpcCalls,
    from: vi.fn((table: string) => makeBuilder(table, () => take(queues.get(table)), calls)),
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return take(rpcQueues.get(name));
    }),
  };
}

type Db = ReturnType<typeof makeDb>;

/** The events that actually reached the writer, in order. */
const events = (db: Db) =>
  db.rpcCalls
    .filter((c) => c.name === "record_match_event")
    .map((c) => c.args as Record<string, unknown>);

const payloadOf = (ev: Record<string, unknown>) => ev.p_payload as Record<string, unknown>;

/** The single-publish precondition read (server client, RLS). */
const serverClientFor = (sessionId: string | null) => ({
  from: vi.fn(() =>
    makeBuilder("matches", () => ({ data: sessionId ? { session_id: sessionId } : null }), [])
  ),
});

/** Roster fixtures shared by the audit's two snapshot reads. */
const ROSTER = [
  { match_id: MATCH_ID, team: "a", player_id: "p1" },
  { match_id: MATCH_ID, team: "a", player_id: "p2" },
  { match_id: MATCH_ID, team: "b", player_id: "p3" },
  { match_id: MATCH_ID, team: "b", player_id: "p4" },
];
const PROFILES = [
  { id: "p1", display_name: "Ana" },
  { id: "p2", display_name: "Ben" },
  { id: "p3", display_name: "Cy" },
  { id: "p4", display_name: "Dee" },
];

/** A normal (non-held) auto draft's provenance row. */
const provenance = (id = MATCH_ID, over: Partial<Record<string, unknown>> = {}) => ({
  id,
  created_method: "auto",
  is_held: false,
  held_ready_at: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthenticatedUser).mockResolvedValue({
    id: USER_ID,
    email: "org@test.com",
  } as never);
  vi.mocked(isSessionOrganizer).mockResolvedValue(true);
  vi.mocked(getActorContext).mockResolvedValue({ id: USER_ID, name: "Miggy" });
});

// ─────────────────────────────────────────────────────────────
// publishMatchAction — the single-draft transition
// ─────────────────────────────────────────────────────────────

describe("publishMatchAction — 'published' event", () => {
  it("PUB-EVT-1: a successful publish writes exactly one 'published' event, fully addressed", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(serverClientFor(SESSION_ID) as never);
    const db = makeDb({
      tables: {
        matches: [{ data: [provenance()] }],
        match_players: [{ data: ROSTER }],
        profiles: [{ data: PROFILES }],
      },
      rpc: { publish_match: [{ data: "SUCCESS" }] },
    });
    vi.mocked(createServiceClient).mockReturnValue(db as never);

    const result = await publishMatchAction(MATCH_ID);

    expect(result.success).toBe(true);
    const evs = events(db);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      p_match_id: MATCH_ID,
      p_session_id: SESSION_ID,
      p_event_type: "published",
      // pending on BOTH sides of the transition — publishing flips is_published,
      // never status — so "draft" per the codebase's pending ⇒ draft convention.
      p_phase: "draft",
      p_actor_type: "organizer",
      p_actor_id: USER_ID,
      p_actor_name: "Miggy",
    });
  });

  it("PUB-EVT-2: the payload names the path and snapshots the roster durably", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(serverClientFor(SESSION_ID) as never);
    const db = makeDb({
      tables: {
        matches: [{ data: [provenance()] }],
        match_players: [{ data: ROSTER }],
        profiles: [{ data: PROFILES }],
      },
      rpc: { publish_match: [{ data: "SUCCESS" }] },
    });
    vi.mocked(createServiceClient).mockReturnValue(db as never);

    await publishMatchAction(MATCH_ID);

    const p = payloadOf(events(db)[0]);
    expect(p.reason).toBe("publish_single");
    expect(p.created_method).toBe("auto");
    expect(p.is_held).toBe(false);
    expect(p.held_ready_at).toBeNull();
    // Names are captured at publish time so a later rename/merge can't rewrite
    // history — same reason the 'created' and 'cancelled' payloads carry them.
    expect(p.roster).toEqual([
      { team: "a", player_id: "p1", player_name: "Ana" },
      { team: "a", player_id: "p2", player_name: "Ben" },
      { team: "b", player_id: "p3", player_name: "Cy" },
      { team: "b", player_id: "p4", player_name: "Dee" },
    ]);
  });

  it("PUB-EVT-3: ALREADY_PUBLISHED writes NOTHING even though it answers success", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(serverClientFor(SESSION_ID) as never);
    const db = makeDb({ rpc: { publish_match: [{ data: "ALREADY_PUBLISHED" }] } });
    vi.mocked(createServiceClient).mockReturnValue(db as never);

    const result = await publishMatchAction(MATCH_ID);

    // The trap this case exists for: result.success is true, so "log on success"
    // would stamp a second review onto a match nobody re-published. Nothing
    // transitioned — is_published was already true — so nothing is recorded.
    expect(result.success).toBe(true);
    expect(events(db)).toHaveLength(0);
  });

  it.each([
    "HELD_NOT_READY",
    "HAS_LEFT_PLAYERS",
    "CONFLICT",
    "NOT_PENDING",
    "NOT_FOUND",
    "NOT_ORGANIZER",
  ])("PUB-EVT-4: %s writes nothing", async (code) => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(serverClientFor(SESSION_ID) as never);
    const db = makeDb({ rpc: { publish_match: [{ data: code }] } });
    vi.mocked(createServiceClient).mockReturnValue(db as never);

    const result = await publishMatchAction(MATCH_ID);

    expect(result.success).toBe(false);
    expect(events(db)).toHaveLength(0);
  });

  it("PUB-EVT-5: the JS fallback records it too — the ledger doesn't depend on migration state", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(serverClientFor(SESSION_ID) as never);
    const db = makeDb({
      tables: {
        matches: [
          // 1. the fallback's own precondition read
          {
            data: {
              session_id: SESSION_ID,
              status: "pending",
              is_published: false,
              is_held: false,
              held_ready_at: null,
            },
          },
          // 2. the conflict probe's "other active matches"
          { data: [] },
          // 3. the UPDATE, RETURNING the row it actually flipped
          { data: [{ id: MATCH_ID }] },
          // 4. the audit's provenance read
          { data: [provenance()] },
        ],
        match_players: [{ data: ROSTER }],
        profiles: [{ data: PROFILES }],
        queue_entries: [{ data: [] }],
      },
      // PGRST202 = "function does not exist" → the action falls back to JS.
      rpc: {
        publish_match: [
          { data: null, error: { message: "Could not find the function", code: "PGRST202" } },
        ],
      },
    });
    vi.mocked(createServiceClient).mockReturnValue(db as never);

    const result = await publishMatchAction(MATCH_ID);

    expect(result.success).toBe(true);
    const evs = events(db);
    expect(evs).toHaveLength(1);
    expect(evs[0].p_event_type).toBe("published");
    // Same reason as the RPC path on purpose: identical transition. Which one
    // ran is a property of the environment, not of the match.
    expect(payloadOf(evs[0]).reason).toBe("publish_single");
  });

  it("PUB-EVT-14: the fallback logs nothing when its UPDATE flipped no row", async () => {
    // The fallback's UPDATE carries .eq('is_published', false), so a concurrent
    // publisher landing between the precondition read and the write turns it
    // into a silent no-op that still returns no error. Logging on "no error"
    // would credit THIS organizer with the other one's transition — the
    // fallback's unlabelled ALREADY_PUBLISHED.
    vi.mocked(createServerSupabaseClient).mockResolvedValue(serverClientFor(SESSION_ID) as never);
    const db = makeDb({
      tables: {
        matches: [
          {
            data: {
              session_id: SESSION_ID,
              status: "pending",
              is_published: false,
              is_held: false,
              held_ready_at: null,
            },
          },
          { data: [] },
          // The UPDATE matched nothing — the other publisher got there first.
          { data: [] },
        ],
        match_players: [{ data: ROSTER }],
        profiles: [{ data: PROFILES }],
        queue_entries: [{ data: [] }],
      },
      rpc: {
        publish_match: [
          { data: null, error: { message: "Could not find the function", code: "PGRST202" } },
        ],
      },
    });
    vi.mocked(createServiceClient).mockReturnValue(db as never);

    const result = await publishMatchAction(MATCH_ID);

    // Still a success for the organizer — the match IS published, just not by
    // this call. That mirrors how the RPC path reports ALREADY_PUBLISHED.
    expect(result.success).toBe(true);
    expect(events(db)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// publishAllDraftMatchesAction — the batch transition
// ─────────────────────────────────────────────────────────────

describe("publishAllDraftMatchesAction — 'published' event", () => {
  it("PUB-EVT-6: one event per match that actually flipped — a skipped draft gets none", async () => {
    const db = makeDb({
      tables: {
        matches: [
          // 1. draft snapshot — two candidates
          {
            data: [
              { id: MATCH_ID, is_held: false, held_ready_at: null },
              { id: MATCH_ID_2, is_held: false, held_ready_at: null },
            ],
          },
          // 2. the re-read: only MATCH_ID flipped; MATCH_ID_2 was skipped
          { data: [{ id: MATCH_ID }] },
          // 3. the audit's provenance read
          { data: [provenance()] },
        ],
        match_players: [{ data: ROSTER }],
        profiles: [{ data: PROFILES }],
      },
      rpc: {
        publish_all_drafts: [{ data: { success: true, published_count: 1, skipped_count: 1 } }],
      },
    });
    vi.mocked(createServiceClient).mockReturnValue(db as never);

    const result = await publishAllDraftMatchesAction(SESSION_ID);

    expect(result.success).toBe(true);
    const evs = events(db);
    // The count comes from the same re-read that drives the on-deck push, so the
    // ledger and the notification cannot disagree about who was published.
    expect(evs).toHaveLength(1);
    expect(evs[0].p_match_id).toBe(MATCH_ID);
    expect(evs.some((e) => e.p_match_id === MATCH_ID_2)).toBe(false);
    expect(payloadOf(evs[0]).reason).toBe("publish_all");
  });

  it("PUB-EVT-7: a reported publish that the re-read cannot confirm writes nothing", async () => {
    const db = makeDb({
      tables: {
        matches: [
          { data: [{ id: MATCH_ID, is_held: false, held_ready_at: null }] },
          { data: [] }, // re-read finds nothing still pending+published
        ],
      },
      rpc: {
        publish_all_drafts: [{ data: { success: true, published_count: 1, skipped_count: 0 } }],
      },
    });
    vi.mocked(createServiceClient).mockReturnValue(db as never);

    await publishAllDraftMatchesAction(SESSION_ID);

    // Deliberately biased toward under-recording: the count the RPC reports is
    // not evidence about WHICH rows moved, and a 'published' row naming the
    // wrong match is worse than a missing one.
    expect(events(db)).toHaveLength(0);
  });

  it("PUB-EVT-8: the batch fallback records the UPDATE's own RETURNING set", async () => {
    const db = makeDb({
      tables: {
        matches: [
          // 1. the ACTION's own pre-RPC draft snapshot (it runs before the
          //    PGRST202 is seen, so the fallback re-reads the list itself)
          {
            data: [
              { id: MATCH_ID, is_held: false, held_ready_at: null },
              { id: MATCH_ID_2, is_held: false, held_ready_at: null },
            ],
          },
          // 2. the FALLBACK's draft list
          {
            data: [
              { id: MATCH_ID, is_held: false, held_ready_at: null },
              { id: MATCH_ID_2, is_held: false, held_ready_at: null },
            ],
          },
          // 3. "other active matches" conflict probe
          { data: [] },
          // 4. the UPDATE ... RETURNING id — only one row actually flipped
          { data: [{ id: MATCH_ID }] },
          // 5. the audit's provenance read
          { data: [provenance()] },
        ],
        match_players: [{ data: ROSTER }],
        profiles: [{ data: PROFILES }],
        queue_entries: [{ data: [] }],
      },
      rpc: {
        publish_all_drafts: [
          { data: null, error: { message: "Could not find the function", code: "PGRST202" } },
        ],
      },
    });
    vi.mocked(createServiceClient).mockReturnValue(db as never);

    const result = await publishAllDraftMatchesAction(SESSION_ID);

    expect(result.success).toBe(true);
    const evs = events(db);
    expect(evs).toHaveLength(1);
    expect(evs[0].p_match_id).toBe(MATCH_ID);
    expect(payloadOf(evs[0]).reason).toBe("publish_all");
  });
});

// ─────────────────────────────────────────────────────────────
// Held cross-court drafts — the distinguishing payload
// ─────────────────────────────────────────────────────────────

describe("held drafts — 'published' event", () => {
  it("PUB-EVT-9: a held draft's payload carries the pair that makes its wait measurable", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(serverClientFor(SESSION_ID) as never);
    const db = makeDb({
      tables: {
        matches: [
          {
            data: [
              provenance(MATCH_ID, { created_method: "held", is_held: true, held_ready_at: STAMP }),
            ],
          },
        ],
        match_players: [{ data: ROSTER }],
        profiles: [{ data: PROFILES }],
      },
      rpc: { publish_match: [{ data: "SUCCESS" }] },
    });
    vi.mocked(createServiceClient).mockReturnValue(db as never);

    await publishMatchAction(MATCH_ID);

    const p = payloadOf(events(db)[0]);
    expect(p.created_method).toBe("held");
    expect(p.is_held).toBe(true);
    // held_ready_at (when the hold unlocked) against the event's own created_at
    // (when it was published) is the gap the 08/15 post-mortem had no way to
    // measure — it could not even establish that the two surviving held drafts
    // were published rather than promoted by some other route.
    expect(p.held_ready_at).toBe(STAMP);
  });

  it("PUB-EVT-10: auto-publish on readiness is attributed to the engine, not to a person", async () => {
    const db = makeDb({
      tables: {
        matches: [
          // 1. the unready-held sweep
          {
            data: [
              {
                id: MATCH_ID,
                pulled_player_ids: ["p1"],
                pulled_from_match_id: "src-1",
                held_ready_at: null,
                created_at: new Date().toISOString(),
              },
            ],
          },
          // 2. the source match — completed, so the body is free
          { data: { status: "completed", completed_at: STAMP } },
          // 3. promotionsSinceFreed ≥ 1 ⇒ ready
          { count: 1, data: null },
          // 4. the held_ready_at stamp
          { data: null },
          // 5. the audit's provenance read
          {
            data: [
              provenance(MATCH_ID, { created_method: "held", is_held: true, held_ready_at: STAMP }),
            ],
          },
        ],
        sessions: [{ data: { auto_publish: true } }],
        match_players: [
          { data: [{ player_id: "p1" }] }, // roster-integrity probe (pulled body still in)
          { data: ROSTER }, // the audit's roster snapshot
        ],
        profiles: [{ data: PROFILES }],
      },
      rpc: { auto_publish_match: [{ data: "SUCCESS" }] },
    });
    vi.mocked(createServiceClient).mockReturnValue(db as never);

    await recomputeHeldReadiness(db as never, SESSION_ID);

    const evs = events(db);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      p_event_type: "published",
      p_match_id: MATCH_ID,
      // 'engine', NOT the actorId-derived 'system' default: no organizer
      // reviewed this, the matchmaker released it. Same distinction the
      // 'created' event draws inside create_match_with_players.
      p_actor_type: "engine",
      p_actor_id: null,
    });
    expect(payloadOf(evs[0]).reason).toBe("auto_publish_held");
  });

  it("PUB-EVT-11: auto-publish that the RPC refuses writes nothing", async () => {
    const db = makeDb({
      tables: {
        matches: [
          {
            data: [
              {
                id: MATCH_ID,
                pulled_player_ids: ["p1"],
                pulled_from_match_id: "src-1",
                held_ready_at: null,
                created_at: new Date().toISOString(),
              },
            ],
          },
          { data: { status: "completed", completed_at: STAMP } },
          { count: 1, data: null },
          { data: null },
        ],
        sessions: [{ data: { auto_publish: true } }],
        match_players: [{ data: [{ player_id: "p1" }] }],
      },
      rpc: {
        auto_publish_match: [{ data: "CONFLICT" }],
        clear_on_deck_match_atomic: [{ data: null }],
      },
    });
    vi.mocked(createServiceClient).mockReturnValue(db as never);

    await recomputeHeldReadiness(db as never, SESSION_ID);

    // The draft is stamped ready but never published — it gets cleared instead.
    expect(events(db)).toHaveLength(0);
    expect(db.rpcCalls.some((c) => c.name === "clear_on_deck_match_atomic")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// Best-effort semantics
// ─────────────────────────────────────────────────────────────

describe("'published' logging is best-effort", () => {
  it("PUB-EVT-12: a writer failure never fails the publish the organizer already saw succeed", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(serverClientFor(SESSION_ID) as never);
    const db = makeDb({
      tables: {
        matches: [{ data: [provenance()] }],
        match_players: [{ data: ROSTER }],
        profiles: [{ data: PROFILES }],
      },
      rpc: {
        publish_match: [{ data: "SUCCESS" }],
        record_match_event: [{ data: null, error: { message: "record_match_event exploded" } }],
      },
    });
    vi.mocked(createServiceClient).mockReturnValue(db as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await publishMatchAction(MATCH_ID);

    // Swallowed and logged — the publish is the user-facing mutation and it
    // already happened in the DB; failing the action here would report a false
    // negative about a match that IS published.
    expect(result.success).toBe(true);
    // Pin the actual failure, not just "something logged" — an unrelated
    // console.error on the publish path would satisfy a bare toHaveBeenCalled.
    expect(
      err.mock.calls.some(
        (c) =>
          String(c[0]).includes("[match-event-log] published") &&
          String(c[1] ?? "").includes("record_match_event exploded")
      )
    ).toBe(true);
    err.mockRestore();
  });

  it("PUB-EVT-13: a throwing client is swallowed too", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(serverClientFor(SESSION_ID) as never);
    const db = makeDb({ rpc: { publish_match: [{ data: "SUCCESS" }] } });
    // The provenance read throws outright, not a returned { error }.
    db.from = vi.fn((table: string) => {
      if (table === "matches") throw new Error("connection reset");
      return makeBuilder(table, () => ({ data: [] }), db.calls);
    }) as never;
    vi.mocked(createServiceClient).mockReturnValue(db as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await publishMatchAction(MATCH_ID);

    expect(result.success).toBe(true);
    expect(events(db)).toHaveLength(0);
    // Same as PUB-EVT-12: name the arm that swallowed it. This is the catch in
    // logPublishedEvents, not logMatchEvent's per-row one.
    expect(
      err.mock.calls.some((c) => String(c[0]).includes("[match-event-log] published batch threw"))
    ).toBe(true);
    err.mockRestore();
  });
});
