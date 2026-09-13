// ============================================================
// lookupActiveJoinSession — anon-safe public join lookup
// ============================================================
// IDs: LSJ-*
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const { createServerSupabaseClient } = vi.hoisted(() => ({
  createServerSupabaseClient: vi.fn(),
}));
vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient }));

import { lookupActiveJoinSession } from "@/lib/resolve-session-join";

const SID = "00000000-0000-4000-8000-000000000001";

function mockRpc(
  row: { id: string; name: string; is_active: boolean; club_slug: string | null } | null
) {
  createServerSupabaseClient.mockResolvedValue({
    rpc: vi.fn().mockResolvedValue({ data: row ? [row] : [] }),
  });
}

describe("lookupActiveJoinSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("LSJ-1: a non-UUID never hits the RPC", async () => {
    await expect(lookupActiveJoinSession("not-a-uuid")).resolves.toEqual({ ok: false });
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
  });

  it("LSJ-2: an active session with a club slug is ok", async () => {
    mockRpc({ id: SID, name: "Thursday", is_active: true, club_slug: "chillax" });
    await expect(lookupActiveJoinSession(SID)).resolves.toEqual({
      ok: true,
      sessionId: SID,
      name: "Thursday",
      clubSlug: "chillax",
    });
  });

  it("LSJ-3: inactive / club-less / missing rows are not ok", async () => {
    mockRpc({ id: SID, name: "Thursday", is_active: false, club_slug: "chillax" });
    await expect(lookupActiveJoinSession(SID)).resolves.toEqual({ ok: false });

    mockRpc({ id: SID, name: "Thursday", is_active: true, club_slug: null });
    await expect(lookupActiveJoinSession(SID)).resolves.toEqual({ ok: false });

    mockRpc(null);
    await expect(lookupActiveJoinSession(SID)).resolves.toEqual({ ok: false });
  });
});
