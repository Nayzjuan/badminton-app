// ============================================================
// ensureClubMembership — unit suite (mocked service client, no DB)
// ============================================================
// Covers the QR-join auto-enroll branches + the { ok, joined, reason } contract
// that drives the "Welcome to <club>" first-join toast AND the legacy shims'
// divert-or-forward decision. Negative paths included: club not found,
// membership read failure, insert failure, reactivation failure.
//
// The `reason` discriminator is load-bearing, not decoration: the /play and
// /organizer shims divert to /play on `club_not_found` / `write_failed` (we know
// there is no row) but FORWARD on `read_failed` (we could not find out). Each
// negative case below asserts its exact reason so a collapsed or mislabelled
// branch fails here rather than silently bouncing real members out of a club.
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
  readError?: { message: string } | null;
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
        eq: () => ({
          maybeSingle: async () => ({
            // A real PostgREST error comes back with data: null — mirror that so
            // the read-failure case cannot accidentally exercise the "no row"
            // path instead.
            data: cfg.readError ? null : (cfg.existing ?? null),
            error: cfg.readError ?? null,
          }),
        }),
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
  it("EC-1 (negative): unknown club slug → club_not_found, no writes", async () => {
    withCfg({ club: null });
    const res = await ensureClubMembership("no-such-club", "user-1");
    expect(res).toEqual({ ok: false, joined: false, reason: "club_not_found" });
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

  it("EC-3 (negative): insert fails → write_failed", async () => {
    withCfg({ club: CLUB, existing: null, insertError: { message: "insert denied" } });
    const res = await ensureClubMembership("chillax", "user-1");
    expect(res).toEqual({ ok: false, joined: false, reason: "write_failed" });
  });

  it("EC-4: soft-removed member is reactivated and reports joined", async () => {
    withCfg({ club: CLUB, existing: { id: "m-1", is_active: false }, updateError: null });
    const res = await ensureClubMembership("chillax", "user-1");
    expect(res).toEqual({ ok: true, joined: true });
    expect(updateSpy).toHaveBeenCalledWith({ is_active: true });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("EC-5 (negative): reactivation update fails → write_failed", async () => {
    withCfg({
      club: CLUB,
      existing: { id: "m-1", is_active: false },
      updateError: { message: "update denied" },
    });
    const res = await ensureClubMembership("chillax", "user-1");
    expect(res).toEqual({ ok: false, joined: false, reason: "write_failed" });
  });

  it("EC-6: already an active member → ok but joined:false (no toast, no writes)", async () => {
    withCfg({ club: CLUB, existing: { id: "m-1", is_active: true } });
    const res = await ensureClubMembership("chillax", "user-1");
    expect(res).toEqual({ ok: true, joined: false });
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("EC-7 (negative): membership read fails → read_failed, and never guesses a write", async () => {
    withCfg({ club: CLUB, readError: { message: "could not connect" } });
    const res = await ensureClubMembership("chillax", "user-1");
    // The distinct reason is the whole point: an errored SELECT says nothing
    // about whether a row exists, so callers must NOT read this as "not a
    // member". Collapsing it into write_failed would make the legacy shims
    // bounce genuine owners/admins to /play on a transient blip.
    expect(res).toEqual({ ok: false, joined: false, reason: "read_failed" });
    // And it must not "helpfully" insert on an unknown state — a blind insert
    // would either collide with the existing row or hand out a fresh `member`
    // role to someone who is an owner.
    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
