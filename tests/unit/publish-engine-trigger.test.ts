// ============================================================
// Integration tests: engine trigger after draft publish actions
// ============================================================
// Verifies that publishMatchAction and publishAllDraftMatchesAction
// call runEngineForSession after a successful publish, and that the
// engine is NOT called when nothing was actually published.
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
// after() (used for fire-and-forget push) runs synchronously in tests.
vi.mock("next/server", () => ({ after: (cb: () => unknown) => cb() }));
// Push delivery is out of scope here — stub it so the after() callback no-ops.
vi.mock("@/lib/notifications/push-server", () => ({
  pushToPlayers: vi.fn().mockResolvedValue({ sent: 0, errors: 0 }),
}));
vi.mock("@/app/actions/matchmaking", () => ({ runEngineForSession: vi.fn() }));
vi.mock("@/app/actions/_shared", () => ({
  getAuthenticatedUser: vi.fn(),
  isSessionOrganizer: vi.fn(),
  getActorContext: vi.fn(),
}));
// The 'published' audit is a separate concern (tests/unit/published-event.test.ts).
// Stubbed here so these cases keep measuring the engine trigger alone.
vi.mock("@/lib/match-event-log", () => ({
  logMatchEvent: vi.fn(),
  logPublishedEvents: vi.fn(),
  fetchRosterSnapshots: vi.fn().mockResolvedValue(new Map()),
}));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { runEngineForSession } from "@/app/actions/matchmaking";
import { getAuthenticatedUser, isSessionOrganizer, getActorContext } from "@/app/actions/_shared";
import { publishMatchAction, publishAllDraftMatchesAction } from "@/app/actions/match-drafts";

// ── Valid UUIDs ────────────────────────────────────────────────
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const MATCH_ID = "00000000-0000-4000-8000-000000000002";

// ── Mock builder helpers ───────────────────────────────────────

type MockResponse = { data?: unknown; error?: { message: string; code?: string } | null };

/**
 * Minimal chainable query builder that resolves to a single response.
 * Supports all common Supabase chaining patterns.
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
    "not",
    "or",
    "order",
    "limit",
    "update",
    "insert",
    "upsert",
    "delete",
  ]) {
    b[m] = (..._args: unknown[]) => b;
  }
  return b;
}

/**
 * Creates a mock Supabase service client whose from() calls consume
 * responses from a queue in order, and whose rpc() returns a fixed response.
 */
function makeServiceClient(rpcResponse: MockResponse, fromResponses: MockResponse[] = []) {
  let idx = 0;
  return {
    rpc: vi.fn().mockResolvedValue(rpcResponse),
    from: vi.fn((_table: string) => {
      const res = fromResponses[idx++] ?? { data: null, error: null };
      return makeBuilder(res);
    }),
  };
}

/**
 * Creates a mock server Supabase client (used by publishMatchAction's
 * initial match fetch: db.from("matches").select("session_id").single()).
 */
function makeServerClient(fromResponses: MockResponse[]) {
  let idx = 0;
  return {
    from: vi.fn((_table: string) => {
      const res = fromResponses[idx++] ?? { data: null, error: null };
      return makeBuilder(res);
    }),
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "user-1", email: "org@test.com" } },
        error: null,
      }),
    },
  };
}

// ── Setup ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runEngineForSession).mockResolvedValue(undefined);
  vi.mocked(getAuthenticatedUser).mockResolvedValue({
    id: "user-1",
    email: "org@test.com",
  } as never);
  vi.mocked(isSessionOrganizer).mockResolvedValue(true);
  vi.mocked(getActorContext).mockResolvedValue({ id: "user-1", name: "Org" });
});

// ── PE-1 ───────────────────────────────────────────────────────

describe("publishMatchAction — engine trigger", () => {
  it("PE-1: calls runEngineForSession when RPC returns SUCCESS", async () => {
    // Server client for the initial match fetch
    const serverClient = makeServerClient([{ data: { session_id: SESSION_ID }, error: null }]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(serverClient as never);

    // Service client for the publish_match RPC
    const svcClient = makeServiceClient({ data: "SUCCESS", error: null });
    vi.mocked(createServiceClient).mockReturnValue(svcClient as never);

    const result = await publishMatchAction(MATCH_ID);

    expect(result.success).toBe(true);
    expect(runEngineForSession).toHaveBeenCalledOnce();
    expect(runEngineForSession).toHaveBeenCalledWith(SESSION_ID);
  });

  // ── PE-2 ───────────────────────────────────────────────────────

  it("PE-2: does NOT call runEngineForSession when RPC returns ALREADY_PUBLISHED", async () => {
    const serverClient = makeServerClient([{ data: { session_id: SESSION_ID }, error: null }]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(serverClient as never);

    const svcClient = makeServiceClient({ data: "ALREADY_PUBLISHED", error: null });
    vi.mocked(createServiceClient).mockReturnValue(svcClient as never);

    const result = await publishMatchAction(MATCH_ID);

    expect(result.success).toBe(true);
    expect(runEngineForSession).not.toHaveBeenCalled();
  });

  // ── PE-3 ───────────────────────────────────────────────────────

  it("PE-3: does NOT call runEngineForSession when RPC returns HAS_LEFT_PLAYERS", async () => {
    const serverClient = makeServerClient([{ data: { session_id: SESSION_ID }, error: null }]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(serverClient as never);

    const svcClient = makeServiceClient({ data: "HAS_LEFT_PLAYERS", error: null });
    vi.mocked(createServiceClient).mockReturnValue(svcClient as never);

    const result = await publishMatchAction(MATCH_ID);

    expect(result.success).toBe(false);
    expect(runEngineForSession).not.toHaveBeenCalled();
  });

  // ── PE-6 ───────────────────────────────────────────────────────

  it("PE-6: calls runEngineForSession when fallback path publishes successfully", async () => {
    // Server client for the initial match fetch (used by publishMatchAction)
    const serverClient = makeServerClient([{ data: { session_id: SESSION_ID }, error: null }]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(serverClient as never);

    // Service client: RPC returns PGRST202 → triggers fallback path
    // The fallback (publishMatchFallback) makes these from() calls in order:
    //   1. matches select (status, is_published) → pending, not published
    //   2. match_players select (player_id) → empty (no players to conflict-check)
    //   3. matches update (is_published=true) → success
    //   Note: queue_entries update (status=on_deck) is skipped when playerIds is empty
    const PGRST202 = { message: "Could not find the function", code: "PGRST202" };
    const svcClient = makeServiceClient({ data: null, error: PGRST202 }, [
      // 1. matches fetch for fallback initial check
      { data: { session_id: SESSION_ID, status: "pending", is_published: false }, error: null },
      // 2. match_players fetch
      { data: [], error: null },
      // 3. matches update (is_published=true) — no conflict check since playerIds empty
      { data: null, error: null },
    ]);
    vi.mocked(createServiceClient).mockReturnValue(svcClient as never);

    const result = await publishMatchAction(MATCH_ID);

    expect(result.success).toBe(true);
    expect(runEngineForSession).toHaveBeenCalledOnce();
  });
});

// ── PE-4 / PE-5 ────────────────────────────────────────────────

describe("publishAllDraftMatchesAction — engine trigger", () => {
  it("PE-4: calls runEngineForSession when RPC returns publishedCount > 0", async () => {
    const svcClient = makeServiceClient({
      data: { success: true, published_count: 3, skipped_count: 0 },
      error: null,
    });
    vi.mocked(createServiceClient).mockReturnValue(svcClient as never);

    const result = await publishAllDraftMatchesAction(SESSION_ID);

    expect(result.success).toBe(true);
    expect(result.publishedCount).toBe(3);
    expect(runEngineForSession).toHaveBeenCalledOnce();
    expect(runEngineForSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it("PE-5: does NOT call runEngineForSession when RPC returns publishedCount === 0", async () => {
    const svcClient = makeServiceClient({
      data: { success: true, published_count: 0, skipped_count: 2 },
      error: null,
    });
    vi.mocked(createServiceClient).mockReturnValue(svcClient as never);

    const result = await publishAllDraftMatchesAction(SESSION_ID);

    expect(result.success).toBe(true);
    expect(runEngineForSession).not.toHaveBeenCalled();
  });
});
