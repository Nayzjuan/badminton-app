// ============================================================
// Scenario K — Auth / Login UI
// ============================================================
// Tests basic authentication and login-page UI behaviours:
//
//   [K-1] Anonymous player can access the home page and sees
//         the join / login form (not an error page).
//
//   [K-2] Organizer bot can sign in and land on the organizer
//         dashboard for the sandbox session.
//
//   [K-3] The RETURNING tab on the login page reveals an inline
//         reconnect form (name + PIN) — no modal is opened.
//
// Notes:
//   - Tests that need an authenticated browser context use the
//     saved ORGANIZER_STORAGE_STATE (see fixtures/auth.ts).
//   - [K-1] and [K-3] explicitly create an unauthenticated
//     browser context to simulate an anonymous visitor.
// ============================================================

import { test, expect } from "@playwright/test";
import dotenv from "dotenv";
import path from "path";

import { resetSandboxSession, getSandboxClubSlug } from "../helpers/teardown";
import { clubOrganizer } from "../../src/lib/club-paths";
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

// ── One-time global setup ─────────────────────────────────────
test.beforeAll(async ({ browser }) => {
  await ensureOrganizerAccount();
  CLUB_SLUG = await getSandboxClubSlug();

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
// [K-1] Anonymous player can access play page and sees join UI
// ─────────────────────────────────────────────────────────────
test.describe("Auth — [K-1] Anonymous login form visible", () => {
  test("anonymous player can access play page and sees join UI", async ({ browser }) => {
    // Use a fresh unauthenticated context — no storage state injected.
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      // Navigate to the root / home page — unauthenticated users land here.
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

      // The home page renders the LoginForm for unauthenticated visitors.
      // We verify the page loaded (not a 404/error) and the join UI is present.

      // The form heading "Badminton Queue" must be visible.
      await expect(page.getByRole("heading", { name: /badminton queue/i })).toBeVisible({
        timeout: 15_000,
      });

      // The name input must be present — confirms the join / login UI rendered.
      await expect(page.getByLabel(/your name/i)).toBeVisible({ timeout: 8_000 });

      // The submit button should read "Join Queue" (no sessionId in URL).
      await expect(page.getByRole("button", { name: /join queue/i })).toBeVisible({
        timeout: 5_000,
      });
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [K-2] Organizer bot can sign in and reach organizer dashboard
// ─────────────────────────────────────────────────────────────
test.describe("Auth — [K-2] Organizer bot dashboard access", () => {
  test("organizer bot can sign in and reach organizer dashboard", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}${clubOrganizer(CLUB_SLUG, SESSION_ID)}`, {
        waitUntil: "networkidle",
      });

      // The organizer dashboard renders a tab bar with "Active Courts".
      // Wait for the tabpanel to confirm the dashboard fully mounted.
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 20_000 });

      // The "Active Courts" tab label must be visible in the tab list.
      await expect(page.getByRole("tab", { name: /active courts/i })).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [K-3] RETURNING tab reveals inline reconnect form (no modal)
// ─────────────────────────────────────────────────────────────
// The old UX buried reconnect as a muted underline link below the
// full new-player form. The new UX surfaces a NEW PLAYER / RETURNING
// segmented toggle at the very top — equal visual hierarchy, zero
// scrolling required for returning players.
// ─────────────────────────────────────────────────────────────
test.describe("Auth — [K-3] Returning player inline reconnect form", () => {
  test("RETURNING tab reveals inline reconnect form with PIN input — no modal", async ({
    browser,
  }) => {
    // Unauthenticated context — login form with both tabs present.
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

      // The RETURNING tab must be visible at the top of the form
      // without any scrolling — this is the core UX fix.
      const returningTab = page.getByRole("tab", { name: /returning/i });
      await expect(returningTab).toBeVisible({ timeout: 15_000 });

      // Click the tab — the inline reconnect form replaces the new-player form.
      await returningTab.click();

      // No Radix Dialog / modal should open — the form is rendered inline.
      await expect(page.getByRole("dialog")).not.toBeAttached();

      // The inline form must expose name + PIN inputs directly in the page.
      await expect(page.locator("#reconnect_name")).toBeVisible({ timeout: 5_000 });
      await expect(page.locator("#reconnect_pin")).toBeVisible({ timeout: 5_000 });

      // The RECONNECT submit button must be visible (not hidden inside a modal).
      await expect(page.getByRole("button", { name: /^reconnect$/i })).toBeVisible({
        timeout: 5_000,
      });
    } finally {
      await context.close();
    }
  });
});
