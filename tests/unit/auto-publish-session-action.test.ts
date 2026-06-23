// ============================================================
// Unit tests: toggleAutoPublish server action (orchestration)
// ============================================================
// Verifies the auto-publish toggle's control flow with all DB/engine
// collaborators mocked:
//   ON  (D3): persists auto_publish=true, clears unpublished drafts, reruns
//             the engine — but ONLY when auto-matchmaking is ON.
//   OFF (D4): persists auto_publish=false; never clears or reruns (live
//             on-deck matches are left untouched).
//   D11 guard: enabling while auto-matchmaking is OFF persists the preference
//              but skips the clear-and-rerun (the engine can't run anyway).
//
// Case ids: TAP-*
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/app/actions/matchmaking", () => ({ runEngineForSession: vi.fn() }));
vi.mock("@/app/actions/match-drafts", () => ({ clearAllUnpublishedDrafts: vi.fn() }));
vi.mock("@/app/actions/_shared", () => ({ isSessionOrganizer: vi.fn() }));
vi.mock("@/lib/broadcast", () => ({
  broadcastAutoPublishToggled: vi.fn().mockResolvedValue(undefined),
}));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { runEngineForSession } from "@/app/actions/matchmaking";
import { clearAllUnpublishedDrafts } from "@/app/actions/match-drafts";
import { isSessionOrganizer } from "@/app/actions/_shared";
import { broadcastAutoPublishToggled } from "@/lib/broadcast";
import { toggleAutoPublish } from "@/app/actions/sessions";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

// ── Mock builders ──────────────────────────────────────────────

type MockResponse = { data?: unknown; error?: { message: string } | null };

function makeBuilder(response: MockResponse) {
  const b: Record<string, unknown> = {};
  b["single"] = () => Promise.resolve(response);
  b["then"] = (res: (v: MockResponse) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(response).then(res, rej);
  for (const m of ["select", "eq", "update", "in", "neq", "order", "limit"]) {
    b[m] = (..._args: unknown[]) => b;
  }
  return b;
}

/** Service client whose sessions UPDATE…RETURNING resolves to `sessionRow`. */
function makeServiceClient(sessionRow: MockResponse) {
  return {
    from: vi.fn(() => makeBuilder(sessionRow)),
  };
}

function makeServerClient(userId: string | null) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId } : null },
        error: null,
      }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createServerSupabaseClient).mockResolvedValue(makeServerClient("org-user") as never);
  vi.mocked(isSessionOrganizer).mockResolvedValue(true);
  vi.mocked(clearAllUnpublishedDrafts).mockResolvedValue({
    success: true,
    clearedCount: 2,
    message: "Cleared 2 drafts.",
  } as never);
});

describe("toggleAutoPublish — server action orchestration", () => {
  it("TAP-1: enable with auto-matchmaking ON → clears drafts + reruns engine (D3/D8)", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeServiceClient({
        data: { auto_publish: true, is_auto_matchmaking_on: true },
        error: null,
      }) as never
    );

    const result = await toggleAutoPublish(SESSION_ID, true);

    expect(result.success).toBe(true);
    expect(result.isOn).toBe(true);
    expect(result.clearedCount).toBe(2);
    expect(clearAllUnpublishedDrafts).toHaveBeenCalledWith(SESSION_ID);
    expect(runEngineForSession).toHaveBeenCalledWith(SESSION_ID);
    expect(broadcastAutoPublishToggled).toHaveBeenCalledWith(SESSION_ID, true);
  });

  it("TAP-2: disable → never clears or reruns; leaves on-deck alone (D4)", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeServiceClient({
        data: { auto_publish: false, is_auto_matchmaking_on: true },
        error: null,
      }) as never
    );

    const result = await toggleAutoPublish(SESSION_ID, false);

    expect(result.success).toBe(true);
    expect(result.isOn).toBe(false);
    expect(clearAllUnpublishedDrafts).not.toHaveBeenCalled();
    expect(runEngineForSession).not.toHaveBeenCalled();
    expect(broadcastAutoPublishToggled).toHaveBeenCalledWith(SESSION_ID, false);
  });

  it("TAP-3: enable while auto-matchmaking OFF → persists only, no clear/rerun (D11)", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeServiceClient({
        data: { auto_publish: true, is_auto_matchmaking_on: false },
        error: null,
      }) as never
    );

    const result = await toggleAutoPublish(SESSION_ID, true);

    expect(result.success).toBe(true);
    expect(result.isOn).toBe(true);
    expect(result.message).toMatch(/auto-matchmaking/i);
    expect(clearAllUnpublishedDrafts).not.toHaveBeenCalled();
    expect(runEngineForSession).not.toHaveBeenCalled();
  });

  it("TAP-4: non-organizer → rejected, no session write", async () => {
    vi.mocked(isSessionOrganizer).mockResolvedValue(false);
    const service = makeServiceClient({ data: null, error: null });
    vi.mocked(createServiceClient).mockReturnValue(service as never);

    const result = await toggleAutoPublish(SESSION_ID, true);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/organizer/i);
    expect(service.from).not.toHaveBeenCalled();
    expect(clearAllUnpublishedDrafts).not.toHaveBeenCalled();
  });

  it("TAP-5: enable but draft-clear fails → surfaces the error, engine not run", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeServiceClient({
        data: { auto_publish: true, is_auto_matchmaking_on: true },
        error: null,
      }) as never
    );
    vi.mocked(clearAllUnpublishedDrafts).mockResolvedValue({
      success: false,
      clearedCount: 0,
      message: "clear failed",
    } as never);

    const result = await toggleAutoPublish(SESSION_ID, true);

    expect(result.success).toBe(false);
    expect(result.message).toBe("clear failed");
    expect(runEngineForSession).not.toHaveBeenCalled();
  });

  it("TAP-6: invalid session id → rejected before any auth/DB work", async () => {
    const result = await toggleAutoPublish("not-a-uuid", true);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/invalid session/i);
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
  });
});
