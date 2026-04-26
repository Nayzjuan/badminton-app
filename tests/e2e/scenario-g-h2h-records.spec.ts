// ============================================================
// Scenario G — H2H Records
// ============================================================
// Tests the H2HStrip component that appears on on-deck match cards,
// showing historical win/loss counts for the exact 2v2 pairing.
//
// Feature behaviour:
//   • Strip shown ONLY when the pairing has prior history (totalAllTime > 0)
//   • First-meeting pairs → no strip rendered at all (null return)
//   • All-time history exists but no session history → "first time tonight"
//   • Both all-time + session history → numeric A/B counts shown
//   • Error from RPC → strip silently absent (null return)
//
// Initial state (seeded fresh before each test):
//   - "first_match_on_deck" preset:
//       Match: alice/bob (Team A) vs cara/dan (Team B), status=pending
//       Eve: waiting
//   - 2 courts available
//
// Completed-match history (H2H data) is seeded inline per test via
// the admin DB client — inserted AFTER the main seed so the
// teardown's DELETE catches them on the next beforeEach.
//
// For "first time tonight", we need all-time history from a
// DIFFERENT session. A temporary session row is created in-test
// and cleaned up in a finally block.
// ============================================================

import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";

import { resetSandboxSession, seedSession } from "../helpers/teardown";
import {
  ensureOrganizerAccount,
  signInOrganizerBot,
  ORGANIZER_STORAGE_STATE,
  getOrganizerUserId,
} from "../fixtures/auth";

dotenv.config({ path: path.resolve(__dirname, "../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), override: false });

// ── DB helper ─────────────────────────────────────────────────
function adminDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
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
let seeded: Awaited<ReturnType<typeof seedSession>>;

test.beforeEach(async () => {
  await resetSandboxSession();
  // first_match_on_deck: alice/bob vs cara/dan on deck, eve waiting
  seeded = await seedSession("first_match_on_deck");
});

// ── Helper: seed completed matches in a given session ──────────
// Creates N completed matches for the alice/bob vs cara/dan pairing.
// teamAWins: how many times alice+bob (Team A) won.
// teamBWins: how many times cara+dan (Team B) won.
// Remaining matches (up to total) don't count since we only track W/L.
async function seedCompletedMatches(
  sessionId: string,
  teamAWins: number,
  teamBWins: number
) {
  const db = adminDb();

  type MatchRow = {
    session_id: string;
    status: "completed";
    team_a_score: number;
    team_b_score: number;
    is_mixed_level: boolean;
    sort_order: number;
  };

  const matchInserts: MatchRow[] = [];
  for (let i = 0; i < teamAWins; i++) {
    matchInserts.push({
      session_id: sessionId,
      status: "completed",
      team_a_score: 21,
      team_b_score: 15,
      is_mixed_level: false,
      sort_order: 100 + i,
    });
  }
  for (let i = 0; i < teamBWins; i++) {
    matchInserts.push({
      session_id: sessionId,
      status: "completed",
      team_a_score: 15,
      team_b_score: 21,
      is_mixed_level: false,
      sort_order: 200 + i,
    });
  }

  if (matchInserts.length === 0) return;

  const { data: matches, error } = await db
    .from("matches")
    .insert(matchInserts)
    .select("id");

  if (error || !matches) {
    throw new Error(`[G:seed] Failed to insert completed matches: ${error?.message}`);
  }

  // Insert match_players for each completed match
  const playerInserts: Array<{
    match_id: string;
    player_id: string;
    team: "a" | "b";
  }> = [];

  for (const m of matches) {
    playerInserts.push(
      { match_id: m.id, player_id: seeded.players.alice.userId, team: "a" },
      { match_id: m.id, player_id: seeded.players.bob.userId,   team: "a" },
      { match_id: m.id, player_id: seeded.players.cara.userId,  team: "b" },
      { match_id: m.id, player_id: seeded.players.dan.userId,   team: "b" }
    );
  }

  const { error: mpErr } = await db.from("match_players").insert(playerInserts);
  if (mpErr) {
    throw new Error(`[G:seed] Failed to insert match_players: ${mpErr.message}`);
  }
}

// ── G-1: History exists ────────────────────────────────────────

test.describe("H2H Strip — history exists", () => {
  test("G-1: shows correct A/B win counts when pairing has history", async ({ browser }) => {
    // 2 A wins + 1 B win in the same session → alltime A=2, B=1; tonight A=2, B=1
    await seedCompletedMatches(seeded.sessionId, 2, 1);

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(`${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`);
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // On-deck card must be visible first
      await expect(page.getByText("On Deck #1")).toBeVisible({ timeout: 10_000 });

      // H2HStrip should appear (async, give it time to fetch)
      await expect(page.getByTestId("h2h-strip")).toBeVisible({ timeout: 8_000 });

      // All-time counts: A=2, B=1
      await expect(page.getByTestId("h2h-alltime-a")).toHaveText("2");
      await expect(page.getByTestId("h2h-alltime-b")).toHaveText("1");

      // Tonight counts: A=2, B=1 (same session)
      await expect(page.getByTestId("h2h-tonight-a")).toHaveText("2");
      await expect(page.getByTestId("h2h-tonight-b")).toHaveText("1");

      // "first time tonight" label should NOT appear
      await expect(page.getByTestId("h2h-first-tonight")).not.toBeAttached();
    } finally {
      await context.close();
    }
  });

  test("G-1b: symmetric — B-dominated record shows correct counts", async ({ browser }) => {
    // 1 A win + 3 B wins → alltime A=1, B=3
    await seedCompletedMatches(seeded.sessionId, 1, 3);

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(`${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`);
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });
      await expect(page.getByText("On Deck #1")).toBeVisible({ timeout: 10_000 });

      await expect(page.getByTestId("h2h-strip")).toBeVisible({ timeout: 8_000 });
      await expect(page.getByTestId("h2h-alltime-a")).toHaveText("1");
      await expect(page.getByTestId("h2h-alltime-b")).toHaveText("3");
    } finally {
      await context.close();
    }
  });
});

// ── G-2: First time tonight ────────────────────────────────────

test.describe("H2H Strip — first time tonight", () => {
  test("G-2: shows 'first time tonight' when all-time history exists but no session history", async ({
    browser,
  }) => {
    const db = adminDb();

    // Create a temporary "historical" session so we can record all-time
    // history without polluting the sandbox session (which would make
    // session counts non-zero and break the "first time tonight" assertion).
    const organizerUserId = await getOrganizerUserId();
    const { data: tempSession, error: tempErr } = await db
      .from("sessions")
      .insert({
        name: "E2E Temp Historical Session",
        created_by: organizerUserId,
        scoring: "single" as const,
        organizer_passcode: "TMPH01",
      })
      .select("id")
      .single();

    if (tempErr || !tempSession) {
      throw new Error(`[G-2] Failed to create temp session: ${tempErr?.message}`);
    }

    try {
      // 1 completed match between alice/bob and cara/dan in the HISTORICAL session
      const { data: histMatch, error: histMatchErr } = await db
        .from("matches")
        .insert({
          session_id: tempSession.id,
          status: "completed",
          team_a_score: 21,
          team_b_score: 15,
          is_mixed_level: false,
          sort_order: 1,
        })
        .select("id")
        .single();

      if (histMatchErr || !histMatch) {
        throw new Error(`[G-2] Failed to create historical match: ${histMatchErr?.message}`);
      }

      await db.from("match_players").insert([
        { match_id: histMatch.id, player_id: seeded.players.alice.userId, team: "a" as const },
        { match_id: histMatch.id, player_id: seeded.players.bob.userId,   team: "a" as const },
        { match_id: histMatch.id, player_id: seeded.players.cara.userId,  team: "b" as const },
        { match_id: histMatch.id, player_id: seeded.players.dan.userId,   team: "b" as const },
      ]);

      // alltime: A=1, B=0 (from historical session)
      // session (sandbox): A=0, B=0 (no completed matches this session)
      // → H2HStrip should show "first time tonight"

      const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
      const page = await context.newPage();

      try {
        await page.goto(`${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`);
        await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });
        await expect(page.getByText("On Deck #1")).toBeVisible({ timeout: 10_000 });

        // H2HStrip renders (all-time history > 0)
        await expect(page.getByTestId("h2h-strip")).toBeVisible({ timeout: 8_000 });

        // All-time counts
        await expect(page.getByTestId("h2h-alltime-a")).toHaveText("1");
        await expect(page.getByTestId("h2h-alltime-b")).toHaveText("0");

        // Session section shows "first time tonight" instead of numeric counts
        await expect(page.getByTestId("h2h-first-tonight")).toBeVisible();
        await expect(page.getByTestId("h2h-tonight-a")).not.toBeAttached();
        await expect(page.getByTestId("h2h-tonight-b")).not.toBeAttached();
      } finally {
        await context.close();
      }
    } finally {
      // Cleanup: remove historical match_players, matches, and temp session
      const { data: histMatches } = await db
        .from("matches")
        .select("id")
        .eq("session_id", tempSession.id);

      const histMatchIds = (histMatches ?? []).map((m) => m.id);
      if (histMatchIds.length > 0) {
        await db.from("match_players").delete().in("match_id", histMatchIds);
        await db.from("matches").delete().in("id", histMatchIds);
      }
      await db.from("sessions").delete().eq("id", tempSession.id);
    }
  });
});

// ── G-3: First meeting (no history at all) ─────────────────────

test.describe("H2H Strip — first meeting (no history)", () => {
  test("G-3: strip is absent when pairing has no prior history at all", async ({ browser }) => {
    // No completed matches seeded — total all-time = 0
    // The H2HStrip component returns null for first-meeting pairs

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(`${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`);
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Wait for the on-deck card to appear AND for the async H2H fetch to settle.
      // The fetch is fast (< 1s), so waiting for network idle is sufficient.
      await expect(page.getByText("On Deck #1")).toBeVisible({ timeout: 10_000 });
      await page.waitForLoadState("networkidle");

      // Strip must not be in the DOM at all
      await expect(page.getByTestId("h2h-strip")).not.toBeAttached({ timeout: 3_000 });
    } finally {
      await context.close();
    }
  });
});

// ── G-4: Strip only shows data for the exact pairing ──────────

test.describe("H2H Strip — pairing specificity", () => {
  test("G-4: strip absent when history exists for different pairings but not this one", async ({
    browser,
  }) => {
    const db = adminDb();

    // Seed completed matches for alice+cara vs bob+dan
    // (different pairing from the on-deck alice+bob vs cara+dan)
    const { data: otherMatch } = await db
      .from("matches")
      .insert({
        session_id: seeded.sessionId,
        status: "completed",
        team_a_score: 21,
        team_b_score: 10,
        is_mixed_level: false,
        sort_order: 99,
      })
      .select("id")
      .single();

    if (otherMatch) {
      // alice + cara (Team A) vs bob + dan (Team B) — different pairing
      await db.from("match_players").insert([
        { match_id: otherMatch.id, player_id: seeded.players.alice.userId, team: "a" as const },
        { match_id: otherMatch.id, player_id: seeded.players.cara.userId,  team: "a" as const },
        { match_id: otherMatch.id, player_id: seeded.players.bob.userId,   team: "b" as const },
        { match_id: otherMatch.id, player_id: seeded.players.dan.userId,   team: "b" as const },
      ]);
    }

    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await page.goto(`${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`);
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });
      await expect(page.getByText("On Deck #1")).toBeVisible({ timeout: 10_000 });
      await page.waitForLoadState("networkidle");

      // The on-deck match is alice+bob vs cara+dan.
      // The only completed match is alice+cara vs bob+dan → different pairing.
      // → Strip should NOT appear.
      await expect(page.getByTestId("h2h-strip")).not.toBeAttached({ timeout: 3_000 });
    } finally {
      await context.close();
    }
  });
});

// ── Regression: on-deck card layout not broken ─────────────────

test.describe("Regression — on-deck card renders cleanly", () => {
  test("on-deck card loads without JS errors after H2HStrip integration", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    try {
      await page.goto(`${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`);
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // On-deck card present and functional
      await expect(page.getByText("On Deck #1")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Tap any player to start a swap")).toBeVisible();

      // No JS errors on the courts tab
      expect(errors).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
