// ============================================================
// ensureClubMembership — unit suite (mocked service client, no DB)
// ============================================================
// Covers the QR-join auto-enroll branches + the { ok, joined } contract that
// drives the "Welcome to <club>" first-join toast. Negative paths included:
// club not found, insert failure, reactivation failure.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// getClubBySlug is wrapped in React `cache()` at module load — make it a no-op
// identity wrapper so it just calls through under Vitest.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

// clubs.ts imports these at module scope; ensureClubMembership only touches the
// service client, but stub the rest so importing the module is side-effect-free.
// vi.hoisted so the fn exists before the (hoisted) vi.mock factory references it.
const { createServiceClient } = vi.hoisted(() => ({ createServiceClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient }));
vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));

import { ensureClubMembership } from "@/lib/clubs";

type Cfg = {
  club?: { id: string; slug: string } | null;
  existing?: { id: string; is_active: boolean } | null;
  insertError?: { message: string } | null;
  updateError?: { message: string } | null;
};

const insertSpy = vi.fn();
const updateSpy = vi.fn();

/** Minimal chainable stub mirroring the exact call shapes in ensureClubMembership. */
function makeClient(cfg: Cfg) {
  const clubs = {
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: cfg.club ?? null, error: null }) }),
    }),
  };
  const members = {
    select: () => ({
      eq: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: cfg.existing ?? null, error: null }) }),
      }),
    }),
    insert: async (row: unknown) => {
      insertSpy(row);
      return { error: cfg.insertError ?? null };
    },
    update: (patch: unknown) => {
      updateSpy(patch);
      return { eq: async () => ({ error: cfg.updateError ?? null }) };
    },
  };
  return { from: (table: string) => (table === "clubs" ? clubs : members) };
}

const CLUB = { id: "club-1", slug: "chillax" };

function withCfg(cfg: Cfg) {
  createServiceClient.mockReturnValue(makeClient(cfg) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ensureClubMembership", () => {
  it("EC-1 (negative): unknown club slug → { ok:false, joined:false }, no writes", async () => {
    withCfg({ club: null });
    const res = await ensureClubMembership("no-such-club", "user-1");
    expect(res).toEqual({ ok: false, joined: false });
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("EC-2: first-time join (no row) inserts and reports joined", async () => {
    withCfg({ club: CLUB, existing: null, insertError: null });
    const res = await ensureClubMembership("chillax", "user-1");
    expect(res).toEqual({ ok: true, joined: true });
    expect(insertSpy).toHaveBeenCalledWith({
      club_id: "club-1",
      player_id: "user-1",
      role: "member",
    });
  });

  it("EC-3 (negative): insert fails → { ok:false, joined:false }", async () => {
    withCfg({ club: CLUB, existing: null, insertError: { message: "insert denied" } });
    const res = await ensureClubMembership("chillax", "user-1");
    expect(res).toEqual({ ok: false, joined: false });
  });

  it("EC-4: soft-removed member is reactivated and reports joined", async () => {
    withCfg({ club: CLUB, existing: { id: "m-1", is_active: false }, updateError: null });
    const res = await ensureClubMembership("chillax", "user-1");
    expect(res).toEqual({ ok: true, joined: true });
    expect(updateSpy).toHaveBeenCalledWith({ is_active: true });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("EC-5 (negative): reactivation update fails → { ok:false, joined:false }", async () => {
    withCfg({
      club: CLUB,
      existing: { id: "m-1", is_active: false },
      updateError: { message: "update denied" },
    });
    const res = await ensureClubMembership("chillax", "user-1");
    expect(res).toEqual({ ok: false, joined: false });
  });

  it("EC-6: already an active member → ok but joined:false (no toast, no writes)", async () => {
    withCfg({ club: CLUB, existing: { id: "m-1", is_active: true } });
    const res = await ensureClubMembership("chillax", "user-1");
    expect(res).toEqual({ ok: true, joined: false });
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
