// ============================================================
// Middleware repairs encoded join paths before they 404
// ============================================================
// IDs: MWJ-*
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/utils/supabase/middleware", () => ({
  updateSession: vi.fn(async () => NextResponse.next()),
}));

import { middleware } from "@/middleware";
import { updateSession } from "@/utils/supabase/middleware";

const SID = "00000000-0000-4000-8000-000000000001";

describe("middleware join-path repair", () => {
  beforeEach(() => {
    vi.mocked(updateSession).mockClear();
  });

  it("MWJ-1: an encoded ?session= in the path 308s and skips auth refresh", async () => {
    const req = new NextRequest(`http://localhost/c/chillax/join%3Fsession%3D${SID}`);
    const res = await middleware(req);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`http://localhost/c/chillax/join/${SID}`);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("MWJ-2: a canonical /j/<id> path passes through to updateSession", async () => {
    const req = new NextRequest(`http://localhost/j/${SID}`);
    await middleware(req);
    expect(updateSession).toHaveBeenCalledTimes(1);
  });

  it("MWJ-4: pass-through requests stamp x-request-path for the rename gate", async () => {
    const req = new NextRequest(`http://localhost/c/chillax/play/${SID}?tab=queue`);
    await middleware(req);
    expect(updateSession).toHaveBeenCalledTimes(1);
    const forwarded = vi.mocked(updateSession).mock.calls[0]![0] as NextRequest;
    expect(forwarded.headers.get("x-request-path")).toBe(`/c/chillax/play/${SID}?tab=queue`);
  });

  it("MWJ-3: /play/join?session=<uuid> 308s onto /j/<uuid> with an empty search", async () => {
    const req = new NextRequest(`http://localhost/play/join?session=${SID}`);
    const res = await middleware(req);
    expect(res.status).toBe(308);
    const location = res.headers.get("location") ?? "";
    expect(location).toBe(`http://localhost/j/${SID}`);
    expect(location).not.toContain("?");
    expect(updateSession).not.toHaveBeenCalled();
  });
});
