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
//   [K-3] The "Reconnect" link on the login page opens the
//         Reconnect modal which contains a PIN input field.
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
      await page.goto(`${BASE_URL}/organizer/${SESSION_ID}`, { waitUntil: "networkidle" });

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
// [K-3] Player reconnect modal appears on login page
// ─────────────────────────────────────────────────────────────
test.describe("Auth — [K-3] Reconnect modal has PIN input", () => {
  test("player reconnect modal appears on login page", async ({ browser }) => {
    // Unauthenticated context — the login form and Reconnect link are present.
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });

      // The "Already have a PIN? Reconnect" button must be visible.
      const reconnectBtn = page.getByRole("button", { name: /reconnect/i });
      await expect(reconnectBtn).toBeVisible({ timeout: 15_000 });

      // Click it to open the modal.
      await reconnectBtn.click();

      // The Reconnect modal is a Radix Dialog — it renders a dialog role element.
      const modal = page.getByRole("dialog");
      await expect(modal).toBeVisible({ timeout: 8_000 });

      // The modal must contain a PIN input field.
      // ReconnectModal renders a PIN label / input so players can re-identify.
      await expect(modal.getByLabel(/pin/i)).toBeVisible({ timeout: 5_000 });
    } finally {
      await context.close();
    }
  });
});
