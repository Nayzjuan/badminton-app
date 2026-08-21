// ============================================================
// OAuth profile provisioning — the service-role write on every sign-in (OP)
// ============================================================
// src/lib/oauth-provision.ts runs inside /auth/callback on EVERY Google
// sign-in, and it writes to `profiles` through createServiceClient — RLS
// bypassed. There is no policy underneath it and no return value that reveals
// what it did, so the only thing standing between a returning player and a
// silently rewritten identity is the shape of the code itself.
//
// Four properties carry the weight, and none of them is observable from the
// result object:
//
//   1. IDEMPOTENCE. Only an UNRESOLVED stub — needs_rename === true AND
//      collided_name === null — may be touched. A returning Google user, an
//      anonymous player who LINKED Google, and a duplicate-flagged anonymous
//      player all reach this code on every single sign-in. If the stub test
//      loosens, their display_name is overwritten with whatever Google
//      currently says their name is, on every login, forever. "The result said
//      requiresRename:false" does not prove that — only "NO update was issued"
//      does, so the negatives below count writes, not return values.
//
//   2. THE PIN IS NEVER OVERWRITTEN. `profile.pin ?? generatePin()` is the
//      whole of it. The PIN is the name+PIN reconnect fallback; re-minting it
//      locks a player out of their own recovery path with no error anywhere.
//      generatePin is mocked to a KNOWN value distinct from the fixture PIN so
//      "the existing pin was written" and "a fresh pin was written" cannot be
//      confused for one another.
//
//   3. THE TOCTOU FALLBACK. isNameTaken is a read; the partial unique index is
//      the arbiter. When another first-time sign-in claims the same derived
//      name in between, the unique-path UPDATE comes back with 23505 and the
//      module must fall back to the collision path — a SECOND update recording
//      collided_name — and return requiresRename:true. A suite that only walks
//      the happy path leaves that branch unexecuted, and it is the branch that
//      decides whether the user gets the /rename gate or a dead callback.
//
//   4. EVERY WRITE IS BOUND TO THE CALLER'S OWN id. Presence is not the
//      property: `.eq(...)` happening is not `.eq("id", userId)` happening, and
//      a swapped or hardcoded bound value makes exactly the same number of
//      calls. The mock records column=value pairs and the tests assert the
//      pair, because a mis-bound service-role update rewrites a stranger's row.
//
// Tests:
//   OP-1  a unique derived name is assigned, the flag cleared, the name returned
//   OP-2  a colliding name records collided_name and keeps the rename gate up
//   OP-3  (negative) a returning Google user is NOT written to at all
//   OP-4  (negative) an anonymous user who LINKED Google is NOT written to
//   OP-5  (negative) a duplicate-flagged anonymous user is NOT written to, and
//         still requires the rename gate
//   OP-6  (negative) a missing profile row writes nothing and derives nothing
//   OP-7  the existing PIN survives the unique path verbatim
//   OP-8  the existing PIN survives the collision path verbatim
//   OP-9  a null PIN is minted exactly once on the unique path
//   OP-10 (edge) a null PIN is minted on the collision path too
//   OP-11 (edge) an empty-string PIN is NOT a missing PIN
//   OP-12 the TOCTOU fallback issues a SECOND update recording collided_name
//   OP-13 (edge) the TOCTOU fallback reports no assignedName and never clears
//         the flag
//   OP-14 (negative) the collision write is bound to the caller's own id
//   OP-15 (negative) the unique write is bound to the caller's own id
//   OP-16 (negative) BOTH TOCTOU writes are bound to the caller's own id
//   OP-17 (negative) SECURITY — the id binding TRACKS the argument on the read
//         and on the write, rather than matching one fixture by coincidence
//   OP-18 (negative) the uniqueness check gets the module's own service client,
//         the derived name, and the caller's own id as the exclusion
//   OP-19 the profile read projects `pin`
//   OP-20 (edge) an empty-string collided_name is a recorded collision, not an
//         unresolved stub
//   OP-21 the derivation is handed the Google metadata verbatim
//   OP-22 (negative) only `profiles` is touched, and a resolved sign-in issues
//         exactly ONE write
//
// WHAT THIS FILE DOES NOT PROVE:
//   • That deriveDisplayName produces a schema-legal name from real Google
//     metadata — it is mocked here. That is tests/unit/oauth-name.test.ts.
//   • That isNameTaken agrees with the partial unique index about what "taken"
//     means, including the ILIKE escaping and the needs_rename=false domain —
//     mocked here, covered by tests/unit/dup-name.test.ts.
//   • That generatePin produces a 4-digit crypto-random value — mocked here.
//   • That /auth/callback calls this at the right moment, with the right
//     metadata, and routes on the result — that is the route, not this module;
//     see tests/unit/oauth-actions.test.ts and the callback E2E.
//   • That the DB actually raises 23505 on a duplicate. OP-12/13 simulate the
//     error the driver surfaces; the index itself is a migration concern.
//
// IDs: OP
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
// Each of the three collaborators below is its own unit with its own suite.
// Stubbing them lets this file assert WHETHER and HOW they were called without
// re-testing them — and, for generatePin, lets "a PIN was minted" be an exact
// value comparison instead of a shape guess.
vi.mock("@/lib/oauth-name", () => ({ deriveDisplayName: vi.fn() }));
vi.mock("@/lib/dup-name", () => ({ isNameTaken: vi.fn() }));
vi.mock("@/lib/pin", () => ({ generatePin: vi.fn() }));

import { createServiceClient } from "@/utils/supabase/service";
import { deriveDisplayName } from "@/lib/oauth-name";
import { isNameTaken } from "@/lib/dup-name";
import { generatePin } from "@/lib/pin";
import { ensureOAuthProfile } from "@/lib/oauth-provision";
import type { OAuthMeta } from "@/lib/oauth-name";

// Hex letters on purpose: an all-digit id is unchanged by a case transform, so
// OP-17 would still pass against a rewritten binding.
const USER_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER_USER_ID = "9999eeee-8888-4fff-9aaa-7777bbbb6666";

// These two MUST differ, for the same reason the two PINs below must. If
// DERIVED were byte-identical to META.full_name, no assertion in this file
// could tell "the value deriveDisplayName returned" apart from "the raw
// Google metadata field", and every write below — display_name,
// collided_name, the name handed to isNameTaken, the returned assignedName —
// could be re-sourced straight from meta.full_name with the suite still
// green. The apostrophe is the point: it is a character the real sanitiser
// strips, so DERIVED reads as a plausible derivation of META rather than an
// arbitrary rename.
const META: OAuthMeta = { full_name: "Miggy O'Reyes", name: null, email: "miggy@example.com" };
const DERIVED = "Miggy Reyes";

// These two MUST differ. If they matched, every "the existing PIN survived"
// assertion would also pass against a module that re-mints on every sign-in.
const EXISTING_PIN = "4821";
const GENERATED_PIN = "9137";

/** The row handle_new_user leaves behind for a first-time Google sign-in. */
const UNRESOLVED_STUB = { needs_rename: true, collided_name: null, pin: EXISTING_PIN };
/** A Google user who has signed in before — resolved, name is theirs. */
const RETURNING_USER = { needs_rename: false, collided_name: null, pin: EXISTING_PIN };
/** An anonymous player who linked Google — keeps the name they picked. */
const LINKED_ANON = { needs_rename: false, collided_name: "Miggy", pin: EXISTING_PIN };
/** An anonymous registrant already flagged as a duplicate, awaiting /rename. */
const FLAGGED_ANON = { needs_rename: true, collided_name: "Miggy", pin: EXISTING_PIN };

type Resp = { data?: unknown; error?: unknown };
type ReadCall = { table: string; ops: string[] };
type UpdateCall = { table: string; payload: Record<string, unknown>; ops: string[] };

/**
 * Service client that separates READS from WRITES and records, for each, the
 * column=value pairs it was bound to. Two things depend on that separation:
 * counting updates (the idempotence property is "zero updates", which a mock
 * that only logs table names cannot see) and asserting WHICH column carried
 * WHICH value (a swapped-argument mutant issues the same number of calls).
 *
 * `updateResults` is consumed positionally, so the TOCTOU tests can make the
 * FIRST update fail and the SECOND succeed.
 */
function serviceClient(opts: { profile?: Resp; updateResults?: Resp[] } = {}) {
  const profileResp: Resp = opts.profile ?? { data: null, error: null };
  const updateResults: Resp[] = opts.updateResults ?? [];

  const reads: ReadCall[] = [];
  const updates: UpdateCall[] = [];

  const from = vi.fn((table: string) => {
    const readRec: ReadCall = { table, ops: [] };

    const readChain: Record<string, unknown> = {};
    readChain.eq = (col: unknown, val: unknown) => {
      readRec.ops.push(`eq:${String(col)}=${String(val)}`);
      return readChain;
    };
    readChain.maybeSingle = () => Promise.resolve(profileResp);

    return {
      select: (cols: string) => {
        reads.push(readRec);
        readRec.ops.push(`select:${cols}`);
        return readChain;
      },
      update: (payload: Record<string, unknown>) => {
        const rec: UpdateCall = { table, payload, ops: [] };
        updates.push(rec);
        const resp: Resp = updateResults[updates.length - 1] ?? { data: null, error: null };

        const upChain: Record<string, unknown> = {};
        upChain.eq = (col: unknown, val: unknown) => {
          rec.ops.push(`eq:${String(col)}=${String(val)}`);
          return upChain;
        };
        upChain.then = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(resp).then(res, rej);
        return upChain;
      },
    };
  });

  return {
    from,
    reads,
    updates,
    tables: () => from.mock.calls.map((c) => c[0]),
  };
}

type MockService = ReturnType<typeof serviceClient>;

/** Installs `svc` and hands back the very reference the module will receive. */
function useServiceClient(svc: MockService): MockService {
  vi.mocked(createServiceClient).mockReturnValue(
    svc as unknown as ReturnType<typeof createServiceClient>
  );
  return svc;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Everything downstream is wired to SUCCEED by default: the name derives, the
  // uniqueness check passes, the PIN mints, the update returns no error. A
  // negative that asserts a step did not run is therefore proving the guard
  // standing in front of it, not a stub that was never going to work anyway.
  vi.mocked(deriveDisplayName).mockReturnValue(DERIVED);
  vi.mocked(isNameTaken).mockResolvedValue(false);
  vi.mocked(generatePin).mockReturnValue(GENERATED_PIN);
});

// ── The two resolved outcomes (the positive controls) ─────────
describe("OP: ensureOAuthProfile — resolving a first-time stub", () => {
  it("OP-1: a unique derived name is assigned, the flag cleared, and the name returned", async () => {
    const svc = useServiceClient(
      serviceClient({ profile: { data: UNRESOLVED_STUB, error: null } })
    );

    const result = await ensureOAuthProfile(USER_ID, META);

    expect(
      svc.updates.length,
      "a first-time Google sign-in with a unique name issued no write — the stub stays unresolved and the user is bounced to /rename forever"
    ).toBe(1);
    expect(
      svc.updates[0]?.payload,
      "the resolving write no longer assigns the name AND clears the flag AND blanks collided_name in one payload; leaving needs_rename true keeps the rename gate up on a name that is already unique"
    ).toEqual({
      display_name: DERIVED,
      needs_rename: false,
      collided_name: null,
      pin: EXISTING_PIN,
    });
    expect(
      result,
      "a uniquely-resolved sign-in must report the assigned name and NOT require a rename — the callback routes on exactly this"
    ).toEqual({ requiresRename: false, assignedName: DERIVED });
  });

  it("OP-2: a colliding derived name records collided_name and leaves the gate up", async () => {
    vi.mocked(isNameTaken).mockResolvedValue(true);
    const svc = useServiceClient(
      serviceClient({ profile: { data: UNRESOLVED_STUB, error: null } })
    );

    const result = await ensureOAuthProfile(USER_ID, META);

    expect(
      svc.updates.length,
      "a collision issued no write — the /rename screen has no stem to prefill and R1 has nothing to forbid"
    ).toBe(1);
    expect(
      svc.updates[0]?.payload,
      "the collision write changed shape — it must record the colliding name and ensure a PIN, and nothing else"
    ).toEqual({ collided_name: DERIVED, pin: EXISTING_PIN });
    expect(
      "display_name" in (svc.updates[0]?.payload ?? {}),
      "the collision path assigned display_name anyway — that is the write the partial unique index exists to reject, and it hands one player another player's name"
    ).toBe(false);
    expect(
      "needs_rename" in (svc.updates[0]?.payload ?? {}),
      "the collision path touched needs_rename — clearing it drops the /rename gate and strands the user on a name that is already taken"
    ).toBe(false);
    expect(
      result,
      "a collision must send the caller to the rename gate and must NOT report a name as assigned"
    ).toEqual({ requiresRename: true });
  });

  it("OP-21: the derivation is handed the Google metadata verbatim", async () => {
    useServiceClient(serviceClient({ profile: { data: UNRESOLVED_STUB, error: null } }));

    await ensureOAuthProfile(USER_ID, META);

    expect(
      vi.mocked(deriveDisplayName).mock.calls,
      "the OAuth metadata was not passed through untouched — a dropped or rebuilt meta object silently degrades every new user to the 'Player' fallback"
    ).toEqual([[META]]);
  });

  it("OP-19: the profile read projects pin", async () => {
    const svc = useServiceClient(
      serviceClient({ profile: { data: UNRESOLVED_STUB, error: null } })
    );

    await ensureOAuthProfile(USER_ID, META);

    expect(
      svc.reads[0]?.ops,
      "the read no longer projects needs_rename, collided_name and pin together — dropping `pin` makes profile.pin undefined, so the ?? mints a fresh PIN and overwrites the reconnect credential on every sign-in, with nothing anywhere reporting it"
    ).toContain("select:needs_rename, collided_name, pin");
  });

  it("OP-22 (negative): only `profiles` is touched, and a resolved sign-in issues exactly one write", async () => {
    const svc = useServiceClient(
      serviceClient({ profile: { data: UNRESOLVED_STUB, error: null } })
    );

    await ensureOAuthProfile(USER_ID, META);

    expect(
      svc.tables(),
      "the provisioner reached a table other than `profiles` — every one of its writes runs with RLS bypassed, so its blast radius is exactly the set of tables it names"
    ).toEqual(["profiles", "profiles"]);
    expect(
      svc.updates.length,
      "the resolved path issued more than one write — a second, unconditional write is the shape that re-mints PINs and re-derives names"
    ).toBe(1);
  });
});

// ── Idempotence: who may NOT be written to ────────────────────
// Every one of these rows arrives here on EVERY sign-in. The assertion is
// "zero updates", not "the result said no" — a module that returns the right
// answer while still issuing the write has already destroyed the name.
describe("OP: ensureOAuthProfile — no-op for anyone who is not an unresolved stub", () => {
  it("OP-3 (negative): a returning Google user is not written to at all", async () => {
    const svc = useServiceClient(serviceClient({ profile: { data: RETURNING_USER, error: null } }));

    const result = await ensureOAuthProfile(USER_ID, META);

    expect(
      svc.updates,
      "a returning Google user was written to — their chosen display_name is overwritten with Google's current full_name on every single sign-in"
    ).toEqual([]);
    expect(
      vi.mocked(deriveDisplayName),
      "the resolved-profile guard runs AFTER the derivation instead of before it; the write it protects is one line away"
    ).not.toHaveBeenCalled();
    expect(
      vi.mocked(isNameTaken),
      "a resolved profile still burned a uniqueness read — the guard is not sitting in front of the work it is meant to skip"
    ).not.toHaveBeenCalled();
    expect(
      result,
      "a returning, resolved user was told they need to rename — the callback would divert them to /rename on every login"
    ).toEqual({ requiresRename: false });
  });

  it("OP-4 (negative): an anonymous user who LINKED Google keeps their name", async () => {
    const svc = useServiceClient(serviceClient({ profile: { data: LINKED_ANON, error: null } }));

    const result = await ensureOAuthProfile(USER_ID, META);

    expect(
      svc.updates,
      "a linked anonymous player was written to — the name they registered under is replaced by their Google name, breaking name+PIN reconnect and every leaderboard reference"
    ).toEqual([]);
    expect(
      vi.mocked(generatePin),
      "a linked profile reached the PIN branch — nothing past the resolved-profile guard should execute for them"
    ).not.toHaveBeenCalled();
    expect(result, "a resolved linked profile was reported as needing a rename").toEqual({
      requiresRename: false,
    });
  });

  it("OP-5 (negative): a duplicate-flagged anonymous user is untouched and still needs renaming", async () => {
    const svc = useServiceClient(serviceClient({ profile: { data: FLAGGED_ANON, error: null } }));

    const result = await ensureOAuthProfile(USER_ID, META);

    expect(
      svc.updates,
      "a duplicate-flagged anonymous player was written to — needs_rename=true is NOT enough to make a row a stub, and this write clobbers the collided_name the /rename screen prefills from"
    ).toEqual([]);
    expect(
      vi.mocked(deriveDisplayName),
      "a flagged anonymous profile was re-derived from Google metadata; the collided_name check is not guarding the derivation"
    ).not.toHaveBeenCalled();
    expect(
      result,
      "a player still carrying a duplicate flag was told no rename was required — the callback lets them into the app under a duplicate name"
    ).toEqual({ requiresRename: true });
  });

  it("OP-20 (edge): an empty-string collided_name is a recorded collision, not an unresolved stub", async () => {
    // Present-but-falsy. The module compares against null on purpose; a
    // truthiness test would reclassify this row as an unresolved stub and
    // overwrite the name of somebody already sitting at the /rename gate.
    const svc = useServiceClient(
      serviceClient({
        profile: {
          data: { needs_rename: true, collided_name: "", pin: EXISTING_PIN },
          error: null,
        },
      })
    );

    const result = await ensureOAuthProfile(USER_ID, META);

    expect(
      svc.updates,
      "'unresolved stub' is being decided by truthiness rather than by an explicit null, so a flagged row with a blank collided_name gets re-derived and rewritten"
    ).toEqual([]);
    expect(result, "a flagged row was reported as not needing a rename").toEqual({
      requiresRename: true,
    });
  });

  it("OP-6 (negative): a missing profile row writes nothing and derives nothing", async () => {
    const svc = useServiceClient(serviceClient({ profile: { data: null, error: null } }));

    const result = await ensureOAuthProfile(USER_ID, META);

    expect(
      svc.updates,
      "a sign-in with no profile row issued a write — an UPDATE against an id that does not exist is a silent no-op today, but the guard is what stops a future upsert from provisioning an unauthenticated id"
    ).toEqual([]);
    expect(
      vi.mocked(deriveDisplayName),
      "the missing-row guard runs after the derivation; the callback should bail immediately, not compute a name for a row that is not there"
    ).not.toHaveBeenCalled();
    expect(
      vi.mocked(isNameTaken),
      "a missing profile still burned a uniqueness read"
    ).not.toHaveBeenCalled();
    expect(
      result,
      "a missing profile row must degrade to 'nothing to do' — reporting requiresRename would trap the user on /rename with no row to rename"
    ).toEqual({ requiresRename: false });
  });
});

// ── The PIN is a credential, not a field ──────────────────────
describe("OP: ensureOAuthProfile — the reconnect PIN is never overwritten", () => {
  it("OP-7: an existing PIN survives the unique path verbatim", async () => {
    const svc = useServiceClient(
      serviceClient({ profile: { data: UNRESOLVED_STUB, error: null } })
    );

    await ensureOAuthProfile(USER_ID, META);

    expect(
      svc.updates[0]?.payload.pin,
      "the resolving write replaced an existing reconnect PIN — the player's name+PIN recovery stops working and nothing tells them or us"
    ).toBe(EXISTING_PIN);
    expect(
      vi.mocked(generatePin),
      "a PIN was minted for a profile that already had one; ?? is being evaluated eagerly or has been replaced by an unconditional call"
    ).not.toHaveBeenCalled();
  });

  it("OP-8: an existing PIN survives the collision path verbatim", async () => {
    vi.mocked(isNameTaken).mockResolvedValue(true);
    const svc = useServiceClient(
      serviceClient({ profile: { data: UNRESOLVED_STUB, error: null } })
    );

    await ensureOAuthProfile(USER_ID, META);

    expect(
      svc.updates[0]?.payload.pin,
      "the collision write replaced an existing reconnect PIN — a user sent to the rename gate loses their recovery credential on the way there"
    ).toBe(EXISTING_PIN);
    expect(
      vi.mocked(generatePin),
      "the collision path minted a PIN over an existing one"
    ).not.toHaveBeenCalled();
  });

  it("OP-9: a null PIN is minted exactly once on the unique path", async () => {
    const svc = useServiceClient(
      serviceClient({
        profile: { data: { needs_rename: true, collided_name: null, pin: null }, error: null },
      })
    );

    await ensureOAuthProfile(USER_ID, META);

    expect(
      svc.updates[0]?.payload.pin,
      "an OAuth account was provisioned with no reconnect PIN — it has no name+PIN fallback, so a lost Google session is a lockout"
    ).toBe(GENERATED_PIN);
    expect(
      vi.mocked(generatePin).mock.calls.length,
      "generatePin ran more or fewer than once for a pinless stub — minting twice means the value written is not the value the user was ever shown"
    ).toBe(1);
  });

  it("OP-10 (edge): a null PIN is minted on the collision path too", async () => {
    vi.mocked(isNameTaken).mockResolvedValue(true);
    const svc = useServiceClient(
      serviceClient({
        profile: { data: { needs_rename: true, collided_name: null, pin: null }, error: null },
      })
    );

    await ensureOAuthProfile(USER_ID, META);

    expect(
      svc.updates[0]?.payload.pin,
      "a user diverted to the rename gate was left with no PIN — the collision branch must ensure the credential exists exactly as the unique branch does"
    ).toBe(GENERATED_PIN);
  });

  it("OP-11 (edge): an empty-string PIN is not a missing PIN", async () => {
    // `?? ` falls back on null/undefined only. Under `||` this row would be
    // re-minted, which is the same defect as OP-7 wearing a different mask.
    const svc = useServiceClient(
      serviceClient({
        profile: { data: { needs_rename: true, collided_name: null, pin: "" }, error: null },
      })
    );

    await ensureOAuthProfile(USER_ID, META);

    expect(
      svc.updates[0]?.payload.pin,
      "the PIN fallback is triggering on falsiness rather than on absence, so any falsy-but-present stored PIN is silently replaced"
    ).toBe("");
    expect(
      vi.mocked(generatePin),
      "a PIN was minted for a profile whose pin column was present"
    ).not.toHaveBeenCalled();
  });
});

// ── The TOCTOU fallback: the branch a happy-path suite never runs ──
describe("OP: ensureOAuthProfile — the unique-index race", () => {
  it("OP-12: an errored unique write falls back to a SECOND, collision write", async () => {
    const svc = useServiceClient(
      serviceClient({
        profile: { data: UNRESOLVED_STUB, error: null },
        // 23505 from the partial unique index: another first-time sign-in
        // claimed this exact name between isNameTaken and this write.
        updateResults: [
          { data: null, error: { code: "23505", message: "duplicate key value" } },
          { data: null, error: null },
        ],
      })
    );

    const result = await ensureOAuthProfile(USER_ID, META);

    expect(
      svc.updates.length,
      "the losing side of a name race issued no fallback write — the profile keeps needs_rename=true with collided_name still null, so the /rename screen has no stem and the user retries into the same race forever"
    ).toBe(2);
    expect(
      svc.updates[1]?.payload,
      "the TOCTOU fallback did not write the same payload the collision path writes — the rename gate depends on collided_name being recorded and on a PIN existing"
    ).toEqual({ collided_name: DERIVED, pin: EXISTING_PIN });
    expect(
      result,
      "a user who lost the name race was told the name was assigned to them — the callback lets them in under a name the database refused to give them"
    ).toEqual({ requiresRename: true });
  });

  it("OP-13 (edge): the fallback reports no assignedName and never clears the flag", async () => {
    const svc = useServiceClient(
      serviceClient({
        profile: { data: UNRESOLVED_STUB, error: null },
        updateResults: [{ data: null, error: { code: "23505", message: "duplicate key" } }],
      })
    );

    const result = await ensureOAuthProfile(USER_ID, META);

    expect(
      "assignedName" in result,
      "a failed assignment still reported an assignedName — the callback would greet the user by a name that was never written"
    ).toBe(false);
    expect(
      "needs_rename" in (svc.updates[1]?.payload ?? {}),
      "the fallback write touched needs_rename; clearing it after a rejected assignment drops the gate on a row whose display_name is still the stub"
    ).toBe(false);
    expect(
      "display_name" in (svc.updates[1]?.payload ?? {}),
      "the fallback retried the same display_name the index had just rejected"
    ).toBe(false);
  });
});

// ── Every write is bound to the caller's own id ───────────────
// `.eq(...)` happening is not `.eq("id", userId)` happening: a swapped or
// hardcoded bound value issues exactly the same number of calls. These assert
// the PAIR.
describe("OP: ensureOAuthProfile — service-role writes are bound to the caller", () => {
  it("OP-15 (negative): the unique-path write is bound to the caller's own id", async () => {
    const svc = useServiceClient(
      serviceClient({ profile: { data: UNRESOLVED_STUB, error: null } })
    );

    await ensureOAuthProfile(USER_ID, META);

    expect(
      svc.updates[0]?.ops,
      "the RLS-bypassing assignment was not bound to id = the caller — an unbound or mis-bound update rewrites the display_name and PIN of rows belonging to other players"
    ).toEqual([`eq:id=${USER_ID}`]);
  });

  it("OP-14 (negative): the collision write is bound to the caller's own id", async () => {
    vi.mocked(isNameTaken).mockResolvedValue(true);
    const svc = useServiceClient(
      serviceClient({ profile: { data: UNRESOLVED_STUB, error: null } })
    );

    await ensureOAuthProfile(USER_ID, META);

    expect(
      svc.updates[0]?.ops,
      "the collision write was not bound to id = the caller — it stamps collided_name and a PIN onto somebody else's row"
    ).toEqual([`eq:id=${USER_ID}`]);
  });

  it("OP-16 (negative): both TOCTOU writes are bound to the caller's own id", async () => {
    const svc = useServiceClient(
      serviceClient({
        profile: { data: UNRESOLVED_STUB, error: null },
        updateResults: [{ data: null, error: { code: "23505", message: "duplicate key" } }],
      })
    );

    await ensureOAuthProfile(USER_ID, META);

    expect(
      svc.updates.map((u) => u.ops),
      "a write on the race-loss path was not bound to id = the caller; the fallback is the least-exercised branch in the file and the easiest place for the binding to be dropped"
    ).toEqual([[`eq:id=${USER_ID}`], [`eq:id=${USER_ID}`]]);
  });

  it("OP-17 (negative): the id binding tracks the argument, on the read and the write", async () => {
    // A second, unrelated id. If either binding were pinned to a constant — or
    // to the id of the row that was read rather than the caller — the fixture
    // in every other test would still satisfy them.
    const svc = useServiceClient(
      serviceClient({ profile: { data: UNRESOLVED_STUB, error: null } })
    );

    await ensureOAuthProfile(OTHER_USER_ID, META);

    expect(
      svc.reads[0]?.ops,
      "the profile read was not bound to the id it was asked about — the module would decide a stranger's row is the caller's stub"
    ).toContain(`eq:id=${OTHER_USER_ID}`);
    expect(
      svc.updates[0]?.ops,
      "the write did not follow the caller's id — the binding is fixed rather than derived from the argument, so every sign-in writes the same row"
    ).toEqual([`eq:id=${OTHER_USER_ID}`]);
    expect(
      vi.mocked(isNameTaken).mock.calls[0]?.[2],
      "the uniqueness exclusion did not follow the caller's id"
    ).toBe(OTHER_USER_ID);
  });

  it("OP-18 (negative): the uniqueness check gets the module's own client, name and exclusion", async () => {
    const svc = useServiceClient(
      serviceClient({ profile: { data: UNRESOLVED_STUB, error: null } })
    );

    await ensureOAuthProfile(USER_ID, META);

    const call = vi.mocked(isNameTaken).mock.calls[0];
    expect(
      call?.[0],
      "the uniqueness check was handed a different client than the one this module created — an anon/RLS client cannot see other clubs' rows, so every name would read as available"
    ).toBe(svc as unknown as Parameters<typeof isNameTaken>[0]);
    expect(
      call?.[1],
      "the uniqueness check was run against a name other than the one about to be written — the check and the write must agree or the index decides alone"
    ).toBe(DERIVED);
    expect(
      call?.[2],
      "the caller's own row was not excluded from the uniqueness check — a stub would collide with itself and every new Google user would be pushed to /rename"
    ).toBe(USER_ID);
  });
});
