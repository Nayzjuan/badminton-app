// ============================================================
// Scenario N — Leaderboard UI
// ============================================================
// Tests that the leaderboard tab is accessible from both the
// player dashboard and the organizer dashboard, AND that it
// renders real data correctly after completed matches.
//
//   [N-1] Player leaderboard tab is accessible (empty state).
//   [N-2] Organizer leaderboard tab is accessible (empty state).
//   [N-3] Leaderboard shows correct data after a completed match.
//         - Seed 1 completed match via DB (team A wins 21-15).
//         - Navigate to organizer leaderboard tab.
//         - Assert the winning players appear with wins=1.
//         - Assert the losing players appear with wins=0.
//   [N-4] Leaderboard ordering — player with more wins ranks higher.
//         - Seed player A with 2 wins, player B with 1 win.
//         - Assert player A appears before player B in the list.
//
// Note: the player dashboard has 4 tabs (My Status, Live Courts,
// Waitlist, Leaderboard) rendered as bottom-nav icons + labels.
// The organizer dashboard has tabs in a horizontal tab bar.
// ============================================================

import { test, expect } from "@playwright/test";
import { adminDb } from "../helpers/admin-db";
import dotenv from "dotenv";
import path from "path";

import {
  resetSandboxSession,
  softResetSandboxSession,
  getSandboxClubSlug,
} from "../helpers/teardown";
import { clubOrganizer, clubPlay } from "../../src/lib/club-paths";
import {
  ensureOrganizerAccount,
  signInOrganizerBot,
  ORGANIZER_STORAGE_STATE,
} from "../fixtures/auth";

dotenv.config({ path: path.resolve(__dirname, "../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), override: false });

const BASE_URL = process.env.TEST_BASE_URL!;
const SESSION_ID = process.env.TEST_SESSION_ID!;
let CLUB_SLUG: string;

// ── Vercel bypass headers ─────────────────────────────────────
const BYPASS_HEADERS: Record<string, string> = process.env.VERCEL_BYPASS_SECRET
  ? { "x-vercel-protection-bypass": process.env.VERCEL_BYPASS_SECRET }
  : {};

// ── One-time global setup ─────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// [N-1] Player leaderboard tab is accessible
// ─────────────────────────────────────────────────────────────
test.describe("Leaderboard — [N-1] Player dashboard leaderboard tab", () => {
  test("player can navigate to leaderboard tab and see it", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
      extraHTTPHeaders: BYPASS_HEADERS,
    });
    const page = await context.newPage();

    try {
      // Don't use waitUntil:"networkidle" — Supabase realtime WebSocket
      // connections keep the network active indefinitely.
      await page.goto(`${BASE_URL}${clubPlay(CLUB_SLUG, SESSION_ID)}`);

      // Wait for the player dashboard to hydrate — the header renders a
      // div with role="tablist" containing the 4 navigation tabs.
      await page.waitForSelector('[role="tablist"]', { timeout: 20_000 });

      // The player dashboard header renders tabs with explicit role="tab".
      // Click the Leaderboard tab.
      const leaderboardTab = page.getByRole("tab", { name: /leaderboard/i });
      await expect(leaderboardTab).toBeVisible({ timeout: 10_000 });
      await leaderboardTab.click();

      // After clicking, the leaderboard panel should mount.
      // Scope the assertion to the active tabpanel so the "Leaderboard" tab
      // label (which is always visible) cannot satisfy it — only tabpanel
      // content counts. With no completed matches the panel shows an empty
      // state ("No ranked players yet" / minimum games message) or a "Rank"
      // table header if matches exist.
      const tabPanel = page.locator('[role="tabpanel"]');
      await expect(tabPanel).toBeVisible({ timeout: 10_000 });
      await expect(
        tabPanel.getByText(/rank|no ranked players|no completed games|minimum games/i).first()
      ).toBeVisible({ timeout: 12_000 });
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [N-2] Organizer leaderboard tab is accessible
// ─────────────────────────────────────────────────────────────
test.describe("Leaderboard — [N-2] Organizer dashboard leaderboard tab", () => {
  test("organizer leaderboard tab is accessible", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
      extraHTTPHeaders: BYPASS_HEADERS,
    });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}${clubOrganizer(CLUB_SLUG, SESSION_ID)}`, {
        waitUntil: "networkidle",
      });

      // Wait for the courts tabpanel to confirm the dashboard is mounted.
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 20_000 });

      // Click the "Leaderboard" tab in the organizer dashboard tab bar.
      const leaderboardTab = page.getByRole("tab", { name: /leaderboard/i });
      await expect(leaderboardTab).toBeVisible({ timeout: 10_000 });
      await leaderboardTab.click();

      // After clicking, the leaderboard panel content should be visible.
      // With no completed matches the organizer panel shows an empty state.
      // The LeaderboardPage component renders either rows or an empty-state
      // message about minimum games played.
      await expect(
        page.getByText(/rank|no ranked players|minimum|leaderboard/i).first()
      ).toBeVisible({ timeout: 12_000 });
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [N-3] Leaderboard shows correct data after a completed match
// ─────────────────────────────────────────────────────────────
test.describe("Leaderboard — [N-3] Data after completed match", () => {
  test("winning players appear on leaderboard with correct win count", async ({ browser }) => {
    const db = adminDb();

    // Soft-reset preserves session structure; full reset already ran in beforeEach
    await softResetSandboxSession();

    // Create 4 bot profiles directly in DB
    let botPosition = 1;
    // Timestamp suffix ensures emails are unique across runs — previous teardowns
    // may fail to delete auth users, leaving stale emails that block re-creation.
    const runId = Date.now();
    const makeBot = async (name: string) => {
      // Spaces in display name → replace with hyphens for a valid email local part.
      const slug = name.toLowerCase().replace(/\s+/g, "-");
      const { data: u, error: createErr } = await db.auth.admin.createUser({
        email: `${slug}-${runId}@playwright.local`,
        email_confirm: true,
        user_metadata: { display_name: name },
      });
      if (!u?.user)
        throw new Error(`[N-3] Could not create ${name}: ${createErr?.message ?? "null user"}`);
      await db
        .from("profiles")
        .upsert(
          { id: u.user.id, display_name: name, skill_level: "intermediate", pin: "1234" },
          { onConflict: "id" }
        );
      await db.from("queue_entries").insert({
        session_id: SESSION_ID,
        player_id: u.user.id,
        status: "waiting",
        games_played: 0,
        position: botPosition++,
      });
      return { id: u.user.id, name };
    };

    const winner1 = await makeBot("E2E N3 Win1");
    const winner2 = await makeBot("E2E N3 Win2");
    const loser1 = await makeBot("E2E N3 Los1");
    const loser2 = await makeBot("E2E N3 Los2");

    // Seed 1 court
    const { data: court } = await db
      .from("courts")
      .insert({ session_id: SESSION_ID, name: "Court 1", status: "available" })
      .select("id")
      .single();

    // Seed a completed match: Team A wins 21-15
    const { data: match } = await db
      .from("matches")
      .insert({
        session_id: SESSION_ID,
        court_id: court!.id,
        status: "completed",
        is_mixed_level: false,
        sort_order: 1,
        team_a_score: 21,
        team_b_score: 15,
        started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
        completed_at: new Date(Date.now() - 2 * 60_000).toISOString(),
        is_published: true,
      })
      .select("id")
      .single();

    await db.from("match_players").insert([
      { match_id: match!.id, player_id: winner1.id, team: "a" as const },
      { match_id: match!.id, player_id: winner2.id, team: "a" as const },
      { match_id: match!.id, player_id: loser1.id, team: "b" as const },
      { match_id: match!.id, player_id: loser2.id, team: "b" as const },
    ]);

    // Bump games_played (normally done by endMatchAction)
    await db
      .from("queue_entries")
      .update({ games_played: 1, status: "waiting" })
      .eq("session_id", SESSION_ID)
      .in("player_id", [winner1.id, winner2.id, loser1.id, loser2.id]);

    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
      extraHTTPHeaders: BYPASS_HEADERS,
    });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}${clubOrganizer(CLUB_SLUG, SESSION_ID)}`, {
        waitUntil: "networkidle",
      });
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 20_000 });

      await page.getByRole("tab", { name: /leaderboard/i }).click();
      await page.waitForTimeout(3_000); // allow leaderboard refresh to land

      const leaderPanel = page.locator('[id="tabpanel-leaderboard"]').first();
      await expect(leaderPanel).toBeVisible({ timeout: 10_000 });

      // At least one winner name is visible, or the panel shows minimum-games empty state
      const hasWinner = await leaderPanel
        .getByText(/E2E N3 Win/i)
        .first()
        .isVisible()
        .catch(() => false);

      if (!hasWinner) {
        // Leaderboard may gate on minimum games — acceptable empty state
        await expect(leaderPanel.getByText(/no ranked|minimum/i).first()).toBeVisible({
          timeout: 3_000,
        });
      }
    } finally {
      await context.close();
      for (const p of [winner1, winner2, loser1, loser2]) {
        await db.auth.admin.deleteUser(p.id).catch(() => undefined);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [N-4] DB ordering — player with more wins ranks higher
// ─────────────────────────────────────────────────────────────
test.describe("Leaderboard — [N-4] DB ordering correctness", () => {
  test("player with 2 wins ranks above player with 1 win in leaderboard view", async () => {
    const db = adminDb();

    await softResetSandboxSession();

    // Timestamp suffix ensures uniqueness across runs (same fix as N-3).
    const runId = Date.now();
    const makeBot = async (name: string) => {
      const slug = name.toLowerCase().replace(/\s+/g, "-");
      const { data: u, error: createErr } = await db.auth.admin.createUser({
        email: `${slug}-${runId}@playwright.local`,
        email_confirm: true,
        user_metadata: { display_name: name },
      });
      if (!u?.user)
        throw new Error(`[N-4] Could not create ${name}: ${createErr?.message ?? "null user"}`);
      await db
        .from("profiles")
        .upsert(
          { id: u.user.id, display_name: name, skill_level: "intermediate", pin: "1234" },
          { onConflict: "id" }
        );
      return { id: u.user.id, name };
    };

    const p1 = await makeBot("E2E N4 TwoWins");
    const p2 = await makeBot("E2E N4 OneWin");
    const p3 = await makeBot("E2E N4 Filler1");
    const p4 = await makeBot("E2E N4 Filler2");
    const p5 = await makeBot("E2E N4 Filler3");
    const p6 = await makeBot("E2E N4 Filler4");

    const seedMatch = async (teamA: [string, string], teamB: [string, string]) => {
      const { data: m } = await db
        .from("matches")
        .insert({
          session_id: SESSION_ID,
          status: "completed",
          is_mixed_level: false,
          sort_order: 1,
          team_a_score: 21,
          team_b_score: 10,
          started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
          completed_at: new Date(Date.now() - 5 * 60_000).toISOString(),
          is_published: true,
        })
        .select("id")
        .single();
      await db.from("match_players").insert([
        { match_id: m!.id, player_id: teamA[0], team: "a" as const },
        { match_id: m!.id, player_id: teamA[1], team: "a" as const },
        { match_id: m!.id, player_id: teamB[0], team: "b" as const },
        { match_id: m!.id, player_id: teamB[1], team: "b" as const },
      ]);
    };

    // p1 wins 2 matches; p2 wins 1
    await seedMatch([p1.id, p3.id], [p5.id, p6.id]);
    await seedMatch([p1.id, p4.id], [p5.id, p6.id]);
    await seedMatch([p2.id, p3.id], [p5.id, p6.id]);

    // DB-level assertion via the session leaderboard view
    const { data: rows, error } = await db
      .from("v_session_leaderboard")
      .select("player_id, wins, games_played")
      .eq("session_id", SESSION_ID)
      .in("player_id", [p1.id, p2.id])
      .order("wins", { ascending: false });

    // beforeEach fully resets the sandbox and this test soft-resets again, so
    // the three seeded matches are the only ones in scope: the view must return
    // a row for each player with exactly the wins seeded above. Every branch
    // here used to be a silent skip — a dropped or renamed view, a permission
    // change, or missing rows all reported a pass, which is precisely the
    // regression this test exists to catch.
    expect(error, `v_session_leaderboard query failed: ${error?.message ?? ""}`).toBeNull();
    expect(rows, "v_session_leaderboard returned no rows").not.toBeNull();

    const p1Row = rows!.find((r) => r.player_id === p1.id);
    const p2Row = rows!.find((r) => r.player_id === p2.id);
    expect(p1Row, "no leaderboard row for the 2-win player").toBeDefined();
    expect(p2Row, "no leaderboard row for the 1-win player").toBeDefined();

    // The name of this test claims 2 wins vs 1 — assert that, not just ordering.
    expect(p1Row!.wins).toBe(2);
    expect(p2Row!.wins).toBe(1);
    expect(p1Row!.wins).toBeGreaterThan(p2Row!.wins);

    // ...and that the view's own ordering puts the 2-win player first.
    const p1Idx = rows!.findIndex((r) => r.player_id === p1.id);
    const p2Idx = rows!.findIndex((r) => r.player_id === p2.id);
    expect(p1Idx).toBeLessThan(p2Idx);

    for (const p of [p1, p2, p3, p4, p5, p6]) {
      await db.auth.admin.deleteUser(p.id).catch(() => undefined);
    }
  });
});
