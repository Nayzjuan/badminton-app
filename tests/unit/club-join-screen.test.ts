// ============================================================
// ClubJoinScreen — enroll → rename gate → enqueue
// ============================================================
// #89 moved join body out of /c/[slug]/join/page into ClubJoinScreen
// (shared by /j/[id] and the club path). The confirm/rename L1 must
// stay after enroll and before the queue upsert, or a share/QR scan
// puts an unconfirmed Google name on the board.
//
//   CJS-1  needs_name_confirm → gate fires; queue upsert never runs
//   CJS-2  clean profile + session → enroll, gate, upsert, redirect
//   CJS-3  clean profile, club-only → gate to club base; no upsert
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

class NavError extends Error {}

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new NavError(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new NavError("NOT_FOUND");
  }),
}));

vi.mock("@/lib/rename-gate", () => ({
  enforceRenameGate: vi.fn(),
}));

vi.mock("@/lib/resolve-session-join", () => ({
  lookupActiveJoinSession: vi.fn(),
}));

vi.mock("@/lib/clubs", () => ({
  getClubBySlug: vi.fn(),
  ensureClubMembership: vi.fn(),
}));

vi.mock("@/utils/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
}));

vi.mock("@/components/login-form", () => ({
  LoginForm: () => null,
}));

import { redirect } from "next/navigation";
import { enforceRenameGate } from "@/lib/rename-gate";
import { lookupActiveJoinSession } from "@/lib/resolve-session-join";
import { getClubBySlug, ensureClubMembership } from "@/lib/clubs";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { ClubJoinScreen } from "@/components/join/club-join-screen";

const SID = "00000000-0000-4000-8000-000000000001";
const UID = "00000000-0000-4000-8000-00000000d0e5";

async function dest(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "FELL_THROUGH";
  } catch (e) {
    if (e instanceof NavError) return e.message;
    throw e;
  }
}

function supabaseMock(profile: { id: string; needs_rename: boolean; needs_name_confirm: boolean }) {
  const upsert = vi.fn().mockResolvedValue({ data: null, error: null });
  const client = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: UID } } }),
    },
    from: vi.fn((table: string) => {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: profile }),
            }),
          }),
        };
      }
      if (table === "queue_entries") {
        return { upsert };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };
  vi.mocked(createServerSupabaseClient).mockResolvedValue(
    client as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
  );
  return { upsert, client };
}

describe("ClubJoinScreen rename gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getClubBySlug).mockResolvedValue({
      id: "club-1",
      slug: "chillax",
      name: "Chillax",
    } as Awaited<ReturnType<typeof getClubBySlug>>);
    vi.mocked(lookupActiveJoinSession).mockResolvedValue({
      ok: true,
      sessionId: SID,
      name: "Thursday",
      clubSlug: "chillax",
    });
    vi.mocked(ensureClubMembership).mockResolvedValue({ ok: true, joined: true });
    vi.mocked(enforceRenameGate).mockResolvedValue(undefined);
  });

  it("CJS-1: confirm-pending is gated after enroll and never enqueued", async () => {
    const { upsert } = supabaseMock({
      id: UID,
      needs_rename: false,
      needs_name_confirm: true,
    });
    vi.mocked(enforceRenameGate).mockImplementation(async (_profile, nextPath) => {
      redirect(`/rename?next=${encodeURIComponent(nextPath)}`);
    });

    expect(await dest(() => ClubJoinScreen({ clubSlug: "chillax", sessionId: SID }))).toBe(
      `REDIRECT:/rename?next=${encodeURIComponent(`/c/chillax/play/${SID}`)}`
    );

    expect(ensureClubMembership).toHaveBeenCalledWith("chillax", UID);
    expect(enforceRenameGate).toHaveBeenCalledWith(
      expect.objectContaining({ id: UID, needs_name_confirm: true }),
      `/c/chillax/play/${SID}`
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it("CJS-2: clean profile + session enrolls, gates, then enqueues", async () => {
    const { upsert } = supabaseMock({
      id: UID,
      needs_rename: false,
      needs_name_confirm: false,
    });

    expect(await dest(() => ClubJoinScreen({ clubSlug: "chillax", sessionId: SID }))).toBe(
      `REDIRECT:/c/chillax/play/${SID}?joined=1`
    );

    expect(ensureClubMembership).toHaveBeenCalledWith("chillax", UID);
    expect(enforceRenameGate).toHaveBeenCalledWith(
      expect.objectContaining({ id: UID, needs_name_confirm: false }),
      `/c/chillax/play/${SID}`
    );
    expect(upsert).toHaveBeenCalledWith(
      { session_id: SID, player_id: UID, status: "waiting" },
      { onConflict: "session_id,player_id", ignoreDuplicates: true }
    );
    expect(vi.mocked(enforceRenameGate).mock.invocationCallOrder[0]).toBeLessThan(
      upsert.mock.invocationCallOrder[0]
    );
  });

  it("CJS-3: club-only join gates to the club base and does not enqueue", async () => {
    const { upsert } = supabaseMock({
      id: UID,
      needs_rename: false,
      needs_name_confirm: false,
    });

    expect(await dest(() => ClubJoinScreen({ clubSlug: "chillax" }))).toBe(
      "REDIRECT:/c/chillax?joined=1"
    );
    expect(enforceRenameGate).toHaveBeenCalledWith(
      expect.objectContaining({ id: UID }),
      "/c/chillax"
    );
    expect(upsert).not.toHaveBeenCalled();
  });
});
