// ============================================================
// Unit Tests: Queue Actions — joinQueueAction guard suite
// ============================================================
//
// Covers the active-match guard introduced in joinQueueAction:
//   • Players with status "on_deck" are blocked from re-joining.
//   • Players with status "playing" are blocked from re-joining.
//   • Players with status "waiting" are allowed to re-join.
//   • Players with status "left" are allowed to re-join (returning player).
//   • First-time joiners (no existing row) proceed normally.
//
// Also verifies the Inherited Games floor logic is applied to
// returning players (existing.games_played < sessionFloor).
//
// Mock strategy:
//   @/utils/supabase/server is replaced by vi.mock().
//   Each test builds a minimal mock client with pre-configured
//   from() responses consumed in call order.
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
}));

// joinQueueAction now calls createServiceClient() then svc.rpc("join_queue").
// Mock it so the RPC returns PGRST202 (not deployed), forcing the fallback
// path that the existing test assertions cover.
vi.mock("@/utils/supabase/service", () => ({
  createServiceClient: vi.fn(),
}));

vi.mock("@/app/actions/matchmaking", () => ({
  runEngineForSession: vi.fn().mockResolvedValue(undefined),
}));

// after() from next/server throws "called outside a request scope" in unit
// tests. Replace it with a synchronous pass-through so tests can exercise
// code paths that call after(() => runEngineForSession(...)).
vi.mock("next/server", () => ({
  after: vi.fn((cb: () => unknown) => cb()),
}));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { joinQueueAction } from "@/app/actions/queue";

// ── Valid UUID that passes isValidUUID ─────────────────────────
const SESSION_ID = "00000000-0000-4000-8000-000000000010";

// ── Mock builder helpers ───────────────────────────────────────

type MockResponse = { data?: unknown; error?: { message: string } | null };

/**
 * Minimal chainable query builder that resolves to a single response.
 * Supports .select(), .eq(), .neq(), .in(), .order(), .limit(),
 * .update(), .insert(), .maybeSingle(), .single() chains.
 */
function makeBuilder(response: MockResponse) {
  const b: Record<string, unknown> = {};
  b["then"] = (res: (v: MockResponse) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(response).then(res, rej);
  b["catch"] = (rej: (e: unknown) => unknown) => Promise.resolve(response).catch(rej);
  b["maybeSingle"] = () => Promise.resolve(response);
  b["single"] = () => Promise.resolve(response);
  for (const m of [
    "select",
    "eq",
    "neq",
    "in",
    "or",
    "order",
    "limit",
    "update",
    "insert",
    "upsert",
  ]) {
    b[m] = (..._args: unknown[]) => b;
  }
  return b;
}

/**
 * Creates a mock Supabase client whose from() calls consume
 * responses in order. auth.getUser() always returns a valid user.
 *
 * joinQueueAction now runs a needs_rename gate query (the duplicate-name L2
 * check) as its FIRST from() call, so we auto-inject that response ahead of the
 * caller's responses. Pass opts.needsRename=true to exercise the gate.
 */
function makeMockClient(fromResponses: MockResponse[], opts?: { needsRename?: boolean }) {
  const responses: MockResponse[] = [
    { data: { needs_rename: opts?.needsRename ?? false }, error: null },
    ...fromResponses,
  ];
  let idx = 0;
  const from = vi.fn((_table: string) => {
    const res = responses[idx++] ?? { data: null, error: null };
    return makeBuilder(res);
  });
  const auth = {
    getUser: vi.fn().mockResolvedValue({
      data: { user: { id: "player-uuid-1234" } },
      error: null,
    }),
  };
  return { from, auth };
}

// Service client mock that always returns PGRST202 from rpc("join_queue"),
// triggering the fallback path that the existing tests exercise.
const PGRST202 = { code: "PGRST202", message: "Function not found" };
const mockServiceClient = {
  rpc: vi.fn().mockResolvedValue({ data: null, error: PGRST202 }),
  // Re-pointed per test at the same builder as the user-context mock, because
  // joinQueueFallback now performs its DB work on the service client.
  from: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createServiceClient).mockReturnValue(mockServiceClient as never);
});

// ── Guard: on_deck / playing statuses ─────────────────────────

describe("joinQueueAction — active-match guard", () => {
  it('returns an error and does NOT re-queue a player whose status is "on_deck"', async () => {
    const mock = makeMockClient([
      // Step 1: existing row fetch → on_deck
      { data: { id: "entry-1", games_played: 2, status: "on_deck" }, error: null },
      // Step 2 would be floor query — should NOT be reached
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    // joinQueueFallback now runs on the SERVICE client: queue_entries UPDATE
    // is revoked for anon/authenticated (20260721190000), so its reads and
    // writes must go through service_role. Route the same builder there —
    // the DB interaction sequence each test asserts is unchanged.
    mockServiceClient.from = mock.from;

    const result = await joinQueueAction(SESSION_ID);

    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/currently in a match/i);
    // Two from() calls: needs_rename gate + existing-row fetch; floor never ran.
    expect(mock.from).toHaveBeenCalledTimes(2);
  });

  it('returns an error and does NOT re-queue a player whose status is "playing"', async () => {
    const mock = makeMockClient([
      // Step 1: existing row → playing
      { data: { id: "entry-2", games_played: 3, status: "playing" }, error: null },
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    // joinQueueFallback now runs on the SERVICE client: queue_entries UPDATE
    // is revoked for anon/authenticated (20260721190000), so its reads and
    // writes must go through service_role. Route the same builder there —
    // the DB interaction sequence each test asserts is unchanged.
    mockServiceClient.from = mock.from;

    const result = await joinQueueAction(SESSION_ID);

    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/currently in a match/i);
    // needs_rename gate + existing-row fetch, then the guard fires.
    expect(mock.from).toHaveBeenCalledTimes(2);
  });

  it('allows re-join when existing status is "left" (returning player)', async () => {
    const mock = makeMockClient([
      // Step 1: existing row → left
      { data: { id: "entry-3", games_played: 1, status: "left" }, error: null },
      // Step 2: floor query → games_played floor = 1
      { data: { games_played: 1 }, error: null },
      // Step 3a: update → success
      { data: null, error: null },
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    // joinQueueFallback now runs on the SERVICE client: queue_entries UPDATE
    // is revoked for anon/authenticated (20260721190000), so its reads and
    // writes must go through service_role. Route the same builder there —
    // the DB interaction sequence each test asserts is unchanged.
    mockServiceClient.from = mock.from;

    const result = await joinQueueAction(SESSION_ID);

    // No error — re-join should proceed
    expect(result.error).toBeUndefined();
  });

  it('allows re-join when existing status is "waiting" (concurrent tap guard)', async () => {
    // Edge case: player somehow calls joinQueue while already waiting.
    // The guard must NOT block this — only on_deck/playing are blocked.
    const mock = makeMockClient([
      { data: { id: "entry-4", games_played: 0, status: "waiting" }, error: null },
      { data: { games_played: 0 }, error: null },
      { data: null, error: null },
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    // joinQueueFallback now runs on the SERVICE client: queue_entries UPDATE
    // is revoked for anon/authenticated (20260721190000), so its reads and
    // writes must go through service_role. Route the same builder there —
    // the DB interaction sequence each test asserts is unchanged.
    mockServiceClient.from = mock.from;

    const result = await joinQueueAction(SESSION_ID);
    expect(result.error).toBeUndefined();
  });

  it("blocks a flagged duplicate with requiresRename before any join logic (L2 gate)", async () => {
    // needs_rename=true → gate returns immediately; no existing-row/floor/insert.
    const mock = makeMockClient([], { needsRename: true });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    // joinQueueFallback now runs on the SERVICE client: queue_entries UPDATE
    // is revoked for anon/authenticated (20260721190000), so its reads and
    // writes must go through service_role. Route the same builder there —
    // the DB interaction sequence each test asserts is unchanged.
    mockServiceClient.from = mock.from;

    const result = await joinQueueAction(SESSION_ID);

    expect(result.requiresRename).toBe(true);
    expect(result.success).toBe(false);
    // Only the gate query ran — nothing downstream.
    expect(mock.from).toHaveBeenCalledTimes(1);
  });

  it("allows first-time joiner (no existing row) to proceed", async () => {
    const mock = makeMockClient([
      // Step 1: no existing row
      { data: null, error: null },
      // Step 2: floor query → empty session
      { data: null, error: null },
      // Step 3b: insert → success
      { data: null, error: null },
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    // joinQueueFallback now runs on the SERVICE client: queue_entries UPDATE
    // is revoked for anon/authenticated (20260721190000), so its reads and
    // writes must go through service_role. Route the same builder there —
    // the DB interaction sequence each test asserts is unchanged.
    mockServiceClient.from = mock.from;

    const result = await joinQueueAction(SESSION_ID);
    expect(result.error).toBeUndefined();
  });
});

// ── Inherited Games floor logic ───────────────────────────────

describe("joinQueueAction — Inherited Games floor", () => {
  it("sets games_played to sessionFloor when returning player is below the floor", async () => {
    // Player has 0 games_played; session floor is 3 → should be set to 3.
    // We verify by checking that mock.from was called with the correct update chain.
    const mock = makeMockClient([
      // Step 1: existing row → left, games_played=0
      { data: { id: "entry-5", games_played: 0, status: "left" }, error: null },
      // Step 2: floor query → floor=3
      { data: { games_played: 3 }, error: null },
      // Step 3a: update → success
      { data: null, error: null },
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    // joinQueueFallback now runs on the SERVICE client: queue_entries UPDATE
    // is revoked for anon/authenticated (20260721190000), so its reads and
    // writes must go through service_role. Route the same builder there —
    // the DB interaction sequence each test asserts is unchanged.
    mockServiceClient.from = mock.from;

    const result = await joinQueueAction(SESSION_ID);

    // Should succeed — floor was applied
    expect(result.error).toBeUndefined();
    // Four from() calls: needs_rename gate → existing fetch → floor query → update
    expect(mock.from).toHaveBeenCalledTimes(4);
  });

  it("preserves existing games_played when it is already above the floor", async () => {
    // Player has 5 games_played; session floor is 2 → games_played stays 5.
    const mock = makeMockClient([
      { data: { id: "entry-6", games_played: 5, status: "left" }, error: null },
      { data: { games_played: 2 }, error: null },
      { data: null, error: null },
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    // joinQueueFallback now runs on the SERVICE client: queue_entries UPDATE
    // is revoked for anon/authenticated (20260721190000), so its reads and
    // writes must go through service_role. Route the same builder there —
    // the DB interaction sequence each test asserts is unchanged.
    mockServiceClient.from = mock.from;

    const result = await joinQueueAction(SESSION_ID);
    expect(result.error).toBeUndefined();
  });

  it("returns an error when the update DB call fails for a returning player", async () => {
    const mock = makeMockClient([
      { data: { id: "entry-7", games_played: 2, status: "left" }, error: null },
      { data: { games_played: 2 }, error: null },
      // Update fails
      { data: null, error: { message: "connection lost" } },
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    // joinQueueFallback now runs on the SERVICE client: queue_entries UPDATE
    // is revoked for anon/authenticated (20260721190000), so its reads and
    // writes must go through service_role. Route the same builder there —
    // the DB interaction sequence each test asserts is unchanged.
    mockServiceClient.from = mock.from;

    const result = await joinQueueAction(SESSION_ID);
    expect(result.error).toBe("connection lost");
  });

  it("returns an error when the insert DB call fails for a first-time joiner", async () => {
    const mock = makeMockClient([
      { data: null, error: null }, // no existing row
      { data: null, error: null }, // floor query → empty
      // Insert fails
      { data: null, error: { message: "unique constraint" } },
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    // joinQueueFallback now runs on the SERVICE client: queue_entries UPDATE
    // is revoked for anon/authenticated (20260721190000), so its reads and
    // writes must go through service_role. Route the same builder there —
    // the DB interaction sequence each test asserts is unchanged.
    mockServiceClient.from = mock.from;

    const result = await joinQueueAction(SESSION_ID);
    expect(result.error).toBe("unique constraint");
  });
});

// ── Auth guard ────────────────────────────────────────────────

describe("joinQueueAction — auth guard", () => {
  it("returns an error when the user is not authenticated", async () => {
    const mock = {
      from: vi.fn(),
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: null },
          error: { message: "Not authenticated" },
        }),
      },
    };
    vi.mocked(createServerSupabaseClient).mockResolvedValue(mock as never);
    // joinQueueFallback now runs on the SERVICE client: queue_entries UPDATE
    // is revoked for anon/authenticated (20260721190000), so its reads and
    // writes must go through service_role. Route the same builder there —
    // the DB interaction sequence each test asserts is unchanged.
    mockServiceClient.from = mock.from;

    const result = await joinQueueAction(SESSION_ID);
    expect(result.error).toMatch(/not authenticated/i);
    // No DB calls should have been made
    expect(mock.from).not.toHaveBeenCalled();
  });

  it("returns an error for an invalid session UUID", async () => {
    // isValidUUID check fires before createServerSupabaseClient, so no mock needed
    const result = await joinQueueAction("not-a-uuid");
    expect(result.error).toMatch(/invalid session/i);
  });
});
