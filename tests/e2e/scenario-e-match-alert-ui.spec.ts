// ============================================================
// Scenario E — MatchAlert UI (revamped player match card)
// ============================================================
// Verifies the new MatchAlert component renders correctly from
// a signed-in player's perspective at /play/[sessionId].
//
// Test player: organizer bot (signed-in, seeded into each match).
// The organizer bot is added as a player on Team A alongside a
// single bot partner (E2E_Bob), with E2E_Cara + E2E_Dan on Team B.
//
//   [A] ON-DECK — card shows amber header, YOUR TEAM / OPPONENTS
//       labels, "Next Available Court", and YOU on organizer's row
//   [B] ON-DECK POSITION 2 — eyebrow shows "#2 On Deck" copy
//   [C] IN-PROGRESS — dark navy header shows court name at large
//       size, IT'S YOUR TURN eyebrow, YOUR TEAM / OPPONENTS labels
//   [D] VIP TAG — organizer row renders the VIP tag when set
//
// Teardown: resetSandboxSession wipes all seeded data after each test.
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
const BASE_URL   = process.env.TEST_BASE_URL!;

// ── Bot player type ────────────────────────────────────────────
interface BotPlayer { userId: string; }

// ── Create a throwaway bot user + profile ─────────────────────
async function createBot(
  displayName: string,
  skill = "intermediate"
): Promise<BotPlayer> {
  const db = adminDb();
  const { data, error } = await db.auth.admin.createUser({
    email: `${displayName.toLowerCase().replace(/\s/g, "-")}@playwright.local`,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`[seed] createBot(${displayName}): ${error?.message}`);
  const userId = data.user.id;
  await db.from("profiles").upsert(
    { id: userId, display_name: displayName, skill_level: skill, pin: "1234" },
    { onConflict: "id" }
  );
  return { userId };
}

// ── Seed helpers ───────────────────────────────────────────────

/**
 * Seed a court + a 4-player match with the organizer as Team A player 1.
 * Returns the court ID and match ID.
 */
async function seedOrganizerInMatch(
  organizerUserId: string,
  opts: {
    status: "pending" | "in_progress";
    /** position among on-deck matches (1 = next). Only relevant for pending. */
    onDeckPosition?: number;
  }
) {
  const db = adminDb();

  // Create bots for the other three slots
  const [bob, cara, dan] = await Promise.all([
    createBot("E2E_Bob_E"),
    createBot("E2E_Cara_E"),
    createBot("E2E_Dan_E"),
  ]);

  // Create a court
  const courtStatus = opts.status === "in_progress" ? "in_use" : "available";
  const { data: courtData, error: courtErr } = await db
    .from("courts")
    .insert({ session_id: SESSION_ID, name: "Court 1", status: courtStatus })
    .select("id")
    .single();
  if (courtErr || !courtData) throw new Error(`[seed] court: ${courtErr?.message}`);
  const courtId = courtData.id;

  // Add all four players to the queue
  const queueStatus = opts.status === "pending" ? "on_deck" : "playing";
  await db.from("queue_entries").insert([
    { session_id: SESSION_ID, player_id: organizerUserId, status: queueStatus, games_played: 0, position: 1 },
    { session_id: SESSION_ID, player_id: bob.userId,       status: queueStatus, games_played: 0, position: 2 },
    { session_id: SESSION_ID, player_id: cara.userId,      status: queueStatus, games_played: 0, position: 3 },
    { session_id: SESSION_ID, player_id: dan.userId,       status: queueStatus, games_played: 0, position: 4 },
  ]);

  // Create the match
  const { data: matchData, error: matchErr } = await db
    .from("matches")
    .insert({
      session_id:     SESSION_ID,
      court_id:       opts.status === "in_progress" ? courtId : null,
      status:         opts.status,
      is_mixed_level: false,
      // Pending matches must be published so the UI renders them as "On Deck"
      // rather than "Draft" (is_published defaults to false since the
      // draft-mode migration 20260502100000_draft_mode_is_published.sql).
      ...(opts.status === "pending" && { is_published: true }),
      ...(opts.status === "in_progress" && { started_at: new Date().toISOString() }),
    })
    .select("id")
    .single();
  if (matchErr || !matchData) throw new Error(`[seed] match: ${matchErr?.message}`);
  const matchId = matchData.id;

  // Assign players: organizer + bob = Team A; cara + dan = Team B
  await db.from("match_players").insert([
    { match_id: matchId, player_id: organizerUserId, team: "a" },
    { match_id: matchId, player_id: bob.userId,       team: "a" },
    { match_id: matchId, player_id: cara.userId,      team: "b" },
    { match_id: matchId, player_id: dan.userId,       team: "b" },
  ]);

  return { courtId, matchId, bots: { bob, cara, dan } };
}

/**
 * Create a second pending match ahead of the organizer's match,
 * making the organizer's match position 2 on deck.
 */
async function seedLeadingMatch() {
  const db = adminDb();
  const [p1, p2, p3, p4] = await Promise.all([
    createBot("E2E_P1_E"),
    createBot("E2E_P2_E"),
    createBot("E2E_P3_E"),
    createBot("E2E_P4_E"),
  ]);
  await db.from("queue_entries").insert([
    { session_id: SESSION_ID, player_id: p1.userId, status: "on_deck", games_played: 0, position: 5 },
    { session_id: SESSION_ID, player_id: p2.userId, status: "on_deck", games_played: 0, position: 6 },
    { session_id: SESSION_ID, player_id: p3.userId, status: "on_deck", games_played: 0, position: 7 },
    { session_id: SESSION_ID, player_id: p4.userId, status: "on_deck", games_played: 0, position: 8 },
  ]);
  const { data: mData } = await db
    .from("matches")
    .insert({ session_id: SESSION_ID, status: "pending", is_mixed_level: false, is_published: true })
    .select("id")
    .single();
  if (!mData) throw new Error("[seed] leading match failed");
  await db.from("match_players").insert([
    { match_id: mData.id, player_id: p1.userId, team: "a" },
    { match_id: mData.id, player_id: p2.userId, team: "a" },
    { match_id: mData.id, player_id: p3.userId, team: "b" },
    { match_id: mData.id, player_id: p4.userId, team: "b" },
  ]);
}

// ── Set / clear VIP tag on organizer profile ──────────────────
async function setOrganizerVip(
  organizerUserId: string,
  tag: string | null,
  theme: string | null
) {
  await adminDb()
    .from("profiles")
    .update({ vip_tag: tag, vip_theme: theme })
    .eq("id", organizerUserId);
}

// ── Global setup ───────────────────────────────────────────────
let organizerUserId: string;

test.beforeAll(async ({ browser }) => {
  await ensureOrganizerAccount();
  organizerUserId = await getOrganizerUserId();

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await signInOrganizerBot(page, BASE_URL);
  } finally {
    await context.close();
  }
});

// Make every test start from a clean slate.  Without this, the first test
// in this file can collide with leftover state from a previous test run
// (e.g. scenario-i seeds 6 courts named Court 1-6 and the unique constraint
// `courts_session_id_name_key` then rejects this file's "Court 1" insert).
test.beforeEach(async () => {
  await resetSandboxSession();
});

test.afterEach(async () => {
  // Clear any VIP tag set during the test
  await setOrganizerVip(organizerUserId, null, null);
  await resetSandboxSession();
});

// ─────────────────────────────────────────────────────────────
// [A] On-deck card — base layout
// ─────────────────────────────────────────────────────────────
test.describe("MatchAlert — [A] On-deck base layout", () => {
  test("shows amber card with YOUR TEAM / OPPONENTS labels and YOU on organizer row", async ({
    browser,
  }) => {
    await seedOrganizerInMatch(organizerUserId, { status: "pending" });

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page    = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/play/${SESSION_ID}`, { waitUntil: "networkidle" });

      // Wait for the on-deck alert to appear (role=alert is added by our fix)
      const card = page.getByRole("alert").first();
      await expect(card).toBeVisible({ timeout: 12_000 });

      // Primary heading copy
      await expect(page.getByRole("heading", { name: /next available court/i })).toBeVisible({
        timeout: 8_000,
      });

      // Column labels (exact: true — avoids substring match on "Find your team…")
      await expect(page.getByText("Your Team", { exact: true })).toBeVisible();
      await expect(page.getByText("Opponents",  { exact: true })).toBeVisible();

      // YOU label must appear (one visible occurrence — the organizer's row)
      const youLabels = page.getByText("You", { exact: true });
      await expect(youLabels.first()).toBeVisible({ timeout: 5_000 });
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [B] On-deck card — position 2 copy
// ─────────────────────────────────────────────────────────────
test.describe("MatchAlert — [B] On-deck position 2 shows #2 copy", () => {
  test("eyebrow reads #2 On Deck and subline mentions 1 match ahead", async ({
    browser,
  }) => {
    // Seed a leading match FIRST so the organizer's match is position 2
    await seedLeadingMatch();
    await seedOrganizerInMatch(organizerUserId, { status: "pending", onDeckPosition: 2 });

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page    = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/play/${SESSION_ID}`, { waitUntil: "networkidle" });

      // Position-2 heading
      await expect(page.getByRole("heading", { name: /#2 on deck/i })).toBeVisible({
        timeout: 12_000,
      });

      // Sub-line mentions 1 match ahead
      await expect(page.getByText(/1 match ahead/i)).toBeVisible({ timeout: 8_000 });
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [C] In-progress card
// ─────────────────────────────────────────────────────────────
test.describe("MatchAlert — [C] In-progress card shows court name", () => {
  test("shows dark header with court name as large heading and It's your turn eyebrow", async ({
    browser,
  }) => {
    await seedOrganizerInMatch(organizerUserId, { status: "in_progress" });

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page    = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/play/${SESSION_ID}`, { waitUntil: "networkidle" });

      // role=alert is set on the in-progress card too
      const card = page.getByRole("alert").first();
      await expect(card).toBeVisible({ timeout: 12_000 });

      // Court name in heading
      await expect(page.getByRole("heading", { name: "Court 1" })).toBeVisible({
        timeout: 8_000,
      });

      // Eyebrow copy
      await expect(page.getByText(/it'?s your turn/i)).toBeVisible({ timeout: 5_000 });

      // Team labels still present — scoped to the alert card to avoid
      // other "Your Team" labels that may appear in sibling UI (e.g. ScoreInputCard)
      const inProgressCard = page.getByRole("alert").first();
      await expect(inProgressCard.getByText("Your Team", { exact: true })).toBeVisible();
      await expect(inProgressCard.getByText("Opponents",  { exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [D] VIP tag renders for organizer row
// ─────────────────────────────────────────────────────────────
test.describe("MatchAlert — [D] VIP tag visible on organizer row", () => {
  test("VIP tag text is visible when organizer has vip_tag + vip_theme set", async ({
    browser,
  }) => {
    // Give the organizer a VIP tag first
    await setOrganizerVip(organizerUserId, "MVP", "gold-prestige");
    await seedOrganizerInMatch(organizerUserId, { status: "pending" });

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page    = await context.newPage();

    try {
      await page.goto(`${BASE_URL}/play/${SESSION_ID}`, { waitUntil: "networkidle" });

      // Wait for the card to be visible
      await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 12_000 });

      // MVP tag should be in the DOM.
      // VipTag renders 2 spans per instance (dark/light mode), and the player
      // header also shows the tag — filter to the first visible occurrence
      // (the holo light-mode span, since Playwright runs Chromium in light mode).
      await expect(page.getByText("MVP").filter({ visible: true }).first()).toBeVisible({
        timeout: 8_000,
      });
    } finally {
      await context.close();
    }
  });
});
