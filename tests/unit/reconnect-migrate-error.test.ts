// ============================================================
// reconnectPlayer — migrate_player_identity RPC failure surface
// ============================================================
// A correct PIN that then dies inside migrate_player_identity is the only
// path that returns "Failed to migrate account. Please try again." These
// tests pin that mapping and that the PostgREST code/details are logged
// (the UI string is deliberately generic; the log is how we tell 23503
// from 23505 from a missing GRANT).
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/clubs", () => ({
  ensureClubMembership: vi.fn(),
  getClubBySlug: vi.fn().mockResolvedValue(null),
  resolveSessionClubSlug: vi.fn(),
}));
vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue({ get: () => null }) }));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { reconnectPlayer } from "@/app/actions/auth";

type Resp = { data?: unknown; error?: unknown };

function builder(resp: Resp) {
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ["select", "eq", "ilike", "in", "order", "limit", "update", "insert"])
    b[m] = self;
  b["maybeSingle"] = () => Promise.resolve(resp);
  b["single"] = () => Promise.resolve(resp);
  b["then"] = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(resp).then(res, rej);
  return b;
}

const OPEN = {
  data: {
    attempt_id: "a1",
    over_subject_limit: false,
    over_ip_limit: false,
    spray_suspected: false,
  },
  error: null,
};

const OLD_ID = "00000000-0000-0000-0000-000000000001";
const NEW_ID = "00000000-0000-0000-0000-000000000002";

function serviceForMigrate(migrateErr: {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}) {
  const deleteUser = vi.fn(async () => ({ error: null }));
  const svc = {
    rpc: vi.fn((name: string) => {
      if (name === "reconnect_record_and_check") return builder(OPEN);
      if (name === "auth_attempt_mark_succeeded") return builder({ data: null, error: null });
      if (name === "migrate_player_identity") {
        return Promise.resolve({ data: null, error: migrateErr });
      }
      return builder({ data: null, error: null });
    }),
    from: vi.fn((table: string) => {
      if (table === "profiles") {
        return builder({
          data: [{ id: OLD_ID, display_name: "Alice", pin: "4821", needs_rename: false }],
          error: null,
        });
      }
      return builder({ data: null, error: null });
    }),
    auth: {
      admin: {
        getUserById: vi.fn(async () => ({
          data: { user: { identities: [{ provider: "anonymous" }] } },
        })),
        deleteUser,
      },
    },
  };
  return { svc, deleteUser };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createServerSupabaseClient).mockResolvedValue({
    auth: {
      signOut: vi.fn(async () => ({ error: null })),
      signInAnonymously: vi.fn(async () => ({
        data: { user: { id: NEW_ID } },
        error: null,
      })),
    },
  } as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>);
});

describe("reconnectPlayer migrate RPC failure", () => {
  it("RM-1: a correct PIN with a failed RPC returns the generic migrate error", async () => {
    const { svc, deleteUser } = serviceForMigrate({
      message: 'update or delete on table "profiles" violates foreign key constraint',
      code: "23503",
      details: 'Key (id)=(...) is still referenced from table "clubs".',
    });
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await reconnectPlayer("Alice", "4821");

    expect(r.success).toBe(false);
    expect(r.error).toBe("Failed to migrate account. Please try again.");
    expect(deleteUser).toHaveBeenCalledWith(NEW_ID);
    expect(svc.rpc.mock.calls.map((c: unknown[]) => c[0])).toContain("migrate_player_identity");
  });

  it("RM-2: the PostgREST code and details are logged (UI stays generic)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { svc } = serviceForMigrate({
      message: "duplicate key value violates unique constraint",
      code: "23505",
      details: "Key (display_name)=(...) already exists.",
      hint: "idx_profiles_unique_active_name",
    });
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    await reconnectPlayer("Alice", "4821");

    const migrateLogs = errSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("migrate_player_identity RPC failed")
    );
    expect(migrateLogs.length).toBeGreaterThan(0);
    expect(migrateLogs[0]).toEqual(
      expect.arrayContaining(["23505", "Key (display_name)=(...) already exists."])
    );
    errSpy.mockRestore();
  });
});
