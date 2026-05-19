// ============================================================
// Scenario L — Organizer Session Management
// ============================================================
// Tests organizer-facing session management actions:
//
//   [L-1] Organizer can see their session and add a court.
//         - Navigate to organizer dashboard.
//         - Type a court name and click "+ Add Court".
//         - Assert the court appears in the courts list.
//
//   [L-2] Organizer can toggle auto-matchmaking on and off.
//         - Find the auto toggle button.
//         - Click it once → assert it shows "Auto On".
//         - Click it again → assert it shows "Auto Off".
//
// These tests run against the sandbox session (TEST_SESSION_ID).
// Each test starts from a clean slate via resetSandboxSession().
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

const BASE_URL   = process.env.TEST_BASE_URL!;
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
// [L-1] Organizer can see their session and add a court
// ─────────────────────────────────────────────────────────────
test.describe("Session Management — [L-1] Add court", () => {
  test("organizer can see their session and add a court", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/organizer/${SESSION_ID}`, { waitUntil: "networkidle" });

      // Wait for the Courts tab panel to fully mount.
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 20_000 });

      // The empty state text confirms we start with no courts.
      // (resetSandboxSession wipes all courts for the sandbox session)

      // ── Type a court name ────────────────────────────────────
      const courtNameInput = page.getByPlaceholder(/court name/i);
      await expect(courtNameInput).toBeVisible({ timeout: 8_000 });
      await courtNameInput.fill("Court Alpha");

      // ── Click "+ Add Court" ──────────────────────────────────
      const addBtn = page.getByRole("button", { name: /add court/i });
      await expect(addBtn).toBeVisible({ timeout: 5_000 });
      await addBtn.click();

      // ── Assert the court appears in the courts list ──────────
      // The court name is rendered inside a CourtCard.
      // Allow up to 10 s for the optimistic update / DB round-trip.
      await expect(page.getByText("Court Alpha")).toBeVisible({ timeout: 10_000 });
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [L-2] Organizer can toggle auto-matchmaking on and off
// ─────────────────────────────────────────────────────────────
test.describe("Session Management — [L-2] Auto-matchmaking toggle", () => {
  test("organizer can toggle auto-matchmaking on and off", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/organizer/${SESSION_ID}`, { waitUntil: "networkidle" });

      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 20_000 });

      // The toggle button has data-testid="toggle-auto-matchmaking" (confirmed
      // from the existing scenario-b tests that use the same selector).
      const toggleBtn = page.getByTestId("toggle-auto-matchmaking");
      await expect(toggleBtn).toBeVisible({ timeout: 10_000 });

      // ── Initial state: Auto Off ──────────────────────────────
      // resetSandboxSession sets is_auto_matchmaking_on=false.
      await expect(toggleBtn).toHaveText(/auto off/i, { timeout: 5_000 });

      // ── Click once → expect Auto On ─────────────────────────
      await toggleBtn.click();
      await expect(toggleBtn).toHaveText(/auto on/i, { timeout: 10_000 });

      // ── Click again → expect Auto Off ───────────────────────
      await toggleBtn.click();
      await expect(toggleBtn).toHaveText(/auto off/i, { timeout: 10_000 });
    } finally {
      await context.close();
    }
  });
});
