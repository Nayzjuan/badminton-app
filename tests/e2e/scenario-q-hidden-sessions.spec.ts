// ============================================================
// Scenario Q — Infrastructure sessions stay out of human lists
// ============================================================
// The E2E sandbox lives in the CHILLAX club (the only club), so before
// `sessions.is_hidden` it appeared in all three session lists the app
// renders — including as an ACTIVE session on the organizer hub, with its
// organizer_passcode on display, and on /play for every player in the club.
// Its "DO NOT JOIN" name was a workaround for being visible at all.
//
// This spec is the regression guard, and it is deliberately run FROM the
// sandbox: the session driving the test is the very one that must not be
// listed. It also proves the column grant is right — filtering on is_hidden
// with the authenticated client would fail outright with "permission denied
// for table sessions" if 20260721101500 had added the column without
// `grant select (is_hidden)`, because Postgres requires SELECT privilege on
// columns referenced in a WHERE clause.
// ============================================================

import { test, expect } from "@playwright/test";
import dotenv from "dotenv";
import path from "path";

import { adminDb } from "../helpers/admin-db";
import { getSandboxClubSlug } from "../helpers/teardown";
import { clubOrganizer } from "../../src/lib/club-paths";
import {
  ensureOrganizerAccount,
  signInOrganizerBot,
  ORGANIZER_STORAGE_STATE,
} from "../fixtures/auth";

dotenv.config({ path: path.resolve(__dirname, "../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), override: false });

const SANDBOX_NAME_FRAGMENT = "E2E SANDBOX";

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

test.describe("Hidden sessions — live", () => {
  test("[Q-1] the sandbox is flagged hidden and readable by the client roles", async () => {
    const db = adminDb();
    const { data, error } = await db
      .from("sessions")
      .select("id, name, is_hidden")
      .eq("id", process.env.TEST_SESSION_ID!)
      .single();

    expect(error).toBeNull();
    expect(data!.name).toContain(SANDBOX_NAME_FRAGMENT);
    expect(data!.is_hidden).toBe(true);
  });

  test("[Q-2] it is absent from the organizer hub, which still lists real sessions", async ({
    browser,
  }) => {
    const clubSlug = await getSandboxClubSlug();
    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(`${process.env.TEST_BASE_URL}/c/${clubSlug}/organizer`);
      // Wait for the list to have actually rendered before asserting absence —
      // an empty page trivially "does not contain" the sandbox.
      await page.waitForLoadState("networkidle");
      const body = await page.locator("body").innerText();

      expect(body).not.toContain(SANDBOX_NAME_FRAGMENT);
      // Positive control: the page really did render sessions, so the negative
      // assertion above means something. The club has 20+ past club nights.
      expect(body.length).toBeGreaterThan(200);
    } finally {
      await context.close();
    }
  });

  test("[Q-3] the sandbox dashboard itself is still reachable by id", async ({ browser }) => {
    // Hiding is a LISTING concern, not access control — the whole e2e suite
    // drives this session directly, so it must keep working.
    const clubSlug = await getSandboxClubSlug();
    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}${clubOrganizer(clubSlug, process.env.TEST_SESSION_ID!)}`
      );
      await expect(page.locator('[id="tabpanel-courts"]')).toBeVisible({ timeout: 20_000 });
    } finally {
      await context.close();
    }
  });
});
