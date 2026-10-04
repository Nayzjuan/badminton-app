import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
vi.mock("next/server", () => ({ after: (cb: () => unknown) => cb() }));
vi.mock("@/lib/notifications/push-server", () => ({
  pushToPlayers: vi.fn().mockResolvedValue({ sent: 0, errors: 0 }),
}));
vi.mock("@/app/actions/matchmaking", () => ({ scheduleEngineForSession: vi.fn() }));
vi.mock("@/app/actions/_shared", () => ({
  getAuthenticatedUser: vi.fn(),
  isSessionOrganizer: vi.fn(),
  getActorContext: vi.fn(),
}));
vi.mock("@/lib/match-event-log", () => ({
  logMatchEvent: vi.fn(),
  logPublishedEvents: vi.fn(),
  fetchRosterSnapshots: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/broadcast", () => ({
  broadcastOrganizerIntervention: vi.fn(),
  broadcastDraftsPublished: vi.fn(),
}));

import { createServiceClient } from "@/utils/supabase/service";
import { scheduleEngineForSession } from "@/app/actions/matchmaking";
import { getAuthenticatedUser, isSessionOrganizer } from "@/app/actions/_shared";
import { clearUnpublishedDraftsAction } from "@/app/actions/match-drafts";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

type MockResponse = { data?: unknown; error?: { message: string } | null };

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

function makeServiceClient(rpcResponse: MockResponse, fromResponses: MockResponse[]) {
  let idx = 0;
  return {
    rpc: vi.fn().mockResolvedValue(rpcResponse),
    from: vi.fn((_table: string) => {
      const res = fromResponses[idx++] ?? { data: null, error: null };
      return makeBuilder(res);
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(scheduleEngineForSession).mockResolvedValue(undefined);
  vi.mocked(getAuthenticatedUser).mockResolvedValue({
    id: "user-1",
    email: "org@test.com",
  } as never);
  vi.mocked(isSessionOrganizer).mockResolvedValue(true);
});

describe("clearUnpublishedDraftsAction — engine schedule", () => {
  it("CUD-1: Auto ON schedules the engine after a successful clear", async () => {
    const svc = makeServiceClient({ data: ["p1"], error: null }, [
      { data: [], error: null },
      { data: { is_auto_matchmaking_on: true }, error: null },
    ]);
    vi.mocked(createServiceClient).mockReturnValue(svc as never);

    const result = await clearUnpublishedDraftsAction(SESSION_ID);

    expect(result.success).toBe(true);
    expect(scheduleEngineForSession).toHaveBeenCalledOnce();
    expect(scheduleEngineForSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it("CUD-2: Auto OFF does not schedule the engine", async () => {
    const svc = makeServiceClient({ data: ["p1"], error: null }, [
      { data: [], error: null },
      { data: { is_auto_matchmaking_on: false }, error: null },
    ]);
    vi.mocked(createServiceClient).mockReturnValue(svc as never);

    const result = await clearUnpublishedDraftsAction(SESSION_ID);

    expect(result.success).toBe(true);
    expect(scheduleEngineForSession).not.toHaveBeenCalled();
  });

  it("CUD-3: a failed clear does not schedule the engine", async () => {
    const svc = makeServiceClient({ data: null, error: { message: "boom" } }, [
      { data: [], error: null },
    ]);
    vi.mocked(createServiceClient).mockReturnValue(svc as never);

    const result = await clearUnpublishedDraftsAction(SESSION_ID);

    expect(result.success).toBe(false);
    expect(scheduleEngineForSession).not.toHaveBeenCalled();
  });
});
