// ============================================================
// getClientIp — the IP arm of the credential-guessing limiters (CI)
// ============================================================
// src/lib/client-ip.ts produces the `p_ip` argument for two fail-closed
// rate-limit RPCs: `reconnect_record_and_check` (auth.ts `reconnectPlayer`)
// and `cojoin_record_and_check` (sessions.ts `joinAsCoOrganizer`). It is a
// SECURITY input, not a diagnostic one.
//
// reconnectPlayer is the reason this file is dangerous. It runs BEFORE the
// caller has any identity at all — signInAnonymously is a live path, so an
// attacker can mint a fresh subject for every guess and the subject arm of the
// limiter never fires. The IP arm is the only arm that bites there, and this
// function is the whole of it. Three distinct ways it can go wrong, each with
// a different production shape:
//
//   1. WRONG HOP. `x-forwarded-for` is a comma-separated chain. The leftmost
//      entry is the connecting client; the rest are proxies. Return the
//      rightmost and every caller behind one Vercel edge collapses into a
//      single bucket — the first attacker to trip the limit locks out the
//      whole venue, and the guessing continues from any other edge.
//   2. CONSTANT VALUE. Return the same string (or "") for every caller and
//      the limiter has one global bucket. Return null for every caller and
//      the IP arm silently stops biting: null is the documented "no request
//      scope" signal, so nothing downstream reports an outage.
//   3. THROWING. Both callers treat any gate error as a DENIAL. An exception
//      escaping this function does not degrade the limiter, it takes reconnect
//      offline for everybody.
//
// The tests below therefore pin the PARSE (which hop, and how it is trimmed),
// the FALLBACK ORDER (and that the fallback header is not even read when it
// must not be), and the degrade-to-null contract of the catch.
//
//   CI-1  a multi-hop x-forwarded-for resolves to the LEFTMOST hop
//   CI-2  (edge) whitespace around the comma separators is stripped
//   CI-3  a single-value x-forwarded-for is the hop, verbatim
//   CI-4  x-real-ip is used when x-forwarded-for is ABSENT
//   CI-5  (edge) x-forwarded-for present-but-EMPTY also falls back to x-real-ip
//   CI-6  (negative) x-real-ip is never even READ when x-forwarded-for is
//         usable — with a positive control proving that arm works at all
//   CI-7  (negative) neither header present -> null, not a placeholder
//   CI-8  (edge) headers() throwing outside a request scope degrades to null
//   CI-9  (edge) a REJECTED headers() promise degrades to null the same way
//   CI-10 (edge) a whitespace-only x-forwarded-for yields the EMPTY STRING —
//         it is truthy, so the x-real-ip fallback is skipped
//   CI-11 (negative) only the two documented header names are consulted
//   CI-12 (edge) an IPv6 hop survives intact — the split is on "," not ":"
//
// WHAT THIS FILE DOES NOT PROVE
//   - That the leftmost hop is TRUSTWORTHY. On Vercel the platform proxy
//     rewrites x-forwarded-for from the real connecting socket, so a
//     caller-supplied value cannot survive to position 0. That is a property
//     of the deployment, not of this code, and no unit test can assert it.
//   - That the callers do the right thing with a null IP. reconnectPlayer's
//     gate wiring (including the null-IP path, since those suites have no
//     request scope) is covered by tests/unit/reconnect-throttle.test.ts.
//   - That the SQL side buckets correctly. `reconnect_record_and_check` and
//     `cojoin_record_and_check` are database functions; their windowing lives
//     in the migration, not here.
//
// IDs: CI
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// The mocked next/headers is driven per test through this holder. vi.hoisted
// keeps it initialised before the (hoisted) vi.mock factory can close over it.
// The SUT imports next/headers DYNAMICALLY, inside the function, so the
// factory does not run until the first getClientIp() call.
const scope = vi.hoisted(() => {
  const s: {
    /** null = no request scope, so headers() throws exactly as Next does. */
    impl: (() => Promise<{ get(name: string): string | null }>) | null;
    /** Every header name getClientIp asked for, in call order. */
    reads: string[];
  } = { impl: null, reads: [] };
  return s;
});

vi.mock("next/headers", () => ({
  headers: () => {
    if (!scope.impl) {
      throw new Error("`headers` was called outside a request scope.");
    }
    return scope.impl();
  },
}));

import { getClientIp } from "@/lib/client-ip";

// ── Scope helpers ─────────────────────────────────────────────

/**
 * Install a request scope carrying `bag`. Lookups are case-insensitive and
 * absent names answer null, which is what the WHATWG Headers object returned
 * by next/headers does — a mock that matched case-sensitively would redden on
 * a header-name re-casing that production would not even notice.
 */
function withHeaders(bag: Record<string, string>): void {
  const norm = new Map(Object.entries(bag).map(([k, v]) => [k.toLowerCase(), v]));
  scope.impl = async () => ({
    get(name: string): string | null {
      scope.reads.push(name.toLowerCase());
      const v = norm.get(name.toLowerCase());
      return v === undefined ? null : v;
    },
  });
}

/** No request scope: headers() throws synchronously, as it does in Next. */
function withNoRequestScope(): void {
  scope.impl = null;
}

/** A request scope whose headers() rejects rather than throwing inline. */
function withRejectingScope(): void {
  scope.impl = () => Promise.reject(new Error("dynamic server usage"));
}

beforeEach(() => {
  scope.impl = null;
  scope.reads = [];
});

// ── Tests ─────────────────────────────────────────────────────

describe("getClientIp — leftmost-hop parse", () => {
  it("CI-1: a multi-hop x-forwarded-for resolves to the leftmost hop", async () => {
    withHeaders({
      "x-forwarded-for": "203.0.113.7,70.41.3.18,150.172.238.178",
      "x-real-ip": "70.41.3.18",
    });

    expect(
      await getClientIp(),
      "the rate limiter is keyed on a PROXY hop rather than the connecting client — every caller behind that hop shares one bucket, so one attacker locks out an entire venue while their own guessing continues from any other edge"
    ).toBe("203.0.113.7");
  });

  it("CI-2 (edge): whitespace around the comma separators is stripped from the hop", async () => {
    withHeaders({ "x-forwarded-for": "  203.0.113.7 , 70.41.3.18 " });

    expect(
      await getClientIp(),
      'the hop reached the limiter with surrounding whitespace — " 203.0.113.7" and "203.0.113.7" are different bucket keys, so a caller gets a fresh allowance from nothing more than the padding a proxy happens to add'
    ).toBe("203.0.113.7");
  });

  it("CI-3: a single-value x-forwarded-for is the hop, verbatim", async () => {
    withHeaders({ "x-forwarded-for": "198.51.100.42" });

    expect(
      await getClientIp(),
      "a single-hop header — the common case behind one proxy — no longer yields the caller IP, so the IP arm of the limiter stops biting for most real traffic"
    ).toBe("198.51.100.42");
  });

  it("CI-12 (edge): an IPv6 hop survives intact", async () => {
    withHeaders({ "x-forwarded-for": "2001:db8::8a2e:370:7334, 203.0.113.7" });

    expect(
      await getClientIp(),
      "an IPv6 caller was truncated — the chain is split on the comma, never on the colon, or every IPv6 client collapses into one shared bucket"
    ).toBe("2001:db8::8a2e:370:7334");
  });
});

describe("getClientIp — fallback order", () => {
  it("CI-4: x-real-ip is used when x-forwarded-for is absent", async () => {
    withHeaders({ "x-real-ip": "198.51.100.9" });

    expect(
      await getClientIp(),
      "a deployment that only sets x-real-ip now reports no IP at all, which silently disables the IP arm of both limiters — and for reconnectPlayer that is the ONLY arm, since an anonymous caller can mint a new subject per guess"
    ).toBe("198.51.100.9");
  });

  it("CI-5 (edge): x-forwarded-for present-but-empty falls back to x-real-ip", async () => {
    withHeaders({ "x-forwarded-for": "", "x-real-ip": "198.51.100.9" });

    // The source gates on truthiness (`if (xff)`), not on presence, so an
    // empty header is treated as absent. Pinning it stops a rewrite to an
    // `!== null` presence check, which would return "" for these callers and
    // funnel all of them into one shared bucket.
    expect(
      await getClientIp(),
      "an empty x-forwarded-for no longer falls through to x-real-ip — every caller sent by a proxy that emits the header empty now shares one bucket keyed on the empty string, so they rate-limit each other"
    ).toBe("198.51.100.9");
  });

  it("CI-10 (edge): a whitespace-only x-forwarded-for yields the empty string", async () => {
    withHeaders({ "x-forwarded-for": "   ", "x-real-ip": "198.51.100.9" });

    // Documented sharp edge, NOT an endorsement: "   " is truthy, so the
    // fallback is skipped and trim() empties it. If this is ever changed to
    // fall through to x-real-ip, change this test deliberately rather than
    // discovering the shift from a limiter that started bucketing differently.
    expect(
      await getClientIp(),
      "the whitespace-only x-forwarded-for branch changed behaviour — this test records what the source does today (the header is truthy, so no fallback, and trim() empties it); a change here silently repartitions the limiter's buckets"
    ).toBe("");
  });

  it("CI-6 (negative): x-real-ip is never read when x-forwarded-for is usable", async () => {
    // POSITIVE CONTROL first: the same x-real-ip value, with x-forwarded-for
    // absent, IS returned. Without this half, a getClientIp() that had simply
    // stopped reading x-real-ip entirely would satisfy the negative below.
    withHeaders({ "x-real-ip": "198.51.100.9" });
    expect(
      await getClientIp(),
      "positive control failed: the x-real-ip arm does not work at all, so the negative half of this test proves nothing"
    ).toBe("198.51.100.9");
    expect(
      scope.reads,
      "positive control failed: x-real-ip was never consulted even when it was the only header present"
    ).toContain("x-real-ip");

    scope.reads = [];
    withHeaders({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.9" });

    expect(
      await getClientIp(),
      "x-forwarded-for no longer wins over x-real-ip — the two headers disagree on real traffic, and preferring the wrong one changes which caller the limiter charges"
    ).toBe("203.0.113.7");
    expect(
      scope.reads,
      "x-real-ip was READ even though x-forwarded-for already answered: the fallback is doing work on the primary path, so a later edit can start preferring it and the return value alone would not notice"
    ).not.toContain("x-real-ip");
    expect(scope.reads, "x-forwarded-for was not the header consulted first").toEqual([
      "x-forwarded-for",
    ]);
  });

  it("CI-7 (negative): neither header present yields null, not a placeholder", async () => {
    withHeaders({});

    expect(
      await getClientIp(),
      "a scope with no IP headers returned something other than null — the callers pass this straight to p_ip, and any non-null placeholder becomes a shared bucket in which every header-less caller rate-limits every other one"
    ).toBeNull();
  });

  it("CI-11 (negative): only the two documented header names are consulted", async () => {
    // POSITIVE CONTROL: with the real name present the function answers, so
    // the look-alike assertions below are about NAME SELECTION, not about a
    // function that has stopped working.
    withHeaders({
      "x-forwarded-for": "203.0.113.7",
      "x-forwarded-host": "evil.example",
      forwarded: "for=198.51.100.1",
      "true-client-ip": "198.51.100.2",
      "cf-connecting-ip": "198.51.100.3",
    });

    expect(
      await getClientIp(),
      "positive control failed: the documented x-forwarded-for header was not used even though it was present"
    ).toBe("203.0.113.7");
    expect(
      scope.reads,
      "getClientIp consulted a header this module does not document — on Vercel only x-forwarded-for and x-real-ip are rewritten by the platform proxy, so any other name is caller-supplied and lets an attacker choose their own rate-limit bucket"
    ).toEqual(["x-forwarded-for"]);

    // And with the documented headers gone, the look-alikes are NOT a fallback.
    scope.reads = [];
    withHeaders({ "true-client-ip": "198.51.100.2", "cf-connecting-ip": "198.51.100.3" });

    expect(
      await getClientIp(),
      "a caller-supplied look-alike header was accepted as the client IP — an attacker sets it per request and every guess lands in a bucket of its own"
    ).toBeNull();
  });
});

describe("getClientIp — degrades instead of throwing", () => {
  it("CI-8 (edge): headers() throwing outside a request scope degrades to null", async () => {
    withNoRequestScope();

    // Both callers turn ANY gate error into a denial, so an exception escaping
    // here does not weaken the limiter — it takes reconnect offline entirely.
    await expect(
      getClientIp(),
      "getClientIp rejected instead of returning null: reconnectPlayer and joinAsCoOrganizer are fail-closed, so this exception denies every caller and the feature is down rather than degraded"
    ).resolves.toBeNull();
  });

  it("CI-9 (edge): a rejected headers() promise degrades to null the same way", async () => {
    withRejectingScope();

    await expect(
      getClientIp(),
      "an ASYNC failure of headers() (dynamic-server-usage bailouts reject rather than throw inline) escaped the catch — the await has to be inside the try, or the rejection propagates to a fail-closed caller"
    ).resolves.toBeNull();
  });
});
