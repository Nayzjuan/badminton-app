// ============================================================
// createManualMatchAction — the duplicate-roster soft confirm
// ============================================================
// WHY THIS FILE EXISTS
//
// Production, 2026-08-15: one session held two completed matches for what was
// really one game — same four players, ten minutes apart, both created by the
// organizer, the second a 19-second retroactive hand-entry of a result that had
// already been recorded on another court. It was never a concurrent double
// submit; the CAS in endMatchInternal makes two scores on ONE row impossible.
// Two separate rows are a different defect, and creation is the only place it
// is still visible.
//
// The contract this file defends:
//   1. It is a CONFIRM, never a block — the same four legitimately do rematch,
//      and `confirmDuplicate` must always get the organizer through.
//   2. Roster identity is the SET of four, so swapping the teams does not
//      launder a duplicate past it.
//   3. The probe runs behind the organizer gate, so it is not a read oracle.
//
// IDs: DRC-1 detection · DRC-2 the confirmed re-send · DRC-3 non-duplicates
//      DRC-4 the window bound · DRC-5 message wording · DRC-6 gating
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
}));
vi.mock("@/utils/supabase/service", () => ({
  createServiceClient: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: (cb: () => unknown) => cb() }));
vi.mock("@/lib/notifications/push-server", () => ({
  pushToPlayers: vi.fn().mockResolvedValue({ sent: 0, errors: 0 }),
}));
// Only isSessionActive is stubbed — the table-addressed service mock below
// answers the organizer check with a real isSessionOrganizer, which is the
// point of DRC-6. Everything else in _shared stays real.
vi.mock("@/app/actions/_shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/actions/_shared")>()),
  isSessionActive: vi.fn(async () => true),
}));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { createManualMatchAction } from "@/app/actions/match-lifecycle";
import { DUPLICATE_ROSTER_WINDOW_MINUTES } from "@/lib/constants";

// ── Fixtures ──────────────────────────────────────────────────
const SESSION_ID = "00000000-0000-4000-8000-000000000010";
const USER_ID = "00000000-0000-4000-8000-000000000020";
const STRANGER_ID = "00000000-0000-4000-8000-000000000021";
const [P1, P2, P3, P4, P5] = [
  "00000000-0000-4000-8000-000000000031",
  "00000000-0000-4000-8000-000000000032",
  "00000000-0000-4000-8000-000000000033",
  "00000000-0000-4000-8000-000000000034",
  "00000000-0000-4000-8000-000000000035",
];
const TEAM_A = [P1, P2];
const TEAM_B = [P3, P4];
const PRIOR_MATCH_ID = "match-prior";

type MockResponse = { data?: unknown; error?: { message: string } | null };

/** Awaitable chainable builder. Filters are recorded, never applied. */
function makeBuilder(response: MockResponse, onFilter?: (op: string, ...args: unknown[]) => void) {
  const b: Record<string, unknown> = {};
  b["then"] = (onFulfilled: (v: MockResponse) => unknown, onRejected: (e: unknown) => unknown) =>
    Promise.resolve(response).then(onFulfilled, onRejected);
  b["catch"] = (onRejected: (e: unknown) => unknown) => Promise.resolve(response).catch(onRejected);
  b["single"] = () => Promise.resolve(response);
  b["maybeSingle"] = () => Promise.resolve(response);
  for (const method of ["select", "eq", "neq", "in", "or", "order", "limit", "gte"]) {
    b[method] = (...args: unknown[]) => {
      onFilter?.(method, ...args);
      return b;
    };
  }
  return b;
}

type Harness = {
  /** Rows the duplicate probe's `matches` read resolves to. */
  recentMatches: Array<{ id: string; completed_at: string | null }>;
  /** Rows the duplicate probe's `match_players` read resolves to. */
  recentPlayers: Array<{ match_id: string; player_id: string }>;
  /** created_by on the session row — flip it to make the caller a stranger. */
  sessionOwner: string;
};

function setup(overrides: Partial<Harness> = {}) {
  const h: Harness = {
    recentMatches: [],
    recentPlayers: [],
    sessionOwner: USER_ID,
    ...overrides,
  };

  const tablesRead: string[] = [];
  const gteArgs: Array<[string, unknown]> = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  const from = vi.fn((table: string) => {
    tablesRead.push(table);
    const record = (op: string, ...args: unknown[]) => {
      if (op === "gte") gteArgs.push([args[0] as string, args[1]]);
    };
    switch (table) {
      case "sessions":
        return makeBuilder({
          data: { created_by: h.sessionOwner, club_id: "club-1" },
          error: null,
        });
      case "session_organizers":
      case "club_members":
        return makeBuilder({ data: null, error: null });
      case "queue_entries":
        return makeBuilder({
          data: [P1, P2, P3, P4, P5].map((id) => ({ player_id: id })),
          error: null,
        });
      case "matches":
        return makeBuilder({ data: h.recentMatches, error: null }, record);
      case "match_players":
        return makeBuilder({ data: h.recentPlayers, error: null });
      case "profiles":
        return makeBuilder({
          data: [P1, P2, P3, P4, P5].map((id) => ({ id, skill_level: "intermediate" })),
          error: null,
        });
      default:
        return makeBuilder({ data: null, error: null });
    }
  });

  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    return Promise.resolve({ data: "match-new", error: null });
  });

  vi.mocked(createServiceClient).mockReturnValue({ from, rpc } as never);
  vi.mocked(createServerSupabaseClient).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: USER_ID } }, error: null }),
    },
    from: vi.fn(),
  } as never);

  return { tablesRead, gteArgs, rpcCalls };
}

/** A completed match `minutesAgo` in the past holding exactly `playerIds`. */
function priorMatch(minutesAgo: number | null, playerIds: string[]) {
  return {
    recentMatches: [
      {
        id: PRIOR_MATCH_ID,
        completed_at:
          minutesAgo === null ? null : new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      },
    ],
    recentPlayers: playerIds.map((player_id) => ({ match_id: PRIOR_MATCH_ID, player_id })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────
describe("DRC-1: detection", () => {
  it("DRC-1a: refuses with code 'duplicate_roster' when these four just played", async () => {
    const { rpcCalls } = setup(priorMatch(10, [P1, P2, P3, P4]));

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.success).toBe(false);
    expect(result.code).toBe("duplicate_roster");
    // A soft refusal must NOT have created anything — that is the whole point.
    expect(rpcCalls).toHaveLength(0);
  });

  it("DRC-1b: teams swapped across the net is still the same four", async () => {
    // The prior match had P1+P3 vs P2+P4; this one is P1+P2 vs P3+P4. Same set.
    const { rpcCalls } = setup(priorMatch(5, [P1, P3, P2, P4]));

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.code).toBe("duplicate_roster");
    expect(rpcCalls).toHaveLength(0);
  });

  it("DRC-1c: scans every recent match, not just the newest", async () => {
    const { rpcCalls } = setup({
      recentMatches: [
        { id: "match-other", completed_at: new Date(Date.now() - 60_000).toISOString() },
        { id: PRIOR_MATCH_ID, completed_at: new Date(Date.now() - 600_000).toISOString() },
      ],
      recentPlayers: [
        ...[P1, P2, P3, P5].map((player_id) => ({ match_id: "match-other", player_id })),
        ...[P1, P2, P3, P4].map((player_id) => ({ match_id: PRIOR_MATCH_ID, player_id })),
      ],
    });

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.code).toBe("duplicate_roster");
    expect(rpcCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
describe("DRC-2: the confirmed re-send", () => {
  it("DRC-2a: confirmDuplicate creates the match the probe just refused", async () => {
    const { rpcCalls } = setup(priorMatch(10, [P1, P2, P3, P4]));

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B, true);

    expect(result.success).toBe(true);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe("create_match_with_players");
  });

  it("DRC-2b: confirmDuplicate skips the probe entirely — no matches read", async () => {
    const { tablesRead } = setup(priorMatch(10, [P1, P2, P3, P4]));

    await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B, true);

    expect(tablesRead).not.toContain("matches");
    expect(tablesRead).not.toContain("match_players");
  });

  it("DRC-2c: the default is false — an un-passed flag never auto-confirms", async () => {
    const { rpcCalls } = setup(priorMatch(10, [P1, P2, P3, P4]));

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.code).toBe("duplicate_roster");
    expect(rpcCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
describe("DRC-3: what must NOT trip it", () => {
  it("DRC-3a: three of the four shared is a different lineup", async () => {
    const { rpcCalls } = setup(priorMatch(5, [P1, P2, P3, P5]));

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.success).toBe(true);
    expect(result.code).toBeUndefined();
    expect(rpcCalls).toHaveLength(1);
  });

  it("DRC-3b: an empty session creates without a prompt", async () => {
    const { rpcCalls } = setup();

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.success).toBe(true);
    expect(rpcCalls).toHaveLength(1);
  });

  it("DRC-3c: a match_players read that comes back empty is not a duplicate", async () => {
    // A recent completed match exists but its roster rows are unreadable/absent.
    // Sizes cannot match, so the probe must fall through rather than guess.
    const { rpcCalls } = setup({
      recentMatches: [{ id: PRIOR_MATCH_ID, completed_at: new Date().toISOString() }],
      recentPlayers: [],
    });

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.success).toBe(true);
    expect(rpcCalls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────
describe("DRC-4: the window bound", () => {
  it("DRC-4a: filters completed_at to the last DUPLICATE_ROSTER_WINDOW_MINUTES", async () => {
    const { gteArgs } = setup();
    const before = Date.now();

    await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(gteArgs).toHaveLength(1);
    const [column, value] = gteArgs[0];
    expect(column).toBe("completed_at");
    const cutoff = new Date(value as string).getTime();
    const expected = before - DUPLICATE_ROSTER_WINDOW_MINUTES * 60_000;
    // Seconds of slack for the time the action itself takes to reach the query.
    expect(Math.abs(cutoff - expected)).toBeLessThan(5_000);
  });
});

// ─────────────────────────────────────────────────────────────
describe("DRC-5: the message the organizer reads", () => {
  it("DRC-5a: names how long ago, pluralised", async () => {
    setup(priorMatch(10, [P1, P2, P3, P4]));
    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);
    expect(result.message).toContain("10 minutes ago");
  });

  it("DRC-5b: one minute is singular", async () => {
    setup(priorMatch(1, [P1, P2, P3, P4]));
    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);
    expect(result.message).toContain("1 minute ago");
    expect(result.message).not.toContain("1 minutes");
  });

  it("DRC-5c: seconds ago reads as 'just finished', not '0 minutes ago'", async () => {
    setup(priorMatch(0, [P1, P2, P3, P4]));
    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);
    expect(result.message).toContain("just finished a match together");
    expect(result.message).not.toContain("0 minute");
  });

  // Not a reachable production state: the probe's own
  // .gte("completed_at", windowStart) already drops NULL rows, because a SQL
  // comparison against NULL is never true — and the builder mock records that
  // filter without applying it, which is what lets this case be constructed at
  // all. What it pins is the fallback the TYPE still demands (`completed_at` is
  // nullable in the schema, so the arm has to exist): keep it from rotting into
  // a user-visible "NaN minutes ago" if the filter ever moves or loosens.
  it("DRC-5d: the nullable-column fallback reads as a timeless phrase, never NaN", async () => {
    setup(priorMatch(null, [P1, P2, P3, P4]));
    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);
    expect(result.message).toContain("already have a completed match in this session");
    expect(result.message).not.toContain("NaN");
  });

  it("DRC-5e: ends in a question, because the caller renders it as a confirm", async () => {
    setup(priorMatch(3, [P1, P2, P3, P4]));
    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);
    expect(result.message.trim().endsWith("?")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
describe("DRC-6: the probe sits behind the organizer gate", () => {
  it("DRC-6a: a non-organizer is refused before any match is read", async () => {
    const { tablesRead, rpcCalls } = setup({
      sessionOwner: STRANGER_ID,
      ...priorMatch(10, [P1, P2, P3, P4]),
    });

    const result = await createManualMatchAction(SESSION_ID, TEAM_A, TEAM_B);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/organizer access required/i);
    // No `code` — the caller must not offer "Create anyway" on an auth failure.
    expect(result.code).toBeUndefined();
    expect(tablesRead).not.toContain("matches");
    expect(rpcCalls).toHaveLength(0);
  });
});
