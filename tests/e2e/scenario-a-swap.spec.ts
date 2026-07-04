// ============================================================
// Scenario A — Tap-to-Swap Flow
// ============================================================
// Tests the new Tap-to-Swap feature where an organizer replaces
// a player in an on-deck match with a waiting player.
//
// Initial state (seeded fresh before each test):
//   - 2 courts (both available)
//   - 5 bot players: Alice, Bob, Cara, Dan (on-deck match), Eve (waiting)
//   - Match: alice+bob (Team A) vs cara+dan (Team B), status=pending
//   - Eve in queue with status=waiting
//
// Happy path assertions:
//   UI:  - SwapSheet opens with Eve as an available candidate
//        - Confirm button enabled after selecting Eve
//        - Sheet closes and "Swapped … → …" toast appears
//        - On-deck card now shows Eve, NOT Alice
//   DB:  - match_players: Alice removed, Eve added (Team A)
//        - queue_entries: Eve=on_deck, Alice=waiting
//        - matches.is_mixed_level=false (all intermediate)
//
// Negative path (separate test):
//   - SwapSheet opens → match is promoted (status→in_progress) mid-swap
//   - Confirm fires → sheet auto-closes with MATCH_STARTED error toast
// ============================================================

import { test, expect } from "@playwright/test";
import { adminDb } from "../helpers/admin-db";
import dotenv from "dotenv";
import path from "path";

import { resetSandboxSession, seedSession } from "../helpers/teardown";
import { clubOrganizer } from "../../src/lib/club-paths";
import {
  ensureOrganizerAccount,
  signInOrganizerBot,
  ORGANIZER_STORAGE_STATE,
} from "../fixtures/auth";

// Load .env.test secrets before any test runs
dotenv.config({ path: path.resolve(__dirname, "../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), override: false });

// ── One-time global setup ──────────────────────────────────────
// Creates the organizer bot account if it doesn't exist.
// Runs before all tests in this file.
test.beforeAll(async ({ browser }) => {
  await ensureOrganizerAccount();

  // Sign in the organizer bot and save storage state (if not cached)
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await signInOrganizerBot(page, process.env.TEST_BASE_URL!);
  } finally {
    await context.close();
  }
});

// ── Per-test setup ─────────────────────────────────────────────
// Wipe + reseed the sandbox session before each test to guarantee
// a clean, deterministic state. This is the idempotency keystone.
let seeded: Awaited<ReturnType<typeof seedSession>>;

test.beforeEach(async () => {
  await resetSandboxSession();
  seeded = await seedSession("first_match_on_deck");
});

// ── Tests ─────────────────────────────────────────────────────

test.describe("Tap-to-Swap — Happy Path", () => {
  test("organizer swaps Alice out → Eve in; UI + DB both reflect the change", async ({
    browser,
  }) => {
    const db = adminDb();

    // Use the saved organizer storage state so we start authenticated.
    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      // Lazy locator declarations — Playwright resolves these at the moment
      // each action runs, so defining them before the step blocks is fine.
      const alicePill = page.locator(`[data-testid="player-pill-${seeded.players.alice.userId}"]`);
      const eveCandidate = page.locator(
        `[data-testid="swap-candidate-${seeded.players.eve.userId}"]`
      );
      const confirmBtn = page.locator('[data-testid="swap-confirm"]');

      // ── Steps 1–2 ───────────────────────────────────────────
      await test.step("1–2 · Navigate to dashboard and verify on-deck card", async () => {
        await page.goto(
          `${process.env.TEST_BASE_URL}${clubOrganizer(seeded.clubSlug, seeded.sessionId)}`
        );
        // Wait for the courts tab (active by default) to load
        await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });
        // The OnDeckPanel renders on the courts tab alongside ActiveCourts.
        await expect(page.getByText("On Deck #1")).toBeVisible({ timeout: 10_000 });
      });

      // ── Steps 3–5 ───────────────────────────────────────────
      await test.step("3–5 · Open swap sheet via Tap-to-Swap picking mode", async () => {
        // Tap-to-Swap v2: first tap enters picking mode (floating amber bar).
        await expect(alicePill).toBeVisible({ timeout: 5_000 });
        await alicePill.click();

        // "Pick from Bench" escalates from picking mode to the legacy SwapSheet dialog.
        await expect(page.getByTestId("swap-floating-bar")).toBeVisible({ timeout: 5_000 });
        await page.getByTestId("swap-floating-bar").getByRole("button", { name: "Bench" }).click();

        // Sheet is open and shows the outgoing player.
        // Scope to the dialog to avoid strict-mode violation with the player
        // pill (which also contains "E2E_Alice") still visible in the background.
        await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
        await expect(page.getByText("Swap Player")).toBeVisible();
        await expect(page.getByRole("dialog").getByText("E2E_Alice")).toBeVisible();
      });

      // ── Steps 6–8 ───────────────────────────────────────────
      await test.step("6–8 · Select Eve; verify in-match players are excluded", async () => {
        // Eve (waiting) must appear; Alice/Bob (in match) must NOT appear as candidates.
        await expect(eveCandidate).toBeVisible({ timeout: 5_000 });
        await expect(
          page.locator(`[data-testid="swap-candidate-${seeded.players.alice.userId}"]`)
        ).not.toBeVisible();
        await expect(
          page.locator(`[data-testid="swap-candidate-${seeded.players.bob.userId}"]`)
        ).not.toBeVisible();

        // Confirm is disabled before a selection is made.
        await expect(confirmBtn).toBeDisabled();

        await eveCandidate.click();

        // Confirm enabled; no mismatch warning (all players are intermediate).
        await expect(confirmBtn).toBeEnabled({ timeout: 3_000 });
        await expect(page.getByText("mixed-level match")).not.toBeVisible();
      });

      // ── Step 9 ──────────────────────────────────────────────
      await test.step("9 · Confirm the swap", async () => {
        await confirmBtn.click();
      });

      // ── Step 10 ─────────────────────────────────────────────
      await test.step("10 · UI: sheet closed, toast shown, on-deck card updated", async () => {
        // Sheet should close automatically after successful swap.
        await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5_000 });

        // Sonner toast confirms the swap (data-sonner-toast is Sonner's DOM marker).
        await expect(
          page.locator("[data-sonner-toast]").filter({ hasText: "Swapped" })
        ).toBeVisible({ timeout: 5_000 });

        // On-deck card: Eve is now shown (testid avoids matching toast text).
        await expect(page.getByTestId(`player-pill-${seeded.players.eve.userId}`)).toBeVisible({
          timeout: 5_000,
        });

        // Alice is back in the waiting queue — her pill must be gone from the card.
        await expect(
          page.getByTestId(`player-pill-${seeded.players.alice.userId}`)
        ).not.toBeVisible({ timeout: 3_000 });
      });

      // ── Step 11 ─────────────────────────────────────────────
      await test.step("11 · DB: match_players, queue_entries, and is_mixed_level", async () => {
        const matchId = seeded.matchId!;

        // match_players: Eve in, Alice out — roster still 4 players.
        const { data: matchPlayers } = await db
          .from("match_players")
          .select("player_id, team")
          .eq("match_id", matchId);

        const playerIds = (matchPlayers ?? []).map((p) => p.player_id);
        expect(playerIds).toContain(seeded.players.eve.userId);
        expect(playerIds).not.toContain(seeded.players.alice.userId);
        expect(playerIds).toContain(seeded.players.bob.userId);
        expect(playerIds).toContain(seeded.players.cara.userId);
        expect(playerIds).toContain(seeded.players.dan.userId);
        expect(matchPlayers).toHaveLength(4);

        // Eve inherits Alice's team slot ("a").
        const eveRow = (matchPlayers ?? []).find((p) => p.player_id === seeded.players.eve.userId);
        expect(eveRow?.team).toBe("a");

        // queue_entries: Eve promoted to on_deck; Alice demoted to waiting.
        const { data: queueEntries } = await db
          .from("queue_entries")
          .select("player_id, status")
          .eq("session_id", seeded.sessionId)
          .in("player_id", [seeded.players.alice.userId, seeded.players.eve.userId]);

        const eveQueue = queueEntries?.find((q) => q.player_id === seeded.players.eve.userId);
        const aliceQueue = queueEntries?.find((q) => q.player_id === seeded.players.alice.userId);

        expect(eveQueue?.status).toBe("on_deck");
        expect(aliceQueue?.status).toBe("waiting");

        // is_mixed_level must be false — all four remaining players are intermediate.
        const { data: matchRow } = await db
          .from("matches")
          .select("is_mixed_level")
          .eq("id", matchId)
          .single();

        expect(matchRow?.is_mixed_level).toBe(false);
      });
    } finally {
      await context.close();
    }
  });
});

test.describe("Tap-to-Swap — Skill Mismatch Warning", () => {
  test("mismatch banner shown when replacement creates mixed-level match", async ({ browser }) => {
    // Re-seed: make Eve advanced (mismatch with the intermediate team)
    const db = adminDb();
    await db
      .from("profiles")
      .update({ skill_level: "advanced" })
      .eq("id", seeded.players.eve.userId);

    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}${clubOrganizer(seeded.clubSlug, seeded.sessionId)}`
      );
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Open swap sheet for Alice via v2 flow: tap → picking mode → "Pick from Bench"
      await page.locator(`[data-testid="player-pill-${seeded.players.alice.userId}"]`).click();

      await expect(page.getByTestId("swap-floating-bar")).toBeVisible({ timeout: 5_000 });
      await page.getByTestId("swap-floating-bar").getByRole("button", { name: "Bench" }).click();

      await expect(page.getByRole("dialog")).toBeVisible();

      // Select Eve (advanced vs intermediate team)
      await page.locator(`[data-testid="swap-candidate-${seeded.players.eve.userId}"]`).click();

      // Mismatch warning banner should be visible
      await expect(page.getByText("mixed-level match")).toBeVisible({ timeout: 3_000 });

      // Confirm button should still be enabled (warning is non-blocking)
      await expect(page.locator('[data-testid="swap-confirm"]')).toBeEnabled();

      // Dismiss the warning
      await page.getByLabel("Dismiss mixed-level warning").click();
      await expect(page.getByText("mixed-level match")).not.toBeVisible();
    } finally {
      await context.close();
    }
  });
});

test.describe("Tap-to-Swap — Negative Paths", () => {
  test("MATCH_STARTED: sheet auto-closes when match is promoted mid-swap", async ({ browser }) => {
    const db = adminDb();
    const matchId = seeded.matchId!;

    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}${clubOrganizer(seeded.clubSlug, seeded.sessionId)}`
      );
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Open swap sheet for Alice via v2 flow: tap → picking mode → "Pick from Bench"
      await page.locator(`[data-testid="player-pill-${seeded.players.alice.userId}"]`).click();
      await expect(page.getByTestId("swap-floating-bar")).toBeVisible({ timeout: 5_000 });
      await page.getByTestId("swap-floating-bar").getByRole("button", { name: "Bench" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();

      // Simulate match being promoted while sheet is open:
      // Set match status to in_progress via DB (bypassing the UI)
      await db
        .from("matches")
        .update({ status: "in_progress", started_at: new Date().toISOString() })
        .eq("id", matchId);

      // Also update queue entries to "playing" to match
      await db
        .from("queue_entries")
        .update({ status: "playing" })
        .eq("session_id", seeded.sessionId)
        .in("player_id", [
          seeded.players.alice.userId,
          seeded.players.bob.userId,
          seeded.players.cara.userId,
          seeded.players.dan.userId,
        ]);

      // Select Eve and confirm the swap
      await page.locator(`[data-testid="swap-candidate-${seeded.players.eve.userId}"]`).click();
      await page.locator('[data-testid="swap-confirm"]').click();

      // The sheet should close (either MATCH_STARTED error or Layer 2 useEffect)
      // Layer 2 useEffect in the dashboard auto-dismisses when the match
      // disappears from onDeckMatches via realtime. The server action guard
      // also returns MATCH_STARTED → onClose() called immediately.
      await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 8_000 });

      // DB: Alice should still be in the match (swap was rejected)
      const { data: matchPlayers } = await db
        .from("match_players")
        .select("player_id")
        .eq("match_id", matchId);

      const playerIds = (matchPlayers ?? []).map((p) => p.player_id);
      expect(playerIds).toContain(seeded.players.alice.userId);
      expect(playerIds).not.toContain(seeded.players.eve.userId);
    } finally {
      await context.close();
    }
  });

  test("sheet shows error and stays open when selected player is no longer available", async ({
    browser,
  }) => {
    const db = adminDb();

    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}${clubOrganizer(seeded.clubSlug, seeded.sessionId)}`
      );
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Open swap sheet for Alice via v2 flow: tap → picking mode → "Pick from Bench"
      await page.locator(`[data-testid="player-pill-${seeded.players.alice.userId}"]`).click();
      await expect(page.getByTestId("swap-floating-bar")).toBeVisible({ timeout: 5_000 });
      await page.getByTestId("swap-floating-bar").getByRole("button", { name: "Bench" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();

      // Select Eve
      await page.locator(`[data-testid="swap-candidate-${seeded.players.eve.userId}"]`).click();

      // Simulate Eve being put on_deck by another organizer before confirm
      await db
        .from("queue_entries")
        .update({ status: "on_deck" })
        .eq("session_id", seeded.sessionId)
        .eq("player_id", seeded.players.eve.userId);

      // Confirm the swap
      await page.locator('[data-testid="swap-confirm"]').click();

      // Sheet should stay open with inline error (PLAYER_UNAVAILABLE)
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText("no longer available")).toBeVisible({ timeout: 5_000 });

      // "Retry" button allows trying again
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

test.describe("Tap-to-Swap — Undo", () => {
  test("Undo action on toast reverses the swap in the DB", async ({ browser }) => {
    const db = adminDb();

    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}${clubOrganizer(seeded.clubSlug, seeded.sessionId)}`
      );
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Perform the swap (Alice → Eve) via v2 flow
      await page.locator(`[data-testid="player-pill-${seeded.players.alice.userId}"]`).click();
      // v2: tap → picking mode (floating bar) → "Pick from Bench" → SwapSheet dialog
      await expect(page.getByTestId("swap-floating-bar")).toBeVisible({ timeout: 5_000 });
      await page.getByTestId("swap-floating-bar").getByRole("button", { name: "Bench" }).click();
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
      await page.locator(`[data-testid="swap-candidate-${seeded.players.eve.userId}"]`).click();
      await page.locator('[data-testid="swap-confirm"]').click();

      // Wait for the undo toast
      const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Swapped" });
      await expect(toast).toBeVisible({ timeout: 5_000 });

      // Click the "Undo" action button on the toast
      await toast.getByRole("button", { name: "Undo" }).click();

      // Wait for the server action to confirm success before checking DB.
      // Without this, the UI optimistic update can land before the DB write commits.
      await expect(
        page.locator("[data-sonner-toast]").filter({ hasText: "Swap undone" })
      ).toBeVisible({ timeout: 8_000 });

      // After undo, Alice should be back in the on-deck card.
      await expect(page.getByTestId(`player-pill-${seeded.players.alice.userId}`)).toBeVisible({
        timeout: 5_000,
      });
      await expect(page.getByTestId(`player-pill-${seeded.players.eve.userId}`)).not.toBeVisible({
        timeout: 3_000,
      });

      // DB verification
      const matchId = seeded.matchId!;
      const { data: matchPlayers } = await db
        .from("match_players")
        .select("player_id")
        .eq("match_id", matchId);

      const playerIds = (matchPlayers ?? []).map((p) => p.player_id);
      expect(playerIds).toContain(seeded.players.alice.userId);
      expect(playerIds).not.toContain(seeded.players.eve.userId);

      // Queue status restored
      const { data: queueEntries } = await db
        .from("queue_entries")
        .select("player_id, status")
        .eq("session_id", seeded.sessionId)
        .in("player_id", [seeded.players.alice.userId, seeded.players.eve.userId]);

      const aliceQueue = queueEntries?.find((q) => q.player_id === seeded.players.alice.userId);
      const eveQueue = queueEntries?.find((q) => q.player_id === seeded.players.eve.userId);

      expect(aliceQueue?.status).toBe("on_deck");
      expect(eveQueue?.status).toBe("waiting");
    } finally {
      await context.close();
    }
  });
});
