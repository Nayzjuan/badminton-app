// ============================================================
// Scenario R — Resilience & realtime delivery (PRs #45 / #46 / #48)
// ============================================================
// The 07/25 incident ("kicked out of the queue") and its three
// follow-up PRs are covered extensively by unit tests. This file
// deliberately covers only what a unit test physically cannot:
// behaviour that depends on a real Supabase Realtime socket, a
// real RLS-gated private broadcast channel, and a real browser.
//
//   [R-1] Broadcast delivery — an auto-matchmaking toggle in one
//         organizer context reaches a SECOND organizer context.
//         This travels by broadcast, never by postgres_changes:
//         use-organizer-session.ts strips is_auto_matchmaking_on
//         from the postgres_changes payload on purpose, because
//         the sessions RLS SELECT policy would never deliver that
//         UPDATE to a co-organizer.
//
//   [R-2] Session close → the player is redirected, and WHERE
//         depends on the player. Since 2026-08-11 the destination
//         is decided per viewer: compute_session_wrapped builds
//         its rows from completed matches, so a player who never
//         finished one has no recap and must land on the club
//         lobby rather than an all-zero Wrapped. Both branches are
//         covered below.
//
//         Close now has THREE independent delivery paths (the
//         broadcast, a postgres_changes UPDATE on the session row,
//         and a status poll — APP_MANIFEST §3.31), so unlike the
//         rest of this file it is no longer broadcast-only. It
//         still belongs here because only a real socket against a
//         real RLS-gated channel can show that a FAST path is the
//         one doing the work: the 20s poll is suppressed and the
//         elapsed time is bounded, so a run that only recovers on
//         the safety net fails instead of passing slow. (The toast
//         does NOT identify the path — leaveClosedSession emits the
//         same one whichever signal fired. It is asserted because
//         it is the user-visible half of the contract.)
//
//         SCOPE: these two assert the COMPOSITE destination, not
//         the client's own probe. leaveClosedSession calls
//         router.refresh() before it pushes, and the play page's
//         RSC runs the identical per-viewer branch server-side and
//         normally wins the race — by design, see the comment in
//         c/[clubSlug]/(full)/play/[sessionId]/page.tsx. So a
//         resolveDestination that always answered "Wrapped" would
//         still pass R-2a — and the mirror holds for R-2b, where
//         one hard-coded to the lobby would pass just the same.
//         That branch is covered exhaustively in
//         tests/unit/use-organizer-broadcast-closure.test.ts; what
//         cannot be unit-tested, and is what these cover, is that
//         a real close over a real socket puts a real browser on
//         the right page.
//
//   [R-3] Auth-loss HOLD — the core of the 07/25 fix. Destroy a
//         live client's auth cookies, force a refetch, and prove
//         the populated UI is HELD rather than wiped by the
//         success-with-zero-rows that RLS returns to anon.
//
//   [R-4] FLIP transitions actually run — asserted by recording
//         real WAAPI calls, not by racing getAnimations().
//
//   [R-5] draft_cap_phase reaches a SECOND organizer and locks it
//         out. This is the end-to-end proof for the 2026-08-04 fix:
//         the emit used to live in a "use client" hook, where the
//         service-role key does not exist, so postBroadcast bailed
//         at its missing-key guard and no co-organizer was ever
//         locked out. Nothing below the socket can catch that —
//         the REST endpoint answers 202 either way, and a unit test
//         mocking fetch sees a "successful" send.
//
// SCOPE NOTE: the recovery half of the 07/25 fix (refetch on
// TOKEN_REFRESHED / SIGNED_IN) is intentionally NOT covered here.
// useAuthRecoveryRefetch listens to onAuthStateChange, and
// re-adding cookies from Playwright emits no auth event —
// supabase-js does not watch cookie storage. Asserting it here
// would produce a test that passes for the wrong reason. That
// path is unit-tested (tests/unit/use-auth-recovery-refetch).
// ============================================================

import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import dotenv from "dotenv";
import path from "path";

import { adminDb } from "../helpers/admin-db";
import { resetSandboxSession, seedSession, getSandboxClubSlug } from "../helpers/teardown";
import { clubBase, clubOrganizer, clubPlay, clubWrapped } from "../../src/lib/club-paths";
import {
  ensureOrganizerAccount,
  signInOrganizerBot,
  getOrganizerUserId,
  ORGANIZER_STORAGE_STATE,
} from "../fixtures/auth";

dotenv.config({ path: path.resolve(__dirname, "../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), override: false });

const BASE_URL = process.env.TEST_BASE_URL!;
const SESSION_ID = process.env.TEST_SESSION_ID!;
let CLUB_SLUG: string;

const BYPASS_HEADERS: Record<string, string> = process.env.VERCEL_BYPASS_SECRET
  ? { "x-vercel-protection-bypass": process.env.VERCEL_BYPASS_SECRET }
  : {};

// The organizer header's auto-matchmaking toggle only renders its
// data-testid on the desktop (lg:) breakpoint — below 1024px a
// different, test-id-less button is used instead.
const DESKTOP = { width: 1440, height: 900 };

/** A context that is signed in as the organizer bot, on desktop. */
async function organizerContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    storageState: ORGANIZER_STORAGE_STATE,
    extraHTTPHeaders: BYPASS_HEADERS,
    viewport: DESKTOP,
    // useFlipList reads prefers-reduced-motion directly via matchMedia
    // (WAAPI cannot be reached from the globals.css reduced-motion block),
    // so a machine with "Reduce Motion" enabled would silently disable
    // every animation. Pin it so [R-4] tests the same thing everywhere.
    reducedMotion: "no-preference",
  });
}

/**
 * Blind `window.setInterval` to ONE cadence, before the app loads.
 *
 * Every polling fallback in this app is a bare `setInterval` with a literal
 * period, so the period is the only handle a test has on it. Matching on the
 * exact millisecond value is crude but precise: it takes out the timer under
 * test and nothing else. Callers below name the cadence they are suppressing
 * and say why.
 *
 * The zero handle is safe — the app's `clearInterval(0)` is a no-op.
 */
async function suppressInterval(
  page: import("@playwright/test").Page,
  periodMs: number
): Promise<void> {
  await page.addInitScript((target: number) => {
    const real = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...rest: unknown[]) =>
      timeout === target ? 0 : real(handler, timeout, ...rest)) as typeof window.setInterval;
  }, periodMs);
}

/**
 * Neutralise the observer's polling fallback BEFORE the app loads.
 *
 * useOrganizerSession re-fetches the whole session every 15s, which means a
 * completely dead broadcast channel still ends up with the right state — just
 * late. That is exactly how the "realtime:" topic-prefix bug (fixed 2026-08-04
 * in src/lib/broadcast.ts) survived in production: [R-1] passed on the poll.
 * Suppressing the 15s timer makes the private broadcast the expected path, so a
 * regression fails instead of running slow.
 *
 * Not airtight, and deliberately so: two non-broadcast refresh paths in
 * use-organizer-session.ts survive this patch — the `visibilitychange` handler
 * and the Layer-3 refetch that fires when `realtimeConnected` goes false→true.
 * A realtime reconnect inside the assertion window could still carry the state
 * across. Neutralising those would mean disabling the very reconnect machinery
 * PR #48 added, so the residual is accepted; it can only ever mask a
 * regression, never invent a pass on a channel that works.
 *
 * The patch is global and also silences the 15s timers in use-queue.ts,
 * use-leaderboard.ts and use-tv-board.ts — none of which these tests read.
 */
async function suppressPollingFallback(page: import("@playwright/test").Page): Promise<void> {
  await suppressInterval(page, 15_000);
}

test.beforeAll(async ({ browser }) => {
  await ensureOrganizerAccount();
  CLUB_SLUG = await getSandboxClubSlug();
  const context = await browser.newContext({ extraHTTPHeaders: BYPASS_HEADERS });
  const page = await context.newPage();
  try {
    await signInOrganizerBot(page, BASE_URL);
  } finally {
    await context.close();
  }
});

test.beforeEach(async () => {
  await resetSandboxSession();
});

test.afterAll(async () => {
  await resetSandboxSession();
});

// ─────────────────────────────────────────────────────────────
// [R-1] Broadcast delivery across two organizer contexts
// ─────────────────────────────────────────────────────────────
test.describe("Resilience — [R-1] private broadcast reaches a second client", () => {
  test("toggling auto-matchmaking in one organizer tab flips it in another", async ({
    browser,
  }) => {
    await seedSession("all_waiting");

    const ctxA = await organizerContext(browser);
    const ctxB = await organizerContext(browser);
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    // The observer must learn about this through the broadcast, not the poll.
    await suppressPollingFallback(pageB);

    try {
      const url = `${BASE_URL}${clubOrganizer(CLUB_SLUG, SESSION_ID)}`;
      await Promise.all([pageA.goto(url), pageB.goto(url)]);

      const toggleA = pageA.getByTestId("toggle-auto-matchmaking");
      const toggleB = pageB.getByTestId("toggle-auto-matchmaking");
      await expect(toggleA).toBeVisible({ timeout: 25_000 });
      await expect(toggleB).toBeVisible({ timeout: 25_000 });

      // resetSandboxSession() leaves is_auto_matchmaking_on = false.
      await expect(toggleB).toHaveAttribute("aria-pressed", "false");

      // Give B's private channel time to finish its join. The channel is
      // `private: true` and defers behind whenRealtimeAuthReady(), so a
      // broadcast sent before the join completes is simply never delivered
      // — there is no replay. This wait is what makes the test meaningful:
      // without it, a failure would be ambiguous between "broadcast broken"
      // and "we raced the subscription".
      await pageB.waitForTimeout(3_000);

      await toggleA.click();

      // B learns about this ONLY through the broadcast channel
      // `session-events:{sessionId}`, event `auto_matchmaking_toggled` — the
      // postgres_changes handler strips is_auto_matchmaking_on (see
      // use-organizer-session.ts) and the 15s poll is disabled above.
      await expect(toggleB).toHaveAttribute("aria-pressed", "true", { timeout: 12_000 });

      // And the server really committed it — not just an optimistic paint.
      // (A's own button flips optimistically via pendingAuto, so asserting
      // on A would prove nothing about the server or the broadcast.)
      await expect
        .poll(
          async () => {
            const { data } = await adminDb()
              .from("sessions")
              .select("is_auto_matchmaking_on")
              .eq("id", SESSION_ID)
              .single();
            return data?.is_auto_matchmaking_on ?? null;
          },
          { timeout: 15_000 }
        )
        .toBe(true);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [R-2] Session close → the player is routed, per viewer
// ─────────────────────────────────────────────────────────────

/**
 * Kill the closure watcher's 20s safety-net poll, so only the two FAST paths
 * (the private broadcast and the `sessions` row postgres_changes stream) can
 * move the player.
 *
 * Same reasoning as suppressPollingFallback: the reported symptom was "the
 * wrap didn't fire right away", and a test that accepts a poll-covered
 * redirect 20s later would have passed on the very bug this fixes. The
 * event-driven triggers inside the same effect (visibilitychange, channel
 * status) are deliberately left alone — they are fast paths too, and
 * neutralising them would mean disabling the reconnect recovery itself.
 *
 * Targets SESSION_STATUS_POLL_MS (20000) in use-session-closed-watcher.ts.
 */
async function suppressClosurePoll(page: import("@playwright/test").Page): Promise<void> {
  await suppressInterval(page, 20_000);
}

test.describe("Resilience — [R-2] session close reaches the player", () => {
  /**
   * Put the organizer bot in the queue. `seedSession` only queues the five
   * player bots, and the bot is the identity both tabs are signed in as.
   */
  async function queueOrganizerBot(organizerId: string): Promise<void> {
    const { error } = await adminDb().from("queue_entries").insert({
      session_id: SESSION_ID,
      player_id: organizerId,
      status: "waiting",
    });
    if (error) throw new Error(`[R-2] Failed to queue the organizer bot: ${error.message}`);
  }

  /**
   * Open a player tab and an organizer tab on the sandbox session, close the
   * session from the organizer, and assert the player is moved to
   * `expectedPath`.
   *
   * The toast is probed CONCURRENTLY with the URL, never before it. Serially,
   * a missed toast burns its own timeout and then poisons the elapsed-time
   * assertion below — the test would fail claiming the redirect was slow when
   * the redirect was fine and the toast was the casualty. Racing them keeps
   * each failure reported as itself.
   *
   * Both are asserted, because they fail differently: no toast means no close
   * signal reached this client at all, whereas a toast with no navigation means
   * the handler ran and the destination probe or router.push behind it is what
   * broke. The diagnostic carries every URL the player visited and their
   * console — a private-channel authorization refusal only ever surfaces there.
   */
  async function expectPlayerRoutedOnClose(browser: Browser, expectedPath: string): Promise<void> {
    const playerCtx = await organizerContext(browser);
    const organizerCtx = await organizerContext(browser);
    const playerPage = await playerCtx.newPage();
    const organizerPage = await organizerCtx.newPage();

    await suppressClosurePoll(playerPage);

    const playerConsole: string[] = [];
    playerPage.on("console", (m) => playerConsole.push(`${m.type()}: ${m.text()}`));
    const playerUrls: string[] = [];
    playerPage.on("framenavigated", (f) => {
      if (f === playerPage.mainFrame()) playerUrls.push(f.url());
    });

    try {
      await playerPage.goto(`${BASE_URL}${clubPlay(CLUB_SLUG, SESSION_ID)}`);
      await playerPage.waitForSelector('[role="tablist"]', { timeout: 25_000 });

      await organizerPage.goto(`${BASE_URL}${clubOrganizer(CLUB_SLUG, SESSION_ID)}`);
      await expect(organizerPage.getByTestId("toggle-auto-matchmaking")).toBeVisible({
        timeout: 25_000,
      });

      // Let the player's private channel finish its join. `session_closed` is
      // fire-and-forget with no replay, so a close sent before the join
      // completes is missed on that path forever.
      await playerPage.waitForTimeout(3_000);

      const closedAt = Date.now();
      await organizerPage.getByRole("button", { name: "Close Session" }).click();
      await organizerPage.getByRole("button", { name: "Yes, close session" }).click();

      // The handler toasts, then routes WRAPPED_REDIRECT_DELAY_MS (250ms)
      // later — after resolving where THIS viewer belongs. `.first()` because
      // a re-render can leave two live sonner nodes with the same copy, which
      // would otherwise trip strict mode and read as "no toast".
      const [arrival, toastSeen] = await Promise.all([
        playerPage.waitForURL(`**${expectedPath}`, { timeout: 25_000 }).then(
          () => ({ ok: true as const, elapsedMs: Date.now() - closedAt }),
          (err: Error) => ({ ok: false as const, err })
        ),
        expect(playerPage.getByText(/time to see your awards/i).first())
          .toBeVisible({ timeout: 15_000 })
          .then(
            () => true,
            () => false
          ),
      ]);

      if (!arrival.ok) {
        throw new Error(
          `Player never reached ${expectedPath}. Toast seen: ${toastSeen} ` +
            `(false => no close signal arrived; true => handler ran but the ` +
            `destination probe or push failed)\n` +
            `URLs visited: ${JSON.stringify(playerUrls, null, 2)}\n` +
            `Player console:\n${playerConsole.join("\n")}\n` +
            `Original: ${arrival.err.message}`
        );
      }

      // The user-visible half: they are told why the page moved under them.
      expect(toastSeen, "the close toast never appeared on the player's screen").toBe(true);

      // The whole point of the fix is that this is immediate. Server-side
      // pre-work inside closeSession measured ~346ms mean / ~1.4s tail, so
      // anything beyond a few seconds means the fast paths did not deliver and
      // something slower covered — the original production symptom.
      expect(
        arrival.elapsedMs,
        `player moved only after ${arrival.elapsedMs}ms — the fast paths did not deliver`
      ).toBeLessThan(15_000);

      // Sanity-check the DB agrees the session actually closed, so a redirect
      // caused by anything else cannot make this pass.
      const { data: session } = await adminDb()
        .from("sessions")
        .select("is_active, ended_at")
        .eq("id", SESSION_ID)
        .single();
      expect(session?.is_active).toBe(false);
      expect(session?.ended_at).not.toBeNull();
    } finally {
      await playerCtx.close();
      await organizerCtx.close();
    }
  }

  // ── R-2a: no recap → the club lobby ─────────────────────────
  test("a player with no completed match is sent to the club lobby", async ({ browser }) => {
    await seedSession("all_waiting");
    const organizerId = await getOrganizerUserId();

    // Queue the organizer bot so the dashboard shows them as a participant
    // rather than a bystander. Not load-bearing for the assertion — the
    // recap comes from completed matches, not from the queue — but it makes
    // this the shape the complaint described.
    //
    // `all_waiting` creates no completed match, so compute_session_wrapped
    // writes no session_wrapped_stats row for anyone: exactly the "walk-in
    // who never got on court" case. Wrapped would render them an all-zero
    // recap AND stamp intro_dismissed_at, so the lobby is correct.
    await queueOrganizerBot(organizerId);

    await expectPlayerRoutedOnClose(browser, clubBase(CLUB_SLUG));
  });

  // ── R-2b: has a recap → their Wrapped page ──────────────────
  test("a player who completed a match is sent to their Wrapped page", async ({ browser }) => {
    const seeded = await seedSession("all_waiting");
    const organizerId = await getOrganizerUserId();

    await queueOrganizerBot(organizerId);

    // Give the organizer bot a finished match so compute_session_wrapped has
    // something to build a row from. Scores are mandatory: its
    // completed_matches CTE filters on `team_a_score IS NOT NULL AND
    // team_b_score IS NOT NULL`, so a completed match without them yields no
    // recap and this test would silently become a duplicate of R-2a.
    const { data: completedMatch, error: completedErr } = await adminDb()
      .from("matches")
      .insert({
        session_id: SESSION_ID,
        court_id: null,
        status: "completed",
        is_mixed_level: false,
        sort_order: 0,
        team_a_score: 21,
        team_b_score: 19,
        started_at: new Date(Date.now() - 11 * 60_000).toISOString(),
        completed_at: new Date(Date.now() - 60_000).toISOString(),
      })
      .select("id")
      .single();
    if (completedErr || !completedMatch) {
      throw new Error(`[R-2b] Failed to seed completed match: ${completedErr?.message}`);
    }

    const { error: mpErr } = await adminDb()
      .from("match_players")
      .insert([
        { match_id: completedMatch.id, player_id: organizerId, team: "a" as const },
        { match_id: completedMatch.id, player_id: seeded.players.alice.userId, team: "a" as const },
        { match_id: completedMatch.id, player_id: seeded.players.bob.userId, team: "b" as const },
        { match_id: completedMatch.id, player_id: seeded.players.cara.userId, team: "b" as const },
      ]);
    if (mpErr) {
      throw new Error(`[R-2b] Failed to seed completed match players: ${mpErr.message}`);
    }

    await expectPlayerRoutedOnClose(browser, clubWrapped(CLUB_SLUG, SESSION_ID, organizerId));
  });
});

// ─────────────────────────────────────────────────────────────
// [R-3] Auth-loss HOLD — the 07/25 regression guard
// ─────────────────────────────────────────────────────────────
test.describe("Resilience — [R-3] a de-authed client holds its populated UI", () => {
  test("losing auth does not kick the player out of the queue", async ({ browser }) => {
    await seedSession("all_waiting");
    const organizerId = await getOrganizerUserId();

    // Put our own player in the queue — the 07/25 report was "I got kicked out
    // of the queue", so the surface that matters is the player's own status,
    // not just the roster list.
    await adminDb().from("queue_entries").insert({
      session_id: SESSION_ID,
      player_id: organizerId,
      status: "waiting",
    });

    const context = await organizerContext(browser);
    const page = await context.newPage();

    const holdWarnings: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.includes("holding state") || text.includes("preserving stale")) {
        holdWarnings.push(text);
      }
    });

    try {
      await page.goto(`${BASE_URL}${clubPlay(CLUB_SLUG, SESSION_ID)}`);
      await page.waitForSelector('[role="tablist"]', { timeout: 25_000 });

      // My Status must be showing a real queue position before we break
      // anything, so that we are testing a HOLD of real content.
      const leaveButton = page.getByRole("button", { name: "Leave Queue" });
      await expect(leaveButton).toBeVisible({ timeout: 25_000 });

      await page.getByRole("tab", { name: /waitlist/i }).click();
      const rows = page.getByLabel(/^Position \d+$/);
      await expect.poll(async () => rows.count(), { timeout: 25_000 }).toBeGreaterThanOrEqual(3);
      const populatedCount = await rows.count();

      // ── Destroy the auth session, exactly like a refresh-token rotation
      // race does in the wild. @supabase/ssr keeps the session in `sb-*`
      // cookies and re-reads them on every getSession(), so dropping those
      // cookies makes every subsequent REST read run as anon — and under the
      // multi-tenant RLS that returns success-with-zero-rows rather than an
      // error, which is the entire trap the 07/25 fix defends against.
      //
      // Filter by name rather than clearing everything: a blanket
      // clearCookies() would also drop Vercel's `_vercel_jwt` bypass cookie
      // and the next document request would hit the SSO wall, making this
      // fail for a reason that has nothing to do with the fix.
      await context.clearCookies({ name: /^sb-/ });

      // Now provoke a refetch — but NOT via visibilitychange. That path calls
      // router.refresh(), which re-runs the play page's Server Component; with
      // the cookies gone it sees no user and redirect("/")s to the login page.
      // That redirect is correct behaviour for a real sign-out, but it is not
      // what 07/25 was: there the page stayed mounted and its lists blanked.
      //
      // A postgres_changes event reproduces that precisely. The realtime socket
      // authenticated at join time and holds its JWT in memory, so it keeps
      // delivering after the cookies are gone, while the REST refetch it
      // triggers re-reads cookies and runs as anon. Page stays mounted; the
      // refetch comes back empty; the hold is the only thing standing between
      // the player and an empty queue.
      await adminDb()
        .from("queue_entries")
        .update({ status: "waiting" })
        .eq("session_id", SESSION_ID)
        .eq("player_id", organizerId);

      // Let the event land, the anon refetch return empty, and the hook act.
      await page.waitForTimeout(8_000);

      // Guard against the silent-pass mode: if the app navigated anyway, the
      // row count below would be 0 for a reason that has nothing to do with
      // holding state.
      expect(page.url()).toContain(`/play/${SESSION_ID}`);

      // THE ASSERTION: the roster is still there. Pre-fix, an empty success
      // wiped it.
      await expect
        .poll(async () => rows.count(), { timeout: 5_000 })
        .toBeGreaterThanOrEqual(populatedCount);

      // …and the player is still in the queue on their own tab. Pre-fix this
      // is where "Ready to play?" + a Join Queue CTA appeared, which is what
      // players read as being kicked out.
      await page.getByRole("tab", { name: /my status/i }).click();
      await expect(leaveButton).toBeVisible();
      await expect(page.getByRole("button", { name: "Join Queue" })).toHaveCount(0);

      // And prove the hold was deliberate rather than incidental (e.g. the
      // refetch simply never firing): at least one hook logged its hold.
      expect(holdWarnings.join("\n")).toMatch(/holding state|preserving stale/);
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [R-4] FLIP transitions really run
// ─────────────────────────────────────────────────────────────

type FlipRecord = { duration: unknown; from: unknown; isRow: boolean; rows: number };

/**
 * Instrument the page before any app code runs.
 *
 * Records every Element.animate() call. Polling getAnimations() instead would
 * be a race: these animations are fire-and-forget with the default
 * fill:"none", so a finished animation is dropped from getAnimations() and any
 * round-trip is likely to see an empty array — passing or failing for reasons
 * unrelated to the feature.
 *
 * Also tags each waitlist row's DOM node the first time it is seen and records
 * the sequence of row identities. That separates the two ways a move can go
 * missing: if the surviving rows carry NEW tags after a removal, React
 * re-created them and useFlipList is right to treat them as new; if they keep
 * their old tags it is a genuine reorder and the hook lost its bookkeeping.
 */
async function installFlipProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as { __flips?: FlipProbeRecord[]; __rowIds?: string[] };
    type FlipProbeRecord = { duration: unknown; from: unknown; isRow: boolean; rows: number };
    w.__flips = [];
    w.__rowIds = [];

    let nextProbeId = 1;
    let lastSample = "";
    const sample = () => {
      const ids: string[] = [];
      document.querySelectorAll('[aria-label^="Position "]').forEach((el) => {
        const node = el as HTMLElement;
        if (!node.dataset.probeId) node.dataset.probeId = String(nextProbeId++);
        ids.push(node.dataset.probeId);
      });
      const s = ids.join(",") || "(empty)";
      if (s !== lastSample) {
        lastSample = s;
        if (w.__rowIds!.length < 200) w.__rowIds!.push(s);
      }
    };
    // Observe `document`, not `document.documentElement` — init scripts run
    // against an empty document where documentElement is still null, and
    // observe(null) throws, which would also skip the animate() patch below.
    new MutationObserver(sample).observe(document, { childList: true, subtree: true });

    const original = Element.prototype.animate;
    Element.prototype.animate = function (
      this: Element,
      keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      options?: number | KeyframeAnimationOptions
    ) {
      const frames = Array.isArray(keyframes) ? keyframes : [];
      w.__flips!.push({
        duration: typeof options === "object" ? options?.duration : options,
        from: frames[0]?.transform,
        // Whether this was a waitlist row, and how many rows existed at that
        // moment. Element.animate is global, so without this a 240ms enter
        // fired by some unrelated list is indistinguishable from the waitlist
        // failing to play its move. Test by descendant, not by the element's
        // own aria-label: useFlipList's ref sits on the row WRAPPER, while
        // aria-label="Position N" sits on the rank number inside it.
        //
        // Read it as "in the waitlist subtree", NOT as "this element is a row":
        // the predicate is also true for the list container and every ancestor
        // up to <body>. Do not lean on it as proof of which node moved.
        //
        // Why it is still safe to treat a hit as "the waitlist animated":
        // framer-motion is not installed, so the only WAAPI callers in the app
        // are useFlipList's two `el.animate()` sites. The one other surface
        // using that hook — LiveCourtsTab — cannot pollute this probe for
        // three independent reasons: it is unmounted while the Waitlist tab is
        // active, its court cards contain no `[aria-label^="Position "]`
        // descendant (so isRow would be false regardless), and it passes
        // `animateEnter: false`, so it can never emit a 240ms enter — which is
        // the assertion most at risk from a false positive. (Tailwind
        // `animate-in` classes elsewhere are CSS, and never reach this patch.)
        isRow: !!this.querySelector?.('[aria-label^="Position "]'),
        rows: document.querySelectorAll('[aria-label^="Position "]').length,
      });
      return original.call(this, keyframes, options);
    } as typeof Element.prototype.animate;
  });
}

/**
 * Open the waitlist, drop whoever is rendered FIRST so every remaining row
 * shifts up a slot, and return what the probe saw.
 *
 * The victim must be read off the DOM, not from `order("joined_at")`. The
 * waitlist sorts by games_played first, so the oldest entry is frequently the
 * BOTTOM row; removing it changes nobody's rank and correctly produces no move
 * animation. That mismatch — a test bug, not a product bug — is what made this
 * spec fail on roughly a third of runs.
 */
async function reorderWaitlistTopRow(
  page: import("@playwright/test").Page,
  sessionId: string
): Promise<{ flips: FlipRecord[]; rowIds: string[] }> {
  await page.goto(`${BASE_URL}${clubPlay(CLUB_SLUG, SESSION_ID)}`);
  await page.waitForSelector('[role="tablist"]', { timeout: 25_000 });
  await page.getByRole("tab", { name: /waitlist/i }).click();

  const rows = page.getByLabel(/^Position \d+$/);
  await expect.poll(async () => rows.count(), { timeout: 25_000 }).toBeGreaterThanOrEqual(4);

  const { data: waiting } = await adminDb()
    .from("queue_entries")
    .select("id, player_id")
    .eq("session_id", sessionId)
    .eq("status", "waiting");
  expect(waiting?.length ?? 0).toBeGreaterThanOrEqual(4);

  const { data: profiles } = await adminDb()
    .from("profiles")
    .select("id, display_name")
    .in(
      "id",
      waiting!.map((e) => e.player_id)
    );

  // The rank number carries the aria-label; its parent is the whole row,
  // whose text contains the player's display name.
  const firstRowText = await page.evaluate(() => {
    const rank = document.querySelector('[aria-label="Position 1"]');
    return (rank?.parentElement?.textContent ?? "").toUpperCase();
  });

  const topProfile = profiles!.find(
    (p) => p.display_name && firstRowText.includes(p.display_name.toUpperCase())
  );
  expect(
    topProfile,
    `Could not match the first rendered row (${JSON.stringify(firstRowText)}) ` +
      `to any waiting player: ${JSON.stringify(profiles?.map((p) => p.display_name))}`
  ).toBeTruthy();

  const topEntry = waiting!.find((e) => e.player_id === topProfile!.id)!;
  const before = await rows.count();

  // Discard everything captured so far, as late as possible — the very last
  // statement before the mutation. useFlipList never animates its first commit
  // (it only records offsetTop), so mount noise is not evidence. Clearing
  // earlier — e.g. right after the `>= 4` poll — would leave the two admin
  // SELECTs and the DOM read inside the recording window, so a split paint
  // (4 rows, then the 5th) would bank a legitimate 240ms ENTER and red the
  // "no survivor played an ENTER" assertion on something that is not a bug.
  await page.evaluate(() => {
    (window as unknown as { __flips: unknown[] }).__flips.length = 0;
  });

  await adminDb().from("queue_entries").update({ status: "left" }).eq("id", topEntry.id);

  // Prove the reorder actually reached the DOM before anything is asserted
  // about how it was drawn. Without this, a realtime delivery failure and a
  // missing animation produce the same timeout on completely different causes.
  await expect
    .poll(async () => rows.count(), {
      timeout: 25_000,
      message:
        "The waitlist never shrank: the queue_entries UPDATE did not reach the page. " +
        "This is a realtime delivery failure, not an animation failure — the FLIP " +
        "assertions below never ran. Observed on roughly 1 run in 14 against the live " +
        "deployment; the queue hook has no polling fallback, so a dropped postgres_changes " +
        "event leaves the list stale until the next navigation.",
    })
    .toBeLessThan(before);

  // Let any animation the reorder triggered be issued before reading the
  // probe. Poll on a timer, not the default requestAnimationFrame: a page that
  // is not the foreground tab has its rAF callbacks frozen, so the default
  // would leave the predicate unevaluated and time out with the evidence
  // already sitting in __flips.
  await page
    .waitForFunction(
      () => (window as unknown as { __flips: unknown[] }).__flips.length > 0,
      undefined,
      { timeout: 10_000, polling: 250 }
    )
    .catch(() => {
      /* asserted by the caller, with the full dump */
    });

  return page.evaluate(() => ({
    flips: (window as unknown as { __flips: FlipRecord[] }).__flips,
    rowIds: (window as unknown as { __rowIds: string[] }).__rowIds,
  }));
}

test.describe("Resilience — [R-4] queue reordering animates via WAAPI", () => {
  test("removing the top row reaches the DOM and animates the survivors", async ({ browser }) => {
    const seeded = await seedSession("all_waiting");
    const context = await organizerContext(browser);
    await installFlipProbe(context);
    const page = await context.newPage();

    try {
      const { flips, rowIds } = await reorderWaitlistTopRow(page, seeded.sessionId);

      const dump =
        `\nElement.animate() calls: ${JSON.stringify(flips, null, 2)}` +
        `\nRow identity over time: ${JSON.stringify(rowIds)}`;

      // The survivors must keep their DOM nodes. React re-creating the rows
      // would be a real regression (it throws away focus, scroll anchoring and
      // any in-flight animation) AND would make the FLIP assertion below
      // meaningless, since brand-new nodes have no previous position to move
      // from.
      const populated = rowIds.filter((s) => s !== "(empty)");
      expect(populated.length, `expected at least two row states${dump}`).toBeGreaterThanOrEqual(2);
      const survivors = populated[populated.length - 1]!.split(",");
      const beforeIds = populated[populated.length - 2]!.split(",");
      expect(survivors.length, `row count should have dropped${dump}`).toBeLessThan(
        beforeIds.length
      );
      expect(
        survivors.every((id) => beforeIds.includes(id)),
        `surviving rows were re-created instead of reordered${dump}`
      ).toBe(true);

      // Something was animated on the rows that remain. Which animation it is
      // — the 320ms move or the 240ms enter — is the subject of the known
      // issue below; that it animates at all is deterministic.
      expect(
        flips.some((f) => f.isRow),
        `no waitlist row animated after the reorder${dump}`
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  // Was `test.fixme` until 2026-08-04: it failed on ~60% of runs because
  // useFlipList genuinely played the 240ms ENTER fade instead of the 320ms
  // MOVE. The test was right and the hook was wrong.
  //
  // Root cause (fixed in src/hooks/use-flip-list.ts): the layout effect was
  // keyed [orderKey, animateEnter] and wrote prevTops/hasMeasured on EVERY run,
  // including runs where the host had rendered no rows. waitlist-tab.tsx calls
  // the hook above `if (loading) return <skeleton/>`, and `waitlist` and
  // `loading` are independent props — fetchWaitlist is one round trip while
  // fetchActiveMatches is up to four, so setWaitlist lands several commits
  // before setLoading(false). That intermediate commit changed the orderKey
  // with zero rows registered, wiping every First position; the commit that
  // finally painted the rows changed no key, so the keyed effect never ran and
  // never re-measured. The next reorder saw an empty prevTops and took the
  // `prevTop === undefined` branch for every survivor. The ~40% pass rate was
  // just the races where the tab mounted after setLoading(false).
  //
  // The hook now skips (rather than overwrites) its bookkeeping on a zero-row
  // commit, re-measures on every commit, and only arms `hasMeasured` once rows
  // have actually been measured. Regression-locked deterministically by
  // FLIP-6/7/8 in tests/unit/use-flip-list.test.tsx (all three fail against the
  // old hook); this E2E is the against-production confirmation.
  test("a row that changes rank plays a 320ms translateY move animation", async ({ browser }) => {
    const seeded = await seedSession("all_waiting");
    const context = await organizerContext(browser);
    await installFlipProbe(context);
    const page = await context.newPage();

    try {
      const { flips, rowIds } = await reorderWaitlistTopRow(page, seeded.sessionId);

      const dump =
        `\nElement.animate() calls: ${JSON.stringify(flips, null, 2)}` +
        `\nRow identity over time: ${JSON.stringify(rowIds)}`;

      // MOVE_MS is 320 and ENTER_MS is 240, so the duration distinguishes a
      // genuine rank change from a row merely entering the list. `isRow` is
      // load-bearing and not redundant with the duration: Element.animate is
      // global, so a 320ms translateY fired by any other list on the page
      // (courts, banners) would satisfy the duration filter on its own and let
      // the waitlist regress silently. [R-4] above asserts the same predicate.
      const moves = flips.filter(
        (f) =>
          f.isRow &&
          f.duration === 320 &&
          typeof f.from === "string" &&
          f.from.includes("translateY")
      );
      expect(
        moves.length,
        `List reordered but no waitlist row recorded a 320ms translateY move.${dump}`
      ).toBeGreaterThan(0);
      // A move always starts from a NON-zero offset — the row's old slot.
      expect(
        moves.some((f) => !/translateY\(0(px)?\)/.test(f.from as string)),
        `every recorded move started from translateY(0), i.e. no row actually shifted${dump}`
      ).toBe(true);
      // And the survivors must NOT have been treated as entrances. This is the
      // exact symptom the fix removes, so assert its absence directly rather
      // than inferring it from the presence of a move.
      expect(
        flips.filter((f) => f.isRow && f.duration === 240),
        `a surviving row played the 240ms ENTER fade instead of a MOVE${dump}`
      ).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [R-5] draft_cap_phase reaches a second organizer
// ─────────────────────────────────────────────────────────────

/** One observed state of B's lockout overlay: its phase, and who it credits. */
type CapOverlayState = { phase: string | null; actor: string };

/**
 * Record every state B's cap-lockout overlay passes through.
 *
 * Polling for the overlay from the test would be a race that gets no second
 * chance: the whole clearing → generating → done cycle runs server-side in a
 * couple of seconds, and a `toBeVisible()` that arrives late is
 * indistinguishable from a broadcast that never arrived — which is precisely
 * the bug under test. Sampling from inside the page on every mutation captures
 * the transition even when it is over before the next round-trip.
 *
 * Attribute mutations are watched as well as childList: the overlay element
 * survives across phases and only its data-cap-phase flips.
 */
async function installCapOverlayProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as { __capStates?: CapOverlayProbeState[] };
    type CapOverlayProbeState = { phase: string | null; actor: string };
    w.__capStates = [];

    let last = "";
    const sample = () => {
      const overlay = document.querySelector('[data-testid="cap-lockout-overlay"]');
      const phase = overlay ? overlay.getAttribute("data-cap-phase") : null;
      const actor =
        document.querySelector('[data-testid="cap-lockout-actor"]')?.textContent?.trim() ?? "";
      const key = `${phase}|${actor}`;
      if (key !== last) {
        last = key;
        if (w.__capStates!.length < 100) w.__capStates!.push({ phase, actor });
      }
    };
    // Observe `document`: an init script runs against an empty document where
    // documentElement is still null, and observe(null) throws.
    new MutationObserver(sample).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-cap-phase"],
    });
  });
}

test.describe("Resilience — [R-5] a cap change locks out the other organizer", () => {
  test("changing the draft cap in one tab locks and then releases a second tab", async ({
    browser,
  }) => {
    await seedSession("all_waiting");

    // The cap chip is disabled while Auto is OFF, and applyDraftCapOverride
    // short-circuits straight to "done" without ever emitting clearing or
    // generating. Both halves of the three-phase emit only exist with Auto ON.
    // Writing the column directly is safe: nothing server-side watches it —
    // the engine only ever runs from a server action.
    // Checked, not fire-and-forget: a silently failed update leaves Auto OFF, the
    // server takes the short-circuit branch and emits a lone "done" — both polls
    // below would pass and the run would die on the bare `toContain('"clearing"')`
    // with no explanation. Fail here instead, where the cause is obvious.
    const { error: seedCapError } = await adminDb()
      .from("sessions")
      .update({ is_auto_matchmaking_on: true, max_auto_drafts_override: null })
      .eq("id", SESSION_ID);
    expect(seedCapError, `[R-5] setup: could not turn Auto ON for the sandbox session`).toBeNull();

    const ctxA = await organizerContext(browser);
    const ctxB = await organizerContext(browser);
    await installCapOverlayProbe(ctxB);
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    // B must hear about this over the socket or not at all.
    await suppressPollingFallback(pageB);

    // Capture the raw frames too. The overlay proves the UI reacted; the frame
    // proves what it reacted TO. Without it, a pass could in principle come
    // from some other refresh path repainting the header, and — far more
    // usefully on a failure — the frame log distinguishes "the broadcast never
    // left the server" from "it arrived and the client ignored it".
    const capFrames: string[] = [];
    pageB.on("websocket", (ws) => {
      ws.on("framereceived", (frame) => {
        const payload = frame.payload;
        if (typeof payload === "string" && payload.includes("draft_cap_phase")) {
          capFrames.push(payload);
        }
      });
    });

    try {
      const url = `${BASE_URL}${clubOrganizer(CLUB_SLUG, SESSION_ID)}`;
      await Promise.all([pageA.goto(url), pageB.goto(url)]);

      const chipA = pageA.locator('[data-testid="draft-cap-chip"]:visible').first();
      await expect(chipA).toBeVisible({ timeout: 25_000 });
      await expect(pageB.locator('[data-testid="draft-cap-chip"]:visible').first()).toBeVisible({
        timeout: 25_000,
      });

      // B has to be joined before A sends. The channel is `private: true` and
      // defers behind whenRealtimeAuthReady(); a broadcast sent before the join
      // completes is never delivered and never replayed.
      await pageB.waitForTimeout(3_000);

      await chipA.click();
      await pageA.locator('[data-testid="draft-cap-option-2"]:visible').first().click();

      // ── The assertion the whole fix exists for ──────────────
      // B never clicked anything. Everything below reached it through
      // `session-events:{sessionId}` / `draft_cap_phase`.
      await expect
        .poll(() => capFrames.length, {
          timeout: 20_000,
          message:
            "B's socket never received a draft_cap_phase frame. Either the emit did not " +
            "run server-side (the 2026-08-04 bug: src/lib/broadcast.ts imported from a " +
            '"use client" module, where SUPABASE_SERVICE_ROLE_KEY is undefined and ' +
            "postBroadcast bails at its missing-key guard), or the topic does not match " +
            "the one the client joined (the REST API answers 202 for any topic).",
        })
        .toBeGreaterThan(0);

      // Then wait for the TERMINAL frame before snapshotting the buffer.
      // `clearing` is the FIRST of the three phases and `done` the last — it is
      // emitted from a `finally`, so it also covers the early clear-failure
      // return, not just a completed engine run. The poll above therefore
      // resolves on `clearing` alone, and a buffer snapshot taken there would
      // race the rest of the cycle and fail against a server that is working
      // perfectly (observed on the first production run of this spec,
      // 2026-08-04). The two polls stay separate on purpose: the first
      // distinguishes "no broadcast ever left the server" from the second's
      // "the cycle started but never terminated", and each carries the message
      // that fits its own failure.
      //
      // 15s, not 25s: server-side this is three awaited REST posts plus one
      // engine run — 2-5s in practice. A wider window would still pass while
      // silently accepting a lockout long enough for a co-organizer to notice,
      // and the overlay has no dismiss control. This keeps a real upper bound
      // on lockout duration with 3-5x headroom.
      await expect
        .poll(() => capFrames.join("\n"), {
          timeout: 15_000,
          message:
            "B received the opening draft_cap_phase frame but never the terminal " +
            '"done". The overlay has no dismiss control, so a co-organizer would be ' +
            "stuck behind it until the ttlMs lease expires. Check applyDraftCapOverride's " +
            "emit-on-every-exit-path in src/app/actions/sessions.ts.",
        })
        .toContain('"done"');

      const framesText = capFrames.join("\n");
      // Not asserted with the client's `realtime:` wire prefix: realtime-js
      // prepends that itself, which is exactly why the REST payload must NOT
      // carry it. Matching on the bare name holds for both sides.
      expect(framesText, `frames:\n${framesText}`).toContain(`session-events:${SESSION_ID}`);
      expect(framesText).toContain('"clearing"');
      // opId is what stops the initiator's own echo from re-locking it, and
      // ttlMs is what lets a client self-unlock when the terminal "done" is
      // lost. Both are dead weight in a unit test and load-bearing here.
      expect(framesText).toContain('"opId"');
      expect(framesText).toContain('"ttlMs"');

      // The overlay actually rendered on B, credited to the other organizer.
      const states = await pageB.evaluate(
        () => (window as unknown as { __capStates: CapOverlayState[] }).__capStates
      );
      const dump = `\nB's overlay states: ${JSON.stringify(states)}\nframes:\n${framesText}`;
      expect(
        states.some((s) => s.phase === "clearing" || s.phase === "generating"),
        `B received the broadcast but never rendered the lockout overlay${dump}`
      ).toBe(true);
      expect(
        states.some((s) => /^Started by \S/.test(s.actor)),
        `The overlay never credited the organizer who started it${dump}`
      ).toBe(true);

      // …and it lets go. A lockout that never clears is worse than no lockout:
      // the co-organizer is stuck behind an overlay with no dismiss control.
      await expect(pageB.locator('[data-testid="cap-lockout-overlay"]')).toHaveCount(0, {
        timeout: 25_000,
      });

      // The server really committed the cap — so a pass cannot come from the
      // broadcast alone with the write having failed.
      await expect
        .poll(
          async () => {
            const { data } = await adminDb()
              .from("sessions")
              .select("max_auto_drafts_override")
              .eq("id", SESSION_ID)
              .single();
            return data?.max_auto_drafts_override ?? null;
          },
          { timeout: 15_000 }
        )
        .toBe(2);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
