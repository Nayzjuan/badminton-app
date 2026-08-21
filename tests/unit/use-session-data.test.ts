// @vitest-environment happy-dom
// ============================================================
// useSessionData — the player-side data spine (SD)
// ============================================================
// Every player staring at /play/[id] is looking at this hook's state. It owns
// three independent reads — courts, active matches, waitlist — each with its
// own fetch, its own ref-callback and its own race guard, all fed by ONE
// consolidated set of realtime subscriptions. Four things make it dangerous,
// and all four are invisible to a green build:
//
//   1. STALE-WINS. fetchWaitlist stamps `++fetchWaitlistSeq.current` and
//      re-checks it after every await. Delete that check and an overlapping
//      pair of fetches resolving out of order paints the OLDER queue over the
//      newer one — the list is wrong, nothing errors, and the next realtime
//      event papers over it before anyone can screenshot it.
//   2. BLANKING ON FAILURE. This is the 07/25 incident ("kicked out of the
//      queue"): a de-authed client's reads came back success-with-ZERO-ROWS,
//      the hooks called setState([]) and every player watched the queue and
//      the courts empty out while the session was still running. An error and
//      a genuinely-empty result arrive through the SAME code path, so the
//      tests below assert BOTH halves — a real empty result must clear, an
//      error and an anon-empty result must not. A test that only proved
//      "errors don't clear" would be satisfied by a hook that never clears
//      anything, which is a different bug with the same screenshot.
//   3. SUBSCRIPTION CHURN. The channels are opened in an effect keyed on
//      [supabase, sessionId] with ref-held callbacks. Widen that key and every
//      render tears down and rejoins five channels — the teardown cascade this
//      repo has fixed more than once.
//   4. DEBOUNCE + CLEANUP. One engine action fans out into ~9 postgres_changes
//      events; each fetch target is trailing-debounced so that burst costs one
//      refetch, and every debouncer is cancelled on unmount so a fetch never
//      lands on a dead component.
//
// The file is listed under "NOT yet included — integration-tested" in
// vitest.config.ts's coverage block, which is exactly why a unit regression
// here has been invisible.
//
//   SD-1   initial load populates courts, waitlist and both match splits
//   SD-2   the waitlist read is bound to THIS session, waiting/on_deck only
//   SD-3   the courts read is bound to THIS session, oldest court first
//   SD-4   draft firewall — the player-side match read demands is_published
//   SD-5   (edge) embedded profile reshaped with pin:null; a missing profile
//          becomes the "Unknown" placeholder bound to the player's OWN id
//   SD-6   on_deck rows pin above waiting rows, order kept inside each tier
//   SD-7   fetchSeq — two overlapping waitlist fetches resolve OUT OF ORDER
//          and the later-started one wins
//   SD-7b  (edge) the seq is re-checked AFTER the auth probe too — a stale
//          empty-but-authed fetch must not clear a newer populated queue
//   SD-7c  fetchSeq — the SAME race on the courts read, which had no guard
//   SD-7d  (edge) the courts seq is re-checked after the auth probe too
//   SD-8   (negative) an errored waitlist fetch preserves the populated list
//   SD-9   positive control for SD-8/SD-11 — a genuinely empty waitlist WITH
//          auth DOES clear the list
//   SD-10  (negative, guard order) an errored waitlist fetch returns before
//          the auth probe: the empty-result branch is never even entered
//   SD-11  (negative) an empty waitlist WITHOUT auth holds the populated list
//   SD-12  (negative) an errored courts fetch preserves the populated courts
//   SD-13  positive control for SD-12/SD-14 — empty courts WITH auth clears
//   SD-14  (negative) an empty courts result WITHOUT auth holds
//   SD-15  subscription stability — five channels, ONE subscribe each, across
//          repeated re-renders, all under the "session-data" prefix
//   SD-16  re-rendering does not re-issue the initial fetches
//   SD-17  a burst of queue events collapses into ONE waitlist refetch
//   SD-18  a profile event refetches waitlist AND matches, (negative) not courts
//   SD-19  cleanup on unmount — every subscription is torn down
//   SD-20  (edge) an event that lands just before unmount never fires after it
//   SD-21  refresh() re-reads all three targets
//   SD-22  (edge) loading still reaches false when all three reads fail
//   SD-23  auth recovery refetches on TOKEN_REFRESHED, (negative) not on
//          SIGNED_OUT
//   SD-24  (edge) a session id change re-binds every read AND every channel
//
// WHAT THIS FILE DOES NOT PROVE
//   - The matches pipeline itself (4-phase fetch, its own seqRef, streaks,
//     court resolution, the Unknown placeholder on match players). That lives
//     in useEnrichedMatches and is covered by tests/unit/use-enriched-matches.ts
//     (EM-1…EM-10). Here we only prove which OPTION useSessionData hands it
//     (includeDrafts: false) and that its fetch is wired to the right events.
//   - That the channels actually reach Postgres, that the realtime filter is
//     correct, or that setAuth precedes subscribe — @/lib/realtime is mocked.
//     Those are covered by realtime-auth-recycle / realtime-private-broadcast.
//   - The debouncer's own semantics (leading vs trailing, cancel) beyond the
//     collapse this hook depends on — realtime-refetch-debounce.test.tsx.
//   - RLS itself. `hasAuthSession` is the real implementation, but the rows a
//     real anon client would be shown are a database property, not a unit one.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useSessionData } from "@/hooks/use-session-data";
import { REALTIME_REFETCH_DEBOUNCE_MS } from "@/lib/constants";
import type { Court, Match, MatchPlayer, Profile, QueueEntry } from "@/types/database";

// ── Constants ─────────────────────────────────────────────────

const SESSION_ID = "sess-sd-777";
const OTHER_SESSION_ID = "sess-sd-999";
const COURT_1 = "court-sd-1";
const COURT_2 = "court-sd-2";
const MATCH_LIVE = "match-sd-live";
const MATCH_DECK = "match-sd-deck";
const PLAYER_A = "player-sd-a";
const PLAYER_B = "player-sd-b";

// ── Fixtures ──────────────────────────────────────────────────

function makeCourt(id: string, name: string): Court {
  return {
    id,
    session_id: SESSION_ID,
    name,
    status: "available",
    created_at: "2026-08-21T09:00:00.000Z",
  };
}

function makeProfile(id: string, displayName: string): Profile {
  return {
    id,
    display_name: displayName,
    skill_level: "intermediate",
    pin: null,
    vip_tag: null,
    vip_theme: null,
    needs_rename: false,
    collided_name: null,
    flagged_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

/**
 * A queue_entries row as PostgREST returns it for this hook's embedded
 * select: the entry columns plus a `profile` object that omits `pin`
 * (PUBLIC_PROFILE_COLUMNS), or null when the FK resolves to nothing.
 */
type QueueRow = QueueEntry & { profile: Omit<Profile, "pin"> | null };

function makeQueueRow(
  playerId: string,
  status: QueueEntry["status"] = "waiting",
  displayName: string | null = "Player",
  gamesPlayed = 0
): QueueRow {
  const { pin: _pin, ...publicProfile } = makeProfile(playerId, displayName ?? "");
  return {
    id: `qe-${playerId}`,
    session_id: SESSION_ID,
    player_id: playerId,
    joined_at: "2026-08-21T09:05:00.000Z",
    games_played: gamesPlayed,
    status,
    position: null,
    is_paused: false,
    paused_at: null,
    created_at: "2026-08-21T09:05:00.000Z",
    profile: displayName === null ? null : publicProfile,
  };
}

function makeMatch(id: string, status: Match["status"], courtId: string | null): Match {
  return {
    id,
    session_id: SESSION_ID,
    court_id: courtId,
    status,
    team_a_score: null,
    team_b_score: null,
    is_mixed_level: false,
    sort_order: 0,
    created_method: "auto",
    modification_count: 0,
    final_classification: "auto_clean",
    provenance_backfilled: false,
    is_published: true,
    created_at: "2026-08-21T09:10:00.000Z",
    started_at: null,
    completed_at: null,
    pulled_player_ids: [],
    pulled_from_match_id: null,
    held_ready_at: null,
    is_held: false,
  };
}

function makeMatchPlayer(matchId: string, playerId: string, team: "a" | "b"): MatchPlayer {
  return { id: `mp-${matchId}-${playerId}`, match_id: matchId, player_id: playerId, team };
}

// ── Mock Supabase client ──────────────────────────────────────
// Every query is logged as `table` + the ordered list of filters it was
// handed, so a test can assert the column-to-VALUE pairing rather than the
// mere fact that some eq() happened: two eq() calls with the arguments
// swapped make exactly the same number of calls.

type TableResult = { data: unknown[] | null; error: { message: string } | null };
/** Resolves the Nth call against a table — lets one test answer two fetches differently. */
type Resolver = (callIndex: number) => TableResult | Promise<TableResult>;

type QueryLog = { table: string; ops: string[] };

const EMPTY_OK: TableResult = { data: [], error: null };

let queryLog: QueryLog[] = [];
let callCount: Record<string, number> = {};
let resolvers: Record<string, Resolver> = {};
let mockSession: { access_token: string } | null = { access_token: "test-jwt" };
let getSessionCalls = 0;
/**
 * Set by SD-7b to suspend the NEXT auth probe. The hold-state guards await
 * hasAuthSession, which is a second await inside the fetch — the only way to
 * prove the seq is re-checked after it is to park a fetch there while a newer
 * one overtakes it. Consumed once, so only the probe it targets is gated.
 */
let authProbeGate: Promise<void> | null = null;
let authListener: ((event: string) => void) | null = null;

function countOf(table: string): number {
  return queryLog.filter((l) => l.table === table).length;
}

function opsOf(table: string, callIndex = 0): string[] {
  const logs = queryLog.filter((l) => l.table === table);
  return logs[callIndex]?.ops ?? [];
}

/** Answer every call against `table` with the same result. */
function setTable(table: string, result: TableResult): void {
  resolvers[table] = () => result;
}

function buildMockClient() {
  return {
    from: (table: string) => {
      const callIndex = callCount[table] ?? 0;
      callCount[table] = callIndex + 1;
      const log: QueryLog = { table, ops: [] };
      queryLog.push(log);

      const chain: Record<string, unknown> = {
        select: (cols: string) => {
          log.ops.push(`select:${cols}`);
          return chain;
        },
        eq: (col: string, val: unknown) => {
          log.ops.push(`eq:${col}=${String(val)}`);
          return chain;
        },
        in: (col: string, vals: unknown[]) => {
          log.ops.push(`in:${col}=[${vals.map(String).join(",")}]`);
          return chain;
        },
        or: (filter: string) => {
          log.ops.push(`or:${filter}`);
          return chain;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          log.ops.push(`order:${col}:${opts?.ascending === false ? "desc" : "asc"}`);
          return chain;
        },
        then: (onFulfilled: (v: unknown) => unknown) => {
          const resolver = resolvers[table] ?? (() => EMPTY_OK);
          return Promise.resolve(resolver(callIndex)).then(onFulfilled);
        },
      };
      return chain;
    },
    // useEnrichedMatches phase 3b.
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    auth: {
      // The auth-loss guard (the REAL hasAuthSession — see the importOriginal
      // below) probes this. Counting the calls is how SD-10 proves the error
      // branch returns BEFORE the empty-result branch is entered.
      getSession: async () => {
        getSessionCalls += 1;
        if (authProbeGate) {
          const gate = authProbeGate;
          authProbeGate = null;
          await gate;
        }
        return { data: { session: mockSession } };
      },
      onAuthStateChange: (cb: (event: string) => void) => {
        authListener = cb;
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                authListener = null;
              },
            },
          },
        };
      },
    },
  };
}

// importOriginal keeps the REAL hasAuthSession — the function whose absence
// caused 07/25 — running against the stub above. Only the client factory is
// replaced, so SD-9/SD-11/SD-13/SD-14 exercise the shipped guard, not a copy.
vi.mock("@/utils/supabase/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/supabase/client")>()),
  createBrowserSupabaseClient: () => buildMockClient(),
}));

// ── Mock realtime ─────────────────────────────────────────────

type Subscription = { name: string; sessionId: string; prefix?: string; cb: () => void };

const subscriptions: Subscription[] = [];
const unsubCounts: Record<string, number> = {};

function makeSubscribe(name: string) {
  return (_client: unknown, sessionId: string, cb: () => void, prefix?: string) => {
    subscriptions.push({ name, sessionId, prefix, cb });
    return () => {
      unsubCounts[name] = (unsubCounts[name] ?? 0) + 1;
    };
  };
}

vi.mock("@/lib/realtime", () => ({
  subscribeToCourts: makeSubscribe("courts"),
  subscribeToQueue: makeSubscribe("queue"),
  subscribeToMatches: makeSubscribe("matches"),
  subscribeToMatchPlayers: makeSubscribe("match_players"),
  subscribeToProfiles: makeSubscribe("profiles"),
}));

/** Fire the realtime callback the hook registered for `name`. */
function fireRealtime(name: string): void {
  const sub = subscriptions.find((s) => s.name === name);
  if (!sub) throw new Error(`no subscription registered for "${name}"`);
  sub.cb();
}

// ── Seeds ─────────────────────────────────────────────────────

/** A fully populated session: 2 courts, 3 queue rows, 1 live + 1 on-deck match. */
function seedFullSession(): void {
  setTable("courts", {
    data: [makeCourt(COURT_1, "Court 1"), makeCourt(COURT_2, "Court 2")],
    error: null,
  });
  setTable("queue_entries", {
    data: [makeQueueRow(PLAYER_A, "waiting", "Alice"), makeQueueRow(PLAYER_B, "waiting", "Bob")],
    error: null,
  });
  setTable("matches", {
    data: [makeMatch(MATCH_LIVE, "in_progress", COURT_1), makeMatch(MATCH_DECK, "pending", null)],
    error: null,
  });
  setTable("match_players", {
    data: [makeMatchPlayer(MATCH_LIVE, PLAYER_A, "a"), makeMatchPlayer(MATCH_LIVE, PLAYER_B, "b")],
    error: null,
  });
  setTable("profiles", {
    data: [makeProfile(PLAYER_A, "Alice"), makeProfile(PLAYER_B, "Bob")],
    error: null,
  });
}

async function renderLoaded() {
  const rendered = renderHook(({ id }: { id: string }) => useSessionData(id), {
    initialProps: { id: SESSION_ID },
  });
  await waitFor(() =>
    expect(rendered.result.current.loading, "the initial load never settled").toBe(false)
  );
  return rendered;
}

// ── Tests ─────────────────────────────────────────────────────

describe("useSessionData — the player-side data spine", () => {
  beforeEach(() => {
    queryLog = [];
    callCount = {};
    resolvers = {};
    mockSession = { access_token: "test-jwt" };
    getSessionCalls = 0;
    authProbeGate = null;
    authListener = null;
    subscriptions.length = 0;
    for (const k of Object.keys(unsubCounts)) delete unsubCounts[k];
    // The hold-state guards log on the path they protect; keep the run readable
    // without suppressing a genuine crash (console.error only, not throw).
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── SD-1 ───────────────────────────────────────────────────
  it("SD-1: initial load populates courts, waitlist and both match splits", async () => {
    seedFullSession();

    const { result } = await renderLoaded();

    expect(
      result.current.courts.map((c) => c.id),
      "the court panel came up empty"
    ).toEqual([COURT_1, COURT_2]);
    expect(
      result.current.waitlist.map((w) => w.player_id),
      "the waiting queue came up empty — every player sees 'No One Waiting'"
    ).toEqual([PLAYER_A, PLAYER_B]);
    expect(
      result.current.inProgressMatches.map((m) => m.id),
      "an in_progress match was not routed to the live-court panel"
    ).toEqual([MATCH_LIVE]);
    expect(
      result.current.onDeckMatches.map((m) => m.id),
      "a published pending match was not routed to the on-deck panel"
    ).toEqual([MATCH_DECK]);
    expect(
      result.current.inProgressMatches[0].players.map((p) => p.profile.display_name).sort(),
      "match players lost their profiles — every name renders as 'Unknown'"
    ).toEqual(["Alice", "Bob"]);
    expect(
      getSessionCalls,
      "the auth probe ran on a fully populated read — the hold-state guard is supposed to be reached only on an EMPTY result"
    ).toBe(0);
  });

  // ── SD-2 ───────────────────────────────────────────────────
  it("SD-2: the waitlist read is bound to THIS session and to waiting/on_deck only", async () => {
    seedFullSession();
    await renderLoaded();

    const ops = opsOf("queue_entries");
    expect(
      ops,
      "the waitlist read is no longer filtered by session_id=<this session> — a swapped column or value shows one club another club's queue"
    ).toContain(`eq:session_id=${SESSION_ID}`);
    expect(
      ops,
      "the waitlist status filter changed shape — it must carry BOTH waiting and on_deck, or drafted players vanish from the queue mid-call"
    ).toContain("in:status=[waiting,on_deck]");
    // Assert the whole ordered list, not `some(startsWith(...))` per column.
    // Two order() calls ARE a compound sort: games_played is the key and
    // joined_at is only the tiebreak, so swapping them makes joined_at the key
    // and the queue becomes FIFO-with-a-games-tiebreak — a different queue,
    // same two calls. And `startsWith("order:games_played")` also matches
    // `order:games_played:desc`, which puts the players who have played the
    // MOST at the front. Both mutations survive a presence-only assertion.
    expect(
      ops.filter((o) => o.startsWith("order:")),
      "the waitlist sort changed: it must be games_played ASC first (fewest games served first) and joined_at ASC second (FIFO tiebreak). A swap or a direction flip serves the wrong player next, and nothing errors"
    ).toEqual(["order:games_played:asc", "order:joined_at:asc"]);
  });

  // ── SD-3 ───────────────────────────────────────────────────
  it("SD-3: the courts read is bound to THIS session and ordered oldest-first", async () => {
    seedFullSession();
    await renderLoaded();

    const ops = opsOf("courts");
    expect(
      ops,
      "the courts read is no longer bound to session_id=<this session> — players would see courts from another session"
    ).toContain(`eq:session_id=${SESSION_ID}`);
    expect(
      ops,
      "courts stopped being ordered created_at ascending — the court panel reshuffles on every refetch"
    ).toContain("order:created_at:asc");
  });

  // ── SD-4 ───────────────────────────────────────────────────
  it("SD-4: draft firewall — the player-side match read demands is_published", async () => {
    seedFullSession();
    await renderLoaded();

    const or = opsOf("matches").find((o) => o.startsWith("or:"));
    expect(
      or,
      "the player-side match read lost its .or() filter — that filter IS the draft firewall; without it every unpublished engine draft is broadcast to the players"
    ).toBeDefined();
    expect(
      or,
      "the draft firewall no longer requires is_published — players can see unpublished drafts"
    ).toContain("is_published.eq.true");
    expect(
      opsOf("matches").some((o) => o.startsWith("in:status=")),
      "the player read switched to the ORGANIZER query shape (includeDrafts: true), which returns every pending draft"
    ).toBe(false);
  });

  // ── SD-5 (edge) ────────────────────────────────────────────
  it("SD-5 (edge): embedded profile is reshaped with pin:null; a missing profile becomes an Unknown placeholder bound to the player's own id", async () => {
    seedFullSession();
    setTable("queue_entries", {
      data: [makeQueueRow(PLAYER_A, "waiting", "Alice"), makeQueueRow(PLAYER_B, "waiting", null)],
      error: null,
    });

    const { result } = await renderLoaded();

    const alice = result.current.waitlist.find((w) => w.player_id === PLAYER_A);
    expect(alice?.profile.display_name, "the embedded profile was dropped from the queue row").toBe(
      "Alice"
    );
    expect(
      alice?.profile.pin,
      "the locked-down `pin` column was not re-added as null — the row no longer matches the Profile shape every consumer types against"
    ).toBeNull();

    const ghost = result.current.waitlist.find((w) => w.player_id === PLAYER_B);
    expect(
      ghost,
      "a queue row whose profile FK resolved to nothing was dropped entirely — that player disappears from the queue instead of rendering as Unknown"
    ).toBeDefined();
    expect(
      ghost?.profile.display_name,
      "a null embedded profile did not degrade to the Unknown placeholder"
    ).toBe("Unknown");
    expect(
      ghost?.profile.id,
      "the Unknown placeholder was bound to the wrong id — it must carry the PLAYER's id, not the queue row's, or every downstream keyed lookup (avatar, skill, swap) misses"
    ).toBe(PLAYER_B);
  });

  // ── SD-6 ───────────────────────────────────────────────────
  it("SD-6: on_deck rows pin above waiting rows, order preserved inside each tier", async () => {
    seedFullSession();
    setTable("queue_entries", {
      data: [
        makeQueueRow("w-1", "waiting", "Wanda", 0),
        makeQueueRow("od-1", "on_deck", "Otto", 3),
        makeQueueRow("w-2", "waiting", "Wes", 1),
        makeQueueRow("od-2", "on_deck", "Odell", 4),
      ],
      error: null,
    });

    const { result } = await renderLoaded();

    expect(
      result.current.waitlist.map((w) => w.player_id),
      "on_deck players are no longer pinned to the top of the queue (or the tie-order inside a tier was lost) — the 'you're up next' rows sink below players who are not"
    ).toEqual(["od-1", "od-2", "w-1", "w-2"]);
  });

  // ── SD-7 ───────────────────────────────────────────────────
  it("SD-7: fetchSeq — two overlapping waitlist fetches resolve OUT OF ORDER and the later-started one wins", async () => {
    seedFullSession();

    // Call 0 is the initial load. Call 1 (the STALE one) hangs until released
    // and answers with the old queue; call 2 answers immediately with the new.
    let releaseStale!: () => void;
    const staleGate = new Promise<void>((res) => {
      releaseStale = res;
    });
    const staleRows = { data: [makeQueueRow("stale-player", "waiting", "Stale")], error: null };
    const freshRows = { data: [makeQueueRow("fresh-player", "waiting", "Fresh")], error: null };

    resolvers.queue_entries = (callIndex) => {
      if (callIndex === 0) {
        return { data: [makeQueueRow(PLAYER_A, "waiting", "Alice")], error: null };
      }
      if (callIndex === 1) return staleGate.then(() => staleRows);
      return freshRows;
    };

    const { result } = await renderLoaded();

    let stalePending!: Promise<void>;
    await act(async () => {
      // Started FIRST, resolves LAST — the shape a slow network + a realtime
      // burst produce in production.
      stalePending = result.current.refresh();
      await result.current.refresh();
    });

    expect(
      result.current.waitlist.map((w) => w.player_id),
      "the second (newer) waitlist fetch never landed — the positive control for the race guard failed, so the assertion below would pass for the wrong reason"
    ).toEqual(["fresh-player"]);

    await act(async () => {
      releaseStale();
      await stalePending;
    });

    expect(
      result.current.waitlist.map((w) => w.player_id),
      "a STALE waitlist fetch resolving after a newer one overwrote the newer result — players see a queue that is one refetch out of date, with no error anywhere"
    ).toEqual(["fresh-player"]);
  });

  // ── SD-7b (edge) ───────────────────────────────────────────
  it("SD-7b (edge): the seq is re-checked AFTER the auth probe — a stale empty-but-authed waitlist fetch does not clear a newer populated queue", async () => {
    seedFullSession();
    const { result } = await renderLoaded();

    // The stale fetch comes back EMPTY, so it does not return at the seq check
    // that follows the query — it walks into the hold-state guard and awaits
    // hasAuthSession. That await is where it gets overtaken. The client IS
    // authed, so when it resumes the guard falls through and it would call
    // setWaitlist([]) — clearing a queue that a newer fetch has just filled.
    const staleAt = countOf("queue_entries");
    resolvers.queue_entries = (callIndex) =>
      callIndex === staleAt
        ? EMPTY_OK
        : { data: [makeQueueRow("fresh-player", "waiting", "Fresh")], error: null };

    let releaseProbe!: () => void;
    authProbeGate = new Promise<void>((res) => {
      releaseProbe = res;
    });

    let stalePending!: Promise<void>;
    await act(async () => {
      stalePending = result.current.refresh();
      // Do not release until the stale fetch is actually parked in the probe.
      // If it were still before the first seq check, that check would catch it
      // and this test would pass without exercising the second one at all.
      await waitFor(() =>
        expect(
          getSessionCalls,
          "the stale fetch never reached the auth probe — this test would then prove nothing about the post-probe seq check"
        ).toBeGreaterThan(0)
      );
      await result.current.refresh();
    });

    expect(
      result.current.waitlist.map((w) => w.player_id),
      "the newer waitlist fetch never landed — the positive control failed, so the assertion below would pass for the wrong reason"
    ).toEqual(["fresh-player"]);

    await act(async () => {
      releaseProbe();
      await stalePending;
    });

    expect(
      result.current.waitlist.map((w) => w.player_id),
      "a stale empty-but-authed waitlist fetch resumed from the auth probe and blanked a queue that a newer fetch had already filled — every player sees 'No One Waiting' with no error anywhere"
    ).toEqual(["fresh-player"]);
  });

  // ── SD-7c ──────────────────────────────────────────────────
  it("SD-7c: fetchSeq — two overlapping COURTS fetches resolve OUT OF ORDER and the later-started one wins", async () => {
    seedFullSession();
    const { result } = await renderLoaded();

    // Same race as SD-7, on the read that had no guard at all. courts is
    // refetched by its own debounced subscription AND by every refresh(), so
    // two runs overlapping is the ordinary case, not the exotic one.
    const staleAt = countOf("courts");
    let releaseStale!: () => void;
    const staleGate = new Promise<void>((res) => {
      releaseStale = res;
    });
    resolvers.courts = (callIndex) =>
      callIndex === staleAt
        ? staleGate.then(() => ({ data: [makeCourt("court-stale", "Stale")], error: null }))
        : { data: [makeCourt("court-fresh", "Fresh")], error: null };

    let stalePending!: Promise<void>;
    await act(async () => {
      stalePending = result.current.refresh();
      await result.current.refresh();
    });

    expect(
      result.current.courts.map((c) => c.id),
      "the second (newer) courts fetch never landed — the positive control for the race guard failed"
    ).toEqual(["court-fresh"]);

    await act(async () => {
      releaseStale();
      await stalePending;
    });

    expect(
      result.current.courts.map((c) => c.id),
      "a STALE courts fetch resolving after a newer one overwrote the newer result — the court panel shows a court that has since been renamed, closed or deleted, and only the next realtime event fixes it"
    ).toEqual(["court-fresh"]);
  });

  // ── SD-7d (edge) ───────────────────────────────────────────
  it("SD-7d (edge): the courts seq is re-checked AFTER the auth probe too — a stale empty-but-authed courts fetch does not clear a newer panel", async () => {
    seedFullSession();
    const { result } = await renderLoaded();

    const staleAt = countOf("courts");
    resolvers.courts = (callIndex) =>
      callIndex === staleAt
        ? EMPTY_OK
        : { data: [makeCourt("court-fresh", "Fresh")], error: null };

    let releaseProbe!: () => void;
    authProbeGate = new Promise<void>((res) => {
      releaseProbe = res;
    });

    let stalePending!: Promise<void>;
    await act(async () => {
      stalePending = result.current.refresh();
      await waitFor(() =>
        expect(
          getSessionCalls,
          "the stale courts fetch never reached the auth probe — this test would then prove nothing about the post-probe seq check"
        ).toBeGreaterThan(0)
      );
      await result.current.refresh();
    });

    expect(
      result.current.courts.map((c) => c.id),
      "the newer courts fetch never landed — the positive control failed"
    ).toEqual(["court-fresh"]);

    await act(async () => {
      releaseProbe();
      await stalePending;
    });

    expect(
      result.current.courts.map((c) => c.id),
      "a stale empty-but-authed courts fetch resumed from the auth probe and blanked a panel a newer fetch had already filled"
    ).toEqual(["court-fresh"]);
  });

  // ── SD-8 (negative) ────────────────────────────────────────
  it("SD-8 (negative): an errored waitlist fetch preserves the already-populated list", async () => {
    seedFullSession();
    const { result } = await renderLoaded();
    expect(result.current.waitlist, "precondition: the queue must be populated first").toHaveLength(
      2
    );

    setTable("queue_entries", { data: null, error: { message: "network down" } });
    await act(async () => {
      await result.current.refresh();
    });

    expect(
      result.current.waitlist.map((w) => w.player_id),
      "a transient waitlist read failure blanked the queue — this is the 07/25 'kicked out of the queue' report: every player watches the list empty while the session is still running"
    ).toEqual([PLAYER_A, PLAYER_B]);
  });

  // ── SD-9 (positive control) ────────────────────────────────
  it("SD-9: positive control — a genuinely empty waitlist WITH auth DOES clear the list", async () => {
    seedFullSession();
    const { result } = await renderLoaded();
    expect(result.current.waitlist, "precondition: the queue must be populated first").toHaveLength(
      2
    );

    // Everyone got drafted onto a court: a real, authoritative empty result.
    setTable("queue_entries", EMPTY_OK);
    await act(async () => {
      await result.current.refresh();
    });

    expect(
      result.current.waitlist,
      "the last player leaving the queue no longer empties it — the hold-state guard has widened into 'never clear anything', which strands a stale queue on screen forever"
    ).toEqual([]);
  });

  // ── SD-10 (negative, guard order) ──────────────────────────
  it("SD-10 (negative, guard order): an errored waitlist fetch returns BEFORE the auth probe", async () => {
    seedFullSession();
    const { result } = await renderLoaded();

    setTable("queue_entries", { data: null, error: { message: "network down" } });
    const before = getSessionCalls;
    await act(async () => {
      await result.current.refresh();
    });

    expect(
      getSessionCalls - before,
      "an errored read reached the empty-result branch and probed auth. Order matters, not just outcome: an error yields `data: null`, which reads as an EMPTY result — so if the empty branch runs first, an authenticated client falls through it and setWaitlist([]) blanks the queue on every transient error"
    ).toBe(0);
    expect(
      result.current.waitlist,
      "the queue was blanked by an errored read (see the ordering note above)"
    ).toHaveLength(2);
  });

  // ── SD-11 (negative) ───────────────────────────────────────
  it("SD-11 (negative): an empty waitlist WITHOUT auth holds the populated list", async () => {
    seedFullSession();
    const { result } = await renderLoaded();
    expect(result.current.waitlist, "precondition: the queue must be populated first").toHaveLength(
      2
    );

    // The 07/25 shape exactly: the client has silently degraded to anon, RLS
    // filters every row, and PostgREST reports SUCCESS with zero rows.
    setTable("queue_entries", EMPTY_OK);
    mockSession = null;
    await act(async () => {
      await result.current.refresh();
    });

    expect(
      result.current.waitlist.map((w) => w.player_id),
      "a de-authed client's success-with-zero-rows blanked the queue. This is the 07/25 incident: RLS filtering is a SUCCESS, so the error branch cannot catch it — only the hasAuthSession probe can"
    ).toEqual([PLAYER_A, PLAYER_B]);
    expect(
      getSessionCalls,
      "the empty result never consulted hasAuthSession at all"
    ).toBeGreaterThan(0);
  });

  // ── SD-12 (negative) ───────────────────────────────────────
  it("SD-12 (negative): an errored courts fetch preserves the already-populated courts", async () => {
    seedFullSession();
    const { result } = await renderLoaded();
    expect(result.current.courts, "precondition: courts must be populated first").toHaveLength(2);

    setTable("courts", { data: null, error: { message: "network down" } });
    await act(async () => {
      await result.current.refresh();
    });

    expect(
      result.current.courts.map((c) => c.id),
      "a transient courts read failure blanked the court panel — the players' view of every live game disappears on one failed request"
    ).toEqual([COURT_1, COURT_2]);
  });

  // ── SD-13 (positive control) ───────────────────────────────
  it("SD-13: positive control — an empty courts result WITH auth DOES clear the panel", async () => {
    seedFullSession();
    const { result } = await renderLoaded();
    expect(result.current.courts, "precondition: courts must be populated first").toHaveLength(2);

    setTable("courts", EMPTY_OK);
    await act(async () => {
      await result.current.refresh();
    });

    expect(
      result.current.courts,
      "an organizer deleting the last court no longer empties the panel — the hold-state guard has widened into 'never clear', leaving a court on screen that does not exist"
    ).toEqual([]);
  });

  // ── SD-14 (negative) ───────────────────────────────────────
  it("SD-14 (negative): an empty courts result WITHOUT auth holds the populated panel", async () => {
    seedFullSession();
    const { result } = await renderLoaded();

    setTable("courts", EMPTY_OK);
    mockSession = null;
    await act(async () => {
      await result.current.refresh();
    });

    expect(
      result.current.courts.map((c) => c.id),
      "a de-authed client's success-with-zero-rows blanked the court panel — same failure shape as the queue on 07/25, on a different table"
    ).toEqual([COURT_1, COURT_2]);
  });

  // ── SD-15 ──────────────────────────────────────────────────
  it("SD-15: subscription stability — five channels, ONE subscribe each, across repeated re-renders", async () => {
    seedFullSession();
    const { rerender } = await renderLoaded();

    rerender({ id: SESSION_ID });
    rerender({ id: SESSION_ID });
    rerender({ id: SESSION_ID });

    expect(
      subscriptions.map((s) => s.name).sort(),
      "the consolidated subscription set changed — the hook must open exactly one channel per table (courts, queue, matches, match_players, profiles) and open it ONCE. A re-render that resubscribes is the teardown cascade this repo has already fixed twice: each rejoin drops events for the window it is down"
    ).toEqual(["courts", "match_players", "matches", "profiles", "queue"]);
    expect(
      subscriptions.every((s) => s.prefix === "session-data"),
      "a channel lost the 'session-data' prefix — unprefixed channels collide with useQueue/usePlayerMatch on the same page and one hook's subscribe silently kills the other's"
    ).toBe(true);
    expect(
      subscriptions.every((s) => s.sessionId === SESSION_ID),
      "a channel was opened against the wrong session id"
    ).toBe(true);
    expect(
      Object.values(unsubCounts).reduce((a, b) => a + b, 0),
      "a re-render tore a live channel down"
    ).toBe(0);
  });

  // ── SD-16 ──────────────────────────────────────────────────
  it("SD-16: re-rendering does not re-issue the initial fetches", async () => {
    seedFullSession();
    const { rerender } = await renderLoaded();

    const before = { courts: countOf("courts"), queue: countOf("queue_entries") };
    rerender({ id: SESSION_ID });
    rerender({ id: SESSION_ID });
    rerender({ id: SESSION_ID });

    expect(
      { courts: countOf("courts"), queue: countOf("queue_entries") },
      "a re-render re-ran the load effect — one of the fetch callbacks lost its useCallback identity, which turns every parent render into three round trips per player"
    ).toEqual(before);
  });

  // ── SD-17 ──────────────────────────────────────────────────
  it("SD-17: a burst of queue events collapses into ONE waitlist refetch", async () => {
    seedFullSession();
    await renderLoaded();
    const before = countOf("queue_entries");

    vi.useFakeTimers();
    act(() => {
      fireRealtime("queue");
      fireRealtime("queue");
      fireRealtime("queue");
    });

    expect(
      countOf("queue_entries") - before,
      "the refetch fired on the LEADING edge — a trailing debounce must not have run yet"
    ).toBe(0);

    await act(async () => {
      vi.advanceTimersByTime(REALTIME_REFETCH_DEBOUNCE_MS);
    });

    expect(
      countOf("queue_entries") - before,
      "a burst of queue events no longer collapses into a single refetch. One engine action fans out into ~9 postgres_changes rows; undebounced, every player's phone runs the whole pipeline once per row"
    ).toBe(1);
  });

  // ── SD-18 ──────────────────────────────────────────────────
  it("SD-18: a profile event refetches the waitlist AND the matches, but (negative) not the courts", async () => {
    seedFullSession();
    await renderLoaded();
    const before = {
      queue: countOf("queue_entries"),
      matches: countOf("matches"),
      courts: countOf("courts"),
    };

    vi.useFakeTimers();
    act(() => {
      fireRealtime("profiles");
    });
    await act(async () => {
      vi.advanceTimersByTime(REALTIME_REFETCH_DEBOUNCE_MS);
    });

    expect(
      countOf("queue_entries") - before.queue,
      "a profile change no longer refetches the waitlist — a renamed player or an edited skill badge stays wrong in the queue until something else moves"
    ).toBe(1);
    expect(
      countOf("matches") - before.matches,
      "a profile change no longer refetches the active matches — a renamed player stays wrong on the court card"
    ).toBe(1);
    expect(
      countOf("courts") - before.courts,
      "a profile change dragged the courts read along with it; profiles have no bearing on courts and each debouncer is supposed to be per-target"
    ).toBe(0);
  });

  // ── SD-19 ──────────────────────────────────────────────────
  it("SD-19: cleanup on unmount — every subscription is torn down", async () => {
    seedFullSession();
    const { unmount } = await renderLoaded();

    unmount();

    expect(
      unsubCounts,
      "a channel survived unmount — leaked channels keep firing refetches against a dead component and, five per navigation, walk the client into Supabase's per-connection channel limit"
    ).toEqual({
      courts: 1,
      queue: 1,
      matches: 1,
      match_players: 1,
      profiles: 1,
    });
  });

  // ── SD-20 (edge) ───────────────────────────────────────────
  it("SD-20 (edge): an event that lands just before unmount never fires a refetch afterwards", async () => {
    seedFullSession();
    const { unmount } = await renderLoaded();
    const before = countOf("queue_entries");

    vi.useFakeTimers();
    act(() => {
      fireRealtime("queue");
    });
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(REALTIME_REFETCH_DEBOUNCE_MS * 5);
    });

    expect(
      countOf("queue_entries") - before,
      "a debounced refetch scheduled before unmount still ran after it — the cleanup must cancel every pending debouncer, or a navigated-away page keeps issuing queries"
    ).toBe(0);
  });

  // ── SD-21 ──────────────────────────────────────────────────
  it("SD-21: refresh() re-reads all three targets", async () => {
    seedFullSession();
    const { result } = await renderLoaded();
    const before = {
      courts: countOf("courts"),
      queue: countOf("queue_entries"),
      matches: countOf("matches"),
    };

    await act(async () => {
      await result.current.refresh();
    });

    expect(
      {
        courts: countOf("courts") - before.courts,
        queue: countOf("queue_entries") - before.queue,
        matches: countOf("matches") - before.matches,
      },
      "refresh() no longer re-reads all three targets — it is what useVisibilityRefresh and the auth-recovery listener call, so a partial refresh leaves one panel stale after every tab-focus and every token refresh"
    ).toEqual({ courts: 1, queue: 1, matches: 1 });
  });

  // ── SD-22 (edge) ───────────────────────────────────────────
  it("SD-22 (edge): loading still reaches false when all three reads fail", async () => {
    setTable("courts", { data: null, error: { message: "down" } });
    setTable("queue_entries", { data: null, error: { message: "down" } });
    setTable("matches", { data: null, error: { message: "down" } });

    const { result } = renderHook(() => useSessionData(SESSION_ID));

    await waitFor(() =>
      expect(
        result.current.loading,
        "every read failed and the hook never left loading — the player is left staring at a spinner with no error and no way out"
      ).toBe(false)
    );
    expect(result.current.courts, "a failed first read invented courts").toEqual([]);
    expect(result.current.waitlist, "a failed first read invented queue rows").toEqual([]);
  });

  // ── SD-23 ──────────────────────────────────────────────────
  it("SD-23: auth recovery refetches on TOKEN_REFRESHED, but (negative) not on SIGNED_OUT", async () => {
    seedFullSession();
    await renderLoaded();
    expect(authListener, "the hook never registered an auth-state listener").not.toBeNull();

    const before = countOf("queue_entries");
    await act(async () => {
      authListener?.("SIGNED_OUT");
    });
    expect(
      countOf("queue_entries") - before,
      "SIGNED_OUT triggered a refetch — an anon read right after sign-out is exactly the success-with-zero-rows the hold guards exist to reject, and firing on every event makes the listener untestable as a recovery signal"
    ).toBe(0);

    await act(async () => {
      authListener?.("TOKEN_REFRESHED");
    });
    expect(
      countOf("queue_entries") - before,
      "auth recovery no longer refetches. Both halves of an auth outage depend on it: the fetches the hold guards refused, and the realtime events that never arrived while the socket was de-authed"
    ).toBe(1);
  });

  // ── SD-24 ──────────────────────────────────────────────────
  it("SD-24: a session id change re-binds every read and every channel to the new session", async () => {
    seedFullSession();
    const { rerender, result } = await renderLoaded();

    rerender({ id: OTHER_SESSION_ID });
    await waitFor(() =>
      expect(
        queryLog.some(
          (l) => l.table === "queue_entries" && l.ops.includes(`eq:session_id=${OTHER_SESSION_ID}`)
        ),
        "changing the session id did not re-read the waitlist for the NEW session — the player would keep seeing the previous session's queue"
      ).toBe(true)
    );

    expect(
      subscriptions
        .filter((s) => s.sessionId === OTHER_SESSION_ID)
        .map((s) => s.name)
        .sort(),
      "changing the session id did not re-open the channels against the new session — realtime updates for the session on screen would never arrive"
    ).toEqual(["courts", "match_players", "matches", "profiles", "queue"]);
    expect(
      unsubCounts,
      "the previous session's channels were left open when the id changed"
    ).toEqual({ courts: 1, queue: 1, matches: 1, match_players: 1, profiles: 1 });
    expect(result.current.loading, "the hook got stuck loading after a session id change").toBe(
      false
    );
  });
});
