// ============================================================
// Suite RG — enforceRenameGate (server-only redirect guard)
// ============================================================
// WHY THIS FILE EXISTS
//
// enforceRenameGate had ZERO tests. Replacing its body with an immediate
// `return` — making the gate entirely inert, so a flagged duplicate walks
// straight into an authenticated screen under the duplicated name — left
// `npx tsc --noEmit` clean and the whole unit suite green.
//
// The two carve-outs are the subtle part, and both are the column-filter
// shape that a mock recording only table names cannot see. So the builder
// below records `op:column=value` and RG-3/RG-4 assert the PAIRING:
//
//   • Grandfather — queue_entries WHERE player_id = me AND status IN
//     (waiting, drafted, on_deck, playing). Widen that status list and the
//     gate stops firing for players it should catch; narrow it and a player
//     mid-match gets yanked to /rename.
//   • Active organizer — sessions WHERE created_by = me AND is_active = true.
//     Drop `is_active` and any organizer who ever ran a session is exempt
//     forever.
//
// RG-1 also pins the fast path as a COST property, not just a behavioural
// one: a clean profile must issue zero queries. That is what makes the gate
// safe to call on every authenticated render.
//
//   RG-1  not flagged        → no redirect, ZERO db round-trips
//   RG-2  flagged, no carve-out → redirects with the encoded next path
//   RG-3  grandfathered      → no redirect + queue filter pairing asserted
//   RG-4  active organizer   → no redirect + session filter pairing asserted
//   RG-5  lookup order       → the queue check short-circuits the session one
//   RG-6  next path encoding → query strings survive as one parameter
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { createServiceClient } from "@/utils/supabase/service";
import { redirect } from "next/navigation";
import { enforceRenameGate } from "@/lib/rename-gate";
import type { Profile } from "@/types/database";

const ME = "00000000-0000-4000-8000-00000000d0e5";

type Resp = { data?: unknown; error?: unknown };
type Recorded = { table: string; ops: string[] };

/** Chainable builder that records every filter as `op:column=value`. */
function builder(resp: Resp, ops: string[]) {
  const b: Record<string, unknown> = {};
  b["select"] = () => b;
  b["limit"] = () => b;
  b["eq"] = (col: string, val: unknown) => {
    ops.push(`eq:${col}=${String(val)}`);
    return b;
  };
  b["in"] = (col: string, vals: unknown[]) => {
    ops.push(`in:${col}=${vals.join(",")}`);
    return b;
  };
  b["maybeSingle"] = () => Promise.resolve(resp);
  b["then"] = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(resp).then(res, rej);
  return b;
}

/** Service client returning `byTable` responses; records each access in order. */
function useService(byTable: Record<string, Resp>): Recorded[] {
  const recorded: Recorded[] = [];
  vi.mocked(createServiceClient).mockReturnValue({
    from: vi.fn((table: string) => {
      const entry: Recorded = { table, ops: [] };
      recorded.push(entry);
      return builder(byTable[table] ?? { data: null }, entry.ops);
    }),
  } as unknown as ReturnType<typeof createServiceClient>);
  return recorded;
}

/** Minimal profile — only the two fields the gate reads. */
function profile(needsRename: boolean): Profile {
  return { id: ME, needs_rename: needsRename } as unknown as Profile;
}

const NONE = { data: null };
const FOUND = { data: { id: "row-1" } };

beforeEach(() => vi.clearAllMocks());

describe("Suite RG — enforceRenameGate", () => {
  it("RG-1: a profile that is not flagged returns immediately with zero queries", async () => {
    const recorded = useService({});

    await enforceRenameGate(profile(false), "/play");

    expect(redirect).not.toHaveBeenCalled();
    // The fast path is a cost guarantee, not just a behaviour: this gate runs
    // on every authenticated render. A regression that made it query first
    // would still "work" and would still pass a redirect-only assertion.
    expect(recorded, "the fast path issued a DB round-trip").toHaveLength(0);
  });

  it("RG-2: a flagged profile with no carve-out is redirected to /rename", async () => {
    useService({ queue_entries: NONE, sessions: NONE });

    await enforceRenameGate(profile(true), "/play");

    expect(redirect).toHaveBeenCalledWith("/rename?next=%2Fplay");
  });

  it("RG-3 (negative): a player in a live queue is grandfathered — and the filter is bound to them", async () => {
    const recorded = useService({ queue_entries: FOUND });

    await enforceRenameGate(profile(true), "/play");

    expect(redirect).not.toHaveBeenCalled();

    const queue = recorded.find((r) => r.table === "queue_entries");
    expect(queue, "the grandfather check never read queue_entries").toBeDefined();
    expect(queue!.ops).toContain(`eq:player_id=${ME}`);
    // Pin the status list exactly. Adding "left"/"finished" here would
    // grandfather players who are no longer in the session at all; dropping
    // "playing" would yank someone off a live court.
    expect(queue!.ops).toContain("in:status=waiting,drafted,on_deck,playing");
  });

  it("RG-4 (negative): an active organizer is exempt — and the filter requires is_active", async () => {
    const recorded = useService({ queue_entries: NONE, sessions: FOUND });

    await enforceRenameGate(profile(true), "/play");

    expect(redirect).not.toHaveBeenCalled();

    const sessions = recorded.find((r) => r.table === "sessions");
    expect(sessions, "the organizer carve-out never read sessions").toBeDefined();
    expect(sessions!.ops).toContain(`eq:created_by=${ME}`);
    // Without this, anyone who has EVER created a session is exempt forever.
    expect(sessions!.ops).toContain("eq:is_active=true");
  });

  it("RG-5: the grandfather hit short-circuits before the organizer lookup", async () => {
    const recorded = useService({ queue_entries: FOUND, sessions: FOUND });

    await enforceRenameGate(profile(true), "/play");

    expect(redirect).not.toHaveBeenCalled();
    // Ordering is behaviour here, not style: the second query is skipped work
    // on the hot path for every flagged player who is mid-session.
    expect(recorded.map((r) => r.table)).toEqual(["queue_entries"]);
  });

  it("RG-6: the next path is URL-encoded so a query string survives as one parameter", async () => {
    useService({ queue_entries: NONE, sessions: NONE });

    await enforceRenameGate(profile(true), "/c/chillax/play/abc?tab=queue&x=1");

    // Unencoded, the "&x=1" would arrive at /rename as a SECOND query
    // parameter and be dropped from `next`, silently truncating the
    // destination the player is sent back to.
    expect(redirect).toHaveBeenCalledWith(
      "/rename?next=%2Fc%2Fchillax%2Fplay%2Fabc%3Ftab%3Dqueue%26x%3D1"
    );
  });
});
