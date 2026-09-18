// ============================================================
// Co-organizer invite mint + redeem
// ============================================================
// IDs: COI-*
// Mint is organizer-only. Redeem admits without enqueueing. Closed,
// close-in-flight, and hidden sessions all miss with the same message.
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/clubs", () => ({
  isClubAdmin: vi.fn(),
  ensureClubMembership: vi.fn().mockResolvedValue({ ok: true, joined: false, action: "unchanged" }),
  resolveSessionClubSlug: vi.fn().mockResolvedValue("chillax"),
}));
vi.mock("@/app/actions/_shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/actions/_shared")>();
  return {
    ...actual,
    getAuthenticatedUser: vi.fn(),
    isSessionOrganizer: vi.fn(),
  };
});
vi.mock("@/app/actions/matchmaking", () => ({
  runEngineForSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/app/actions/match-drafts", () => ({ clearAllUnpublishedDrafts: vi.fn() }));
vi.mock("@/lib/broadcast", () => ({
  broadcastSessionClosed: vi.fn(),
  broadcastAutoMatchmakingToggled: vi.fn(),
  broadcastAutoPublishToggled: vi.fn(),
  broadcastDraftCapPhase: vi.fn(),
  broadcastQueueNotice: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue({ get: () => null }),
}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { isClubAdmin, ensureClubMembership } from "@/lib/clubs";
import { isSessionOrganizer } from "@/app/actions/_shared";
import {
  createSession,
  getOrCreateCoOrganizerInvite,
  redeemCoOrganizerInvite,
} from "@/app/actions/sessions";
import { lookupCoOrganizerInvite } from "@/lib/resolve-co-organizer-invite";
import { isCoOrganizerInviteTokenShape } from "@/lib/co-organizer-invite";
import { clubOrganizer, sessionCoOrgShare } from "@/lib/club-paths";

const SESSION_ID = "00000000-0000-4000-8000-000000000010";
const CLUB_ID = "00000000-0000-4000-8000-0000000000c1";
const CALLER = { id: "00000000-0000-4000-8000-0000000ca11e" };
const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";

type Resp = { data?: unknown; error?: unknown; count?: number };
type Recorded = { table: string; ops: string[] };

function builder(resp: Resp, ops: string[]) {
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ["select", "order", "limit"]) b[m] = self;
  b["insert"] = (payload?: unknown) => {
    if (payload !== undefined) ops.push(`insert:${JSON.stringify(payload)}`);
    return b;
  };
  b["update"] = (payload?: unknown) => {
    if (payload !== undefined) ops.push(`update:${JSON.stringify(payload)}`);
    return b;
  };
  b["upsert"] = self;
  for (const m of ["eq", "neq", "in", "gte", "lte"])
    b[m] = (col: string, val: unknown) => {
      ops.push(`${m}:${col}=${String(val)}`);
      return b;
    };
  b["is"] = (col: string, val: unknown) => {
    ops.push(`is:${col}=${String(val)}`);
    return b;
  };
  b["or"] = (expr: string) => {
    ops.push(`or:${expr}`);
    return b;
  };
  b["maybeSingle"] = () => Promise.resolve(resp);
  b["single"] = () => Promise.resolve(resp);
  b["then"] = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(resp).then(res, rej);
  return b;
}

function serviceClient(responses: Resp[], rpcResp?: Resp) {
  let i = 0;
  const recorded: Recorded[] = [];
  return {
    recorded,
    from: vi.fn((table: string) => {
      const entry: Recorded = { table, ops: [] };
      recorded.push(entry);
      return builder(responses[i++] ?? { data: null, error: null }, entry.ops);
    }),
    rpc: vi.fn((fn: string) => {
      const entry: Recorded = { table: `rpc:${fn}`, ops: [] };
      recorded.push(entry);
      return builder(rpcResp ?? { data: null, error: null }, entry.ops);
    }),
  };
}

function authedAs(user: { id: string } | null, profileResp?: Resp) {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }) },
    from: vi.fn((table: string) => {
      const ops: string[] = [];
      if (table === "profiles") {
        return builder(
          profileResp ?? {
            data: { id: user?.id, needs_rename: false, needs_name_confirm: false },
          },
          ops
        );
      }
      return builder({ data: null, error: null }, ops);
    }),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("COI-CREATE: createSession mints an invite token", () => {
  beforeEach(() => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      authedAs(CALLER) as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
    );
    vi.mocked(isClubAdmin).mockResolvedValue(true);
  });

  it("COI-CREATE-1: the insert payload includes a shaped invite token", async () => {
    const svc = serviceClient([{ data: null }, { data: null }, { data: { id: "new-session-1" } }]);
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await createSession({
      name: "Friday",
      scoring: "single",
      clubId: CLUB_ID,
      passcode: "SMASH0001",
    });
    expect(r.success).toBe(true);

    const inserted = svc.recorded.find((row) => row.ops.some((op) => op.startsWith("insert:")));
    expect(inserted, "createSession never inserted a sessions row").toBeDefined();
    const payload = JSON.parse(
      inserted!.ops.find((op) => op.startsWith("insert:"))!.slice("insert:".length)
    ) as { co_organizer_invite_token?: string };
    expect(isCoOrganizerInviteTokenShape(payload.co_organizer_invite_token ?? "")).toBe(true);
  });
});

describe("COI-MINT: getOrCreateCoOrganizerInvite", () => {
  beforeEach(() => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      authedAs(CALLER) as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
    );
  });

  it("COI-MINT-1: a non-organizer never reads or stamps the token", async () => {
    vi.mocked(isSessionOrganizer).mockResolvedValue(false);
    const svc = serviceClient([]);
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await getOrCreateCoOrganizerInvite(SESSION_ID);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/organizer access required/i);
    expect(svc.from).not.toHaveBeenCalled();
  });

  it("COI-MINT-2: hidden, closed, and close-in-flight sessions refuse to mint", async () => {
    vi.mocked(isSessionOrganizer).mockResolvedValue(true);
    const cases = [
      { is_active: true, ended_at: null, is_hidden: true, co_organizer_invite_token: TOKEN },
      {
        is_active: false,
        ended_at: "2026-09-18T12:00:00Z",
        is_hidden: false,
        co_organizer_invite_token: TOKEN,
      },
      {
        is_active: true,
        ended_at: "2026-09-18T12:00:00Z",
        is_hidden: false,
        co_organizer_invite_token: null,
      },
    ];
    for (const row of cases) {
      const svc = serviceClient([{ data: row }]);
      vi.mocked(createServiceClient).mockReturnValue(
        svc as unknown as ReturnType<typeof createServiceClient>
      );
      const r = await getOrCreateCoOrganizerInvite(SESSION_ID);
      expect(r.success, JSON.stringify(row)).toBe(false);
      expect(r.message).toMatch(/invalid or expired/i);
      expect(svc.recorded.some((rec) => rec.ops.some((op) => op.startsWith("update:")))).toBe(
        false
      );
    }
  });

  it("COI-MINT-3: an existing token is returned without a second mint", async () => {
    vi.mocked(isSessionOrganizer).mockResolvedValue(true);
    const svc = serviceClient([
      {
        data: {
          co_organizer_invite_token: TOKEN,
          is_active: true,
          ended_at: null,
          is_hidden: false,
        },
      },
    ]);
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await getOrCreateCoOrganizerInvite(SESSION_ID);
    expect(r.success).toBe(true);
    expect(r.token).toBe(TOKEN);
    expect(r.path).toBe(sessionCoOrgShare(TOKEN));
    expect(svc.from).toHaveBeenCalledTimes(1);
  });

  it("COI-MINT-4: a null token is stamped only when still null", async () => {
    vi.mocked(isSessionOrganizer).mockResolvedValue(true);
    const minted = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    const svc = serviceClient([
      {
        data: {
          co_organizer_invite_token: null,
          is_active: true,
          ended_at: null,
          is_hidden: false,
        },
      },
      { data: { co_organizer_invite_token: minted } },
    ]);
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await getOrCreateCoOrganizerInvite(SESSION_ID);
    expect(r.success).toBe(true);
    expect(r.token).toBe(minted);
    const update = svc.recorded.find((row) => row.ops.some((op) => op.startsWith("update:")));
    expect(update?.ops).toContain("is:co_organizer_invite_token=null");
    expect(update?.ops).toContain(`eq:id=${SESSION_ID}`);
    expect(update?.ops).toContain("eq:is_active=true");
    expect(update?.ops).toContain("is:ended_at=null");
    expect(update?.ops).toContain("eq:is_hidden=false");
  });
});

describe("COI-REDEEM: redeemCoOrganizerInvite", () => {
  beforeEach(() => {
    vi.mocked(ensureClubMembership).mockResolvedValue({
      ok: true,
      joined: true,
      action: "created",
    });
  });

  it("COI-REDEEM-1: rename-pending profiles are sent to /rename before elevation", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      authedAs(CALLER, {
        data: { id: CALLER.id, needs_rename: true, needs_name_confirm: false },
      }) as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
    );
    const svc = serviceClient([]);
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await redeemCoOrganizerInvite(TOKEN);
    expect(r.success).toBe(false);
    expect(r.requiresRename).toBe(true);
    expect(r.next).toBe(sessionCoOrgShare(TOKEN));
    expect(svc.from).not.toHaveBeenCalled();
  });

  it("COI-REDEEM-2: closed, close-in-flight, hidden, and unknown tokens share one message", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      authedAs(CALLER) as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
    );
    const rows = [
      null,
      { id: SESSION_ID, is_active: false, ended_at: "2026-09-18T12:00:00Z", is_hidden: false },
      { id: SESSION_ID, is_active: true, ended_at: "2026-09-18T12:00:00Z", is_hidden: false },
      { id: SESSION_ID, is_active: true, ended_at: null, is_hidden: true },
    ];
    for (const row of rows) {
      const svc = serviceClient([{ data: row }]);
      vi.mocked(createServiceClient).mockReturnValue(
        svc as unknown as ReturnType<typeof createServiceClient>
      );
      const r = await redeemCoOrganizerInvite(TOKEN);
      expect(r.success).toBe(false);
      expect(r.message).toBe("This invite is invalid or expired.");
      expect(svc.rpc).not.toHaveBeenCalled();
      expect(svc.recorded.map((rec) => rec.table)).not.toContain("queue_entries");
    }
  });

  it("COI-REDEEM-3: a live token admits via admit_session_organizer, enrolls, and does not enqueue", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      authedAs(CALLER) as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
    );
    const svc = serviceClient(
      [{ data: { id: SESSION_ID, is_active: true, ended_at: null, is_hidden: false } }],
      { data: true }
    );
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await redeemCoOrganizerInvite(TOKEN);
    expect(r.success).toBe(true);
    expect(r.destination).toBe(clubOrganizer("chillax", SESSION_ID));
    expect(svc.rpc).toHaveBeenCalledWith("admit_session_organizer", {
      p_session_id: SESSION_ID,
      p_user_id: CALLER.id,
    });
    expect(svc.recorded.map((rec) => rec.table)).toEqual([
      "sessions",
      "rpc:admit_session_organizer",
    ]);
    expect(svc.recorded.map((rec) => rec.table)).not.toContain("queue_entries");
    expect(ensureClubMembership).toHaveBeenCalledWith("chillax", CALLER.id);
  });

  it("COI-REDEEM-4: a session UUID is not an invite token and never hits sessions", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      authedAs(CALLER) as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
    );
    const svc = serviceClient([]);
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await redeemCoOrganizerInvite(SESSION_ID);
    expect(r.success).toBe(false);
    expect(r.message).toBe("This invite is invalid or expired.");
    expect(svc.from).not.toHaveBeenCalled();
  });

  it("COI-REDEEM-5: write_failed club enroll does not report success", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      authedAs(CALLER) as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
    );
    vi.mocked(ensureClubMembership).mockResolvedValue({
      ok: false,
      joined: false,
      reason: "write_failed",
    });
    const svc = serviceClient(
      [{ data: { id: SESSION_ID, is_active: true, ended_at: null, is_hidden: false } }],
      { data: true }
    );
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await redeemCoOrganizerInvite(TOKEN);
    expect(r.success).toBe(false);
    expect(svc.rpc).not.toHaveBeenCalled();
    expect(r.destination).toBeUndefined();
  });

  it("COI-REDEEM-5b: read_failed club enroll does not report success or admit", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      authedAs(CALLER) as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
    );
    vi.mocked(ensureClubMembership).mockResolvedValue({
      ok: false,
      joined: false,
      reason: "read_failed",
    });
    const svc = serviceClient(
      [{ data: { id: SESSION_ID, is_active: true, ended_at: null, is_hidden: false } }],
      { data: true }
    );
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await redeemCoOrganizerInvite(TOKEN);
    expect(r.success).toBe(false);
    expect(svc.rpc).not.toHaveBeenCalled();
  });

  it("COI-REDEEM-6: admit_session_organizer false refuses close-in-flight after the preview lookup", async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      authedAs(CALLER) as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
    );
    const svc = serviceClient(
      [{ data: { id: SESSION_ID, is_active: true, ended_at: null, is_hidden: false } }],
      { data: false }
    );
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );

    const r = await redeemCoOrganizerInvite(TOKEN);
    expect(r.success).toBe(false);
    expect(r.message).toBe("This invite is invalid or expired.");
    expect(ensureClubMembership).toHaveBeenCalled();
    expect(svc.rpc).toHaveBeenCalledWith("admit_session_organizer", {
      p_session_id: SESSION_ID,
      p_user_id: CALLER.id,
    });
  });
});

describe("COI-LOOKUP: lookupCoOrganizerInvite", () => {
  it("COI-LOOKUP-1: a malformed token misses without a database round-trip", async () => {
    const svc = serviceClient([]);
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );
    expect(await lookupCoOrganizerInvite(SESSION_ID)).toEqual({ ok: false });
    expect(svc.from).not.toHaveBeenCalled();
  });

  it("COI-LOOKUP-2: a live row returns name and club; a hidden row misses", async () => {
    const live = serviceClient([
      {
        data: {
          id: SESSION_ID,
          name: "Friday Night",
          is_active: true,
          ended_at: null,
          is_hidden: false,
          clubs: { slug: "chillax", name: "CHILLAX" },
        },
      },
    ]);
    vi.mocked(createServiceClient).mockReturnValue(
      live as unknown as ReturnType<typeof createServiceClient>
    );
    expect(await lookupCoOrganizerInvite(TOKEN)).toEqual({
      ok: true,
      sessionId: SESSION_ID,
      name: "Friday Night",
      clubSlug: "chillax",
      clubName: "CHILLAX",
    });

    const hidden = serviceClient([
      {
        data: {
          id: SESSION_ID,
          name: "Friday Night",
          is_active: true,
          ended_at: null,
          is_hidden: true,
          clubs: { slug: "chillax", name: "CHILLAX" },
        },
      },
    ]);
    vi.mocked(createServiceClient).mockReturnValue(
      hidden as unknown as ReturnType<typeof createServiceClient>
    );
    expect(await lookupCoOrganizerInvite(TOKEN)).toEqual({ ok: false });
  });

  it("COI-LOOKUP-3: a database error is a miss, not a throw", async () => {
    const svc = serviceClient([{ data: null, error: { message: "db down" } }]);
    vi.mocked(createServiceClient).mockReturnValue(
      svc as unknown as ReturnType<typeof createServiceClient>
    );
    await expect(lookupCoOrganizerInvite(TOKEN)).resolves.toEqual({ ok: false });
  });
});
