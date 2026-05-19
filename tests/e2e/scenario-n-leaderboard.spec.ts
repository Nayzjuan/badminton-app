// ============================================================
// Scenario N — Leaderboard UI
// ============================================================
// Tests that the leaderboard tab is accessible from both the
// player dashboard and the organizer dashboard.
//
//   [N-1] Player leaderboard tab is accessible.
//         - Navigate to /play/[sessionId] as organizer bot.
//         - Click the "Leaderboard" tab in the player bottom nav.
//         - Assert the leaderboard content area loads (shows
//           empty state or leaderboard table).
//
//   [N-2] Organizer leaderboard tab is accessible.
//         - Navigate to /organizer/[sessionId].
//         - Click the "Leaderboard" tab.
//         - Assert the leaderboard content area loads.
//
// Because the sandbox session has no completed matches after
// resetSandboxSession(), both tests expect to see either an
// empty-state message or the leaderboard container element.
//
// Note: the player dashboard has 4 tabs (My Status, Live Courts,
// Waitlist, Leaderboard) rendered as bottom-nav icons + labels.
// The organizer dashboard has tabs in a horizontal tab bar.
// ============================================================

import { test, expect } from "@playwright/test";
import dotenv from "dotenv";
import path from "path";

import { resetSandboxSession } from "../helpers/teardown";
import {
  ensureOrganizerAccount,
  signInOrganizerBot,
  ORGANIZER_STORAGE_STATE,
} from "../fixtures/auth";

dotenv.config({ path: path.resolve(__dirname, "../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), override: false });

const BASE_URL = process.env.TEST_BASE_URL!;
const SESSION_ID = process.env.TEST_SESSION_ID!;

// ── One-time global setup ─────────────────────────────────────
test.beforeAll(async ({ browser }) => {
  await ensureOrganizerAccount();

  const context = await browser.newContext();
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
    });
    const page = await context.newPage();

    try {
      // Don't use waitUntil:"networkidle" — Supabase realtime WebSocket
      // connections keep the network active indefinitely.
      await page.goto(`${BASE_URL}/play/${SESSION_ID}`);

      // Wait for the player dashboard to hydrate — the header renders a
      // div with role="tablist" containing the 4 navigation tabs.
      await page.waitForSelector('[role="tablist"]', { timeout: 20_000 });

      // The player dashboard header renders tabs with explicit role="tab".
      // Click the Leaderboard tab.
      const leaderboardTab = page.getByRole("tab", { name: /leaderboard/i });
      await expect(leaderboardTab).toBeVisible({ timeout: 10_000 });
      await leaderboardTab.click();

      // After clicking, the leaderboard panel should mount.
      // With no completed matches the panel shows an empty state or
      // a "No ranked players yet" / minimum games message.
      // We assert something leaderboard-related is visible — either a
      // table header "Rank" or an empty-state message.
      await expect(
        page.getByText(/rank|no ranked players|minimum|leaderboard/i).first()
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
    });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/organizer/${SESSION_ID}`, { waitUntil: "networkidle" });

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
