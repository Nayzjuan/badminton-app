// ============================================================
// Scenario D — Session Wrapped Dismiss-Once
// ============================================================
// Verifies the "show once per session" contract for the
// Session Wrapped intro overlay:
//
//   [A] DISPLAY — Intro shows when intro_dismissed_at is NULL
//   [B] DISPLAY — Intro is skipped when intro_dismissed_at is set
//   [C] SEE AWARDS — "See Your Awards →" closes overlay in-memory
//                    but does NOT set the DB flag (player can still
//                    scroll up and click Done later)
//   [D] DONE (header) — persists dismiss to DB, navigates /play
//   [E] BACK TO LOBBY (footer) — persists dismiss to DB, navigates /play
//   [F] REDIRECT — undismissed session → /play/[id] redirects to wrapped
//   [G] REDIRECT — dismissed session → /play/[id] redirects to /play
//
// Test player: the organizer bot account (already has a browser
// session saved as ORGANIZER_STORAGE_STATE).  A wrapped stats row
// is seeded directly for their user ID before each relevant test.
//
// Session state:
//   - is_active = false (session ended) for redirect tests
//   - Teardown resets is_active = true + wipes wrapped stats rows
// ============================================================

import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";

import { resetSandboxSession } from "../helpers/teardown";
import {
  ensureOrganizerAccount,
  signInOrganizerBot,
  ORGANIZER_STORAGE_STATE,
  getOrganizerUserId,
} from "../fixtures/auth";

dotenv.config({ path: path.resolve(__dirname, "../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), override: false });

// ── Admin DB client (service role — bypasses RLS for seeding) ──
function adminDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

const SESSION_ID = process.env.TEST_SESSION_ID!;
const BASE_URL   = process.env.TEST_BASE_URL!;

// ── Seed a wrapped stats row for the organizer bot ─────────────
async function seedWrappedStats(
  playerId: string,
  introDismissedAt: string | null = null
): Promise<void> {
  const db = adminDb();
  const { error } = await db.from("session_wrapped_stats").upsert(
    {
      session_id:          SESSION_ID,
      player_id:           playerId,
      games_played:        5,
      wins:                3,
      losses:              2,
      points_for:          75,
      points_against:      60,
      win_pct:             60.00,
      win_streak:          2,
      session_rank:        1,
      earned_awards:       [],
      award_data:          {},
      intro_dismissed_at:  introDismissedAt,
    },
    { onConflict: "session_id,player_id" }
  );
  if (error) throw new Error(`[seed:wrapped] ${error.message}`);
}

// ── Close / reopen sandbox session ────────────────────────────
async function closeSession(): Promise<void> {
  const db = adminDb();
  await db
    .from("sessions")
    .update({ is_active: false, ended_at: new Date().toISOString() })
    .eq("id", SESSION_ID);
}

// ── One-time global setup ──────────────────────────────────────
let organizerUserId: string;

test.beforeAll(async ({ browser }) => {
  await ensureOrganizerAccount();
  organizerUserId = await getOrganizerUserId();

  // Save organizer storage state if not already done.
  // The context must be closed in all code paths to avoid resource leaks.
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await signInOrganizerBot(page, BASE_URL);
  } finally {
    await context.close();
  }
});

// ── Per-test teardown ──────────────────────────────────────────
// resetSandboxSession wipes wrapped_stats + reopens the session.
test.afterEach(async () => {
  await resetSandboxSession();
});

// ─────────────────────────────────────────────────────────────
// [A] Intro shows when intro_dismissed_at = NULL
// ─────────────────────────────────────────────────────────────
test.describe("Wrapped Dismiss — [A] Intro visible (not dismissed)", () => {
  test("intro overlay is visible when intro_dismissed_at is null", async ({ browser }) => {
    await seedWrappedStats(organizerUserId, null);

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/wrapped/${SESSION_ID}/${organizerUserId}`, {
        waitUntil: "networkidle",
      });

      // The intro dialog should be present
      const intro = page.getByRole("dialog", { name: "Session Wrapped intro" });
      await expect(intro).toBeVisible({ timeout: 10_000 });

      // Awards page content should be hidden behind the overlay
      const doneBtn = page.getByRole("button", { name: "Done" });
      await expect(doneBtn).not.toBeVisible();
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [B] Intro skipped when intro_dismissed_at is set
// ─────────────────────────────────────────────────────────────
test.describe("Wrapped Dismiss — [B] Intro hidden (already dismissed)", () => {
  test("intro overlay is absent when intro_dismissed_at is already set", async ({ browser }) => {
    await seedWrappedStats(organizerUserId, new Date().toISOString());

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/wrapped/${SESSION_ID}/${organizerUserId}`, {
        waitUntil: "networkidle",
      });

      // Intro dialog should NOT appear at all
      const intro = page.getByRole("dialog", { name: "Session Wrapped intro" });
      await expect(intro).not.toBeVisible({ timeout: 5_000 });

      // Awards page should be immediately visible
      const doneBtn = page.getByRole("button", { name: "Done" });
      await expect(doneBtn).toBeVisible({ timeout: 8_000 });
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [C] "See Your Awards →" is in-memory only (no DB flag)
// ─────────────────────────────────────────────────────────────
test.describe("Wrapped Dismiss — [C] See Awards → in-memory dismiss only", () => {
  test("tapping See Your Awards hides intro but does not set DB flag", async ({ browser }) => {
    await seedWrappedStats(organizerUserId, null);

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/wrapped/${SESSION_ID}/${organizerUserId}`, {
        waitUntil: "networkidle",
      });

      const intro = page.getByRole("dialog", { name: "Session Wrapped intro" });
      await expect(intro).toBeVisible({ timeout: 10_000 });

      // Click "See Your Awards →"
      await page.getByRole("button", { name: "See your awards" }).click();

      // Intro should disappear (in-memory dismiss with 290ms animation)
      await expect(intro).not.toBeVisible({ timeout: 3_000 });

      // Awards page content now visible
      await expect(page.getByRole("button", { name: "Done" })).toBeVisible({ timeout: 5_000 });

      // DB flag should still be NULL — not persisted
      const { data } = await adminDb()
        .from("session_wrapped_stats")
        .select("intro_dismissed_at")
        .eq("session_id", SESSION_ID)
        .eq("player_id", organizerUserId)
        .single();

      expect(data?.intro_dismissed_at).toBeNull();
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [D] "Done" header button persists dismiss to DB
// ─────────────────────────────────────────────────────────────
test.describe("Wrapped Dismiss — [D] Done button persists dismiss", () => {
  test("clicking Done sets intro_dismissed_at in DB and navigates to /play", async ({ browser }) => {
    await seedWrappedStats(organizerUserId, null);

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/wrapped/${SESSION_ID}/${organizerUserId}`, {
        waitUntil: "networkidle",
      });

      // Dismiss intro overlay first to reveal awards page
      await page.getByRole("button", { name: "See your awards" }).click();
      await expect(page.getByRole("button", { name: "Done" })).toBeVisible({ timeout: 5_000 });

      // Click the "Done" button in the header
      await page.getByRole("button", { name: "Done" }).click();

      // Should navigate to /play (the session picker), NOT back to /play/[sessionId]
      await page.waitForURL(/\/play($|\?|#)/, { timeout: 10_000 });
      expect(page.url()).not.toMatch(/\/play\/[0-9a-f-]{36}/);

      // DB flag should now be set
      const { data } = await adminDb()
        .from("session_wrapped_stats")
        .select("intro_dismissed_at")
        .eq("session_id", SESSION_ID)
        .eq("player_id", organizerUserId)
        .single();

      expect(data?.intro_dismissed_at).not.toBeNull();
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [E] "Back to Lobby" footer button persists dismiss to DB
// ─────────────────────────────────────────────────────────────
test.describe("Wrapped Dismiss — [E] Back to Lobby persists dismiss", () => {
  test("clicking Back to Lobby sets intro_dismissed_at in DB", async ({ browser }) => {
    await seedWrappedStats(organizerUserId, null);

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/wrapped/${SESSION_ID}/${organizerUserId}`, {
        waitUntil: "networkidle",
      });

      // Dismiss intro to reveal awards page
      await page.getByRole("button", { name: "See your awards" }).click();
      await expect(page.getByRole("button", { name: "Back to Lobby" })).toBeVisible({
        timeout: 5_000,
      });

      // Click "Back to Lobby" in the footer
      await page.getByRole("button", { name: "Back to Lobby" }).click();

      // Should navigate to /play (the session picker), NOT back to /play/[sessionId]
      await page.waitForURL(/\/play($|\?|#)/, { timeout: 10_000 });
      expect(page.url()).not.toMatch(/\/play\/[0-9a-f-]{36}/);

      // DB flag should be set
      const { data } = await adminDb()
        .from("session_wrapped_stats")
        .select("intro_dismissed_at")
        .eq("session_id", SESSION_ID)
        .eq("player_id", organizerUserId)
        .single();

      expect(data?.intro_dismissed_at).not.toBeNull();
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [F] /play/[sessionId] → wrapped (not yet dismissed)
// ─────────────────────────────────────────────────────────────
test.describe("Wrapped Dismiss — [F] /play redirect → wrapped when not dismissed", () => {
  test("navigating /play/[sessionId] redirects to /wrapped when intro_dismissed_at is null", async ({
    browser,
  }) => {
    // Close the session (is_active = false)
    await closeSession();
    await seedWrappedStats(organizerUserId, null);

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/play/${SESSION_ID}`, { waitUntil: "networkidle" });

      // Should land on the wrapped page for this player
      await expect(page).toHaveURL(
        new RegExp(`/wrapped/${SESSION_ID}/${organizerUserId}`),
        { timeout: 10_000 }
      );

      // Intro overlay should be visible (not dismissed)
      await expect(
        page.getByRole("dialog", { name: "Session Wrapped intro" })
      ).toBeVisible({ timeout: 8_000 });
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [G] /play/[sessionId] → /play (already dismissed)
// ─────────────────────────────────────────────────────────────
test.describe("Wrapped Dismiss — [G] /play redirect → lobby when already dismissed", () => {
  test("navigating /play/[sessionId] redirects to /play when intro_dismissed_at is set", async ({
    browser,
  }) => {
    // Close the session + mark as already dismissed
    await closeSession();
    await seedWrappedStats(organizerUserId, new Date().toISOString());

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/play/${SESSION_ID}`, { waitUntil: "networkidle" });

      // The server redirects to /play, which may itself auto-forward to
      // /play/[some-other-active-session-id]. Either way, the player must
      // NOT be sent to the wrapped page for this already-dismissed session.
      await page.waitForURL(/\/play/, { timeout: 10_000 });
      expect(page.url()).not.toContain(`/wrapped/${SESSION_ID}`);
    } finally {
      await context.close();
    }
  });
});
