// ============================================================
// Tenancy — session binding + shim auto-enroll (PR3)
// ============================================================
// Covers audit findings #4 and #5, which share one root cause: a *session
// UUID* was treated as proof of entitlement to something wider than that
// session.
//
//   #4 getMatchEvents — the organizer gate authorizes `sessionId`, but the
//      read was keyed only on `matchId`. Two independent client-supplied
//      arguments, so an organizer of session A could pass a match id from
//      session B and read another club's audit trail through the service
//      client. The read is now bound to the id that was authorized.
//   #5 the legacy /play and /organizer shims — both called
//      ensureClubMembership for ANY logged-in visitor, so a bare session UUID
//      was a self-service membership in someone else's club. Enrollment is now
//      gated on a real participation signal: a queue row for the player route,
//      the organizer predicate for the organizer one.
//
// The shim tests matter more than they look: the enroll is the ENTIRE
// vulnerability. Both pages redirect either way, so a test that only asserts
// the destination passes whether or not the hole is open.
//
// Both gates are private functions inside their page, not imports — an RSC page
// importing a "use server" module publishes that module's exports as Server
// Action endpoints. TB-IMPORT is the standing guard on that.
//
// IDs: TB-EVENTS · TB-PLAY · TB-ORG · TB-IMPORT
// ============================================================

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi, describe, it, expect, beforeEach } from "vitest";

// Declared before the mocks that reference it. `vi.mock` calls are hoisted
// above everything, so this is not what makes the factory below safe — the
// factory body is lazy and only runs when `next/navigation` is first imported,
// long after module init. Ordering it this way just removes the question.
class NavError extends Error {}

vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/clubs", () => ({
  resolveSessionClubSlug: vi.fn(),
  ensureClubMembership: vi.fn(),
}));
// Keep the real module (getMatchEvents imports its own helpers from here) but
// stub the two gates so each test controls them directly.
vi.mock("@/app/actions/_shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/actions/_shared")>();
  return { ...actual, getAuthenticatedUser: vi.fn(), isSessionOrganizer: vi.fn() };
});
// Both real functions throw to abort rendering. Mocking them as no-ops would
// let a page run PAST `notFound()` with a null slug, which the real runtime
// never does — so the fakes throw too.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new NavError(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new NavError("NOT_FOUND");
  }),
}));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { resolveSessionClubSlug, ensureClubMembership } from "@/lib/clubs";
import { getAuthenticatedUser, isSessionOrganizer } from "@/app/actions/_shared";
import { getMatchEvents } from "@/app/actions/match-events";
import PlayerSessionRedirect from "@/app/play/[sessionId]/page";
import OrganizerSessionRedirect from "@/app/organizer/[sessionId]/page";

const SESSION_A = "00000000-0000-4000-8000-0000000000a1";
const SESSION_B = "00000000-0000-4000-8000-0000000000b2";
const MATCH_IN_B = "00000000-0000-4000-8000-00000000dead";
const CALLER = { id: "00000000-0000-4000-8000-0000000ca11e" };
const STRANGER = { id: "00000000-0000-4000-8000-00000000face" };
const CLUB_ID = "00000000-0000-4000-8000-00000000c1b0";
const SLUG = "rival-club";

type Resp = { data?: unknown; error?: unknown };
type Recorded = { table: string; ops: string[] };
/** One response for every table, or a per-table map. */
type RespSource = Resp | Record<string, Resp>;

/**
 * A bare `{data, error}` answers for every table. A map answers per table and
 * defaults anything it does not name to "no row" — the denying default, so a
 * test that forgets to stub a step fails closed rather than inheriting a row.
 */
function respFor(src: RespSource, table: string): Resp {
  const isMap = !("data" in src) && !("error" in src);
  return isMap ? ((src as Record<string, Resp>)[table] ?? { data: null, error: null }) : src;
}

/**
 * Chainable builder that records every filter it is given, so a test can assert
 * on WHICH columns were constrained — the whole point of finding #4 is a
 * missing filter, and a mock that only records the table name cannot see it.
 */
function builder(resp: Resp, ops: string[]) {
  const b: Record<string, unknown> = {};
  b["select"] = () => b;
  b["order"] = () => b;
  b["eq"] = (col: string, val: unknown) => {
    ops.push(`eq:${col}=${String(val)}`);
    return b;
  };
  b["maybeSingle"] = () => Promise.resolve(resp);
  b["single"] = () => Promise.resolve(resp);
  b["then"] = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(resp).then(res, rej);
  return b;
}

function serviceClient(src: RespSource, recorded: Recorded[]) {
  return {
    from: vi.fn((table: string) => {
      const entry: Recorded = { table, ops: [] };
      recorded.push(entry);
      return builder(respFor(src, table), entry.ops);
    }),
  };
}

function useServiceClient(src: RespSource): Recorded[] {
  const recorded: Recorded[] = [];
  vi.mocked(createServiceClient).mockReturnValue(
    serviceClient(src, recorded) as unknown as ReturnType<typeof createServiceClient>
  );
  return recorded;
}

/** Shapes the two reads `isSessionOrganizerLocal` makes before the club arm. */
const asOrganizerVia = {
  creator: { sessions: { data: { created_by: CALLER.id, club_id: CLUB_ID }, error: null } },
  sessionOrganizersRow: {
    sessions: { data: { created_by: STRANGER.id, club_id: CLUB_ID }, error: null },
    session_organizers: { data: { id: "so1" }, error: null },
  },
  clubAdmin: {
    sessions: { data: { created_by: STRANGER.id, club_id: CLUB_ID }, error: null },
    session_organizers: { data: null, error: null },
    club_members: { data: { role: "admin" }, error: null },
  },
  nobody: {
    sessions: { data: { created_by: STRANGER.id, club_id: CLUB_ID }, error: null },
    session_organizers: { data: null, error: null },
    club_members: { data: null, error: null },
  },
} satisfies Record<string, Record<string, Resp>>;

function authedAs(user: { id: string } | null) {
  vi.mocked(createServerSupabaseClient).mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }) },
  } as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>);
}

/** Run a page and return where it sent the caller ("NOT_FOUND" if it 404'd). */
async function runPage(page: () => Promise<unknown>): Promise<string> {
  try {
    await page();
  } catch (e) {
    if (e instanceof NavError) return e.message;
    throw e;
  }
  throw new Error("page returned without redirecting — the real one always navigates");
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks wipes call history but NOT implementations, so re-arm the
  // shared stubs to their DENYING values every time. A test that forgets to
  // set one then reads as "not an organizer / not queued" and fails loudly,
  // instead of inheriting the previous test's permission and passing for the
  // wrong reason.
  vi.mocked(isSessionOrganizer).mockResolvedValue(false);
  vi.mocked(resolveSessionClubSlug).mockResolvedValue(SLUG);
  vi.mocked(ensureClubMembership).mockResolvedValue({ ok: true, joined: true });
});

// ── #4 the audit trail is bound to the authorized session ─────
describe("TB-EVENTS: getMatchEvents session binding", () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(
      CALLER as unknown as Awaited<ReturnType<typeof getAuthenticatedUser>>
    );
  });

  it("TB-EVENTS-1: filters on the session id, not just the match id", async () => {
    // The caller really IS an organizer of session A — that gate passing must
    // not be enough to read a match that lives in session B.
    vi.mocked(isSessionOrganizer).mockResolvedValue(true);
    const recorded = useServiceClient({ data: [], error: null });

    const r = await getMatchEvents(MATCH_IN_B, SESSION_A);

    expect(r.success).toBe(true);
    const read = recorded.find((x) => x.table === "match_events");
    expect(read).toBeDefined();
    expect(read?.ops).toContain(`eq:match_id_snapshot=${MATCH_IN_B}`);
    // The fix. Without it the query returns session B's trail in full.
    expect(read?.ops).toContain(`eq:session_id_snapshot=${SESSION_A}`);
  });

  it("TB-EVENTS-2: a non-organizer never reaches the service read", async () => {
    vi.mocked(isSessionOrganizer).mockResolvedValue(false);
    const recorded = useServiceClient({ data: [], error: null });

    const r = await getMatchEvents(MATCH_IN_B, SESSION_A);

    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/organizer/i);
    expect(recorded).toHaveLength(0);
  });

  it("TB-EVENTS-3: an unauthenticated caller is refused", async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(null);
    const recorded = useServiceClient({ data: [], error: null });

    const r = await getMatchEvents(MATCH_IN_B, SESSION_A);

    expect(r.success).toBe(false);
    expect(vi.mocked(isSessionOrganizer)).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
  });

  it("TB-EVENTS-4: a malformed session id is rejected before the organizer check", async () => {
    // Both ids are validated, so neither can smuggle a PostgREST filter through
    // the string interpolation the client builds.
    const r = await getMatchEvents(MATCH_IN_B, "not-a-uuid");
    expect(r.success).toBe(false);
    expect(vi.mocked(getAuthenticatedUser)).not.toHaveBeenCalled();
  });
});

// ── #5a the player shim enrolls only actual participants ──────
describe("TB-PLAY: /play/[sessionId] auto-enroll gate", () => {
  const render = (sessionId = SESSION_B) =>
    runPage(() => PlayerSessionRedirect({ params: Promise.resolve({ sessionId }) }));

  it("TB-PLAY-1: a queued walk-in is still enrolled", async () => {
    // The flow worth preserving: an organizer added them to the queue directly,
    // so they have a queue row but no club_members one. Drop the enroll and the
    // club gate bounces them out of a session they are literally playing in.
    authedAs(CALLER);
    useServiceClient({ data: { id: "q1" }, error: null });

    expect(await render()).toBe(`REDIRECT:/c/${SLUG}/play/${SESSION_B}`);
    expect(vi.mocked(ensureClubMembership)).toHaveBeenCalledWith(SLUG, CALLER.id);
  });

  it("TB-PLAY-2: a logged-in stranger who knows the id is NOT enrolled", async () => {
    // The vulnerability. They still get redirected — the club route's own gate
    // decides what they may see — but knowing a UUID no longer buys membership.
    authedAs(CALLER);
    useServiceClient({ data: null, error: null });

    expect(await render()).toBe(`REDIRECT:/c/${SLUG}/play/${SESSION_B}`);
    expect(vi.mocked(ensureClubMembership)).not.toHaveBeenCalled();
  });

  it("TB-PLAY-3: the queue lookup is scoped to this session AND this player", async () => {
    // A lookup missing either filter would match any row in the table and hand
    // TB-PLAY-2 back its membership.
    authedAs(CALLER);
    const recorded = useServiceClient({ data: { id: "q1" }, error: null });

    await render();

    const q = recorded.find((x) => x.table === "queue_entries");
    expect(q?.ops).toEqual([`eq:session_id=${SESSION_B}`, `eq:player_id=${CALLER.id}`]);
  });

  it("TB-PLAY-4: a logged-out visitor is never enrolled and never queried", async () => {
    authedAs(null);
    const recorded = useServiceClient({ data: null, error: null });

    expect(await render()).toBe(`REDIRECT:/c/${SLUG}/play/${SESSION_B}`);
    expect(vi.mocked(ensureClubMembership)).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
  });

  it("TB-PLAY-5: an unknown session 404s without touching membership", async () => {
    vi.mocked(resolveSessionClubSlug).mockResolvedValue(null);
    authedAs(CALLER);

    expect(await render()).toBe("NOT_FOUND");
    expect(vi.mocked(ensureClubMembership)).not.toHaveBeenCalled();
  });
});

// ── #5b the organizer shim enrolls only actual organizers ─────
// The gate is `isSessionOrganizerLocal`, a private function in the page rather
// than the `isSessionOrganizer` import it replaced — see TB-IMPORT for why. It
// is not mockable, so these drive it through the service client it reads with,
// which also pins the three arms of the predicate independently.
describe("TB-ORG: /organizer/[sessionId] auto-enroll gate", () => {
  const render = (sessionId = SESSION_B) =>
    runPage(() => OrganizerSessionRedirect({ params: Promise.resolve({ sessionId }) }));

  it("TB-ORG-1: a co-organizer with no club row is still enrolled", async () => {
    // joinAsCoOrganizer writes session_organizers and nothing else, so this is
    // the case the auto-enroll exists for.
    authedAs(CALLER);
    useServiceClient(asOrganizerVia.sessionOrganizersRow);

    expect(await render()).toBe(`REDIRECT:/c/${SLUG}/organizer/${SESSION_B}`);
    expect(vi.mocked(ensureClubMembership)).toHaveBeenCalledWith(SLUG, CALLER.id);
  });

  it("TB-ORG-2: a logged-in non-organizer is NOT enrolled", async () => {
    // The vulnerability. Redirected either way; the club route decides what
    // they see. Knowing the UUID no longer buys membership.
    authedAs(CALLER);
    useServiceClient(asOrganizerVia.nobody);

    expect(await render()).toBe(`REDIRECT:/c/${SLUG}/organizer/${SESSION_B}`);
    expect(vi.mocked(ensureClubMembership)).not.toHaveBeenCalled();
  });

  it("TB-ORG-3: a logged-out visitor is never enrolled and never queried", async () => {
    authedAs(null);
    const recorded = useServiceClient(asOrganizerVia.sessionOrganizersRow);

    expect(await render()).toBe(`REDIRECT:/c/${SLUG}/organizer/${SESSION_B}`);
    expect(vi.mocked(ensureClubMembership)).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
  });

  it("TB-ORG-4: an unknown session 404s without touching membership", async () => {
    vi.mocked(resolveSessionClubSlug).mockResolvedValue(null);
    authedAs(CALLER);
    useServiceClient(asOrganizerVia.creator);

    expect(await render()).toBe("NOT_FOUND");
    expect(vi.mocked(ensureClubMembership)).not.toHaveBeenCalled();
  });

  it("TB-ORG-5: the session and organizer lookups are scoped to this id AND this user", async () => {
    // Drop either filter on session_organizers and TB-ORG-2 gets its membership
    // back off someone else's row.
    authedAs(CALLER);
    const recorded = useServiceClient(asOrganizerVia.sessionOrganizersRow);

    await render();

    expect(recorded.find((x) => x.table === "sessions")?.ops).toEqual([`eq:id=${SESSION_B}`]);
    expect(recorded.find((x) => x.table === "session_organizers")?.ops).toEqual([
      `eq:session_id=${SESSION_B}`,
      `eq:user_id=${CALLER.id}`,
    ]);
  });

  it("TB-ORG-6: the session creator is enrolled without a session_organizers row", async () => {
    authedAs(CALLER);
    useServiceClient(asOrganizerVia.creator);

    await render();
    expect(vi.mocked(ensureClubMembership)).toHaveBeenCalledWith(SLUG, CALLER.id);
  });

  it("TB-ORG-7: an active club admin counts, and is looked up on the session's own club", async () => {
    // C6: club owner/admin is an implicit organizer on every session in THEIR
    // club — the club id must come from the session row, never from the caller.
    authedAs(CALLER);
    const recorded = useServiceClient(asOrganizerVia.clubAdmin);

    await render();

    expect(vi.mocked(ensureClubMembership)).toHaveBeenCalledWith(SLUG, CALLER.id);
    expect(recorded.find((x) => x.table === "club_members")?.ops).toEqual([
      `eq:club_id=${CLUB_ID}`,
      `eq:player_id=${CALLER.id}`,
      "eq:is_active=true",
    ]);
  });

  it("TB-ORG-8: a deleted session enrolls nobody", async () => {
    authedAs(CALLER);
    useServiceClient({ sessions: { data: null, error: null } });

    expect(await render()).toBe(`REDIRECT:/c/${SLUG}/organizer/${SESSION_B}`);
    expect(vi.mocked(ensureClubMembership)).not.toHaveBeenCalled();
  });
});

// ── the blocker this PR's review caught ───────────────────────
describe('TB-IMPORT: the shims must not import from a "use server" module', () => {
  // `_shared.ts` is `"use server"`. Imported by another ACTION module it is a
  // plain function call and registers nothing — which is why it has no entry in
  // the server-reference manifest. Imported by an RSC page its exports must
  // become passable references, so Next registers ALL of them as dispatchable
  // Server Action endpoints scoped to that route. Two are cross-tenant boolean
  // oracles over a caller-supplied uuid and one is an unauthenticated
  // display-name lookup, so the import silently publishes four new endpoints.
  //
  // Verified by diffing .next/server/server-reference-manifest.json between a
  // build with and without the import: 70 actions → 74. This test is the cheap
  // standing guard, since nothing about the import site looks dangerous.
  //
  // The assertion is on the whole `app/actions/` directory, not on `_shared`
  // by name, and it extracts specifiers rather than matching the alias: a
  // relative `../../actions/_shared`, a dynamic `await import(...)` or a hop
  // through a different action module publishes exactly the same way, and a
  // guard narrower than the rule it enforces is a guard that reads as passing.
  // Neither shim imports from `app/actions/` at all today, so this costs
  // nothing. Elsewhere in the app the pattern is deliberate and fine — RSC
  // pages import `getTvData` / `getWrappedData` from `"use server"` modules,
  // which is why those two ARE in the manifest; they are public reads on
  // public routes. The rule is about not publishing tenancy predicates.
  const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

  it.each([["src/app/organizer/[sessionId]/page.tsx"], ["src/app/play/[sessionId]/page.tsx"]])(
    "TB-IMPORT: %s imports nothing from app/actions/",
    (rel) => {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      const specifiers = [...src.matchAll(SPECIFIER)].map((m) => m[1]);

      // sanity: the extractor sees this file's real imports, so an empty
      // result can never be mistaken for a pass
      expect(specifiers).toContain("next/navigation");
      expect(specifiers.filter((s) => /(^|\/)actions\//.test(s))).toEqual([]);
    }
  );
});
