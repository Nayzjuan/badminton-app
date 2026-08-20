// ============================================================
// Unit tests: addCourtAction — the failure messages it returns
// ============================================================
// courts carries UNIQUE (session_id, name), so re-adding an existing court name
// is the one failure an organizer can reach by ordinary use. The action used to
// return `error.message` verbatim, which names the index rather than the problem
// ("duplicate key value violates unique constraint courts_session_id_name_key"),
// and every other failure leaked raw Postgres text to the client the same way.
//
//   ACA-1  23505 → prose naming the court, not the constraint
//   ACA-2  a name containing a quote stays unambiguous in that message
//   ACA-3  any other DB error is generic to the client and logged server-side
//   ACA-4  the organizer gate still precedes the insert
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/app/actions/_shared", () => ({
  getAuthenticatedUser: vi.fn(),
  isSessionOrganizer: vi.fn(),
}));

import { addCourtAction } from "@/app/actions/courts";
import { createServiceClient } from "@/utils/supabase/service";
import { getAuthenticatedUser, isSessionOrganizer } from "@/app/actions/_shared";

/** Service client whose courts INSERT resolves to `error`. */
function mockSvc(error: { code?: string; message: string } | null) {
  const insert = vi.fn().mockResolvedValue({ error });
  vi.mocked(createServiceClient).mockReturnValue({
    from: vi.fn(() => ({ insert })),
  } as never);
  return { insert };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: "user-1" } as never);
  vi.mocked(isSessionOrganizer).mockResolvedValue(true);
});

describe("ACA — addCourtAction failure messages", () => {
  it("ACA-1 maps a unique violation to prose naming the court", async () => {
    mockSvc({
      code: "23505",
      message: 'duplicate key value violates unique constraint "courts_session_id_name_key"',
    });
    const result = await addCourtAction("session-1", "Court 11");

    expect(result.success).toBe(false);
    expect(result.message).toBe("This session already has a court named “Court 11”.");
    // The index name must not reach the organizer.
    expect(result.message).not.toMatch(/constraint|duplicate key/i);
  });

  it("ACA-2 keeps the message unambiguous when the name contains a quote", async () => {
    mockSvc({ code: "23505", message: "duplicate key" });
    const result = await addCourtAction("session-1", 'Court "A"');

    // With ASCII delimiters this read: ...named "Court "A"". The typographic
    // pair keeps the name's own quotes distinguishable from the delimiters.
    expect(result.message).toBe('This session already has a court named “Court "A"”.');
  });

  it("ACA-3 returns a generic message for any other DB error, and logs the cause", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSvc({ code: "23503", message: "insert or update violates foreign key constraint" });
    const result = await addCourtAction("session-1", "Court 11");

    expect(result).toEqual({ success: false, message: "Failed to add court. Please try again." });
    expect(spy).toHaveBeenCalled();
  });

  it("ACA-4 refuses a non-organizer before touching the table", async () => {
    vi.mocked(isSessionOrganizer).mockResolvedValue(false);
    const { insert } = mockSvc(null);
    const result = await addCourtAction("session-1", "Court 11");

    expect(result).toEqual({ success: false, message: "Not authorized." });
    expect(insert).not.toHaveBeenCalled();
  });

  it("succeeds cleanly when the insert reports no error", async () => {
    mockSvc(null);
    await expect(addCourtAction("session-1", "Court 13")).resolves.toEqual({
      success: true,
      message: "Court added.",
    });
  });
});
