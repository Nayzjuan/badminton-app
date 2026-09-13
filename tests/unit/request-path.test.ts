// ============================================================
// request-path — stamped path for rename `next`
// ============================================================
//   RP-1  missing header → fallback
//   RP-2  session path is kept (query included)
//   RP-3  /rename does not loop
//   RP-4  protocol-relative is rejected by safeNext
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

import { headers } from "next/headers";
import {
  REQUEST_PATH_HEADER,
  renameNextFromRequest,
  requestPathHeaderValue,
} from "@/lib/request-path";

function stamp(value: string | null) {
  vi.mocked(headers).mockResolvedValue({
    get: (name: string) => (name === REQUEST_PATH_HEADER ? value : null),
  } as unknown as Awaited<ReturnType<typeof headers>>);
}

describe("requestPathHeaderValue / renameNextFromRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("RP-1: a missing header uses the fallback", async () => {
    stamp(null);
    expect(await renameNextFromRequest("/c/chillax")).toBe("/c/chillax");
  });

  it("RP-2: a session path with a query is kept", async () => {
    const path = "/c/chillax/play/00000000-0000-4000-8000-000000000001?tab=queue";
    expect(
      requestPathHeaderValue("/c/chillax/play/00000000-0000-4000-8000-000000000001", "?tab=queue")
    ).toBe(path);
    stamp(path);
    expect(await renameNextFromRequest("/c/chillax")).toBe(path);
  });

  it("RP-3: /rename is not used as next", async () => {
    stamp("/rename?next=%2Fc%2Fchillax");
    expect(await renameNextFromRequest("/c/chillax")).toBe("/c/chillax");
  });

  it("RP-4: a protocol-relative stamp falls back", async () => {
    stamp("/\\evil.com");
    expect(await renameNextFromRequest("/c/chillax")).toBe("/c/chillax");
  });
});
