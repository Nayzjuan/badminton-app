// ============================================================
// Scenario O — Player Score Input
// ============================================================
// Tests the score input UI that appears for a player whose match
// is currently "in_progress".
//
//   [O-1] Player sees score input when their match is in progress.
//         Setup (via adminDb):
//           - Create a court marked "in_use".
//           - Create an in_progress match assigned to that court.
//           - Add the organizer bot to Team A and a throwaway
//             bot to Team B.
//           - Add both players to queue_entries with status="playing".
//         Navigate to /play/[sessionId] as the organizer bot.
//         Assert the ScoreInputCard is visible (header reads
//         "Submit Final Score" and score input fields are present).
//
//   [O-2] Player can submit a score.
//         Same DB setup as [O-1].
//         Fill in team scores (21 and 15).
//         Click the submit button.
//         Assert success state: the "Score submitted!" confirmation
//         message is visible OR the score form disappears.
//
// Implementation notes:
//   - The bot opponent is a throwaway user created directly via
//     the admin auth API (same pattern as scenario-e).
//   - Both players need a queue_entries row with status="playing"
//     so the PlayerDashboard hook (useQueue) recognises them as
//     active participants.
//   - The ScoreInputCard is rendered by PlayerDashboard when
//     currentMatch.match.status === "in_progress".
// ============================================================

import { test, expect } from "@playwright/test";
import { adminDb } from "../helpers/admin-db";
import dotenv from "dotenv";
import path from "path";

import { resetSandboxSession, getSandboxClubSlug } from "../helpers/teardown";
import { clubPlay } from "../../src/lib/club-paths";
import {
  ensureOrganizerAccount,
  signInOrganizerBot,
  getOrganizerUserId,
  ORGANIZER_STORAGE_STATE,
  findOrCreateBotUser,
} from "../fixtures/auth";

dotenv.config({ path: path.resolve(__dirname, "../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), override: false });

const BASE_URL = process.env.TEST_BASE_URL!;
const SESSION_ID = process.env.TEST_SESSION_ID!;
let CLUB_SLUG: string;

let organizerUserId: string;

// ── One-time global setup ─────────────────────────────────────
test.beforeAll(async ({ browser }) => {
  await ensureOrganizerAccount();
  organizerUserId = await getOrganizerUserId();
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

// ── Helper: create a throwaway bot user + profile ─────────────
// Idempotent via findOrCreateBotUser — self-heals if a prior run's
// teardown left this deterministic email's bot account orphaned.
async function createBot(displayName: string): Promise<{ userId: string }> {
  const email = `${displayName.toLowerCase().replace(/\s/g, "-")}@playwright.local`;
  const userId = await findOrCreateBotUser(email, displayName);
  return { userId };
}

// ── Helper: seed an in_progress match with the organizer on Team A ─
async function seedOrganizerInProgressMatch(): Promise<{ matchId: string; courtId: string }> {
  const db = adminDb();

  // Create a throwaway bot for the other three slots.
  // We only need a 4-player match but keep it simple: organizer + 3 bots.
  const [bot2, bot3, bot4] = await Promise.all([
    createBot("E2E_Opp_O_2"),
    createBot("E2E_Opp_O_3"),
    createBot("E2E_Opp_O_4"),
  ]);

  // Create a court in "in_use" state.
  const { data: courtData, error: courtErr } = await db
    .from("courts")
    .insert({ session_id: SESSION_ID, name: "Court Scoring", status: "in_use" })
    .select("id")
    .single();
  if (courtErr || !courtData) throw new Error(`[seed] court: ${courtErr?.message}`);
  const courtId = courtData.id;

  // Create the in_progress match.
  const { data: matchData, error: matchErr } = await db
    .from("matches")
    .insert({
      session_id: SESSION_ID,
      court_id: courtId,
      status: "in_progress",
      is_mixed_level: false,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (matchErr || !matchData) throw new Error(`[seed] match: ${matchErr?.message}`);
  const matchId = matchData.id;

  // Assign players to teams: organizer + bot2 on Team A, bot3 + bot4 on Team B.
  await db.from("match_players").insert([
    { match_id: matchId, player_id: organizerUserId, team: "a" },
    { match_id: matchId, player_id: bot2.userId, team: "a" },
    { match_id: matchId, player_id: bot3.userId, team: "b" },
    { match_id: matchId, player_id: bot4.userId, team: "b" },
  ]);

  // Add all four players to queue_entries with status="playing" so the
  // player dashboard hooks recognise them as active participants.
  await db.from("queue_entries").insert([
    {
      session_id: SESSION_ID,
      player_id: organizerUserId,
      status: "playing",
      games_played: 0,
      position: 1,
    },
    {
      session_id: SESSION_ID,
      player_id: bot2.userId,
      status: "playing",
      games_played: 0,
      position: 2,
    },
    {
      session_id: SESSION_ID,
      player_id: bot3.userId,
      status: "playing",
      games_played: 0,
      position: 3,
    },
    {
      session_id: SESSION_ID,
      player_id: bot4.userId,
      status: "playing",
      games_played: 0,
      position: 4,
    },
  ]);

  return { matchId, courtId };
}

// ─────────────────────────────────────────────────────────────
// [O-1] Player sees score input when match is in_progress
// ─────────────────────────────────────────────────────────────
test.describe("Player Scoring — [O-1] Score input form is visible", () => {
  test("player sees score input when their match is in progress", async ({ browser }) => {
    await seedOrganizerInProgressMatch();

    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      await page.goto(`${BASE_URL}${clubPlay(CLUB_SLUG, SESSION_ID)}`, {
        waitUntil: "networkidle",
      });

      // The ScoreInputCard header reads "Submit Final Score".
      // Give the dashboard time to fetch the in_progress match via usePlayerMatch.
      // Use .first() because the text can match multiple elements in the DOM tree
      // (the <p> header text element and a parent container that includes it).
      await expect(page.getByText(/submit final score/i).first()).toBeVisible({ timeout: 15_000 });

      // The card contains two score input fields labelled "Your Team" and "Opponents".
      await expect(page.getByLabel(/your team score/i)).toBeVisible({ timeout: 8_000 });
      await expect(page.getByLabel(/opponents score/i)).toBeVisible({ timeout: 5_000 });
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// [O-2] Player can submit a score
// ─────────────────────────────────────────────────────────────
test.describe("Player Scoring — [O-2] Score submission", () => {
  test("player can submit a score", async ({ browser }) => {
    await seedOrganizerInProgressMatch();

    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      // Don't use waitUntil:"networkidle" — Supabase realtime connections keep
      // the network busy indefinitely and can cause the navigation to hang.
      await page.goto(`${BASE_URL}${clubPlay(CLUB_SLUG, SESSION_ID)}`);

      // Wait for the score input card to appear.
      await expect(page.getByText(/submit final score/i).first()).toBeVisible({ timeout: 20_000 });

      // Fill in team scores using the aria-labelled inputs.
      // The organizer is on Team A, so "Your Team" label maps to Team A score.
      const myScoreInput = page.getByLabel(/your team score/i);
      const theirScoreInput = page.getByLabel(/opponents score/i);

      await myScoreInput.fill("21");
      await theirScoreInput.fill("15");

      // Find and click the submit button.
      // The ScoreInputCard button text changes between "Submit Score" (idle)
      // and "Submitting…" (in-flight). We locate by the data-test-id pattern
      // or by looking for any button that is NOT disabled inside the score section.
      // Strategy: find the first enabled button in the score input section
      // (after both inputs are filled, the submit button becomes enabled).
      // We look inside the section that also contains "Submit Final Score".
      const _scoreSection = page
        .getByText(/submit final score/i)
        .first()
        .locator("..")
        .locator("..");
      // Fallback: directly click any enabled button near the score inputs.
      // The submit button sits at the bottom of a space-y-4 div. It's the only button
      // in the score card (the inputs use type="text"). Find it by type and near context.
      await expect(
        page
          .getByRole("button", { disabled: false })
          .filter({ hasText: /submit/i })
          .first()
      ).toBeVisible({ timeout: 8_000 });
      await page
        .getByRole("button", { disabled: false })
        .filter({ hasText: /submit/i })
        .first()
        .click();

      // Assert success — DB is the authoritative source.
      // submitMatchScore delegates to endMatchAction which must:
      //   1. Set match.status = 'completed'
      //   2. Write exact scores (team_a_score=21, team_b_score=15)
      //   3. Increment games_played for all 4 players
      const db = adminDb();

      // 1. Match must reach 'completed' with correct scores
      await expect
        .poll(
          async () => {
            const { data } = await db
              .from("matches")
              .select("status, team_a_score, team_b_score")
              .eq("session_id", SESSION_ID)
              .eq("status", "completed")
              .maybeSingle();
            return data ? `${data.status}|${data.team_a_score}|${data.team_b_score}` : "pending";
          },
          { timeout: 15_000, intervals: [500, 1_000, 2_000] }
        )
        .toBe("completed|21|15");

      // 2. The organizer bot's games_played must be incremented to 1.
      // Poll rather than single-read: the endMatch server action commits async
      // and the DB may not reflect the increment immediately after the UI update.
      await expect
        .poll(
          async () => {
            const { data } = await db
              .from("queue_entries")
              .select("games_played, status")
              .eq("session_id", SESSION_ID)
              .eq("player_id", organizerUserId)
              .single();
            return data;
          },
          { timeout: 8_000, intervals: [500, 1_000, 2_000] }
        )
        .toMatchObject({ games_played: 1, status: "waiting" });
    } finally {
      await context.close();
    }
  });
});
