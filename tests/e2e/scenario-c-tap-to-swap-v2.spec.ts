// ============================================================
// Scenario C — Tap-to-Swap v2 (Match ↔ Match Direct Swap)
// ============================================================
// Tests the new two-tap Tap-to-Swap v2 feature where the
// organizer can swap players between two on-deck matches
// (or swap teams within the same match) without ever going
// through the bench/queue sheet.
//
// Interaction model:
//   Tap 1 → "picking mode" (floating amber bar + amber ring)
//   Tap 2 (same player)   → cancel picking mode
//   Tap 2 (different pill) → execute swap
//   Esc / × button        → cancel picking mode
//
// Seed: two_matches_on_deck
//   Match 1 (pending): alice/bob (Team A) vs cara/dan  (Team B)
//   Match 2 (pending): eve/frank (Team A) vs grace/henry (Team B)
//   All 8 players: status=on_deck, 2 available courts
//
// Test matrix (11 scenarios):
//   [A] UI — Picking mode activation
//   [B] UI — Cancel by re-tapping selected player
//   [C] UI — Cancel via floating-bar × button
//   [D] UI — Cancel via Esc key
//   [E] SWAP — Same-match team swap (alice ↔ cara, same match)
//   [F] SWAP — Cross-match player swap (alice ↔ eve, different matches)
//   [G] SWAP — VIP tag preserved on player pill during swap mode
//   [H] ESCAPE — "Pick from Bench" opens legacy swap sheet
//   [I] UNDO — Cross-match swap undo reverts DB state
//   [J] GUARD — In-progress court players are NOT tappable
//   [K] GUARD — Layer 2 pre-flight: match starts during picking → cancelled
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

dotenv.config({ path: path.resolve(__dirname, "../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), override: false });

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
let seeded: Awaited<ReturnType<typeof seedSession>>;

test.beforeEach(async () => {
  await resetSandboxSession();
  seeded = await seedSession("two_matches_on_deck");
});

// ─────────────────────────────────────────────────────────────
// [A] Picking mode activation
// ─────────────────────────────────────────────────────────────
test.describe("Tap-to-Swap v2 — [A] Picking mode activation", () => {
  test("first tap enters picking mode: amber ring on pill, floating bar appears", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}${clubOrganizer(seeded.clubSlug, seeded.sessionId)}`
      );
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Floating bar should NOT exist before any tap
      await expect(page.getByTestId("swap-floating-bar")).not.toBeVisible();

      // Tap Alice's pill (she's on Match 1 Team A)
      const alicePill = page.getByTestId(`player-pill-${seeded.players.alice.userId}`);
      await expect(alicePill).toBeVisible({ timeout: 8_000 });
      await alicePill.click();

      // Floating bar should appear
      await expect(page.getByTestId("swap-floating-bar")).toBeVisible({ timeout: 5_000 });

      // Bar should contain Alice's name
      await expect(page.getByTestId("swap-floating-bar").getByText("E2E_Alice")).toBeVisible();

      // Bar should show team label
      await expect(page.getByTestId("swap-floating-bar").getByText("Team A")).toBeVisible();

      // Floating bar should have "Pick from Bench" and Cancel buttons
      await expect(
        page.getByTestId("swap-floating-bar").getByRole("button", { name: "Bench" })
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Cancel swap" })).toBeVisible();

      // Alice's pill should have aria-pressed="true" (selected state)
      await expect(alicePill).toHaveAttribute("aria-pressed", "true");

      // Legacy swap sheet (SheetContent / "Swap Player" dialog) should NOT be open
      await expect(page.getByRole("dialog", { name: /swap player/i })).not.toBeVisible();
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [B] Cancel by re-tapping selected player
// ─────────────────────────────────────────────────────────────
test.describe("Tap-to-Swap v2 — [B] Cancel by re-tap", () => {
  test("tapping the selected player again clears picking mode", async ({ browser }) => {
    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}${clubOrganizer(seeded.clubSlug, seeded.sessionId)}`
      );
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      const alicePill = page.getByTestId(`player-pill-${seeded.players.alice.userId}`);
      await alicePill.click();
      await expect(page.getByTestId("swap-floating-bar")).toBeVisible({ timeout: 5_000 });

      // Tap Alice again — should cancel
      await alicePill.click();

      await expect(page.getByTestId("swap-floating-bar")).not.toBeVisible({ timeout: 5_000 });
      await expect(alicePill).toHaveAttribute("aria-pressed", "false");
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [C] Cancel via floating-bar × button
// ─────────────────────────────────────────────────────────────
test.describe("Tap-to-Swap v2 — [C] Cancel via × button", () => {
  test("clicking the × cancel button dismisses picking mode", async ({ browser }) => {
    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}${clubOrganizer(seeded.clubSlug, seeded.sessionId)}`
      );
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      const alicePill = page.getByTestId(`player-pill-${seeded.players.alice.userId}`);
      await alicePill.click();
      await expect(page.getByTestId("swap-floating-bar")).toBeVisible({ timeout: 5_000 });

      // Click Cancel (×) button
      await page.getByRole("button", { name: "Cancel swap" }).click();

      await expect(page.getByTestId("swap-floating-bar")).not.toBeVisible({ timeout: 5_000 });
      await expect(alicePill).toHaveAttribute("aria-pressed", "false");

      // DB should be unchanged
      const { data: matchPlayers } = await adminDb()
        .from("match_players")
        .select("player_id")
        .eq("match_id", seeded.matchId!);
      const ids = (matchPlayers ?? []).map((p) => p.player_id);
      expect(ids).toContain(seeded.players.alice.userId);
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [D] Cancel via Esc key
// ─────────────────────────────────────────────────────────────
test.describe("Tap-to-Swap v2 — [D] Cancel via Esc key", () => {
  test("pressing Escape dismisses picking mode", async ({ browser }) => {
    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}${clubOrganizer(seeded.clubSlug, seeded.sessionId)}`
      );
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      const alicePill = page.getByTestId(`player-pill-${seeded.players.alice.userId}`);
      await alicePill.click();
      await expect(page.getByTestId("swap-floating-bar")).toBeVisible({ timeout: 5_000 });

      // Press Esc
      await page.keyboard.press("Escape");

      await expect(page.getByTestId("swap-floating-bar")).not.toBeVisible({ timeout: 5_000 });
      await expect(alicePill).toHaveAttribute("aria-pressed", "false");
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [E] Same-match team swap
// ─────────────────────────────────────────────────────────────
test.describe("Tap-to-Swap v2 — [E] Same-match team swap", () => {
  test("alice (Team A) ↔ cara (Team B) in match 1: teams swap, DB updated", async ({ browser }) => {
    const db = adminDb();
    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}${clubOrganizer(seeded.clubSlug, seeded.sessionId)}`
      );
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Tap Alice (match 1, Team A)
      await page.getByTestId(`player-pill-${seeded.players.alice.userId}`).click();
      await expect(page.getByTestId("swap-floating-bar")).toBeVisible({ timeout: 5_000 });

      // Tap Cara (match 1, Team B)
      await page.getByTestId(`player-pill-${seeded.players.cara.userId}`).click();

      // Floating bar should disappear (swap executed)
      await expect(page.getByTestId("swap-floating-bar")).not.toBeVisible({ timeout: 8_000 });

      // Toast should confirm a swap
      await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Swapped" })).toBeVisible({
        timeout: 8_000,
      });

      // ── DB assertions ──────────────────────────────────────
      const matchId = seeded.matchId!;

      const { data: matchPlayers } = await db
        .from("match_players")
        .select("player_id, team")
        .eq("match_id", matchId);

      const aliceRow = (matchPlayers ?? []).find(
        (p) => p.player_id === seeded.players.alice.userId
      );
      const caraRow = (matchPlayers ?? []).find((p) => p.player_id === seeded.players.cara.userId);

      // Alice should now be on Team B, Cara on Team A
      expect(aliceRow?.team).toBe("b");
      expect(caraRow?.team).toBe("a");

      // Bob and Dan remain on their original teams
      const bobRow = (matchPlayers ?? []).find((p) => p.player_id === seeded.players.bob.userId);
      const danRow = (matchPlayers ?? []).find((p) => p.player_id === seeded.players.dan.userId);
      expect(bobRow?.team).toBe("a");
      expect(danRow?.team).toBe("b");

      // All 4 still in the same match
      expect(matchPlayers).toHaveLength(4);
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [F] Cross-match player swap
// ─────────────────────────────────────────────────────────────
test.describe("Tap-to-Swap v2 — [F] Cross-match player swap", () => {
  test("alice (match 1) ↔ eve (match 2): both players switch matches and inherit teams", async ({
    browser,
  }) => {
    const db = adminDb();
    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}${clubOrganizer(seeded.clubSlug, seeded.sessionId)}`
      );
      // Reload once if the courts tab doesn't appear — by test [F] (6th beforeEach cycle)
      // the dev server can be slow to hydrate on the first navigation attempt.
      const tabReady = await page
        .waitForSelector('[id="tabpanel-courts"]', { timeout: 10_000 })
        .catch(() => null);
      if (!tabReady) {
        await page.reload({ waitUntil: "networkidle" });
        await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });
      }

      // Tap Alice (match 1, Team A) — enters picking mode
      await page.getByTestId(`player-pill-${seeded.players.alice.userId}`).click();
      await expect(page.getByTestId("swap-floating-bar")).toBeVisible({ timeout: 5_000 });

      // Tap Eve (match 2, Team A) — executes cross-match swap
      await page.getByTestId(`player-pill-${seeded.players.eve.userId}`).click();

      await expect(page.getByTestId("swap-floating-bar")).not.toBeVisible({ timeout: 8_000 });

      await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Swapped" })).toBeVisible({
        timeout: 8_000,
      });

      // ── DB: Match 1 now has Eve instead of Alice (Team A) ───
      const { data: m1Players } = await db
        .from("match_players")
        .select("player_id, team")
        .eq("match_id", seeded.matchId!);

      const m1Ids = (m1Players ?? []).map((p) => p.player_id);
      expect(m1Ids).toContain(seeded.players.eve.userId);
      expect(m1Ids).not.toContain(seeded.players.alice.userId);
      expect(m1Ids).toContain(seeded.players.bob.userId);
      expect(m1Ids).toContain(seeded.players.cara.userId);
      expect(m1Ids).toContain(seeded.players.dan.userId);
      expect(m1Players).toHaveLength(4);

      // Eve inherits Alice's Team A slot in match 1
      const eveInM1 = (m1Players ?? []).find((p) => p.player_id === seeded.players.eve.userId);
      expect(eveInM1?.team).toBe("a");

      // ── DB: Match 2 now has Alice instead of Eve (Team A) ───
      const { data: m2Players } = await db
        .from("match_players")
        .select("player_id, team")
        .eq("match_id", seeded.matchId2!);

      const m2Ids = (m2Players ?? []).map((p) => p.player_id);
      expect(m2Ids).toContain(seeded.players.alice.userId);
      expect(m2Ids).not.toContain(seeded.players.eve.userId);
      expect(m2Players).toHaveLength(4);

      // Alice inherits Eve's Team A slot in match 2
      const aliceInM2 = (m2Players ?? []).find((p) => p.player_id === seeded.players.alice.userId);
      expect(aliceInM2?.team).toBe("a");

      // ── queue_entries: both players remain on_deck ───────────
      const { data: queueRows } = await db
        .from("queue_entries")
        .select("player_id, status")
        .eq("session_id", seeded.sessionId)
        .in("player_id", [seeded.players.alice.userId, seeded.players.eve.userId]);

      for (const row of queueRows ?? []) {
        expect(row.status).toBe("on_deck");
      }
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [G] VIP tag preserved during swap mode
// ─────────────────────────────────────────────────────────────
test.describe("Tap-to-Swap v2 — [G] VIP tag preserved", () => {
  test("VIP tag on player pill remains visible in picking mode and after swap", async ({
    browser,
  }) => {
    const db = adminDb();

    // Give Alice a VIP tag before the test
    await db
      .from("profiles")
      .update({ vip_tag: "VIP", vip_theme: "gold-prestige" })
      .eq("id", seeded.players.alice.userId);

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}${clubOrganizer(seeded.clubSlug, seeded.sessionId)}`
      );
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // VIP tag visible before picking mode.
      // VipTag renders two spans (one light-mode, one dark-mode) — use .first()
      // so the strict-mode check doesn't fail on the hidden counterpart.
      const alicePill = page.getByTestId(`player-pill-${seeded.players.alice.userId}`);
      await expect(alicePill.getByText("VIP").filter({ visible: true })).toBeVisible({
        timeout: 8_000,
      });

      // Enter picking mode (tap Alice)
      await alicePill.click();
      await expect(page.getByTestId("swap-floating-bar")).toBeVisible({ timeout: 5_000 });

      // VIP tag still visible on selected pill while in picking mode
      await expect(alicePill.getByText("VIP").filter({ visible: true })).toBeVisible();

      // Execute swap with Eve (cross-match)
      await page.getByTestId(`player-pill-${seeded.players.eve.userId}`).click();
      await expect(page.getByTestId("swap-floating-bar")).not.toBeVisible({ timeout: 8_000 });

      // Alice is now in match 2 — her pill should still show the VIP tag
      const alicePillM2 = page.getByTestId(`player-pill-${seeded.players.alice.userId}`);
      await expect(alicePillM2.getByText("VIP").filter({ visible: true })).toBeVisible({
        timeout: 5_000,
      });
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [H] "Pick from Bench" escape to legacy sheet
// ─────────────────────────────────────────────────────────────
test.describe("Tap-to-Swap v2 — [H] Pick from Bench escape", () => {
  test("clicking 'Pick from Bench' in floating bar opens legacy swap sheet", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}${clubOrganizer(seeded.clubSlug, seeded.sessionId)}`
      );
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Tap Alice — enter picking mode
      await page.getByTestId(`player-pill-${seeded.players.alice.userId}`).click();
      await expect(page.getByTestId("swap-floating-bar")).toBeVisible({ timeout: 5_000 });

      // Click "Pick from Bench"
      await page.getByTestId("swap-floating-bar").getByRole("button", { name: "Bench" }).click();

      // Floating bar should disappear (mode switches to "sheet")
      await expect(page.getByTestId("swap-floating-bar")).not.toBeVisible({ timeout: 5_000 });

      // Legacy "Swap Player" dialog should open
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText("Swap Player")).toBeVisible();

      // The dialog should still reference Alice as the outgoing player
      await expect(page.getByRole("dialog").getByText("E2E_Alice")).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [I] Undo cross-match swap
// ─────────────────────────────────────────────────────────────
test.describe("Tap-to-Swap v2 — [I] Undo", () => {
  test("undo on the 5s toast reverts alice ↔ eve cross-match swap in DB", async ({ browser }) => {
    const db = adminDb();
    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}${clubOrganizer(seeded.clubSlug, seeded.sessionId)}`
      );
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Execute cross-match swap: Alice ↔ Eve
      await page.getByTestId(`player-pill-${seeded.players.alice.userId}`).click();
      await expect(page.getByTestId("swap-floating-bar")).toBeVisible({ timeout: 5_000 });
      await page.getByTestId(`player-pill-${seeded.players.eve.userId}`).click();

      // Wait for undo toast
      const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Swapped" });
      await expect(toast).toBeVisible({ timeout: 8_000 });

      // Click Undo
      await toast.getByRole("button", { name: "Undo" }).click();

      // Wait for "Swap undone." confirmation toast — this fires only after the
      // server action resolves, so it's the reliable gate before the DB check.
      await expect(
        page.locator("[data-sonner-toast]").filter({ hasText: "Swap undone" })
      ).toBeVisible({ timeout: 10_000 });

      // Alice's pill should now be back in match 1's court card
      await expect(page.getByTestId(`player-pill-${seeded.players.alice.userId}`)).toBeVisible({
        timeout: 5_000,
      });

      // ── DB: Alice back in match 1 ─────────────────────────
      const { data: m1Players } = await db
        .from("match_players")
        .select("player_id, team")
        .eq("match_id", seeded.matchId!);

      const m1Ids = (m1Players ?? []).map((p) => p.player_id);
      expect(m1Ids).toContain(seeded.players.alice.userId);
      expect(m1Ids).not.toContain(seeded.players.eve.userId);

      // Alice back on Team A in match 1
      const aliceRow = (m1Players ?? []).find((p) => p.player_id === seeded.players.alice.userId);
      expect(aliceRow?.team).toBe("a");

      // ── DB: Eve back in match 2 ───────────────────────────
      const { data: m2Players } = await db
        .from("match_players")
        .select("player_id, team")
        .eq("match_id", seeded.matchId2!);

      const m2Ids = (m2Players ?? []).map((p) => p.player_id);
      expect(m2Ids).toContain(seeded.players.eve.userId);
      expect(m2Ids).not.toContain(seeded.players.alice.userId);
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [J] In-progress court players are NOT tappable
// ─────────────────────────────────────────────────────────────
test.describe("Tap-to-Swap v2 — [J] Active court locked", () => {
  test("players on an in-progress court have no swap button — no picking mode triggered", async ({
    browser,
  }) => {
    // Re-seed with first_match_in_progress (active court, no on-deck match)
    await resetSandboxSession();
    seeded = await seedSession("first_match_in_progress");

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}${clubOrganizer(seeded.clubSlug, seeded.sessionId)}`
      );
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Active court card should be visible
      // The court card is the ActiveCourts section (not OnDeckPanel)
      // Player pills on active courts are <div>, NOT <button> — no role="button"
      const alicePillLocator = page.locator(
        `[data-testid="player-pill-${seeded.players.alice.userId}"]`
      );

      // The pill should either not exist (no data-testid on div variant) or
      // if present, should NOT be a button element
      const pillCount = await alicePillLocator.count();
      if (pillCount > 0) {
        // If a pill element exists, it must NOT be a button
        const tagName = await alicePillLocator.evaluate((el) => el.tagName.toLowerCase());
        expect(tagName).not.toBe("button");
      }

      // After any interaction, floating bar should NOT appear
      if (pillCount > 0) {
        // Try clicking — should do nothing (not a button)
        await alicePillLocator.click({ force: true });
        await page.waitForTimeout(500);
      }
      await expect(page.getByTestId("swap-floating-bar")).not.toBeVisible();
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [K] Layer 2 pre-flight guard
// ─────────────────────────────────────────────────────────────
test.describe("Tap-to-Swap v2 — [K] Layer 2 pre-flight guard", () => {
  test("swap cancelled with warning when target match starts between first and second tap", async ({
    browser,
  }) => {
    const db = adminDb();
    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}${clubOrganizer(seeded.clubSlug, seeded.sessionId)}`
      );
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Tap Alice — enters picking mode (match 1 selected)
      await page.getByTestId(`player-pill-${seeded.players.alice.userId}`).click();
      await expect(page.getByTestId("swap-floating-bar")).toBeVisible({ timeout: 5_000 });

      // While in picking mode: promote Match 2 to in_progress via DB
      // This simulates the organizer calling another match to the court
      await db
        .from("matches")
        .update({ status: "in_progress", started_at: new Date().toISOString() })
        .eq("id", seeded.matchId2!);

      await db
        .from("queue_entries")
        .update({ status: "playing" })
        .eq("session_id", seeded.sessionId)
        .in("player_id", [
          seeded.players.eve.userId,
          seeded.extraPlayers.frank.userId,
          seeded.extraPlayers.grace.userId,
          seeded.extraPlayers.henry.userId,
        ]);

      // Wait for Realtime to propagate (~2s) then tap Eve (now in an in-progress match)
      await page.waitForTimeout(2_500);

      // Eve's pill should no longer be interactive (match promoted to in_progress,
      // which means it moved from OnDeckPanel to ActiveCourts — button removed)
      // The swap floating bar will either:
      //   a) Auto-clear via the Realtime onDeckMatches update (match 2 gone)
      //   b) Show a warning if the tap hits the Layer 2 pre-flight check
      //
      // Either way: after this interaction, the floating bar should be gone
      // and no swap should have occurred in match 1.
      const eveLocator = page.getByTestId(`player-pill-${seeded.players.eve.userId}`);
      const eveVisible = await eveLocator.isVisible();

      if (eveVisible) {
        await eveLocator.click({ force: true });
      }

      // Floating bar should be dismissed (either via Realtime or Layer 2 guard)
      await expect(page.getByTestId("swap-floating-bar")).not.toBeVisible({ timeout: 8_000 });

      // Match 1 DB state unchanged — Alice still in match 1
      const { data: m1Players } = await db
        .from("match_players")
        .select("player_id")
        .eq("match_id", seeded.matchId!);

      const m1Ids = (m1Players ?? []).map((p) => p.player_id);
      expect(m1Ids).toContain(seeded.players.alice.userId);
      expect(m1Ids).toContain(seeded.players.bob.userId);
      expect(m1Ids).toContain(seeded.players.cara.userId);
      expect(m1Ids).toContain(seeded.players.dan.userId);
      expect(m1Players).toHaveLength(4);
    } finally {
      await context.close();
    }
  });
});
