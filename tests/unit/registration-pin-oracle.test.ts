// ============================================================
// signInAnonymously — registration must not be a PIN oracle
// ============================================================
// Registration is unauthenticated and deliberately UNTHROTTLED (a real club
// signs up a dozen walk-ins in a burst, so a limiter here would hurt real
// users). That is only safe while its replies carry no information about
// anyone's PIN.
//
// It used to look a returning player up with `.ilike(name).eq("pin", pin)` and
// answer "Looks like you've played before!" on a hit versus "Name taken." on a
// miss. Those two replies are a free, unlimited PIN oracle: submit one name
// against all 9,000 PINs and watch for the flip. That bypassed the
// reconnectPlayer limiter (tests/unit/reconnect-throttle.test.ts) end to end —
// recover the PIN here for nothing, then spend a single reconnect attempt.
//
// The fix is name-only matching with one shared reply, so right and wrong PINs
// are indistinguishable.
//
// IDs: RO-STRUCT (the lookup never filters on pin) · RO-BLIND (replies match)
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
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("REDIRECTED");
  }),
}));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { signInAnonymously } from "@/app/actions/auth";

const REGISTERED_NAME = "Alice";
const REGISTERED_PIN = "4821";
const WRONG_PIN = "0000";
/** Held only by a FLAGGED duplicate (needs_rename = true). */
const FLAGGED_NAME = "Bob";
const FLAGGED_PIN = "1234";
/** Held by MORE THAN ONE row — the duplicate-cluster shape. */
const CLUSTER_NAME = "Dupe";

/** Sentinel returned by the stubbed auth call — reaching it means the name passed. */
const AUTH_STUB = "AUTH_STUB_REACHED";

const TABLE = [
  { id: "existing-user", display_name: REGISTERED_NAME, needs_rename: false, pin: REGISTERED_PIN },
  { id: "flagged-user", display_name: FLAGGED_NAME, needs_rename: true, pin: FLAGGED_PIN },
  // A duplicate cluster: TWO rows sharing one raw name, both flagged. Both
  // flagged on purpose — with a non-flagged sibling present, isNameTaken would
  // mask a failure of check (1) and RO-MULTI-1 could not detect it.
  { id: "dupe-a", display_name: CLUSTER_NAME, needs_rename: true, pin: "1111" },
  { id: "dupe-b", display_name: CLUSTER_NAME, needs_rename: true, pin: "2222" },
];

/** Filters applied to the current builder chain, so the fake can honour them. */
type Filters = { pin?: string; name?: string; needsRename?: boolean; limit?: number };

/** Every `.eq()` column touched during the run — the structural assertion. */
let eqColumns: string[] = [];

/**
 * Fake `profiles` table. Crucially it HONOURS the filters it records — a
 * pin-filtering query really does come back empty for a wrong PIN, which is what
 * lets RO-BLIND fail against the vulnerable code. A filter-ignoring mock would
 * have agreed with the oracle and passed either way.
 */
function profilesBuilder(filters: Filters) {
  const b: Record<string, unknown> = {};
  const self = () => b;

  b["select"] = self;
  b["order"] = self;
  b["in"] = self;
  // Honoured, NOT swallowed: `.limit()` is what keeps maybeSingle() from
  // erroring on a duplicate cluster (see the multi-row branch below).
  b["limit"] = (n: number) => {
    filters.limit = n;
    return b;
  };
  b["ilike"] = (col: string, val: string) => {
    if (col === "display_name") filters.name = val;
    return b;
  };
  b["eq"] = (col: string, val: unknown) => {
    eqColumns.push(col);
    if (col === "pin") filters.pin = String(val);
    if (col === "needs_rename") filters.needsRename = Boolean(val);
    return b;
  };

  const rows = () => {
    const matched = TABLE.filter((r) => {
      if ((filters.name ?? "").toLowerCase() !== r.display_name.toLowerCase()) return false;
      if (filters.pin !== undefined && filters.pin !== r.pin) return false;
      if (filters.needsRename !== undefined && filters.needsRename !== r.needs_rename) return false;
      return true;
    });
    return filters.limit === undefined ? matched : matched.slice(0, filters.limit);
  };

  const resp = () => ({ data: rows(), error: null });

  /**
   * Real PostgREST behaviour: `.maybeSingle()` on more than one row is an
   * ERROR (PGRST116) with `data: null` — it does not quietly hand back the
   * first. Modelling that is the whole point; a fake that returned `rows()[0]`
   * would agree with buggy code and hide the fail-open in check (1).
   */
  const one = () => {
    const r = rows();
    if (r.length > 1) {
      return Promise.resolve({
        data: null,
        error: { code: "PGRST116", message: "JSON object requested, multiple rows returned" },
      });
    }
    return Promise.resolve({ data: r[0] ?? null, error: null });
  };
  b["maybeSingle"] = one;
  b["single"] = one;
  b["then"] = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(resp()).then(res, rej);
  return b;
}

function installMocks() {
  vi.mocked(createServerSupabaseClient).mockResolvedValue({
    auth: {
      getUser: async () => ({ data: { user: null } }),
      // Stubbed to fail so the action returns instead of running the whole
      // sign-up path; the sentinel proves the name gate let us through.
      signInAnonymously: async () => ({ data: { user: null }, error: { message: AUTH_STUB } }),
    },
  } as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>);

  vi.mocked(createServiceClient).mockReturnValue({
    // Each from() call starts a fresh filter set, as a real builder would.
    from: vi.fn(() => profilesBuilder({})),
  } as unknown as ReturnType<typeof createServiceClient>);
}

function form(name: string, pin: string) {
  const fd = new FormData();
  fd.set("display_name", name);
  fd.set("skill_level", "intermediate");
  fd.set("pin", pin);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  eqColumns = [];
  installMocks();
});

describe("RO-STRUCT: the pre-auth lookup never filters on the PIN", () => {
  it("RO-STRUCT-1: registering a taken name issues no eq('pin') filter", async () => {
    await signInAnonymously(form(REGISTERED_NAME, WRONG_PIN));

    // Any `.eq("pin", …)` before the caller is authenticated means the reply
    // depends on the submitted PIN, which is the oracle by construction.
    expect(eqColumns).not.toContain("pin");
  });
});

describe("RO-BLIND: right and wrong PINs are indistinguishable", () => {
  it("RO-BLIND-1: the correct PIN yields the same reply as a wrong one", async () => {
    const right = await signInAnonymously(form(REGISTERED_NAME, REGISTERED_PIN));
    eqColumns = [];
    const wrong = await signInAnonymously(form(REGISTERED_NAME, WRONG_PIN));

    expect(right?.success).toBe(false);
    expect(wrong?.success).toBe(false);
    // Byte-identical: any difference at all is a distinguisher an attacker can
    // automate over the 9,000-value space.
    expect(right?.error).toBe(wrong?.error);
  });

  it("RO-BLIND-2: the shared reply still routes a real returning player to Reconnect", async () => {
    // Blinding the oracle must not cost the legitimate flow its signpost — a
    // returning player mistyping their PIN needs to be told where to go.
    const r = await signInAnonymously(form(REGISTERED_NAME, WRONG_PIN));
    expect(r?.error).toMatch(/reconnect/i);
    // …while also covering the "someone else has this name" case.
    expect(r?.error).toMatch(/initial/i);
  });
});

describe("RO-FLAG: flagged profiles still block registration", () => {
  // Deliberate trade, pinned here so it can't drift silently.
  //
  // isNameTaken excludes `needs_rename = true` to mirror the partial unique
  // index, so relying on it ALONE would let a flagged returning player register
  // a second account under their own name — stranding their history behind a
  // ghost profile, which is permanent data loss. The name-only pre-check in
  // signInAnonymously exists to stop that. The cost is that a name held only by
  // a flagged duplicate is not claimable until that duplicate renames.
  //
  // Both cases below must behave IDENTICALLY — that is what keeps the fix from
  // reopening the PIN oracle.

  it("RO-FLAG-1: a flagged returner with the CORRECT pin cannot mint a ghost", async () => {
    const r = await signInAnonymously(form(FLAGGED_NAME, FLAGGED_PIN));

    expect(r?.error).toMatch(/already registered/i);
    // Never reached the sign-up call — no second account was created.
    expect(r?.error).not.toBe(AUTH_STUB);
  });

  it("RO-FLAG-2: the wrong pin against that name is indistinguishable", async () => {
    const right = await signInAnonymously(form(FLAGGED_NAME, FLAGGED_PIN));
    const wrong = await signInAnonymously(form(FLAGGED_NAME, WRONG_PIN));
    expect(right?.error).toBe(wrong?.error);
  });

  it("RO-MULTI-1: a name held by SEVERAL rows still blocks (the .limit(1) guard)", async () => {
    // Duplicate clusters are the normal state this codebase is built around, so
    // the name-only lookup routinely matches more than one row. maybeSingle()
    // ERRORS on multiple rows rather than returning the first, and the call site
    // ignores that error — so without `.limit(1)` the check silently fails open
    // and mints exactly the ghost it was added to prevent. Nothing else covers
    // this: isNameTaken skips flagged rows, so with an all-flagged cluster it
    // returns false and registration would sail through.
    const r = await signInAnonymously(form(CLUSTER_NAME, WRONG_PIN));

    expect(r?.error).toMatch(/already registered/i);
    expect(r?.error).not.toBe(AUTH_STUB);
  });

  it("RO-FLAG-3: an unheld name still registers normally", async () => {
    // Guards the obvious over-correction: blocking every name outright.
    const r = await signInAnonymously(form("CompletelyNewPlayer", WRONG_PIN));
    expect(r?.error).toBe(AUTH_STUB); // got past both name checks
  });
});
