// ============================================================
// OAuth server actions — dark-launch gate, session gate, open-redirect guard
// ============================================================
// src/app/actions/oauth.ts is the only place in the app that hands an
// attacker-influenceable string (`next`, `clubSlug`) to Supabase as the URL a
// browser will be sent to after authenticating. Three properties have to hold,
// and none of them is visible from a green build:
//
//   1. DARK LAUNCH. Both actions are gated by NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED
//      === "true" — a STRICT, case-sensitive string compare. Until Google is
//      configured in Supabase, an opened gate produces a provider error in
//      front of real users, so "TRUE" / "True" / " true" / "1" must all leave
//      the feature dark, and no Supabase client may even be constructed.
//   2. SESSION GATE + ORDER. linkWithGoogle links an identity to the CURRENT
//      user; it must refuse a caller with no session, and it must refuse
//      BEFORE linkIdentity runs (this repo's guard-order defect class).
//   3. OPEN-REDIRECT GUARD. Both actions thread `next` through safeNext() and
//      then encodeURIComponent(). The test asserts on the ACTUAL argument the
//      mocked signInWithOAuth / linkIdentity received, because "safeNext is
//      correct" and "the action calls safeNext" are two different claims and
//      only the second one is what ships.
//
// Everything is asserted against the recorded call argument, never against a
// string the test rebuilt itself.
//
// IDs (negatives marked; several IDs expand to one `it` per input value):
//   OA-1  (negative) unset flag refuses sign-in and constructs no client
//   OA-2  (negative) the string "false" refuses
//   OA-3  (negative) "TRUE" refuses — the compare is case-sensitive
//   OA-4  (edge)     six near-miss flag values ("", "1", "yes", "True",
//                    " true", "true ") all leave the feature dark
//   OA-5             success returns the PROVIDER's url and asks for "google"
//   OA-6             redirectTo is <site>/auth/callback?next=…
//   OA-7  (edge)     a trailing slash on NEXT_PUBLIC_SITE_URL is stripped
//   OA-8  (edge)     an unset NEXT_PUBLIC_SITE_URL falls back to localhost:3000
//   OA-9             a legitimate internal next survives byte-for-byte
//   OA-10 (negative) six hostile `next` values never reach redirectTo
//   OA-10R(edge)     the one hostile shape safeNext PASSES THROUGH ("/\host")
//                    still cannot move redirectTo off the deployment origin
//   OA-11 (edge)     absent / empty next falls back to safeNext's own /clubs
//   OA-12 (negative) next is encoded — "&"/"?" cannot split into extra params
//   OA-13            clubSlug is appended as `club` and is encoded
//   OA-14 (edge)     an omitted clubSlug appends no club param
//   OA-15 (edge)     an empty-string clubSlug is treated as absent
//   OA-16 (negative) a provider error is returned verbatim, with no url
//   OA-17 (negative) a response with no url is a failure, never a success
//   OA-18 (edge)     a null data payload returns the envelope, never throws
//   OA-19 (edge)     an error wins even when a url is also present
//   OA-20 (negative) the fresh-sign-in path never calls getUser
//   OA-21 (negative) linkWithGoogle is gated by the same flag — seven values
//   OA-22 (negative) an unauthenticated caller is refused BEFORE linkIdentity
//   OA-23            success links "google" with intent=link and returns the url
//   OA-24 (negative) hostile next never reaches linkWithGoogle's redirectTo
//   OA-25 (negative) the link redirectTo is exactly {intent, next} — no club
//   OA-26 (negative) a linkIdentity error is returned verbatim, with no url
//   OA-27 (negative) an empty-string url is a failure, not a success
//   OA-28 (edge)     a null data payload returns the envelope, never throws
//   OA-29 (edge)     the link redirectTo is built from NEXT_PUBLIC_SITE_URL
//   OA-30 (edge)     an absent next in the link flow falls back to /clubs
// ============================================================

import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

// The action only needs the auth surface; the real client reaches for
// next/headers cookies(), which throws outside a request scope.
vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { signInWithGoogle, linkWithGoogle } from "@/app/actions/oauth";

/** Mirror of the action module's own (unexported) return contract. */
type OAuthStart = { success: true; url: string } | { success: false; error: string };

const SITE = "https://badminton.example.com";
const PROVIDER_URL = "https://accounts.google.com/o/oauth2/v2/auth?client_id=stub&state=xyz";
const USER = { id: "00000000-0000-4000-8000-0000000ca11e" };

const FLAG = "NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED";
const SITE_ENV = "NEXT_PUBLIC_SITE_URL";

const DISABLED = "Google sign-in is not enabled.";
const NO_SESSION = "You must be signed in to upgrade.";
const NO_URL = "No redirect URL returned.";

type AuthResult = { data: unknown; error: unknown };
const ok = (): AuthResult => ({ data: { url: PROVIDER_URL }, error: null });

type OAuthClient = {
  /** Auth methods in the order the action called them — pins guard ORDER. */
  calls: string[];
  auth: {
    getUser: ReturnType<typeof vi.fn>;
    signInWithOAuth: ReturnType<typeof vi.fn>;
    linkIdentity: ReturnType<typeof vi.fn>;
  };
};

/**
 * A Supabase stand-in exposing only `auth`. Every method records its name in
 * call order so a test can assert that a gate ran BEFORE the side effect it
 * protects, not merely that both happened.
 */
function oauthClient(
  opts: { user?: { id: string } | null; signIn?: AuthResult; link?: AuthResult } = {}
): OAuthClient {
  const calls: string[] = [];
  const record = (name: string, resp: AuthResult) =>
    vi.fn(async () => {
      calls.push(name);
      return resp;
    });
  const user = opts.user === undefined ? USER : opts.user;
  return {
    calls,
    auth: {
      getUser: record("getUser", { data: { user }, error: null }),
      signInWithOAuth: record("signInWithOAuth", opts.signIn ?? ok()),
      linkIdentity: record("linkIdentity", opts.link ?? ok()),
    },
  };
}

function install(client: OAuthClient): OAuthClient {
  vi.mocked(createServerSupabaseClient).mockResolvedValue(
    client as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
  );
  return client;
}

/** The redirectTo Supabase ACTUALLY received — never one the test rebuilt. */
function redirectToOf(spy: ReturnType<typeof vi.fn>, what: string): string {
  expect(spy.mock.calls, `${what} was not called exactly once`).toHaveLength(1);
  const arg = spy.mock.calls[0][0] as { options?: { redirectTo?: unknown } };
  const redirectTo = arg?.options?.redirectTo;
  expect(typeof redirectTo, `${what} was called without an options.redirectTo string`).toBe(
    "string"
  );
  return String(redirectTo);
}

function providerOf(spy: ReturnType<typeof vi.fn>): unknown {
  return (spy.mock.calls[0][0] as { provider?: unknown })?.provider;
}

const keysOf = (redirectTo: string) => [...new URL(redirectTo).searchParams.keys()];

// `next` values safeNext must REJECT outright (fallback wins).
const HOSTILE_NEXT = [
  "https://evil.example.com/x",
  "http://evil.example.com/steal",
  "//evil.example.com",
  "javascript:alert(1)",
  "https:/evil.example.com",
  "\\\\evil.example.com",
];

const ORIGINAL: Record<string, string | undefined> = {};
let client: OAuthClient;

beforeAll(() => {
  for (const k of [FLAG, SITE_ENV]) ORIGINAL[k] = process.env[k];
});

afterAll(() => {
  for (const k of [FLAG, SITE_ENV]) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env[FLAG] = "true";
  process.env[SITE_ENV] = SITE;
  // Installed even in the gate tests: if a gate leaks, the failure should be
  // the assertion below and not a TypeError on an undefined client.
  client = install(oauthClient());
});

// ── The dark-launch flag: signInWithGoogle ────────────────────
describe('OA-FLAG: signInWithGoogle is dark unless the flag is exactly "true"', () => {
  const expectDark = async (r: OAuthStart) => {
    expect(r, "the disabled path did not return the documented refusal envelope").toEqual({
      success: false,
      error: DISABLED,
    });
    expect(
      vi.mocked(createServerSupabaseClient),
      "a Supabase client was constructed despite the dark-launch gate refusing"
    ).not.toHaveBeenCalled();
    expect(
      client.auth.signInWithOAuth,
      "an OAuth redirect was started for a feature that is supposed to be dark"
    ).not.toHaveBeenCalled();
  };

  it("OA-1 (negative): refuses when NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED is unset", async () => {
    delete process.env[FLAG];
    await expectDark(await signInWithGoogle("/play"));
  });

  it('OA-2 (negative): refuses when the flag is the string "false"', async () => {
    process.env[FLAG] = "false";
    await expectDark(await signInWithGoogle("/play"));
  });

  it('OA-3 (negative): "TRUE" does NOT enable it — the compare is case-sensitive', async () => {
    process.env[FLAG] = "TRUE";
    await expectDark(await signInWithGoogle("/play"));
  });

  for (const value of ["", "1", "yes", "True", " true", "true "]) {
    it(`OA-4 (edge): flag ${JSON.stringify(value)} leaves Google sign-in dark`, async () => {
      process.env[FLAG] = value;
      const r = await signInWithGoogle("/play");
      expect(r.success, `flag value ${JSON.stringify(value)} enabled Google sign-in`).toBe(false);
      expect(
        vi.mocked(createServerSupabaseClient),
        `flag value ${JSON.stringify(value)} got as far as constructing a Supabase client`
      ).not.toHaveBeenCalled();
    });
  }
});

// ── signInWithGoogle: what Supabase is actually asked for ─────
describe("OA-SIGNIN: signInWithGoogle provider call", () => {
  it("OA-5: returns the PROVIDER's url and asks for the google provider", async () => {
    const r = await signInWithGoogle("/play");
    expect(r, "the provider url was not returned verbatim to the caller").toEqual({
      success: true,
      url: PROVIDER_URL,
    });
    expect(
      providerOf(client.auth.signInWithOAuth),
      "the action asked Supabase for a provider other than google"
    ).toBe("google");
  });

  it("OA-6: redirectTo is the configured site's /auth/callback carrying next", async () => {
    await signInWithGoogle("/play/S1");
    const u = new URL(redirectToOf(client.auth.signInWithOAuth, "signInWithOAuth"));
    expect(u.origin, "the OAuth return target is not the configured deployment").toBe(SITE);
    expect(u.pathname, "the OAuth return target is not the /auth/callback handler").toBe(
      "/auth/callback"
    );
    expect(u.searchParams.get("next"), "next did not survive into redirectTo").toBe("/play/S1");
  });

  it("OA-7 (edge): a trailing slash on NEXT_PUBLIC_SITE_URL is stripped", async () => {
    process.env[SITE_ENV] = `${SITE}/`;
    await signInWithGoogle("/play");
    const redirectTo = redirectToOf(client.auth.signInWithOAuth, "signInWithOAuth");
    expect(
      new URL(redirectTo).pathname,
      "a trailing slash in NEXT_PUBLIC_SITE_URL produced a doubled path Supabase will not match against its redirect allow-list"
    ).toBe("/auth/callback");
    expect(redirectTo.startsWith(`${SITE}/auth/callback`), redirectTo).toBe(true);
  });

  it("OA-8 (edge): an unset NEXT_PUBLIC_SITE_URL falls back to http://localhost:3000", async () => {
    delete process.env[SITE_ENV];
    await signInWithGoogle("/play");
    const u = new URL(redirectToOf(client.auth.signInWithOAuth, "signInWithOAuth"));
    expect(u.origin, "the local-dev fallback origin changed").toBe("http://localhost:3000");
    expect(u.pathname, "the local-dev fallback lost the callback path").toBe("/auth/callback");
  });
});

// ── The open-redirect guard, asserted on the real argument ────
describe("OA-NEXT: signInWithGoogle threads next through safeNext", () => {
  it("OA-9: a legitimate internal next survives into redirectTo byte-for-byte", async () => {
    const legit = "/c/chillax/play/00000000-0000-4000-8000-000000000010";
    await signInWithGoogle(legit);
    const u = new URL(redirectToOf(client.auth.signInWithOAuth, "signInWithOAuth"));
    expect(
      u.searchParams.get("next"),
      "a safe internal destination was discarded — the user lands somewhere other than where they started"
    ).toBe(legit);
  });

  for (const hostile of HOSTILE_NEXT) {
    it(`OA-10 (negative): next=${JSON.stringify(hostile)} never reaches redirectTo`, async () => {
      await signInWithGoogle(hostile);
      const redirectTo = redirectToOf(client.auth.signInWithOAuth, "signInWithOAuth");
      const u = new URL(redirectTo);
      expect(
        u.origin,
        `next=${hostile} moved the OAuth return target off the deployment origin`
      ).toBe(SITE);
      expect(
        u.searchParams.get("next"),
        `next=${hostile} survived the open-redirect guard instead of falling back to /clubs`
      ).toBe("/clubs");
      expect(redirectTo, "an attacker host reached the URL handed to Supabase").not.toContain(
        "evil.example.com"
      );
      expect(redirectTo, "a javascript: URL reached the URL handed to Supabase").not.toContain(
        "javascript:"
      );
    });
  }

  it("OA-10R (negative): a backslash path is rejected by safeNext, so `next` carries the fallback", async () => {
    // "/\evil.example.com" starts with a single "/", so a character-level
    // check reads it as an internal path — but the WHATWG URL parser
    // normalises the backslash to a separator and resolves it to
    // https://evil.example.com/. safeNext resolves against a sentinel origin
    // precisely so this class cannot slip through (see Suite SN, SN-4).
    //
    // What this test adds on top of SN-4 is the COMPOSITION: that
    // signInWithGoogle actually routes its argument through safeNext rather
    // than embedding the raw parameter. Drop the safeNext() call in
    // src/app/actions/oauth.ts and SN-4 stays green while this goes red.
    await signInWithGoogle("/\\evil.example.com");
    const u = new URL(redirectToOf(client.auth.signInWithOAuth, "signInWithOAuth"));
    expect(u.origin, "a backslash path moved the OAuth return target off the deployment").toBe(
      SITE
    );
    expect(u.pathname, "a backslash path moved the OAuth return off /auth/callback").toBe(
      "/auth/callback"
    );
    expect(
      u.searchParams.get("next"),
      "the raw backslash path reached `next` — signInWithGoogle is not passing it through safeNext"
    ).toBe("/clubs");
  });

  it("OA-11 (edge): an absent next falls back to safeNext's own /clubs", async () => {
    await signInWithGoogle();
    const u = new URL(redirectToOf(client.auth.signInWithOAuth, "signInWithOAuth"));
    expect(keysOf(u.toString()), "the next param was dropped entirely").toContain("next");
    expect(u.searchParams.get("next"), "the no-argument fallback is not safeNext's /clubs").toBe(
      "/clubs"
    );
  });

  it("OA-11 (edge): an empty-string next falls back to /clubs too", async () => {
    await signInWithGoogle("");
    const u = new URL(redirectToOf(client.auth.signInWithOAuth, "signInWithOAuth"));
    expect(keysOf(u.toString()), "the next param was dropped entirely").toContain("next");
    expect(u.searchParams.get("next"), "an empty next did not fall back to /clubs").toBe("/clubs");
  });

  it("OA-12 (negative): next is URL-encoded — & and ? cannot split into extra params", async () => {
    const crafted = "/play/S1?a=1&b=2&club=evil";
    await signInWithGoogle(crafted);
    const redirectTo = redirectToOf(client.auth.signInWithOAuth, "signInWithOAuth");
    const u = new URL(redirectTo);
    expect(
      keysOf(redirectTo),
      "an un-encoded next split into extra query params — /auth/callback would read attacker-chosen values for club/intent"
    ).toEqual(["next"]);
    expect(u.searchParams.get("next"), "encoding mangled the destination itself").toBe(crafted);
    expect(redirectTo, "the ? inside next was not percent-encoded").toContain("%3F");
    expect(redirectTo, "the & inside next was not percent-encoded").toContain("%26");
  });
});

// ── The club param ────────────────────────────────────────────
describe("OA-CLUB: signInWithGoogle club threading", () => {
  it("OA-13: clubSlug is appended as `club` and is URL-encoded", async () => {
    await signInWithGoogle("/play", "chillax&intent=link");
    const redirectTo = redirectToOf(client.auth.signInWithOAuth, "signInWithOAuth");
    const u = new URL(redirectTo);
    expect(
      keysOf(redirectTo),
      "an un-encoded clubSlug injected an extra param the callback would act on"
    ).toEqual(["next", "club"]);
    expect(u.searchParams.get("club"), "the club slug did not survive intact").toBe(
      "chillax&intent=link"
    );
    expect(
      u.searchParams.get("intent"),
      "an un-encoded clubSlug injected an intent param — the callback would skip profile provisioning"
    ).toBeNull();
  });

  it("OA-14 (edge): an omitted clubSlug appends no club param at all", async () => {
    await signInWithGoogle("/play");
    const redirectTo = redirectToOf(client.auth.signInWithOAuth, "signInWithOAuth");
    expect(
      keysOf(redirectTo),
      "a club param was appended for a sign-in with no club context — /auth/callback would attempt an enrollment"
    ).toEqual(["next"]);
    expect(redirectTo, "a club param leaked into redirectTo").not.toContain("club=");
  });

  it('OA-15 (edge): an empty-string clubSlug is treated as absent, not a club named ""', async () => {
    await signInWithGoogle("/play", "");
    const redirectTo = redirectToOf(client.auth.signInWithOAuth, "signInWithOAuth");
    expect(keysOf(redirectTo), "an empty clubSlug was appended as a real club param").toEqual([
      "next",
    ]);
    expect(redirectTo, "an empty club param leaked into redirectTo").not.toContain("club=");
  });
});

// ── The result envelope ───────────────────────────────────────
describe("OA-RESULT: signInWithGoogle result envelope", () => {
  it("OA-16 (negative): a provider error is returned verbatim and no url rides along", async () => {
    const message = "Unsupported provider: provider is not enabled";
    client = install(oauthClient({ signIn: { data: null, error: { message } } }));
    const r: OAuthStart = await signInWithGoogle("/play");
    expect(r.success, "a failed OAuth start was reported as a success").toBe(false);
    expect(
      r,
      "the provider's own message was replaced — it is the whole diagnostic for a misconfigured Supabase provider"
    ).toEqual({ success: false, error: message });
    expect("url" in r, "a url rode along on a failed OAuth start").toBe(false);
  });

  it("OA-17 (negative): a response with no url is a failure, never a success", async () => {
    client = install(oauthClient({ signIn: { data: { url: null }, error: null } }));
    const r = await signInWithGoogle("/play");
    expect(r, "a missing provider url was reported as a successful start").toEqual({
      success: false,
      error: NO_URL,
    });
  });

  it("OA-18 (edge): a null data payload returns the envelope instead of throwing", async () => {
    client = install(oauthClient({ signIn: { data: null, error: null } }));
    const r = await signInWithGoogle("/play");
    expect(
      r,
      "a null data payload threw instead of returning the documented { success:false } envelope — server actions must never throw unhandled"
    ).toEqual({ success: false, error: NO_URL });
  });

  it("OA-19 (edge): an error wins even when a url is also present", async () => {
    client = install(
      oauthClient({
        signIn: { data: { url: PROVIDER_URL }, error: { message: "rate limit exceeded" } },
      })
    );
    const r = await signInWithGoogle("/play");
    expect(
      r,
      "a half-populated response (error AND url) was treated as a successful start"
    ).toEqual({ success: false, error: "rate limit exceeded" });
  });

  it("OA-20 (negative): the fresh sign-in path never requires an existing session", async () => {
    // A signed-out visitor is the entire point of this action.
    client = install(oauthClient({ user: null }));
    const r = await signInWithGoogle("/play");
    expect(r.success, "a signed-out visitor could not start a Google sign-in").toBe(true);
    expect(
      client.auth.getUser,
      "the fresh sign-in path gated itself on an existing session — signed-out visitors can no longer sign in with Google"
    ).not.toHaveBeenCalled();
    expect(client.calls, "the sign-in path made an auth call it does not need").toEqual([
      "signInWithOAuth",
    ]);
  });
});

// ── linkWithGoogle: the same flag ─────────────────────────────
describe("OA-LINK-FLAG: linkWithGoogle is gated by the same flag", () => {
  for (const value of [undefined, "", "false", "TRUE", "True", " true", "1"]) {
    it(`OA-21 (negative): flag ${JSON.stringify(value)} refuses the upgrade flow`, async () => {
      if (value === undefined) delete process.env[FLAG];
      else process.env[FLAG] = value;

      const r = await linkWithGoogle("/play");

      expect(r, `flag ${JSON.stringify(value)} did not return the refusal envelope`).toEqual({
        success: false,
        error: DISABLED,
      });
      expect(
        vi.mocked(createServerSupabaseClient),
        `flag ${JSON.stringify(value)} constructed a Supabase client despite the dark-launch gate`
      ).not.toHaveBeenCalled();
      expect(
        client.auth.getUser,
        `flag ${JSON.stringify(value)} reached the session lookup`
      ).not.toHaveBeenCalled();
      expect(
        client.auth.linkIdentity,
        `flag ${JSON.stringify(value)} started a Google identity link while the feature is dark`
      ).not.toHaveBeenCalled();
    });
  }
});

// ── linkWithGoogle: session gate, order, and the redirect ─────
describe("OA-LINK: linkWithGoogle session gate and provider call", () => {
  it("OA-22 (negative): refuses an unauthenticated caller BEFORE linkIdentity runs", async () => {
    client = install(oauthClient({ user: null }));
    const r = await linkWithGoogle("/play");
    expect(r, "an unauthenticated caller was not refused with the documented envelope").toEqual({
      success: false,
      error: NO_SESSION,
    });
    expect(
      client.auth.linkIdentity,
      "a Google identity link was started for a caller with no session"
    ).not.toHaveBeenCalled();
    expect(
      client.calls,
      "linkIdentity ran before the session gate that is supposed to protect it"
    ).toEqual(["getUser"]);
  });

  it("OA-23: links google with intent=link and returns the provider url", async () => {
    const r = await linkWithGoogle("/play/S1");
    expect(r, "a successful link did not return the provider url").toEqual({
      success: true,
      url: PROVIDER_URL,
    });
    expect(providerOf(client.auth.linkIdentity), "the linked provider is not google").toBe(
      "google"
    );
    const u = new URL(redirectToOf(client.auth.linkIdentity, "linkIdentity"));
    expect(u.pathname, "the link flow returns somewhere other than /auth/callback").toBe(
      "/auth/callback"
    );
    expect(
      u.searchParams.get("intent"),
      "without intent=link the callback re-provisions the profile and overwrites the display_name this flow exists to preserve"
    ).toBe("link");
    expect(u.searchParams.get("next"), "next did not survive into the link redirectTo").toBe(
      "/play/S1"
    );
    expect(
      client.auth.signInWithOAuth,
      "the upgrade flow started a fresh sign-in, which would mint a NEW user id and orphan the profile"
    ).not.toHaveBeenCalled();
    expect(client.calls, "the session gate did not precede the identity link").toEqual([
      "getUser",
      "linkIdentity",
    ]);
  });

  for (const hostile of HOSTILE_NEXT) {
    it(`OA-24 (negative): next=${JSON.stringify(hostile)} never reaches the link redirectTo`, async () => {
      await linkWithGoogle(hostile);
      const redirectTo = redirectToOf(client.auth.linkIdentity, "linkIdentity");
      const u = new URL(redirectTo);
      expect(u.origin, `next=${hostile} moved the link return target off the deployment`).toBe(
        SITE
      );
      expect(
        u.searchParams.get("next"),
        `next=${hostile} survived the open-redirect guard in the link flow`
      ).toBe("/clubs");
      expect(redirectTo, "an attacker host reached the URL handed to linkIdentity").not.toContain(
        "evil.example.com"
      );
    });
  }

  it("OA-25 (negative): the link redirectTo is exactly {intent, next} — no injected third param", async () => {
    const crafted = "/play/S1?a=1&intent=oops&club=evil";
    await linkWithGoogle(crafted);
    const redirectTo = redirectToOf(client.auth.linkIdentity, "linkIdentity");
    const u = new URL(redirectTo);
    expect(
      keysOf(redirectTo),
      "an un-encoded next split into extra params the callback would act on"
    ).toEqual(["intent", "next"]);
    expect(u.searchParams.get("intent"), "an injected intent overrode the link intent").toBe(
      "link"
    );
    expect(u.searchParams.get("next"), "encoding mangled the destination itself").toBe(crafted);
    expect(
      u.searchParams.get("club"),
      "the upgrade flow carried a club param — the link keeps the existing profile and enrollment, so a club enrollment must not be triggered"
    ).toBeNull();
  });

  it("OA-26 (negative): a linkIdentity error is returned verbatim with no url", async () => {
    const message = "Manual linking is disabled for this project";
    client = install(oauthClient({ link: { data: null, error: { message } } }));
    const r: OAuthStart = await linkWithGoogle("/play");
    expect(r.success, "a failed link was reported as a success").toBe(false);
    expect(
      r,
      "the real reason a link failed — Manual Linking not enabled in Supabase — was replaced by a generic message, which is the whole diagnostic"
    ).toEqual({ success: false, error: message });
    expect("url" in r, "a url rode along on a failed link").toBe(false);
  });

  it("OA-27 (negative): an empty-string url is a failure, not a success", async () => {
    client = install(oauthClient({ link: { data: { url: "" }, error: null } }));
    const r = await linkWithGoogle("/play");
    expect(
      r,
      "an empty provider url was returned as a success — the client would navigate to the empty string"
    ).toEqual({ success: false, error: NO_URL });
  });

  it("OA-28 (edge): a null data payload returns the envelope instead of throwing", async () => {
    client = install(oauthClient({ link: { data: null, error: null } }));
    const r = await linkWithGoogle("/play");
    expect(
      r,
      "a null data payload threw instead of returning the documented { success:false } envelope"
    ).toEqual({ success: false, error: NO_URL });
  });

  it("OA-29 (edge): the link redirectTo is built from NEXT_PUBLIC_SITE_URL, slash stripped", async () => {
    process.env[SITE_ENV] = `${SITE}/`;
    await linkWithGoogle("/play");
    const u = new URL(redirectToOf(client.auth.linkIdentity, "linkIdentity"));
    expect(u.origin, "the link flow ignored the configured deployment origin").toBe(SITE);
    expect(u.pathname, "a trailing slash produced a doubled callback path in the link flow").toBe(
      "/auth/callback"
    );
  });

  it("OA-30 (edge): an absent next in the link flow falls back to /clubs", async () => {
    await linkWithGoogle();
    const u = new URL(redirectToOf(client.auth.linkIdentity, "linkIdentity"));
    expect(u.searchParams.get("next"), "the link flow's no-argument fallback is not /clubs").toBe(
      "/clubs"
    );
    expect(u.searchParams.get("intent"), "the link intent was lost on the fallback path").toBe(
      "link"
    );
  });
});
