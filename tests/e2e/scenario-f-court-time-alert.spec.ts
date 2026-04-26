// ============================================================
// Scenario F — Court Time Alert
// ============================================================
// Tests the court time limit picker (CourtTimePopover) and the
// per-court alert tier escalation logic.
//
// Feature: organizers can set a per-session court time limit.
// When an in-progress match exceeds the limit the court card
// glows amber; when it exceeds limit + 10 min it glows red.
//
// Initial state (seeded fresh before each test):
//   - "first_match_in_progress" preset:
//       Court 1: in_use — alice/bob vs cara/dan (in_progress match)
//       Court 2: available
//       Eve:     waiting
//
// Test coverage:
//   F-1. Popover — threshold hint visible
//   F-2. Popover — set 30 min limit → DB updated, pill shows "30m"
//   F-3. Popover — Off clears limit → DB updated, pill shows "Off"
//   F-4. Alert tier — normal (green) when under time limit
//   F-5. Alert tier — warning (amber) when at or past time limit
//   F-6. Alert tier — critical (red) when 10+ min past time limit
// ============================================================

import { test, expect } from "@playwright/test";
import { adminDb } from "../helpers/admin-db";
import dotenv from "dotenv";
import path from "path";

import { resetSandboxSession, seedSession } from "../helpers/teardown";
import {
  ensureOrganizerAccount,
  signInOrganizerBot,
  ORGANIZER_STORAGE_STATE,
} from "../fixtures/auth";

dotenv.config({ path: path.resolve(__dirname, "../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), override: false });

function sandboxSessionId(): string {
  const id = process.env.TEST_SESSION_ID!;
  if (!id) throw new Error("[scenario-f] TEST_SESSION_ID not set");
  return id;
}

// ── One-time global setup ──────────────────────────────────────
test.beforeAll(async ({ browser }) => {
  await ensureOrganizerAccount();

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signInOrganizerBot(page, process.env.TEST_BASE_URL!);
  } finally {
    await context.close();
  }
});

// ── Per-test setup ─────────────────────────────────────────────
// Reset sandbox + reset court_time_limit_minutes to null before each test.
let seeded: Awaited<ReturnType<typeof seedSession>>;

test.beforeEach(async () => {
  await resetSandboxSession();
  seeded = await seedSession("first_match_in_progress");

  // Guarantee a clean time limit (teardown doesn't reset this column)
  const db = adminDb();
  await db
    .from("sessions")
    .update({ court_time_limit_minutes: null })
    .eq("id", sandboxSessionId());
});

// ── F-1: Threshold hint ────────────────────────────────────────

test.describe("Court Time Popover — UI content", () => {
  test("F-1: threshold hint is visible inside the popover", async ({ browser }) => {
    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(`${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`);
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Open the time limit popover
      await page.getByTestId("court-time-trigger").click();

      // Threshold hint should be visible in the open popover
      await expect(
        page.getByTestId("court-time-threshold-hint")
      ).toBeVisible({ timeout: 3_000 });

      await expect(
        page.getByTestId("court-time-threshold-hint")
      ).toHaveText("Card glows amber at the limit, red at +10 min");
    } finally {
      await context.close();
    }
  });
});

// ── F-2 & F-3: Setting and clearing the limit ─────────────────

test.describe("Court Time Popover — setting and clearing the limit", () => {
  test("F-2: setting 30 min → DB updated and pill displays '30m'", async ({ browser }) => {
    const db = adminDb();
    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(`${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`);
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Trigger shows "Off" initially (no limit set)
      await expect(page.getByTestId("court-time-trigger")).toHaveText(/Off/);

      // Open popover and pick 30 min
      await page.getByTestId("court-time-trigger").click();
      await expect(page.getByTestId("court-time-preset-30")).toBeVisible({ timeout: 3_000 });
      await page.getByTestId("court-time-preset-30").click();

      // Popover closes on success — trigger now shows "30m"
      await expect(page.getByTestId("court-time-trigger")).toHaveText(/30m/, { timeout: 5_000 });

      // DB check
      const { data: session } = await db
        .from("sessions")
        .select("court_time_limit_minutes")
        .eq("id", seeded.sessionId)
        .single();

      expect(session?.court_time_limit_minutes).toBe(30);
    } finally {
      await context.close();
    }
  });

  test("F-3: clearing the limit (Off) → DB null and pill displays 'Off'", async ({
    browser,
  }) => {
    const db = adminDb();

    // Pre-set limit to 30 so we can clear it
    await db
      .from("sessions")
      .update({ court_time_limit_minutes: 30 })
      .eq("id", sandboxSessionId());

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(`${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`);
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Trigger should already reflect the pre-set value
      await expect(page.getByTestId("court-time-trigger")).toHaveText(/30m/, { timeout: 5_000 });

      // Open popover and click Off
      await page.getByTestId("court-time-trigger").click();
      await expect(page.getByTestId("court-time-off")).toBeVisible({ timeout: 3_000 });
      await page.getByTestId("court-time-off").click();

      // Trigger now shows "Off"
      await expect(page.getByTestId("court-time-trigger")).toHaveText(/Off/, { timeout: 5_000 });

      // DB check
      const { data: session } = await db
        .from("sessions")
        .select("court_time_limit_minutes")
        .eq("id", seeded.sessionId)
        .single();

      expect(session?.court_time_limit_minutes).toBeNull();
    } finally {
      await context.close();
    }
  });
});

// ── F-4, F-5, F-6: Alert tier thresholds ──────────────────────
// Strategy: set the time limit and backdate started_at via admin DB,
// then load the page. The component computes alertTier on mount from
// (Date.now() - started_at) / 60_000. The tier is exposed via the
// data-alert-tier attribute on [data-testid="court-card-{courtId}"].

test.describe("Court Time Alert — tier thresholds", () => {
  test("F-4: normal (green) glow when match is under the time limit", async ({
    browser,
  }) => {
    const db = adminDb();
    const courtId = seeded.courtIds[0]; // Court 1 is in_use
    const matchId = seeded.matchId!;

    // Limit: 30 min, elapsed: 10 min → normal
    const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await db
      .from("sessions")
      .update({ court_time_limit_minutes: 30 })
      .eq("id", sandboxSessionId());
    await db
      .from("matches")
      .update({ started_at: startedAt })
      .eq("id", matchId);

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(`${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`);
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Wait for the court card to appear
      const courtCard = page.getByTestId(`court-card-${courtId}`);
      await expect(courtCard).toBeVisible({ timeout: 8_000 });

      // Should be in normal tier (green glow)
      await expect(courtCard).toHaveAttribute("data-alert-tier", "normal");
    } finally {
      await context.close();
    }
  });

  test("F-5: warning (amber) glow when match has reached the time limit", async ({
    browser,
  }) => {
    const db = adminDb();
    const courtId = seeded.courtIds[0];
    const matchId = seeded.matchId!;

    // Limit: 30 min, elapsed: 31 min → warning
    const startedAt = new Date(Date.now() - 31 * 60_000).toISOString();
    await db
      .from("sessions")
      .update({ court_time_limit_minutes: 30 })
      .eq("id", sandboxSessionId());
    await db
      .from("matches")
      .update({ started_at: startedAt })
      .eq("id", matchId);

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(`${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`);
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      const courtCard = page.getByTestId(`court-card-${courtId}`);
      await expect(courtCard).toBeVisible({ timeout: 8_000 });

      // Should be in warning tier (amber glow)
      await expect(courtCard).toHaveAttribute("data-alert-tier", "warning");
    } finally {
      await context.close();
    }
  });

  test("F-6: critical (red) glow when 10+ minutes past the time limit", async ({
    browser,
  }) => {
    const db = adminDb();
    const courtId = seeded.courtIds[0];
    const matchId = seeded.matchId!;

    // Limit: 30 min, elapsed: 41 min → critical
    const startedAt = new Date(Date.now() - 41 * 60_000).toISOString();
    await db
      .from("sessions")
      .update({ court_time_limit_minutes: 30 })
      .eq("id", sandboxSessionId());
    await db
      .from("matches")
      .update({ started_at: startedAt })
      .eq("id", matchId);

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(`${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`);
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      const courtCard = page.getByTestId(`court-card-${courtId}`);
      await expect(courtCard).toBeVisible({ timeout: 8_000 });

      // Should be in critical tier (red glow)
      await expect(courtCard).toHaveAttribute("data-alert-tier", "critical");
    } finally {
      await context.close();
    }
  });

  test("F-4b: no alert tier when time limit is not set (null)", async ({ browser }) => {
    const db = adminDb();
    const courtId = seeded.courtIds[0];
    const matchId = seeded.matchId!;

    // Match has been going for 45 min but no time limit is set
    const startedAt = new Date(Date.now() - 45 * 60_000).toISOString();
    // court_time_limit_minutes is already null from beforeEach reset
    await db
      .from("matches")
      .update({ started_at: startedAt })
      .eq("id", matchId);

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(`${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`);
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      const courtCard = page.getByTestId(`court-card-${courtId}`);
      await expect(courtCard).toBeVisible({ timeout: 8_000 });

      // No limit set → always normal regardless of elapsed time
      await expect(courtCard).toHaveAttribute("data-alert-tier", "normal");
    } finally {
      await context.close();
    }
  });
});

// ── Regression: existing scenarios not broken ─────────────────
// Quick smoke test: the courts tab still loads correctly after
// the CourtTimePopover was wired in.

test.describe("Regression — courts tab loads cleanly", () => {
  test("courts tab renders without errors after CourtTimePopover integration", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    try {
      await page.goto(`${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`);
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // The time limit picker pill renders in the add-court bar
      await expect(page.getByTestId("court-time-trigger")).toBeVisible({ timeout: 5_000 });

      // No JS errors
      expect(errors).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
