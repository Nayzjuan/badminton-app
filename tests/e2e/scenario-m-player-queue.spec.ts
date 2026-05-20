// ============================================================
// Scenario M — Player Queue UI
// ============================================================
// Tests the player-facing queue position display at
// /play/[sessionId] after the organizer bot has been seeded
// into the waiting queue via the DB admin API.
//
//   [M-1] Player can join queue and see their position number.
//         - Seed the organizer bot into the waiting queue.
//         - Navigate to /play/[sessionId] as that player.
//         - Assert a queue position numeral (#1) is visible.
//
//   [M-2] Player in queue sees correct status UI.
//         - Same setup as [M-1].
//         - Verify the "in line" context text is visible
//           alongside the position numeral.
//
// Implementation note:
//   The organizer bot is used as the test player because it has
//   a real Supabase auth account (needed for the signed-in player
//   dashboard) and a saved storage state (ORGANIZER_STORAGE_STATE).
//   We seed it directly into queue_entries via adminDb() so the DB
//   state matches "player already in queue" without going through
//   the join-queue UI.
// ============================================================

import { test, expect } from "@playwright/test";
import { adminDb } from "../helpers/admin-db";
import dotenv from "dotenv";
import path from "path";

import { resetSandboxSession } from "../helpers/teardown";
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

let organizerUserId: string;

// ── One-time global setup ─────────────────────────────────────
test.beforeAll(async ({ browser }) => {
  await ensureOrganizerAccount();
  organizerUserId = await getOrganizerUserId();

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

// ── Helper: seed organizer bot into the waiting queue ─────────
async function seedOrganizerInQueue() {
  const db = adminDb();

  // Insert the organizer bot as the sole waiting player (position 1).
  const { error } = await db.from("queue_entries").insert({
    session_id: SESSION_ID,
    player_id: organizerUserId,
    status: "waiting",
    games_played: 0,
    position: 1,
  });

  if (error) {
    throw new Error(`[seed] Failed to insert organizer into queue: ${error.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// [M-1] Player in queue sees their position number
// ─────────────────────────────────────────────────────────────
test.describe("Player Queue — [M-1] Position number visible", () => {
  test("player can join queue and see their position number", async ({ browser }) => {
    await seedOrganizerInQueue();

    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/play/${SESSION_ID}`, { waitUntil: "networkidle" });

      // The QueueStatus component renders the position as a hero numeral "#1".
      await expect(page.getByText("#1")).toBeVisible({ timeout: 15_000 });

      // Position #1 is ≤ APPROACHING_QUEUE_THRESHOLD (2), so OnDeckAlert renders
      // "You're Next!" with role="status". Assert the amber urgency banner is visible
      // so a color/threshold regression is caught — not just the numeral.
      await expect(page.getByRole("status", { name: /position 1/i })).toBeVisible({
        timeout: 5_000,
      });
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [M-2] Player in queue sees correct status UI
// ─────────────────────────────────────────────────────────────
test.describe("Player Queue — [M-2] Queue status UI", () => {
  test("player in queue sees correct status UI", async ({ browser }) => {
    await seedOrganizerInQueue();

    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/play/${SESSION_ID}`, { waitUntil: "networkidle" });

      // Position numeral must be visible (confirmed hero element).
      await expect(page.getByText("#1")).toBeVisible({ timeout: 15_000 });

      // The QueueStatus component renders an "in line" context line that
      // also shows the total number of waiting players.
      // Text pattern: "in line · 1 waiting"
      await expect(page.getByText(/in line/i)).toBeVisible({ timeout: 8_000 });
    } finally {
      await context.close();
    }
  });
});
