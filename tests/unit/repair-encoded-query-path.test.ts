// ============================================================
// repairEncodedQueryPath — in-app browsers that encode `?` into the path
// ============================================================
// IDs: REQ-*
// ============================================================

import { describe, it, expect } from "vitest";
import { repairEncodedQueryPath, resolveJoinRedirect } from "@/lib/repair-encoded-query-path";

const SID = "00000000-0000-4000-8000-000000000001";

describe("repairEncodedQueryPath", () => {
  it("REQ-1: a club join path with %3Fsession= becomes the path-based join", () => {
    expect(repairEncodedQueryPath(`/c/chillax/join%3Fsession%3D${SID}`)).toBe(
      `/c/chillax/join/${SID}`
    );
  });

  it("REQ-2: a legacy /play/join%3Fsession= becomes the short /j/ share URL", () => {
    expect(repairEncodedQueryPath(`/play/join%3Fsession%3D${SID}`)).toBe(`/j/${SID}`);
  });

  it("REQ-3: double-encoded %253F is decoded the same way", () => {
    expect(repairEncodedQueryPath(`/c/chillax/join%253Fsession%253D${SID}`)).toBe(
      `/c/chillax/join/${SID}`
    );
  });

  it("REQ-4: a decoded pathname that already contains a literal ? is repaired", () => {
    expect(repairEncodedQueryPath(`/c/chillax/join?session=${SID}`)).toBe(`/c/chillax/join/${SID}`);
  });

  it("REQ-5: an encoded join without a valid UUID drops the session, not 404s", () => {
    expect(repairEncodedQueryPath("/c/chillax/join%3Fsession%3Dnot-a-uuid")).toBe(
      "/c/chillax/join"
    );
    expect(repairEncodedQueryPath("/play/join%3Fsession%3Dnope")).toBe("/play");
  });

  it("REQ-6: ordinary paths are left alone", () => {
    expect(repairEncodedQueryPath("/c/chillax/join")).toBeNull();
    expect(repairEncodedQueryPath(`/c/chillax/join/${SID}`)).toBeNull();
    expect(repairEncodedQueryPath(`/j/${SID}`)).toBeNull();
    expect(repairEncodedQueryPath("/c/chillax/play")).toBeNull();
  });

  it("REQ-7: a non-join path that happens to contain %3F is not rewritten", () => {
    expect(repairEncodedQueryPath("/c/chillax/play%3Ftab%3Dqueue")).toBeNull();
  });

  it("REQ-8: a leftover ?session= on /j/<id> strips back to the short path", () => {
    expect(repairEncodedQueryPath(`/j/${SID}%3Fsession%3D${SID}`)).toBe(`/j/${SID}`);
  });

  it("REQ-9: a leftover ?session= on /c/<slug>/join/<id> strips the query", () => {
    expect(repairEncodedQueryPath(`/c/chillax/join/${SID}%3Fsession%3D${SID}`)).toBe(
      `/c/chillax/join/${SID}`
    );
  });
});

describe("resolveJoinRedirect", () => {
  it("REQ-10: /play/join?session=<uuid> becomes /j/<uuid> with no query", () => {
    expect(resolveJoinRedirect("/play/join", `?session=${SID}`)).toBe(`/j/${SID}`);
  });

  it("REQ-11: /c/<slug>/join?session=<uuid> becomes the path form", () => {
    expect(resolveJoinRedirect("/c/chillax/join", `session=${SID}`)).toBe(`/c/chillax/join/${SID}`);
  });

  it("REQ-12: /j/<id>?session=<id> drops the leftover query", () => {
    expect(resolveJoinRedirect(`/j/${SID}`, `?session=${SID}`)).toBe(`/j/${SID}`);
  });

  it("REQ-13: a canonical join path with no query is left alone", () => {
    expect(resolveJoinRedirect(`/j/${SID}`, "")).toBeNull();
    expect(resolveJoinRedirect(`/c/chillax/join/${SID}`, "")).toBeNull();
  });
});
