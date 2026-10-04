// Unit tests: unlockHeldDraftReadiness + refreshHeldReadiness
//
// UH-1  refuses HOLDING (source still in_progress) — no stamp
// UH-2  stamps a RESTING hold and does not publish
// UH-3  already-stamped hold is success without a second write
// UH-4  refreshHeldReadiness is organizer-gated

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/app/actions/_shared", () => ({
  getAuthenticatedUser: vi.fn(),
  isSessionOrganizer: vi.fn(),
  getActorContext: vi.fn(),
}));
vi.mock("@/app/actions/matchmaking", () => ({
  scheduleEngineForSession: vi.fn(),
  recomputeHeldReadiness: vi.fn(),
}));

import { createServiceClient } from "@/utils/supabase/service";
import { getAuthenticatedUser, isSessionOrganizer } from "@/app/actions/_shared";
import { recomputeHeldReadiness } from "@/app/actions/matchmaking";
import { refreshHeldReadiness, unlockHeldDraftReadiness } from "@/app/actions/match-drafts";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const MATCH_ID = "00000000-0000-4000-8000-000000000002";
const SOURCE_ID = "00000000-0000-4000-8000-000000000003";
const USER_ID = "00000000-0000-4000-8000-000000000099";

type MockResponse = { data?: unknown; error?: { message: string } | null };

function makeBuilder(response: MockResponse) {
  const b: Record<string, unknown> = {};
  b["then"] = (res: (v: MockResponse) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(response).then(res, rej);
  b["maybeSingle"] = () => Promise.resolve(response);
  b["single"] = () => Promise.resolve(response);
  for (const m of ["select", "eq", "neq", "in", "is", "update"]) {
    b[m] = () => b;
  }
  return b;
}

function useService(fromResponses: MockResponse[]) {
  let idx = 0;
  const from = vi.fn(() => makeBuilder(fromResponses[idx++] ?? { data: null, error: null }));
  vi.mocked(createServiceClient).mockReturnValue({ from } as never);
  return from;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: USER_ID } as never);
  vi.mocked(isSessionOrganizer).mockResolvedValue(true);
  vi.mocked(recomputeHeldReadiness).mockResolvedValue(undefined);
});

const restingHold = {
  id: MATCH_ID,
  session_id: SESSION_ID,
  status: "pending",
  is_published: false,
  is_held: true,
  held_ready_at: null,
  pulled_from_match_id: SOURCE_ID,
};

describe("unlockHeldDraftReadiness", () => {
  it("UH-1: refuses HOLDING — source still in_progress, no stamp", async () => {
    const from = useService([
      { data: restingHold, error: null },
      { data: { id: SOURCE_ID, status: "in_progress" }, error: null },
    ]);

    const result = await unlockHeldDraftReadiness(MATCH_ID, SESSION_ID);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/still on court/i);
    expect(from).toHaveBeenCalledTimes(2);
  });

  it("UH-2: stamps a RESTING hold and does not publish", async () => {
    const from = useService([
      { data: restingHold, error: null },
      { data: { id: SOURCE_ID, status: "completed" }, error: null },
      { data: null, error: null },
    ]);

    const result = await unlockHeldDraftReadiness(MATCH_ID, SESSION_ID);

    expect(result).toEqual({ success: true, message: "Publish is unlocked." });
    expect(from).toHaveBeenCalledTimes(3);
  });

  it("UH-3: already unlocked is success without a source read", async () => {
    const from = useService([
      { data: { ...restingHold, held_ready_at: "2026-10-03T12:35:48.000Z" }, error: null },
    ]);

    const result = await unlockHeldDraftReadiness(MATCH_ID, SESSION_ID);

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/already unlocked/i);
    expect(from).toHaveBeenCalledTimes(1);
  });
});

describe("refreshHeldReadiness", () => {
  it("UH-4: organizer-gated; non-organizer never reaches recompute", async () => {
    vi.mocked(isSessionOrganizer).mockResolvedValue(false);

    const result = await refreshHeldReadiness(SESSION_ID);

    expect(result.success).toBe(false);
    expect(result.message).toBe("Forbidden");
    expect(recomputeHeldReadiness).not.toHaveBeenCalled();
  });

  it("UH-5: organizer calls recomputeHeldReadiness", async () => {
    const result = await refreshHeldReadiness(SESSION_ID);

    expect(result.success).toBe(true);
    expect(recomputeHeldReadiness).toHaveBeenCalledTimes(1);
  });
});
