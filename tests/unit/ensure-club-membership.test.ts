// ============================================================
// ensureClubMembership — unit suite (mocked service client, no DB)
// ============================================================
// Race-safe write order: conditional inactive→active update, conflict-safe
// insert, final re-read. `action` drives toast + funnel transitions.
//
//   EC-1  unknown club → club_not_found, no writes
//   EC-2  first-time join inserts and reports created
//   EC-3  insert fails (non-unique) → write_failed
//   EC-4  inactive row reactivates
//   EC-5  reactivation update fails → write_failed
//   EC-6  already active → unchanged after conflict re-read
//   EC-7  conflict re-read fails → read_failed
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const { createServiceClient } = vi.hoisted(() => ({ createServiceClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient }));
vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));

import { ensureClubMembership } from "@/lib/clubs";

type Cfg = {
  club?: { id: string; slug: string } | null;
  updateRow?: { id: string } | null;
  updateError?: { message: string } | null;
  insertRow?: { id: string } | null;
  insertError?: { message: string; code?: string } | null;
  existing?: { id: string; is_active: boolean } | null;
  readError?: { message: string } | null;
};

const insertSpy = vi.fn();
const updateSpy = vi.fn();

function chain(result: { data: unknown; error: unknown }) {
  const b: Record<string, unknown> = {};
  const self = () => b;
  b["eq"] = self;
  b["select"] = self;
  b["maybeSingle"] = async () => result;
  b["then"] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return b;
}

function makeClient(cfg: Cfg) {
  const clubs = {
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: cfg.club ?? null, error: null }) }),
    }),
  };
  const members = {
    update: (patch: unknown) => {
      updateSpy(patch);
      return chain({ data: cfg.updateRow ?? null, error: cfg.updateError ?? null });
    },
    insert: (row: unknown) => {
      insertSpy(row);
      return chain({ data: cfg.insertRow ?? null, error: cfg.insertError ?? null });
    },
    select: () =>
      chain({
        data: cfg.readError ? null : (cfg.existing ?? null),
        error: cfg.readError ?? null,
      }),
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
  it("EC-1 (negative): unknown club slug → club_not_found, no writes", async () => {
    withCfg({ club: null });
    const res = await ensureClubMembership("no-such-club", "user-1");
    expect(res).toEqual({ ok: false, joined: false, reason: "club_not_found" });
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("EC-2: first-time join inserts and reports created", async () => {
    withCfg({ club: CLUB, insertRow: { id: "m-new" } });
    const res = await ensureClubMembership("chillax", "user-1");
    expect(res).toEqual({ ok: true, joined: true, action: "created" });
    expect(insertSpy).toHaveBeenCalledWith({
      club_id: "club-1",
      player_id: "user-1",
      role: "member",
    });
  });

  it("EC-3 (negative): insert fails → write_failed", async () => {
    withCfg({ club: CLUB, insertError: { message: "insert denied" } });
    const res = await ensureClubMembership("chillax", "user-1");
    expect(res).toEqual({ ok: false, joined: false, reason: "write_failed" });
  });

  it("EC-4: soft-removed member is reactivated and reports joined", async () => {
    withCfg({ club: CLUB, updateRow: { id: "m-1" } });
    const res = await ensureClubMembership("chillax", "user-1");
    expect(res).toEqual({ ok: true, joined: true, action: "reactivated" });
    expect(updateSpy).toHaveBeenCalledWith({ is_active: true });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("EC-5 (negative): reactivation update fails → write_failed", async () => {
    withCfg({ club: CLUB, updateError: { message: "update denied" } });
    const res = await ensureClubMembership("chillax", "user-1");
    expect(res).toEqual({ ok: false, joined: false, reason: "write_failed" });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("EC-6: already an active member → unchanged after unique conflict", async () => {
    withCfg({
      club: CLUB,
      insertError: { message: "duplicate", code: "23505" },
      existing: { id: "m-1", is_active: true },
    });
    const res = await ensureClubMembership("chillax", "user-1");
    expect(res).toEqual({ ok: true, joined: false, action: "unchanged" });
  });

  it("EC-7 (negative): conflict re-read fails → read_failed", async () => {
    withCfg({
      club: CLUB,
      insertError: { message: "duplicate", code: "23505" },
      readError: { message: "could not connect" },
    });
    const res = await ensureClubMembership("chillax", "user-1");
    expect(res).toEqual({ ok: false, joined: false, reason: "read_failed" });
  });
});
