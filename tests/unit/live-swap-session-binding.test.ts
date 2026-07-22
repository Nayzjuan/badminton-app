// ============================================================
// Live-swap session binding — TENANCY_AUDIT_2026-07-21.md #10
// ============================================================
// The four live-swap server actions gate on isSessionOrganizer(user.id,
// sessionId) and then call an RPC keyed on a SEPARATELY client-supplied match
// id. Nothing tied the two together, so an organizer of session A could rewrite
// the live roster of a match in session B by passing that match's id.
//
// 20260723000001 binds the RPCs themselves and is the authoritative fix; these
// tests cover the TypeScript half, which turns the SQL's raise into the normal
// error contract and keeps holding if a future RPC edit drops the predicate.
//
// What makes these tests worth having: EVERY assertion checks that the RPC was
// NOT called. Both layers refuse the same forgeries, so a test that only
// asserted on the returned message would stay green with the whole guard
// deleted — the SQL would raise and the action would still report failure.
//
// IDs: LSB-PLAYER · LSB-TEAMS · LSB-ONDECK · LSB-UNDO · LSB-HELPER
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/app/actions/_shared", () => ({
  getAuthenticatedUser: vi.fn(),
  isSessionOrganizer: vi.fn(),
  getActorContext: vi.fn(),
}));
vi.mock("@/lib/broadcast", () => ({ broadcastOrganizerIntervention: vi.fn() }));
vi.mock("@/lib/notifications/push-server", () => ({ pushToPlayers: vi.fn() }));
// after() needs a request scope; run the callback inline.
vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));

import { createServiceClient } from "@/utils/supabase/service";
import { getAuthenticatedUser, isSessionOrganizer, getActorContext } from "@/app/actions/_shared";
import {
  swapPlayerInActiveMatch,
  swapTeamsInActiveMatch,
  swapActiveFromOnDeck,
  undoLiveSwap,
} from "@/app/actions/live-match-swap";

// Real-looking UUIDs — the actions validate shape before anything else.
const SESSION_A = "11111111-1111-4111-8111-111111111111"; // the caller's session
const SESSION_B = "22222222-2222-4222-8222-222222222222"; // someone else's
const MATCH_B = "33333333-3333-4333-8333-333333333333"; // a match in session B
const MATCH_B2 = "44444444-4444-4444-8444-444444444444";
const P_OUT = "55555555-5555-4555-8555-555555555555";
const P_IN = "66666666-6666-4666-8666-666666666666";
const P_FILL = "77777777-7777-4777-8777-777777777777";

type QueryResult = { data: unknown; error: unknown };

/**
 * A thenable stand-in for a PostgREST query builder. Every filter method
 * returns the same object and records its arguments, so a test can assert that
 * `.eq("session_id", …)` was actually applied — the mutant that matters most
 * here is dropping that one filter, which no return-value assertion would see.
 */
function makeQuery(result: QueryResult) {
  const calls: [string, unknown[]][] = [];
  const q: Record<string, unknown> = { calls };
  for (const m of ["select", "eq", "in", "order", "limit", "neq"]) {
    q[m] = vi.fn((...args: unknown[]) => {
      calls.push([m, args]);
      return q;
    });
  }
  q.maybeSingle = vi.fn(async () => result);
  q.single = vi.fn(async () => result);
  q.then = (resolve: (v: QueryResult) => unknown) => Promise.resolve(result).then(resolve);
  return q;
}

/** Wires a fake service client whose `matches` query returns `matchRows`. */
function mockDb(opts: {
  matchRows?: unknown;
  matchesError?: unknown;
  matchSingle?: unknown;
  rpcError?: unknown;
}) {
  const matches = makeQuery({
    data: opts.matchSingle ?? opts.matchRows ?? [],
    error: opts.matchesError ?? null,
  });
  const matchPlayers = makeQuery({ data: { team: "a" }, error: null });
  const rpc = vi.fn(async () => ({ data: null, error: opts.rpcError ?? null }));
  const from = vi.fn((table: string) => (table === "matches" ? matches : matchPlayers));
  const db = { from, rpc };
  vi.mocked(createServiceClient).mockReturnValue(db as never);
  return { db, matches, matchPlayers, rpc };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: "user-1" } as never);
  vi.mocked(isSessionOrganizer).mockResolvedValue(true); // organizer of SESSION_A
  vi.mocked(getActorContext).mockResolvedValue({ id: "user-1", name: "Org" } as never);
});

// ─────────────────────────────────────────────────────────────
// LSB-PLAYER
// ─────────────────────────────────────────────────────────────

describe("LSB-PLAYER: swapPlayerInActiveMatch", () => {
  it("refuses a match that is not in the authorized session, without calling the RPC", async () => {
    const { rpc } = mockDb({ matchRows: [] }); // MATCH_B is not in SESSION_A

    const res = await swapPlayerInActiveMatch(MATCH_B, P_OUT, P_IN, SESSION_A, "Out", "In");

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("MATCH_NOT_ACTIVE");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("filters the binding query on BOTH the id and the session", async () => {
    // Guards against the mutant that drops `.eq("session_id", …)`, which no
    // assertion on the returned message could distinguish.
    const { matches } = mockDb({ matchRows: [] });
    await swapPlayerInActiveMatch(MATCH_B, P_OUT, P_IN, SESSION_A, "Out", "In");

    const calls = (matches.calls as [string, unknown[]][]).map(([m, a]) => `${m}:${a[0]}`);
    expect(calls).toContain("in:id");
    expect(calls).toContain("eq:session_id");
    const eqSession = (matches.calls as [string, unknown[]][]).find(
      ([m, a]) => m === "eq" && a[0] === "session_id"
    );
    expect(eqSession?.[1][1]).toBe(SESSION_A);
  });

  it("proceeds when the match does belong to the session", async () => {
    const { rpc } = mockDb({ matchRows: [{ id: MATCH_B }] });

    const res = await swapPlayerInActiveMatch(MATCH_B, P_OUT, P_IN, SESSION_A, "Out", "In");

    expect(res.success).toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      "swap_player_in_active_match",
      expect.objectContaining({ p_match_id: MATCH_B, p_session_id: SESSION_A })
    );
  });
});

// ─────────────────────────────────────────────────────────────
// LSB-TEAMS
// ─────────────────────────────────────────────────────────────

describe("LSB-TEAMS: swapTeamsInActiveMatch", () => {
  it("refuses a match from another session, without calling the RPC", async () => {
    const { rpc } = mockDb({ matchRows: [] });

    const res = await swapTeamsInActiveMatch(MATCH_B, SESSION_A, P_OUT, P_IN, "A", "B");

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("MATCH_NOT_ACTIVE");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes p_session_id to the RPC", async () => {
    // The parameter is DEFAULT NULL in SQL so the migration and the deploy can
    // land in either order — which means omitting it here silently disables the
    // database-side binding. This is the test that keeps that from happening.
    const { rpc } = mockDb({ matchRows: [{ id: MATCH_B }] });

    await swapTeamsInActiveMatch(MATCH_B, SESSION_A, P_OUT, P_IN, "A", "B");

    expect(rpc).toHaveBeenCalledWith(
      "swap_teams_in_active_match",
      expect.objectContaining({ p_session_id: SESSION_A })
    );
  });
});

// ─────────────────────────────────────────────────────────────
// LSB-ONDECK
// ─────────────────────────────────────────────────────────────

describe("LSB-ONDECK: swapActiveFromOnDeck", () => {
  it("refuses when only ONE of the two matches belongs to the session", async () => {
    // The realistic attack: a real organizer uses their own on-deck match to
    // reach into another club's live match. One row back for two ids requested.
    const { rpc } = mockDb({ matchRows: [{ id: MATCH_B2 }] });

    const res = await swapActiveFromOnDeck(
      MATCH_B,
      P_OUT,
      P_IN,
      MATCH_B2,
      P_FILL,
      SESSION_A,
      "Out",
      "OnDeck",
      "Fill"
    );

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe("MATCH_NOT_ACTIVE");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("proceeds when both matches belong to the session", async () => {
    const { rpc } = mockDb({ matchRows: [{ id: MATCH_B }, { id: MATCH_B2 }] });

    const res = await swapActiveFromOnDeck(
      MATCH_B,
      P_OUT,
      P_IN,
      MATCH_B2,
      P_FILL,
      SESSION_A,
      "Out",
      "OnDeck",
      "Fill"
    );

    expect(res.success).toBe(true);
    expect(rpc).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// LSB-UNDO
// ─────────────────────────────────────────────────────────────

describe("LSB-UNDO: undoLiveSwap", () => {
  it("queue_replacement — refuses when ctx.matchId is not in ctx.sessionId", async () => {
    // `ctx` is a plain object the client round-trips, so these two fields are
    // forgeable independently of one another.
    const { rpc } = mockDb({ matchRows: [] });

    const res = await undoLiveSwap({
      type: "queue_replacement",
      matchId: MATCH_B,
      outPlayerId: P_OUT,
      inPlayerId: P_IN,
      team: "a",
      sessionId: SESSION_A,
      outPlayerName: "Out",
      inPlayerName: "In",
    });

    expect(res.success).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("ondeck_replacement — refuses a partially-foreign pair", async () => {
    const { rpc } = mockDb({ matchRows: [{ id: MATCH_B }] });

    const res = await undoLiveSwap({
      type: "ondeck_replacement",
      activeMatchId: MATCH_B,
      outPlayerId: P_OUT,
      onDeckPlayerId: P_IN,
      onDeckMatchId: MATCH_B2,
      fillPlayerId: P_FILL,
      sessionId: SESSION_A,
      outTeam: "a",
      onDeckTeam: "b",
      outPlayerName: "Out",
      onDeckPlayerName: "OnDeck",
      fillPlayerName: "Fill",
    });

    expect(res.success).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("team_swap — authorizes against the match's OWN session, not a supplied one", async () => {
    // This branch never needed the guard: it reads session_id off the match and
    // gates on that, so there is no second field to disagree with. The test
    // pins that shape — if someone "simplifies" it to take ctx.sessionId, the
    // organizer check would start trusting client input and this goes red.
    const { rpc } = mockDb({ matchSingle: { session_id: SESSION_B } });

    const res = await undoLiveSwap({
      type: "team_swap",
      matchId: MATCH_B,
      playerAId: P_OUT,
      playerBId: P_IN,
      playerAName: "A",
      playerBName: "B",
    });

    expect(res.success).toBe(true);
    expect(isSessionOrganizer).toHaveBeenCalledWith("user-1", SESSION_B);
    expect(rpc).toHaveBeenCalledWith(
      "swap_teams_in_active_match",
      expect.objectContaining({ p_session_id: SESSION_B, p_is_undo: true })
    );
  });

  it("team_swap — refuses when the caller does not organize the match's session", async () => {
    const { rpc } = mockDb({ matchSingle: { session_id: SESSION_B } });
    vi.mocked(isSessionOrganizer).mockResolvedValue(false);

    const res = await undoLiveSwap({
      type: "team_swap",
      matchId: MATCH_B,
      playerAId: P_OUT,
      playerBId: P_IN,
      playerAName: "A",
      playerBName: "B",
    });

    expect(res.success).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// LSB-HELPER
// ─────────────────────────────────────────────────────────────

describe("LSB-HELPER: allMatchesInSession edge cases", () => {
  it("fails closed when the binding query itself errors", async () => {
    // A count comparison on `data` alone would read `null.length ?? 0` as 0 and
    // then compare 0 === 1, which happens to be correct — but only by accident,
    // and not for the single-id case if the shape ever changes. Explicit.
    const { rpc } = mockDb({ matchRows: null, matchesError: { message: "boom" } });

    const res = await swapPlayerInActiveMatch(MATCH_B, P_OUT, P_IN, SESSION_A, "Out", "In");

    expect(res.success).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not miscount when the same match id is supplied twice", async () => {
    // De-duplication matters: `.in()` on [x, x] returns ONE row, so a raw
    // length comparison against the argument count would reject a request that
    // is merely redundant rather than forged.
    const { rpc } = mockDb({ matchRows: [{ id: MATCH_B }] });

    const res = await swapActiveFromOnDeck(
      MATCH_B,
      P_OUT,
      P_IN,
      MATCH_B, // same id twice
      P_FILL,
      SESSION_A,
      "Out",
      "OnDeck",
      "Fill"
    );

    expect(res.success).toBe(true);
    expect(rpc).toHaveBeenCalled();
  });

  it("still requires the organizer gate first", async () => {
    // The binding is an ADDITION to the organizer check, not a replacement:
    // being able to prove a match is in session X must not let a non-organizer
    // of X act on it.
    const { rpc } = mockDb({ matchRows: [{ id: MATCH_B }] });
    vi.mocked(isSessionOrganizer).mockResolvedValue(false);

    const res = await swapPlayerInActiveMatch(MATCH_B, P_OUT, P_IN, SESSION_A, "Out", "In");

    expect(res.success).toBe(false);
    expect(res.message).toContain("Organizer access required");
    expect(rpc).not.toHaveBeenCalled();
  });
});
