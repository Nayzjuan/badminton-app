// ============================================================
// Unit Tests: isNameTaken (R2 app-side pre-check)
// ============================================================
// Mocks the Supabase chain to assert the normalized-compare logic:
// excludes self, matches case/whitespace variants, ignores flagged
// rows (the query filters needs_rename=false), and fails OPEN on error.
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { isNameTaken } from "@/lib/dup-name";

type Row = { id: string; display_name: string };

// Builds a mock service client whose profiles query resolves to `rows`
// (or an error). The chain .from().select().eq().ilike() is awaited.
function mockSvc(rows: Row[] | null, error: { message: string } | null = null) {
  const result = { data: rows, error };
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = vi.fn(self);
  chain.eq = vi.fn(self);
  chain.ilike = vi.fn(self);
  chain.then = (resolve: (v: typeof result) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return {
    from: vi.fn(() => chain),
    _chain: chain,
  } as never;
}

describe("isNameTaken", () => {
  it("returns true when another non-flagged profile shares the normalized name", async () => {
    const svc = mockSvc([{ id: "other", display_name: "Jason" }]);
    expect(await isNameTaken(svc, "jason")).toBe(true);
  });

  it("matches across case and whitespace variants", async () => {
    const svc = mockSvc([{ id: "other", display_name: "  JASON  " }]);
    expect(await isNameTaken(svc, "Jason")).toBe(true);
  });

  it("excludes the caller's own profile (excludeId)", async () => {
    const svc = mockSvc([{ id: "me", display_name: "Jason" }]);
    expect(await isNameTaken(svc, "Jason", "me")).toBe(false);
  });

  it("returns false when no row matches the normalized name", async () => {
    const svc = mockSvc([{ id: "other", display_name: "Jason L" }]);
    expect(await isNameTaken(svc, "Jason")).toBe(false);
  });

  it("returns false (no candidates) for a fresh unique name", async () => {
    const svc = mockSvc([]);
    expect(await isNameTaken(svc, "Brandnew")).toBe(false);
  });

  it("fails OPEN (returns false) on a read error — the unique index still guards the write", async () => {
    const svc = mockSvc(null, { message: "boom" });
    expect(await isNameTaken(svc, "Jason")).toBe(false);
  });

  it("filters to non-flagged rows (needs_rename=false applied on the query)", async () => {
    const svc = mockSvc([{ id: "other", display_name: "Jason" }]);
    await isNameTaken(svc, "Jason");
    // The .eq filter must have been called with needs_rename=false so flagged
    // duplicates are excluded — matching the partial unique index domain.
    expect(
      (svc as unknown as { _chain: { eq: ReturnType<typeof vi.fn> } })._chain.eq
    ).toHaveBeenCalledWith("needs_rename", false);
  });
});
