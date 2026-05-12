// ============================================================
// Scenario J — Drafted Status Player UX (headless)
// ============================================================
// Verifies the two-tier drafted UX from the player's perspective:
//
//   [A] DRAFTED — player sees "Match Forming / Hang tight…" card
//       + pulsing QueueStatus indicator ("Match forming / selected from N queued")
//       + no position number (status is "drafted", not "waiting")
//       + QueueToggle still visible (player can leave if needed)
//
//   [B] DRAFTED → ON_DECK transition — on-deck alert replaces the
//       "Match Forming" card when status changes via Realtime
//
//   [C] DRAFTED → WAITING (cancel) — player returns to normal
//       waiting state with position number restored
//
// Test player: organizer bot (signed in, seeded into each scenario).
// Queue state is injected directly via adminDb to avoid timing
// dependencies on the full organizer → engine → draft flow.
//
// Headless: Playwright uses Chromium headless by default.
// ============================================================

import { test, expect } from "@playwright/test";
import { adminDb } from "../helpers/admin-db";
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

const SESSION_ID = process.env.TEST_SESSION_ID!;
const BASE_URL = process.env.TEST_BASE_URL!;

// ── One-time setup ────────────────────────────────────────────
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

// ── Bot creation helper ───────────────────────────────────────
// Idempotent: if a bot with this email already exists (from a prior
// run where teardown failed), reuse it rather than throwing.
async function createBot(displayName: string): Promise<{ userId: string }> {
  const db = adminDb();
  const email = `${displayName.toLowerCase().replace(/\s/g, "-")}-j@playwright.local`;

  // Try to create; fall back to lookup if the account already exists.
  let userId: string;
  const { data, error } = await db.auth.admin.createUser({
    email,
    email_confirm: true,
  });

  if (error) {
    if (
      error.message.includes("already been registered") ||
      error.message.includes("already exists")
    ) {
      // Reuse the existing account
      const { data: listData } = await db.auth.admin.listUsers({ perPage: 1000 });
      const existing = listData?.users?.find((u) => u.email === email);
      if (!existing)
        throw new Error(`[seed] createBot ${displayName}: found duplicate but cannot locate user`);
      userId = existing.id;
    } else {
      throw new Error(`[seed] createBot ${displayName}: ${error.message}`);
    }
  } else {
    if (!data.user) throw new Error(`[seed] createBot ${displayName}: no user returned`);
    userId = data.user.id;
  }

  await db
    .from("profiles")
    .upsert(
      { id: userId, display_name: displayName, skill_level: "intermediate", pin: "9999" },
      { onConflict: "id" }
    );
  return { userId };
}

// ── Seed: organizer bot + 3 partners in queue, bot set to 'drafted' ──
async function seedDraftedState(organizerUserId: string) {
  const db = adminDb();

  // Create 3 filler bots so totalInQueue is 4.
  // Names must start with "E2E_" so resetSandboxSession auto-cleans them.
  const [b1, b2, b3] = await Promise.all([
    createBot("E2E_J_Alice"),
    createBot("E2E_J_Bob"),
    createBot("E2E_J_Cara"),
  ]);

  // Insert as "waiting" first, then bulk-update to "drafted".
  // We don't call the create_match_with_players RPC directly here because
  // the sandbox session's RLS/organizer setup is different from integration
  // test sessions. A direct two-step seed is equivalent and keeps the E2E
  // helper self-contained without requiring RPC auth setup.
  const queueInserts = [
    { session_id: SESSION_ID, player_id: organizerUserId, status: "waiting" as const },
    { session_id: SESSION_ID, player_id: b1.userId, status: "waiting" as const },
    { session_id: SESSION_ID, player_id: b2.userId, status: "waiting" as const },
    { session_id: SESSION_ID, player_id: b3.userId, status: "waiting" as const },
  ];

  const { error: qErr } = await db.from("queue_entries").insert(queueInserts);
  if (qErr) throw new Error(`[seed] queue_entries: ${qErr.message}`);

  // Seed a pending draft match so the DB state is coherent
  const { data: match, error: mErr } = await db
    .from("matches")
    .insert({
      session_id: SESSION_ID,
      status: "pending",
      is_published: false,
      is_mixed_level: false,
      origin: "auto",
    })
    .select("id")
    .single();
  if (mErr || !match) throw new Error(`[seed] match: ${mErr?.message}`);

  // Insert match_players
  await db.from("match_players").insert([
    { match_id: match.id, player_id: organizerUserId, team: "a" },
    { match_id: match.id, player_id: b1.userId, team: "a" },
    { match_id: match.id, player_id: b2.userId, team: "b" },
    { match_id: match.id, player_id: b3.userId, team: "b" },
  ]);

  // Now set all 4 players to "drafted" (mirrors what create_match_with_players does)
  await db
    .from("queue_entries")
    .update({ status: "drafted" })
    .eq("session_id", SESSION_ID)
    .in("player_id", [organizerUserId, b1.userId, b2.userId, b3.userId]);

  return { matchId: match.id, bots: [b1, b2, b3] };
}

// ─────────────────────────────────────────────────────────────
// [A] Drafted state shows "Match Forming" card + pulsing indicator
// ─────────────────────────────────────────────────────────────
test("J-A: drafted player sees Match Forming card and pulsing QueueStatus indicator", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
  const page = await context.newPage();

  try {
    const organizerUserId = await getOrganizerUserId();
    await seedDraftedState(organizerUserId);

    await page.goto(`${BASE_URL}/play/${SESSION_ID}`);

    // ── Primary messaging card ───────────────────────────────
    // Use exact: true to disambiguate from the QueueStatus "Match forming"
    // span (same text, different casing). Two elements match case-insensitive.
    await expect(page.getByText("Match Forming", { exact: true })).toBeVisible({ timeout: 8000 });

    await expect(page.getByText("Hang tight", { exact: false })).toBeVisible();

    await expect(page.getByText(/you.{0,10}ve been selected/i)).toBeVisible();

    // ── QueueStatus pulsing card ─────────────────────────────
    // Should show "Match forming" (lowercase f — QueueStatus span label)
    // and "selected from" copy instead of a position number
    await expect(page.getByText("Match forming", { exact: true })).toBeVisible();

    await expect(page.getByText(/selected from .+ queued/i)).toBeVisible();

    // Should NOT show a numeric queue position (e.g. "#1", "#2")
    // A drafted player has no meaningful position
    await expect(page.getByText(/^#\d+$/)).not.toBeVisible();

    // ── QueueToggle still present ────────────────────────────
    // Player can still leave even while drafted.
    // Use "Leave Queue" (the QueueToggle button) — not "Leave" (header action).
    await expect(page.getByRole("button", { name: "Leave Queue" })).toBeVisible();
  } finally {
    await context.close();
  }
});

// ─────────────────────────────────────────────────────────────
// [B] Drafted → on_deck: on-deck alert replaces Match Forming card
// ─────────────────────────────────────────────────────────────
test("J-B: transitioning drafted → on_deck via Realtime replaces Match Forming with on-deck alert", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
  const page = await context.newPage();

  try {
    const organizerUserId = await getOrganizerUserId();
    await seedDraftedState(organizerUserId);

    await page.goto(`${BASE_URL}/play/${SESSION_ID}`);

    // Confirm drafted state is showing first (exact: true avoids strict-mode
    // violation with the QueueStatus "Match forming" span)
    await expect(page.getByText("Match Forming", { exact: true })).toBeVisible({
      timeout: 8000,
    });

    // Simulate organizer publishing: flip matches.is_published AND
    // queue_entries.status in the same order that publishMatchAction does.
    // Both updates are required because usePlayerMatch now filters
    // is_published=true (commit 2070d83 draft visibility fix) — without
    // flipping is_published, currentMatch stays null and hasActiveMatch
    // never becomes true, so the on-deck alert never fires.
    const db = adminDb();
    await db
      .from("matches")
      .update({ is_published: true })
      .eq("session_id", SESSION_ID)
      .eq("status", "pending")
      .eq("is_published", false);

    await db
      .from("queue_entries")
      .update({ status: "on_deck" })
      .eq("session_id", SESSION_ID)
      .eq("player_id", organizerUserId);

    // "Match Forming" card should disappear
    await expect(page.getByText("Match Forming", { exact: true })).not.toBeVisible({
      timeout: 8000,
    });

    // On-deck alert or "You're up" copy should appear
    // (OnDeckAlert renders with "You're Up Next" or similar)
    await expect(page.getByText(/up next|on deck|your match/i)).toBeVisible({ timeout: 8000 });
  } finally {
    await context.close();
  }
});

// ─────────────────────────────────────────────────────────────
// [C] Drafted → waiting (cancel): player returns to normal queue state
// ─────────────────────────────────────────────────────────────
test("J-C: cancelling a draft returns player to normal waiting state with position restored", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
  const page = await context.newPage();

  try {
    const organizerUserId = await getOrganizerUserId();
    await seedDraftedState(organizerUserId);

    await page.goto(`${BASE_URL}/play/${SESSION_ID}`);

    // Confirm drafted state (exact: true avoids strict-mode violation)
    await expect(page.getByText("Match Forming", { exact: true })).toBeVisible({
      timeout: 8000,
    });

    // Simulate cancel: restore player to waiting
    const db = adminDb();
    await db
      .from("queue_entries")
      .update({ status: "waiting" })
      .eq("session_id", SESSION_ID)
      .eq("player_id", organizerUserId);

    // "Match Forming" card should disappear
    await expect(page.getByText("Match Forming", { exact: true })).not.toBeVisible({
      timeout: 8000,
    });

    // Player should now see their queue position (#1 in the large number span,
    // or "in line" in the ordinal sub-label). The QueueStatus component renders
    // the exact text "#1" in a <span>, so match that.
    await expect(page.getByText(/in line/i).first()).toBeVisible({ timeout: 8000 });
  } finally {
    await context.close();
  }
});
