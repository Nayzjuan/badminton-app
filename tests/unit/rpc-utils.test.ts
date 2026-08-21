// ============================================================
// isRpcNotFound — the switch between "atomic RPC" and "JS fallback" (RU)
// ============================================================
// Nine lines, and it decides which of two DIFFERENT implementations runs.
// Migrations in this repo are applied BY HAND, so every action that wraps a
// new atomic RPC ships ahead of its function existing in the database. The
// bridge is this predicate: PGRST202 ("could not find the function") means the
// migration is not applied yet, so take the non-atomic JS path; anything else
// means the function IS there and answered with a real error, so surface it.
//
// Call sites: queue.ts (three, one of them NEGATED — `if (!isRpcNotFound(...))`
// picks the domain-error branch), match-drafts.ts (two), notifications.ts (one,
// OR-ed with a missing-table probe). Recompute with:
//     rg -n 'isRpcNotFound\(' src/
//
// Both directions of a wrong answer are shipping bugs, and neither is loud:
//
//   TOO PERMISSIVE (a real domain error mistaken for PGRST202) silently runs
//   the fallback after the RPC already refused. The fallback paths are the
//   pre-atomic ones — queue.ts's own comment calls its TOCTOU risk accepted
//   "once deployed" — so a broadened match reintroduces the exact race the
//   RPC was written to close, and the caller still sees success.
//
//   TOO STRICT (PGRST202 not recognised) turns a not-yet-applied migration
//   into a hard user-facing failure, on a branch whose whole purpose is that
//   merging ships TypeScript only and the schema arrives later by hand.
//
// So the property under test is EXACT EQUALITY ON `code`: not a substring,
// not case-insensitive, not the message text, and never a throw on a null
// error — `null` is the ordinary shape of "the RPC succeeded".
//
//   RU-1  PGRST202 is the not-found signal
//   RU-2  (negative) a different PostgREST code is not
//   RU-3  (edge) an error object carrying no code at all is not
//   RU-4  (edge) null does not throw, and is not the not-found signal
//   RU-5  (edge) an explicitly undefined code is not
//   RU-6  (negative) the comparison is case-SENSITIVE
//   RU-7  (negative) the comparison is exact — prefix, suffix and padded
//         variants are all rejected
//   RU-8  the verdict is decided by `code` alone; sibling fields cannot
//         change it, in either direction
//   RU-9  (negative) an error whose MESSAGE names PGRST202 under a different
//         code is NOT the not-found signal
//   RU-10 (edge) an undefined argument does not throw at runtime
//
// WHAT THIS FILE DOES NOT PROVE
//   - That any caller branches correctly on the verdict. The fallbacks
//     themselves are covered where they live: tests/unit/queue-actions.test.ts
//     (join_queue), tests/unit/published-event.test.ts and
//     tests/unit/publish-held-guard.test.ts (the publish RPCs).
//   - That PGRST202 is the code PostgREST actually emits for a missing
//     function. That is a PostgREST contract; the integration lane observes it
//     against a real database (tests/integration/rls-edge-cases.test.ts).
//   - notifications.ts's second arm. `isMissingNoticeTable` is a different
//     module and is not exercised here.
//
// IDs: RU
// ============================================================

import { describe, it, expect } from "vitest";
import { isRpcNotFound } from "@/lib/rpc-utils";

/**
 * The declared parameter type is `{ code?: string } | null`. Building fixtures
 * through this alias (rather than as inline literals) is what lets a test hand
 * the predicate a realistic PostgrestError — message, details, hint — without
 * tripping excess-property checking on an object literal argument.
 */
type RpcError = {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
};

const NOT_FOUND = "PGRST202";

describe("isRpcNotFound — the not-found signal", () => {
  it("RU-1: PGRST202 is recognised as the missing-function signal", () => {
    const err: RpcError = { code: NOT_FOUND };

    expect(
      isRpcNotFound(err),
      "PGRST202 is no longer recognised — every action that wraps a new atomic RPC now hard-fails until the migration is hand-applied, which is precisely the window the fallback exists to cover"
    ).toBe(true);
  });

  it("RU-8: the verdict is decided by `code` alone, in both directions", () => {
    // A real PostgREST payload, not a bare {code}. The sibling fields must be
    // inert: neither able to produce a false positive nor to suppress a true one.
    const realistic: RpcError = {
      code: NOT_FOUND,
      message: "Could not find the function public.join_queue(p_session_id) in the schema cache",
      details: null,
      hint: "Perhaps you meant to call the function public.join_queue",
    };
    expect(
      isRpcNotFound(realistic),
      "a fully-populated PostgREST error carrying PGRST202 was not recognised — the predicate is keying on something other than `code`, so the shape the database actually returns misses the fallback"
    ).toBe(true);

    const decoy: RpcError = {
      code: "23505",
      message: "Could not find the function public.join_queue(p_session_id) in the schema cache",
      details: "Key (session_id, player_id) already exists.",
      hint: null,
    };
    expect(
      isRpcNotFound(decoy),
      "a non-PGRST202 error was classified as not-found because its sibling fields looked the part — the caller would run the pre-atomic JS fallback after the RPC had already refused the write"
    ).toBe(false);
  });
});

describe("isRpcNotFound — negatives", () => {
  it("RU-2 (negative): a different PostgREST or Postgres code is not the signal", () => {
    for (const code of ["PGRST116", "PGRST301", "23505", "42501", "42883", "P0001"]) {
      const err: RpcError = { code, message: "boom" };
      expect(
        isRpcNotFound(err),
        `code ${code} was treated as "function does not exist": the caller drops to the pre-atomic JS fallback and re-runs work the RPC already rejected, reopening the TOCTOU race the RPC was written to close`
      ).toBe(false);
    }
  });

  it("RU-6 (negative): the comparison is case-sensitive", () => {
    for (const code of ["pgrst202", "Pgrst202", "PGRSt202"]) {
      const err: RpcError = { code };
      expect(
        isRpcNotFound(err),
        `${code} was accepted: the predicate has been case-folded, so any future code that differs from PGRST202 only in case would silently route real errors into the fallback path`
      ).toBe(false);
    }
  });

  it("RU-7 (negative): the comparison is exact, not a substring or prefix match", () => {
    for (const code of ["PGRST2020", "PGRST20", "XPGRST202", " PGRST202", "PGRST202 "]) {
      const err: RpcError = { code };
      expect(
        isRpcNotFound(err),
        `"${code}" was accepted as PGRST202 — the equality check has been relaxed to a substring/prefix test, and a future PGRST2xx code would then be misread as a missing migration and swallowed by the fallback`
      ).toBe(false);
    }
  });

  it("RU-9 (negative): PGRST202 in the MESSAGE under another code is not the signal", () => {
    const err: RpcError = {
      code: "42501",
      message: "permission denied for function; unrelated to PGRST202",
    };

    expect(
      isRpcNotFound(err),
      "the predicate matched on the error's prose rather than its code — a permission failure would be mistaken for an unapplied migration and the caller would run the fallback with the same missing grant"
    ).toBe(false);
  });
});

describe("isRpcNotFound — absent and empty inputs", () => {
  it("RU-3 (edge): an error object with no code at all is not the signal", () => {
    const err: RpcError = { message: "network error" };

    expect(
      isRpcNotFound(err),
      "a codeless error was classified as not-found — transport failures carry no code, and treating them as an unapplied migration runs the non-atomic fallback on every network blip"
    ).toBe(false);
  });

  it("RU-5 (edge): an explicitly undefined code is not the signal", () => {
    const err: RpcError = { code: undefined, message: "network error" };

    expect(
      isRpcNotFound(err),
      'an error whose code is present-but-undefined was classified as not-found; `undefined === "PGRST202"` must stay false however the key got there'
    ).toBe(false);
  });

  it("RU-4 (edge): null is not the signal, and does not throw", () => {
    // null is the ORDINARY shape here: `const { error } = await rpc(...)`
    // yields null on success, and queue.ts:624 evaluates `!isRpcNotFound(err)`
    // on that value. A throw would surface as an unhandled server-action
    // rejection, which the architecture guardrails forbid outright.
    expect(
      () => isRpcNotFound(null),
      "isRpcNotFound threw on a null error — that is the success case of every RPC call in the codebase, so this crashes the action instead of returning the { success } envelope the callers must always produce"
    ).not.toThrow();

    expect(
      isRpcNotFound(null),
      "a successful RPC (error === null) was reported as a missing function — the caller would run the JS fallback in addition to the atomic RPC that had already applied the write, double-applying it"
    ).toBe(false);
  });

  it("RU-10 (edge): an undefined argument does not throw at runtime", () => {
    // The declared parameter type excludes undefined, so this probes the
    // RUNTIME contract only: the optional chain has to short-circuit rather
    // than dereference. Kept because a caller reading `err` off a destructured
    // response can hand over undefined without tsc ever seeing it.
    const absent = undefined as unknown as { code?: string } | null;

    expect(
      () => isRpcNotFound(absent),
      "isRpcNotFound dereferenced an undefined error — the `?.` short-circuit was removed, and any caller whose error variable is undefined rather than null now throws out of a server action"
    ).not.toThrow();

    expect(
      isRpcNotFound(absent),
      "an undefined error was reported as a missing function, which would run the fallback path on a call that never reported a failure at all"
    ).toBe(false);
  });
});
