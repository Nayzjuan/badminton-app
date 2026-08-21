// @vitest-environment happy-dom
// ============================================================
// useOrganizerQueue — the panel that must never blank, on a channel that
// must open once (OQ)
// ============================================================
// This hook is the organizer's live view of who is waiting. Four of its
// properties fail without an error, a log, or a red build:
//
//   1. SUBSCRIPTION STABILITY. Two channels — queue_entries and profiles — are
//      opened from one effect, and both handlers reach their fetchers through
//      `fetchQueueRef.current` / `fetchQueueProfilesRef.current` rather than
//      closing over the callbacks. CLAUDE.md: "Never break the subscription
//      stability pattern." A render-scoped value in that dependency array tears
//      both channels down and re-joins them on every render, and the production
//      symptom is not an exception — it is a player who joins during the
//      re-join window and simply never appears in the queue panel, until some
//      later event happens to trigger a refetch. OQ-12/OQ-13/OQ-14 pin the
//      three separable ways to break it: a widened effect dep, a fetcher that
//      stops being referentially stable, and the ref indirection being replaced
//      by the callback itself.
//
//   2. THE 07/25 BLANKING CLASS. A client whose auth died degrades to `anon`,
//      and the security_invoker view then returns SUCCESS WITH ZERO ROWS — an
//      outcome the error branch structurally cannot catch. Committing it wipes
//      a populated panel and reads to the organizer as "everyone left". So the
//      hook holds on empty-without-auth. OQ-6 is that negative and OQ-7 is its
//      positive control: an empty result WITH live auth must still commit, or a
//      genuinely emptied queue could never render.
//
//   3. THE SEQUENCE GUARD. `fetchQueueSeq` is a monotonic ref; only the newest
//      call commits. Realtime bursts (a publish touches every drafted row) fire
//      overlapping fetches routinely, and without the guard whichever request
//      the network happens to finish LAST wins — which is how a panel ends up
//      showing a roster that was already superseded. OQ-8 resolves an older
//      call after a newer one and asserts the newer result survives.
//
//   4. THE MEMBERSHIP KEY. `playerIdsKey` is a sorted, joined string so the
//      profiles refetch fires on a change of WHO is queued, not on every
//      reorder or wait-time tick — the queue array's identity changes on each
//      of those. `queueIdsRef` then supplies the live ids without dragging
//      `queue` into fetchQueueProfiles' deps. Break either and the panel
//      re-reads every queued player's profile several times a minute for the
//      whole session. OQ-18 is the suppression and OQ-19 its positive control.
//
// The profiles read is also a privacy boundary: it is projected to
// PUBLIC_PROFILE_COLUMNS specifically because profiles RLS is broadly
// permissive, so the COLUMN LIST — not the row policy — is what keeps another
// player's 4-digit reconnect PIN out of the browser response (OQ-20).
//
// Tests:
//   OQ-1   initial state — loading=true, empty queue, empty profile map
//   OQ-2   a successful read commits the view's rows verbatim, in view order
//   OQ-3   the read is bound to this session and carries the full ordering key
//   OQ-4   (negative) a read error leaves the populated panel intact
//   OQ-5   (edge) a null payload with no error also leaves the panel intact
//   OQ-6   (negative) empty + NO auth session holds the stale queue (07/25)
//   OQ-7   empty + live auth commits the empty queue (positive control, OQ-6)
//   OQ-8   an older in-flight fetch resolving LAST does not overwrite the newer
//   OQ-27  (edge) a fetch overtaken DURING its auth probe does not blank the
//          panel — the SECOND sequence check, which the first cannot cover
//   OQ-9   a realtime queue event refetches into state
//   OQ-10  a realtime profile event refetches the queue AND the profile map AND
//          notifies the composer
//   OQ-11  (edge) the composer callback is optional — a profile event with no
//          onProfileChange still refreshes both and does not throw
//   OQ-12  both channels are opened EXACTLY ONCE across re-renders and state
//          changes — the subscription-stability rule
//   OQ-13  fetchQueue keeps one identity across re-renders
//   OQ-14  the queue channel handler is the ref indirection, not fetchQueue
//   OQ-15  both channels are bound to this session and get their OWN status
//          reporters
//   OQ-16  unmount closes both channels and the auth-recovery listener
//   OQ-17  a sessionId change re-opens both channels (positive control, OQ-12)
//   OQ-18  (negative) a reorder / wait-time tick with the SAME membership does
//          not refetch profiles
//   OQ-19  a membership change DOES refetch, bound to the new id set (positive
//          control for OQ-18)
//   OQ-20  the profiles read is projected to PUBLIC_PROFILE_COLUMNS, bound to
//          the queued ids, merged (not replaced) into the map, with pin nulled
//   OQ-28  (negative) a failed profiles read leaves the existing map untouched
//   OQ-21  (edge) an empty queue never touches the profiles table at all
//   OQ-22  removeFromQueue forwards (sessionId, playerId) and does NOT refetch
//   OQ-23  pausePlayer forwards (sessionId, playerId, isPaused) and refetches
//   OQ-24  (negative) a refused action returns the reason and never starts the
//          refetch
//   OQ-25  (edge) a failure carrying neither message nor error still reports a
//          reason rather than silently succeeding
//   OQ-26  auth recovery refetches on TOKEN_REFRESHED and ignores other events
//
// WHAT THIS FILE DOES NOT PROVE
//   - That togglePlayerPause / removePlayerFromQueue authorize the caller or
//     bind their writes to the session. Both are mocked here; their guards are
//     covered in tests/unit/queue-actions.test.ts.
//   - That subscribeToQueue / subscribeToProfiles set the realtime JWT before
//     joining, or name their channels with a prefix. That is
//     tests/unit/realtime-auth-recycle.test.ts and the realtime suites; here
//     they are spies and only the CALL is observable.
//   - That hasAuthSession correctly classifies a half-dead session — the real
//     implementation runs here against a stub `auth.getSession`, so this file
//     pins the hook's REACTION to the answer, not the answer itself.
//   - Anything about the wait-time poll, the visibility refresh, or the
//     onProfilesLoaded bridge — those live in use-organizer-data.ts.
//
// IDs: OQ
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Profile, QueueFullWithWaitTime } from "@/types/database";
import { PUBLIC_PROFILE_COLUMNS } from "@/types/database";

// ── Realtime spies ────────────────────────────────────────────
// The hook imports exactly these two symbols from @/lib/realtime. Every
// subscribe is recorded so a channel-churn regression becomes countable.

type Sub = {
  client: unknown;
  sessionId: unknown;
  handler: () => void;
  channelPrefix: unknown;
  onStatus: unknown;
  unsub: ReturnType<typeof vi.fn>;
};

let queueSubs: Sub[] = [];
let profileSubs: Sub[] = [];

function record(bucket: Sub[]) {
  return (
    client: unknown,
    sessionId: unknown,
    handler: () => void,
    channelPrefix: unknown,
    onStatus: unknown
  ) => {
    const unsub = vi.fn();
    bucket.push({ client, sessionId, handler, channelPrefix, onStatus, unsub });
    return unsub;
  };
}

vi.mock("@/lib/realtime", () => ({
  subscribeToQueue: (
    client: unknown,
    sessionId: unknown,
    handler: () => void,
    channelPrefix: unknown,
    onStatus: unknown
  ) => record(queueSubs)(client, sessionId, handler, channelPrefix, onStatus),
  subscribeToProfiles: (
    client: unknown,
    sessionId: unknown,
    handler: () => void,
    channelPrefix: unknown,
    onStatus: unknown
  ) => record(profileSubs)(client, sessionId, handler, channelPrefix, onStatus),
}));

// A vi.mock factory REPLACES the module, so both symbols the hook imports have
// to be listed or they are `undefined` at import time.
vi.mock("@/app/actions/queue", () => ({
  togglePlayerPause: vi.fn(),
  removePlayerFromQueue: vi.fn(),
}));

// @/utils/supabase/client is deliberately NOT mocked: hasAuthSession is the
// real guard OQ-6/OQ-7 test, and it runs against the stub client's auth below.

import { useOrganizerQueue } from "@/hooks/use-organizer-queue";
import { togglePlayerPause, removePlayerFromQueue } from "@/app/actions/queue";

const mockPause = vi.mocked(togglePlayerPause);
const mockRemove = vi.mocked(removePlayerFromQueue);

// ── Fixtures ──────────────────────────────────────────────────

const SESSION_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER_SESSION_ID = "9f8e7d6c-5b4a-4938-8271-6a5b4c3d2e1f";
const QUEUE_VIEW = "v_queue_full_with_wait_time";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const P3 = "33333333-3333-4333-8333-333333333333";

function makeRow(
  playerId: string,
  over: Partial<QueueFullWithWaitTime> = {}
): QueueFullWithWaitTime {
  return {
    id: `qe-${playerId}`,
    session_id: SESSION_ID,
    player_id: playerId,
    joined_at: "2026-08-21T09:00:00.000Z",
    games_played: 0,
    status: "waiting",
    position: null,
    is_paused: false,
    paused_at: null,
    created_at: "2026-08-21T09:00:00.000Z",
    display_name: `Player ${playerId.slice(0, 2)}`,
    skill_level: "intermediate",
    skill_level_int: 3,
    wait_minutes: 5,
    is_bottleneck: false,
    status_priority: 2,
    ...over,
  };
}

/** A profiles row as the DB hands it back — carrying a `pin` on purpose, so
 *  OQ-20 can prove the hook nulls it rather than passing it through. */
function makeProfileRow(playerId: string): Profile {
  return {
    id: playerId,
    display_name: `Player ${playerId.slice(0, 2)}`,
    skill_level: "intermediate",
    pin: "4821",
    vip_tag: null,
    vip_theme: null,
    needs_rename: false,
    collided_name: null,
    flagged_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

// ── Recording Supabase stub ───────────────────────────────────
// Records every projection, filter and ordering as `op:column=value`, so a
// dropped or transposed argument is visible. A mock that recorded only table
// names would let a swapped .eq() pair through — same call count, different
// security boundary.

type Recorded = { table: string; ops: string[] };
type QueueResponse = { data: QueueFullWithWaitTime[] | null; error: { message: string } | null };
type ProfilesResponse = { data: Profile[] | null; error: { message: string } | null };

let recorded: Recorded[] = [];
let queueResponse: QueueResponse = { data: [], error: null };
let profilesResponse: ProfilesResponse = { data: [], error: null };
let authSession: { access_token: string } | null = { access_token: "test-jwt" };

/** When true, queue reads park until a test resolves them by hand — the only
 *  way to force the out-of-order completion OQ-8 needs. */
let queueDeferred = false;
const pendingQueueResolvers: Array<(r: QueueResponse) => void> = [];

/** Same trick for the auth probe. The hook re-checks the sequence AFTER
 *  awaiting hasAuthSession, and that second check is only reachable by a fetch
 *  that starts DURING the probe — see OQ-27. */
let authDeferred = false;
const pendingAuthResolvers: Array<(s: { access_token: string } | null) => void> = [];

let authListeners: Array<{ cb: (event: string) => void; unsubscribe: ReturnType<typeof vi.fn> }> =
  [];

function buildSupabase(): SupabaseClient<Database> {
  return {
    from(table: string) {
      const rec: Recorded = { table, ops: [] };
      recorded.push(rec);
      const chain: Record<string, unknown> = {
        select: (cols: string) => {
          rec.ops.push(`select:${cols}`);
          return chain;
        },
        eq: (col: string, val: unknown) => {
          rec.ops.push(`eq:${col}=${String(val)}`);
          return chain;
        },
        in: (col: string, vals: unknown) => {
          rec.ops.push(`in:${col}=${String(vals)}`);
          return chain;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          rec.ops.push(`order:${col}:${opts?.ascending ? "asc" : "desc"}`);
          return chain;
        },
        then: (onFulfilled: (v: QueueResponse | ProfilesResponse) => unknown) => {
          if (table !== QUEUE_VIEW) return Promise.resolve(profilesResponse).then(onFulfilled);
          if (queueDeferred) {
            return new Promise<QueueResponse>((resolve) =>
              pendingQueueResolvers.push(resolve)
            ).then(onFulfilled);
          }
          return Promise.resolve(queueResponse).then(onFulfilled);
        },
      };
      return chain;
    },
    auth: {
      getSession: () => {
        if (!authDeferred) return Promise.resolve({ data: { session: authSession } });
        return new Promise<{ access_token: string } | null>((resolve) =>
          pendingAuthResolvers.push(resolve)
        ).then((session) => ({ data: { session } }));
      },
      onAuthStateChange: (cb: (event: string) => void) => {
        const unsubscribe = vi.fn();
        authListeners.push({ cb, unsubscribe });
        return { data: { subscription: { unsubscribe } } };
      },
    },
  } as unknown as SupabaseClient<Database>;
}

/** One client identity for the whole file. An unstable client would make every
 *  subscription-stability assertion vacuous — the effect legitimately depends
 *  on it. */
const supabase = buildSupabase();

const onStatusQueue = vi.fn();
const onStatusProfiles = vi.fn();
const onProfileChange = vi.fn();

function queueReads(): Recorded[] {
  return recorded.filter((r) => r.table === QUEUE_VIEW);
}
function profileReads(): Recorded[] {
  return recorded.filter((r) => r.table === "profiles");
}

/** Flush pending microtasks AND the macrotask queue, so every awaited thenable
 *  has registered its resolver. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function renderQueue(withProfileChange = true) {
  return renderHook(() =>
    useOrganizerQueue(
      SESSION_ID,
      supabase,
      onStatusQueue,
      onStatusProfiles,
      withProfileChange ? onProfileChange : undefined
    )
  );
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  queueSubs = [];
  profileSubs = [];
  authListeners = [];
  recorded = [];
  queueResponse = { data: [], error: null };
  profilesResponse = { data: [], error: null };
  authSession = { access_token: "test-jwt" };
  queueDeferred = false;
  pendingQueueResolvers.length = 0;
  authDeferred = false;
  pendingAuthResolvers.length = 0;
  // The hook logs on a failed read (OQ-4) and on the auth-loss hold (OQ-6).
  // Silencing keeps the suite output honest about real failures.
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  consoleWarnSpy.mockRestore();
});

describe("useOrganizerQueue — Suite OQ", () => {
  // ── OQ-1 ────────────────────────────────────────────────────
  it("OQ-1: starts loading with an empty queue and an empty profile map", () => {
    queueResponse = { data: [makeRow(P1)], error: null };

    const { result } = renderQueue();

    expect(
      result.current.loading,
      "the hook reported loaded before the first read resolved — the queue panel renders 'nobody waiting' for a frame instead of a skeleton"
    ).toBe(true);
    expect(result.current.queue, "the queue started non-empty before any fetch").toEqual([]);
    expect(
      result.current.profiles.size,
      "the profile map started populated before any profile was read"
    ).toBe(0);
  });

  // ── OQ-2 ────────────────────────────────────────────────────
  it("OQ-2: a successful read commits the view's rows verbatim, in view order", async () => {
    const rows = [
      makeRow(P1, { status: "on_deck", status_priority: 0 }),
      makeRow(P2, { status: "drafted", status_priority: 1 }),
      makeRow(P3),
    ];
    queueResponse = { data: rows, error: null };

    const { result } = renderQueue();

    // Settle on the committed rows, not on `loading` — the initial loading flag
    // is OQ-1's property, and using it as the signal here would make an
    // unrelated regression in it redden this test too.
    await waitFor(() => expect(result.current.queue).toHaveLength(3));
    expect(
      result.current.queue,
      "the queue was re-shaped or re-sorted on the client — the panel's order IS the matchmaking order the view computed, and a client-side sort makes the organizer's next-up read disagree with what the engine will actually pick"
    ).toEqual(rows);
  });

  // ── OQ-3 ────────────────────────────────────────────────────
  it("OQ-3: the read is bound to this session and carries the full ordering key", async () => {
    queueResponse = { data: [makeRow(P1)], error: null };

    const { result } = renderQueue();
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(queueReads().length, "the queue view was never read").toBeGreaterThan(0);
    expect(
      queueReads()[0].ops,
      "the queue read's filter or ordering drifted. session_id must be BOUND TO THIS SESSION — asserting an eq() happened is not asserting which, and a transposed pair puts another session's queue on this organizer's screen. The three order keys are the display contract: status_priority first (on_deck, then drafted, then waiting), then games_played, then joined_at; dropping or reordering one silently re-ranks who the organizer thinks is next"
    ).toEqual([
      "select:*",
      `eq:session_id=${SESSION_ID}`,
      "order:status_priority:asc",
      "order:games_played:asc",
      "order:joined_at:asc",
    ]);
  });

  // ── OQ-4 (negative) ─────────────────────────────────────────
  it("OQ-4 (negative): a read error leaves the populated panel intact", async () => {
    const rows = [makeRow(P1), makeRow(P2)];
    queueResponse = { data: rows, error: null };

    const { result } = renderQueue();
    // Positive control: the panel really is populated before the failure, so
    // "still 2 rows" cannot be satisfied by a hook that never fetched.
    await waitFor(() => expect(result.current.queue).toHaveLength(2));

    queueResponse = { data: null, error: { message: "JWT expired" } };
    await act(async () => {
      await result.current.fetchQueue();
    });

    expect(
      result.current.queue,
      "a transient read failure blanked a populated queue panel — this is the 07/25 shape: the organizer watches every waiting player vanish, with nothing on screen saying anything went wrong"
    ).toEqual(rows);
    expect(
      consoleErrorSpy,
      "the read failure was swallowed without a log — that console line is the only trace this failure leaves in production"
    ).toHaveBeenCalled();
  });

  // ── OQ-5 (edge) ─────────────────────────────────────────────
  it("OQ-5 (edge): a null payload with no error also leaves the panel intact", async () => {
    queueResponse = { data: [makeRow(P1), makeRow(P2)], error: null };
    const { result } = renderQueue();
    await waitFor(() => expect(result.current.queue).toHaveLength(2));

    queueResponse = { data: null, error: null };
    await act(async () => {
      await result.current.fetchQueue();
    });

    expect(
      result.current.queue,
      "a null payload with no error was committed as an empty queue — PostgREST can answer this way on an aborted request, and treating it as 'nobody is waiting' empties the panel on a network hiccup"
    ).toHaveLength(2);
  });

  // ── OQ-6 (negative) ─────────────────────────────────────────
  it("OQ-6 (negative): an empty result WITHOUT an auth session holds the stale queue", async () => {
    queueResponse = { data: [makeRow(P1), makeRow(P2)], error: null };
    const { result } = renderQueue();
    await waitFor(() => expect(result.current.queue).toHaveLength(2));

    // Auth dies; the security_invoker view now filters every row and returns
    // SUCCESS with zero rows, which the error branch structurally cannot see.
    authSession = null;
    queueResponse = { data: [], error: null };
    await act(async () => {
      await result.current.fetchQueue();
    });

    expect(
      result.current.queue,
      "an anon-degraded empty result wiped the queue panel — the organizer sees 'nobody waiting' during a live session while twenty people stand on court, and nothing errors, because RLS filtering is a SUCCESS"
    ).toHaveLength(2);
    expect(
      consoleWarnSpy,
      "the hold happened silently — the warn line is what tells an operator the client is running as anon"
    ).toHaveBeenCalled();
  });

  // ── OQ-7 ────────────────────────────────────────────────────
  it("OQ-7: an empty result WITH live auth commits (positive control for OQ-6)", async () => {
    queueResponse = { data: [makeRow(P1)], error: null };
    const { result } = renderQueue();
    await waitFor(() => expect(result.current.queue).toHaveLength(1));

    queueResponse = { data: [], error: null };
    await act(async () => {
      await result.current.fetchQueue();
    });

    expect(
      result.current.queue,
      "a genuinely empty queue was held back as if it were an auth failure — the last player checking out would leave a ghost in the panel for the rest of the session, and OQ-6's hold would be indistinguishable from a hook that can never empty"
    ).toEqual([]);
  });

  // ── OQ-8 ────────────────────────────────────────────────────
  it("OQ-8: an older in-flight fetch resolving last does not overwrite the newer one", async () => {
    queueResponse = { data: [makeRow(P1)], error: null };
    const { result } = renderQueue();
    await waitFor(() => expect(result.current.queue).toHaveLength(1));

    const stale = [makeRow(P1)];
    const fresh = [makeRow(P1), makeRow(P2), makeRow(P3)];

    queueDeferred = true;
    await act(async () => {
      // Two overlapping fetches — exactly what a realtime burst produces when
      // publishing a match touches every drafted row at once.
      const older = result.current.fetchQueue();
      const newer = result.current.fetchQueue();
      await flush();
      expect(pendingQueueResolvers.length, "both fetches should be in flight").toBe(2);

      // The NEWER request answers first, then the older one lands late.
      pendingQueueResolvers[1]({ data: fresh, error: null });
      pendingQueueResolvers[0]({ data: stale, error: null });
      await Promise.all([older, newer]);
    });

    expect(
      result.current.queue,
      "a superseded fetch committed after the newer one — the seq guard is the only thing standing between a realtime burst and a queue panel that shows a roster the server already replaced, and the organizer then drafts a match from players who are no longer waiting"
    ).toEqual(fresh);
  });

  // ── OQ-27 ───────────────────────────────────────────────────
  it("OQ-27: a fetch overtaken DURING its auth probe does not blank the panel", async () => {
    queueResponse = { data: [makeRow(P1)], error: null };
    const { result } = renderQueue();
    await waitFor(() => expect(result.current.queue).toHaveLength(1));

    const fresh = [makeRow(P1), makeRow(P2), makeRow(P3)];

    await act(async () => {
      // Fetch A reads an empty result and parks inside hasAuthSession. It has
      // ALREADY cleared the post-read sequence check, so that check cannot
      // protect anything from here on.
      authDeferred = true;
      queueResponse = { data: [], error: null };
      const older = result.current.fetchQueue();
      await flush();
      expect(
        pendingAuthResolvers.length,
        "the empty result did not trigger an auth probe — the interleave this test needs never happened"
      ).toBe(1);

      // Fetch B starts inside that window, reads a full queue, and commits.
      queueResponse = { data: fresh, error: null };
      await result.current.fetchQueue();

      // A's auth probe finally answers — with a LIVE session, so the anon hold
      // will not save it. Only the post-auth sequence check can.
      pendingAuthResolvers[0]({ access_token: "test-jwt" });
      await older;
    });

    expect(
      result.current.queue,
      "a superseded fetch committed its empty result after the auth probe resolved, blanking a panel that had already been refilled. The post-read sequence check runs BEFORE the probe and is structurally blind to a fetch that starts during it — the probe is a network round trip on a token refresh, which is exactly when a burst of refetches is most likely"
    ).toEqual(fresh);
  });

  // ── OQ-9 ────────────────────────────────────────────────────
  it("OQ-9: a realtime queue event refetches into state", async () => {
    queueResponse = { data: [makeRow(P1)], error: null };
    const { result } = renderQueue();
    await waitFor(() => expect(result.current.queue).toHaveLength(1));

    queueResponse = { data: [makeRow(P1), makeRow(P2)], error: null };
    await act(async () => {
      queueSubs[0].handler();
    });

    await waitFor(() =>
      expect(
        result.current.queue,
        "a queue_entries realtime event did not reach state — a player joining from their phone would never appear in the organizer's panel"
      ).toHaveLength(2)
    );
  });

  // ── OQ-10 ───────────────────────────────────────────────────
  it("OQ-10: a realtime profile event refreshes the queue, the profile map, and the composer", async () => {
    queueResponse = { data: [makeRow(P1)], error: null };
    profilesResponse = { data: [makeProfileRow(P1)], error: null };
    const { result } = renderQueue();
    await waitFor(() => expect(result.current.queue).toHaveLength(1));
    await waitFor(() => expect(profileReads().length).toBeGreaterThan(0));

    const queueBefore = queueReads().length;
    const profilesBefore = profileReads().length;

    await act(async () => {
      profileSubs[0].handler();
    });

    expect(
      queueReads().length,
      "a profile change did not refetch the queue — the view carries skill_level, so an organizer's skill correction would not show on the queue card until an unrelated queue event happened to fire"
    ).toBe(queueBefore + 1);
    expect(
      profileReads().length,
      "a profile change did not refetch the profile map — vip_tag/vip_theme live only there, and the membership-keyed effect cannot fire for a field edit because the player's id never left the set"
    ).toBe(profilesBefore + 1);
    expect(
      onProfileChange,
      "the composer bridge was not called — active match cards keep rendering the pre-edit skill level until the next match event"
    ).toHaveBeenCalledTimes(1);
  });

  // ── OQ-11 (edge) ────────────────────────────────────────────
  it("OQ-11 (edge): a profile event with no onProfileChange still refreshes both and does not throw", async () => {
    queueResponse = { data: [makeRow(P1)], error: null };
    profilesResponse = { data: [makeProfileRow(P1)], error: null };
    const { result } = renderQueue(false);
    await waitFor(() => expect(result.current.queue).toHaveLength(1));
    await waitFor(() => expect(profileReads().length).toBeGreaterThan(0));

    const queueBefore = queueReads().length;
    const profilesBefore = profileReads().length;

    await act(async () => {
      expect(
        () => profileSubs[0].handler(),
        "the optional composer callback was invoked unguarded — every consumer that does not pass onProfileChange (the player-side surfaces) would throw inside a realtime handler, where the exception is swallowed and the channel is left half-wired"
      ).not.toThrow();
    });

    expect(
      queueReads().length,
      "the queue refresh was skipped when the optional callback was absent"
    ).toBe(queueBefore + 1);
    expect(
      profileReads().length,
      "the profile refresh was skipped when the optional callback was absent"
    ).toBe(profilesBefore + 1);
  });

  // ── OQ-12 ───────────────────────────────────────────────────
  it("OQ-12: both channels are opened exactly once across re-renders and state changes", async () => {
    queueResponse = { data: [makeRow(P1)], error: null };
    profilesResponse = { data: [makeProfileRow(P1)], error: null };

    const { result, rerender } = renderQueue();
    await waitFor(() => expect(result.current.queue).toHaveLength(1));

    for (let i = 0; i < 3; i++) rerender();

    // A realtime event changes `queue` state — the render-scoped value most
    // likely to be dragged into that dependency array by a refactor.
    queueResponse = { data: [makeRow(P1), makeRow(P2)], error: null };
    await act(async () => {
      queueSubs[0].handler();
    });
    await waitFor(() => expect(result.current.queue).toHaveLength(2));

    rerender();
    rerender();

    expect(
      queueSubs.length,
      "the queue realtime channel was re-opened on a render that changed neither supabase nor sessionId — CLAUDE.md's subscription-stability rule. Every re-join drops the events that arrive while the socket is down, so a player who joins in that window is simply missing from the panel, with no error anywhere"
    ).toBe(1);
    expect(
      profileSubs.length,
      "the profiles realtime channel was re-opened on an unrelated render — same failure, and it is the channel that carries VIP/skill edits"
    ).toBe(1);
    expect(
      queueSubs[0].unsub,
      "the live queue channel was torn down mid-session"
    ).not.toHaveBeenCalled();
    expect(
      profileSubs[0].unsub,
      "the live profiles channel was torn down mid-session"
    ).not.toHaveBeenCalled();
  });

  // ── OQ-13 ───────────────────────────────────────────────────
  it("OQ-13: fetchQueue keeps one identity across re-renders", async () => {
    queueResponse = { data: [makeRow(P1)], error: null };
    const { result, rerender } = renderQueue();
    await waitFor(() => expect(result.current.queue).toHaveLength(1));
    const first = result.current.fetchQueue;

    queueResponse = { data: [makeRow(P1), makeRow(P2)], error: null };
    await act(async () => {
      queueSubs[0].handler();
    });
    await waitFor(() => expect(result.current.queue).toHaveLength(2));
    rerender();

    expect(
      result.current.fetchQueue,
      "fetchQueue changed identity on a render — it is memoized on exactly (supabase, sessionId). Widening those deps re-runs the initial-load effect on every queue change, re-registers the auth-recovery listener, and arms the subscription-stability trap OQ-12 guards, because the ref is then the only thing keeping the channel off this callback"
    ).toBe(first);
  });

  // ── OQ-14 ───────────────────────────────────────────────────
  it("OQ-14: the queue channel handler goes through the ref, not the fetch callback", async () => {
    queueResponse = { data: [makeRow(P1)], error: null };
    const { result } = renderQueue();
    await waitFor(() => expect(result.current.queue).toHaveLength(1));

    // Precondition, deliberately not "exactly one" — channel COUNT is OQ-12's
    // property, and duplicating it here would make a churn regression redden a
    // test that names something else.
    expect(queueSubs.length, "no queue channel was opened at all").toBeGreaterThan(0);
    expect(
      queueSubs[0].handler,
      "the fetch callback was handed to subscribeToQueue directly instead of the `() => fetchQueueRef.current()` indirection — that is the exact edit that puts fetchQueue into the effect's dependency array, and from there any widening of the fetcher's own deps starts re-joining the realtime channel on every render"
    ).not.toBe(result.current.fetchQueue);

    // Positive control: the indirection still reaches the real fetcher.
    const before = queueReads().length;
    await act(async () => {
      queueSubs[0].handler();
    });
    expect(
      queueReads().length,
      "the channel handler no longer triggers a read — the indirection exists to keep the channel stable, not to disconnect it from the fetcher"
    ).toBe(before + 1);
  });

  // ── OQ-15 ───────────────────────────────────────────────────
  it("OQ-15: both channels are bound to this session and get their own status reporters", async () => {
    queueResponse = { data: [], error: null };
    const { result } = renderQueue();
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(
      queueSubs[0].sessionId,
      "the queue channel was opened against something other than this session — subscribeToQueue builds both the channel name and the postgres_changes filter from it, so a wrong value subscribes the organizer to another session's queue"
    ).toBe(SESSION_ID);
    expect(profileSubs[0].sessionId, "the profiles channel was bound to the wrong session").toBe(
      SESSION_ID
    );
    expect(queueSubs[0].client, "the queue channel used a different client than the reads").toBe(
      supabase
    );
    expect(
      queueSubs[0].channelPrefix,
      "a channel prefix appeared where the hook passes none; the prefix sits between the handler and the status reporter, so a value here means the arguments shifted"
    ).toBeUndefined();
    expect(
      queueSubs[0].onStatus,
      "the queue channel's status reporter is missing or crossed — the connection indicator would report the wrong channel's health"
    ).toBe(onStatusQueue);
    expect(
      profileSubs[0].onStatus,
      "the profiles channel got the queue channel's status reporter — two channels reporting under one id means a dead profiles channel shows as healthy"
    ).toBe(onStatusProfiles);
  });

  // ── OQ-16 ───────────────────────────────────────────────────
  it("OQ-16: unmount closes both channels and the auth-recovery listener", async () => {
    queueResponse = { data: [], error: null };
    const { result, unmount } = renderQueue();
    await waitFor(() => expect(result.current.loading).toBe(false));

    const liveQueue = queueSubs[queueSubs.length - 1];
    const liveProfiles = profileSubs[profileSubs.length - 1];
    const liveAuth = authListeners[authListeners.length - 1];
    const before = {
      q: liveQueue.unsub.mock.calls.length,
      p: liveProfiles.unsub.mock.calls.length,
      a: liveAuth.unsubscribe.mock.calls.length,
    };

    unmount();

    expect(
      liveQueue.unsub.mock.calls.length,
      "the queue channel outlived the dashboard — a leaked channel keeps firing refetches into an unmounted tree and burns a slot in the client's channel budget for the life of the page"
    ).toBe(before.q + 1);
    expect(
      liveProfiles.unsub.mock.calls.length,
      "the profiles channel was leaked on unmount — the cleanup must close BOTH, and closing only the first is the easy half-fix"
    ).toBe(before.p + 1);
    expect(
      liveAuth.unsubscribe.mock.calls.length,
      "the auth-recovery listener was leaked — every TOKEN_REFRESHED then fires a refetch through a dead hook for the rest of the page's life"
    ).toBe(before.a + 1);
  });

  // ── OQ-17 ───────────────────────────────────────────────────
  it("OQ-17: a sessionId change re-opens both channels (positive control for OQ-12)", async () => {
    queueResponse = { data: [], error: null };
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) =>
        useOrganizerQueue(id, supabase, onStatusQueue, onStatusProfiles, onProfileChange),
      { initialProps: { id: SESSION_ID } }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    const opened = queueSubs.length;
    expect(opened, "no queue channel was opened at all").toBeGreaterThan(0);
    const previousQueue = queueSubs[queueSubs.length - 1];
    const previousProfiles = profileSubs[profileSubs.length - 1];

    rerender({ id: OTHER_SESSION_ID });

    expect(
      queueSubs.length,
      "switching sessions did not open a new queue channel — OQ-12's 'exactly once' would then be satisfied by an effect that simply never re-runs, and an organizer moving between sessions would keep receiving the old session's queue events"
    ).toBeGreaterThan(opened);
    expect(
      previousQueue.unsub,
      "the previous session's queue channel was left open — its events keep arriving and refetching against the new session"
    ).toHaveBeenCalledTimes(1);
    expect(
      previousProfiles.unsub,
      "the previous session's profiles channel was left open"
    ).toHaveBeenCalledTimes(1);
    expect(
      queueSubs[queueSubs.length - 1].sessionId,
      "the new queue channel was not bound to the new session id"
    ).toBe(OTHER_SESSION_ID);
  });

  // ── OQ-18 (negative) ────────────────────────────────────────
  it("OQ-18 (negative): a reorder / wait-time tick with the same membership does not refetch profiles", async () => {
    queueResponse = { data: [makeRow(P1), makeRow(P2)], error: null };
    profilesResponse = { data: [makeProfileRow(P1), makeProfileRow(P2)], error: null };

    const { result } = renderQueue();
    await waitFor(() => expect(result.current.queue).toHaveLength(2));
    await waitFor(() => expect(profileReads().length).toBeGreaterThan(0));
    // Counted as a DELTA, not a total: how many reads the hook has issued since
    // mount is OQ-21's property, and duplicating it here would make an
    // unrelated regression redden a test that names something else.
    const before = profileReads().length;

    // Same two players, reordered, with fresh wait_minutes — precisely what the
    // 45 s wait-time poll and any reorder produce. New array identity, same set.
    queueResponse = {
      data: [makeRow(P2, { wait_minutes: 12 }), makeRow(P1, { wait_minutes: 9 })],
      error: null,
    };
    await act(async () => {
      queueSubs[0].handler();
    });
    // Settle on the new wait_minutes, not on a position — row ORDER is OQ-2's
    // property, and this test is only about the membership being unchanged.
    await waitFor(() => expect(result.current.queue.map((q) => q.wait_minutes)).toContain(12));

    expect(
      profileReads().length,
      "a reorder or wait-time tick refetched every queued player's profile. The queue array gets a new identity on every poll, so keying the profile fetch on it — rather than on the sorted membership string — turns one read per membership change into a read every few seconds, for every organizer, all session long"
    ).toBe(before);
  });

  // ── OQ-19 ───────────────────────────────────────────────────
  it("OQ-19: a membership change DOES refetch, bound to the new id set (positive control for OQ-18)", async () => {
    queueResponse = { data: [makeRow(P1), makeRow(P2)], error: null };
    profilesResponse = { data: [makeProfileRow(P1), makeProfileRow(P2)], error: null };

    const { result } = renderQueue();
    await waitFor(() => expect(result.current.queue).toHaveLength(2));
    await waitFor(() => expect(profileReads().length).toBeGreaterThan(0));
    const before = profileReads().length;

    queueResponse = { data: [makeRow(P1), makeRow(P2), makeRow(P3)], error: null };
    profilesResponse = {
      data: [makeProfileRow(P1), makeProfileRow(P2), makeProfileRow(P3)],
      error: null,
    };
    await act(async () => {
      queueSubs[0].handler();
    });
    await waitFor(() => expect(result.current.queue).toHaveLength(3));

    await waitFor(() =>
      expect(
        profileReads().length,
        "a new player joining did not refetch profiles — OQ-18's suppression would then be indistinguishable from an effect that never fires, and the newcomer's card would render with no name, skill or VIP treatment"
      ).toBe(before + 1)
    );
    // Compared as a SET: which ids are bound is this test's property, the order
    // the view happened to return them in is OQ-2's.
    const boundOp = profileReads()[profileReads().length - 1].ops.find((op) =>
      op.startsWith("in:id=")
    );
    expect(boundOp, "the profile refetch issued no id filter at all").toBeDefined();
    expect(
      boundOp!.slice("in:id=".length).split(",").sort(),
      "the profile refetch was not bound to the CURRENT queued ids — queueIdsRef is what supplies them, and a stale or truncated ref means the newcomer's profile is never requested and their card renders with no name, skill or VIP treatment"
    ).toEqual([P1, P2, P3].sort());
  });

  // ── OQ-20 ───────────────────────────────────────────────────
  it("OQ-20: the profiles read is column-limited, id-bound, merged, and pin-stripped", async () => {
    queueResponse = { data: [makeRow(P1)], error: null };
    profilesResponse = { data: [makeProfileRow(P1)], error: null };

    const { result } = renderQueue();
    await waitFor(() => expect(result.current.queue).toHaveLength(1));
    await waitFor(() => expect(profileReads().length).toBeGreaterThan(0));
    const before = profileReads().length;

    // Seed an entry the queue does not contain — the composer merges match
    // enrichment into this same map via setProfiles.
    const outsider = makeProfileRow(P3);
    act(() => {
      result.current.setProfiles((prev) => new Map(prev).set(P3, outsider));
    });

    // Force a further profiles read (a VIP edit arrives on the profiles channel).
    await act(async () => {
      profileSubs[0].handler();
    });
    await waitFor(() => expect(profileReads().length).toBe(before + 1));
    const read = profileReads()[profileReads().length - 1];

    expect(
      read.ops,
      "the profiles projection widened past PUBLIC_PROFILE_COLUMNS. profiles RLS is deliberately permissive — the leaderboard and the Wrapped share page both read arbitrary profiles unauthenticated — so the COLUMN LIST, not the row policy, is the only thing keeping another player's 4-digit reconnect PIN out of the browser response"
    ).toContain(`select:${PUBLIC_PROFILE_COLUMNS}`);
    expect(
      read.ops,
      "the profiles read is no longer bounded to the queued player ids — an unbounded read pulls the whole club's profile table into the organizer's tab on every membership change"
    ).toContain(`in:id=${P1}`);

    expect(
      result.current.profiles.get(P1)?.pin,
      "a pin survived into the in-memory profile map — the hook nulls it on the way in precisely so a widened projection cannot leak one into client state, React DevTools, or an error report"
    ).toBeNull();
    expect(
      result.current.profiles.get(P3),
      "the profile map was REPLACED rather than merged — the composer feeds match-enrichment profiles into this same map, and replacing it drops every player who is on court but not in the queue, blanking their match cards"
    ).toEqual(outsider);
  });

  // ── OQ-28 (negative) ────────────────────────────────────────
  it("OQ-28 (negative): a failed profiles read leaves the existing map untouched", async () => {
    queueResponse = { data: [makeRow(P1)], error: null };
    profilesResponse = { data: [makeProfileRow(P1)], error: null };

    const { result } = renderQueue();
    await waitFor(() => expect(result.current.queue).toHaveLength(1));
    await waitFor(() => expect(result.current.profiles.get(P1)).toBeDefined());
    const loaded = result.current.profiles.get(P1);
    const before = profileReads().length;

    // The profiles read now fails the way a dead token fails it.
    profilesResponse = { data: null, error: { message: "JWT expired" } };
    await act(async () => {
      profileSubs[0].handler();
    });
    await waitFor(() => expect(profileReads().length).toBe(before + 1));

    expect(
      result.current.profiles.get(P1),
      "a failed profiles read emptied the profile map — every queue card then loses its name, skill badge and VIP treatment on one transient failure, and nothing refills the map until the SET of queued players next changes, which on a busy court can be several minutes"
    ).toEqual(loaded);
  });

  // ── OQ-21 (edge) ────────────────────────────────────────────
  it("OQ-21 (edge): an empty queue never touches the profiles table", async () => {
    queueResponse = { data: [], error: null };

    const { result } = renderQueue();
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(
      profileReads(),
      "an empty queue still issued a profiles read — with no ids, `in('id', [])` is a request that can only return nothing, and it fires on every mount of a session that has not started yet"
    ).toEqual([]);
  });

  // ── OQ-22 ───────────────────────────────────────────────────
  it("OQ-22: removeFromQueue forwards (sessionId, playerId), returns {}, and does not refetch", async () => {
    queueResponse = { data: [makeRow(P1)], error: null };
    mockRemove.mockResolvedValue({ success: true });

    const { result } = renderQueue();
    await waitFor(() => expect(result.current.queue).toHaveLength(1));
    const before = queueReads().length;

    let out!: { error?: string };
    await act(async () => {
      out = await result.current.removeFromQueue(P1);
    });

    expect(
      mockRemove,
      "removeFromQueue's positional arguments drifted — the action authorizes on argument 1 and kicks argument 2, so a transposed pair authorizes against a player id and removes against a session id"
    ).toHaveBeenCalledWith(SESSION_ID, P1);
    expect(out, "a successful kick reported an error to the UI").toEqual({});
    expect(
      queueReads().length,
      "removeFromQueue refetched the queue itself. It is wired with NO refreshers on purpose: the RPC cancels matches and rewrites other players' rows, and the realtime event is what carries that whole cascade — a local refetch races it and re-renders a half-applied state"
    ).toBe(before);
  });

  // ── OQ-23 ───────────────────────────────────────────────────
  it("OQ-23: pausePlayer forwards (sessionId, playerId, isPaused) and refetches the queue once", async () => {
    queueResponse = { data: [makeRow(P1)], error: null };
    mockPause.mockResolvedValue({ success: true });

    const { result } = renderQueue();
    await waitFor(() => expect(result.current.queue).toHaveLength(1));
    const before = queueReads().length;

    let out!: { error?: string };
    await act(async () => {
      out = await result.current.pausePlayer(P1, true);
    });

    expect(
      mockPause,
      "pausePlayer's positional arguments drifted — (sessionId, playerId, isPaused) transposed either pauses the wrong player or sends a boolean where the server expects an id, and the server's UUID guard would refuse it as 'invalid session'"
    ).toHaveBeenCalledWith(SESSION_ID, P1, true);
    expect(out, "a successful pause reported an error").toEqual({});
    expect(
      queueReads().length,
      "pausing did not refresh the queue — is_paused drives the greyed-out card AND the engine's exclusion, so the organizer would keep seeing the player as selectable until an unrelated event fired"
    ).toBe(before + 1);
  });

  // ── OQ-24 (negative) ────────────────────────────────────────
  it("OQ-24 (negative): a refused action returns the reason and never starts the refetch", async () => {
    queueResponse = { data: [makeRow(P1)], error: null };
    mockPause.mockResolvedValue({ success: false, error: "Not authorized." });
    mockRemove.mockResolvedValue({ success: false, error: "Player not in queue." });

    const { result } = renderQueue();
    await waitFor(() => expect(result.current.queue).toHaveLength(1));
    const before = queueReads().length;

    let pauseOut!: { error?: string };
    let removeOut!: { error?: string };
    await act(async () => {
      pauseOut = await result.current.pausePlayer(P1, true);
      removeOut = await result.current.removeFromQueue(P1);
    });

    expect(
      pauseOut.error,
      "a refused pause did not surface the server's reason — the wrapper reads `message` first and falls back to `error`, and these actions answer on `error`, so dropping the fallback turns every refusal into a silent no-op the organizer reads as success"
    ).toBe("Not authorized.");
    expect(removeOut.error, "a refused kick did not surface the server's reason").toBe(
      "Player not in queue."
    );
    expect(
      queueReads().length,
      "a refused action still ran its refreshers — the guard must stop the downstream work from STARTING, not merely change what the caller is told; refetching on refusal repaints the panel and makes a rejected write look like it landed"
    ).toBe(before);
  });

  // ── OQ-25 (edge) ────────────────────────────────────────────
  it("OQ-25 (edge): a failure carrying neither message nor error still reports a reason", async () => {
    queueResponse = { data: [makeRow(P1)], error: null };
    mockPause.mockResolvedValue({ success: false });

    const { result } = renderQueue();
    await waitFor(() => expect(result.current.queue).toHaveLength(1));

    let out!: { error?: string };
    await act(async () => {
      out = await result.current.pausePlayer(P1, true);
    });

    expect(
      out.error,
      "a bare success:false produced an undefined error — the caller shows a toast built from this string, so an undefined reason renders an empty toast and the organizer retries the same refused action forever"
    ).toBe("Action failed");
  });

  // ── OQ-26 ───────────────────────────────────────────────────
  it("OQ-26: auth recovery refetches on TOKEN_REFRESHED and ignores unrelated events", async () => {
    queueResponse = { data: [makeRow(P1)], error: null };
    const { result } = renderQueue();
    await waitFor(() => expect(result.current.queue).toHaveLength(1));
    expect(authListeners.length, "no auth listener was registered").toBeGreaterThan(0);
    const listener = authListeners[authListeners.length - 1];

    // Negative first: an unrelated transition must not refetch.
    const before = queueReads().length;
    await act(async () => {
      listener.cb("USER_UPDATED");
    });
    expect(
      queueReads().length,
      "every auth event refetched the queue — the listener fires on transitions that carry no recovery (USER_UPDATED, PASSWORD_RECOVERY), and refetching on all of them multiplies reads on a surface that already polls"
    ).toBe(before);

    // Positive control: recovery pulls the fresh queue in.
    queueResponse = { data: [makeRow(P1), makeRow(P2)], error: null };
    await act(async () => {
      listener.cb("TOKEN_REFRESHED");
    });

    await waitFor(() =>
      expect(
        result.current.queue,
        "auth recovery did not refetch — an organizer whose token died mid-session holds a stale panel (OQ-6) forever, because the hold is only correct if something reconverges when auth comes back"
      ).toHaveLength(2)
    );
  });
});
