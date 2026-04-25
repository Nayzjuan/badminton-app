// ============================================================
// Scenario B — Engine Flow Tests
// ============================================================
// Tests the core matchmaking engine behaviours that cannot be
// covered by unit tests alone: they require real DB state,
// real server actions, and real Realtime propagation.
//
// ── Test 1: Auto ON triggers on-deck generation ──────────────
//   Seed: 5 players waiting, 2 courts, auto OFF (all_waiting).
//   Action: click Auto toggle → turns ON.
//   Assert: at least one "On Deck #1" match appears within 10s.
//
// ── Test 2: Auto OFF keeps queue dormant ─────────────────────
//   Seed: 5 players waiting, 2 courts, auto OFF (all_waiting).
//   Action: none — leave auto OFF.
//   Assert: "No matches on deck" after 3s (engine never ran).
//
// ── Test 3: Red Zone player gets scheduled despite skill gap ──
//   Seed: all_waiting. Then DB-mutate:
//     alice → skill "advanced" (level_int=6) + joined_at 26 min ago
//     bob/cara/dan/eve → skill "intermediate" (level_int=3)
//   Gap |6-3|=3 > SKILL_VARIANCE_MAX(2) → normal matching fails.
//   alice.wait=26 > FALLBACK_WAIT_MINUTES(15) → fallback kicks in.
//   Assert: a match forms AND it has is_mixed_level=true in DB.
//
// ── Test 4: Soft gate defers when pool ≤ 4 with active court ──
//   Seed: soft_gate (alice/bob/cara/dan playing, eve/frank/grace/
//         henry waiting = 4 = GATE_POOL_THRESHOLD).
//   Action: click Auto toggle → turns ON.
//   Engine condition: poolSize(4) ≤ GATE_POOL_THRESHOLD(4)
//                     AND hasActiveMatches=true
//                     AND maxWait < GATE_HOLD_MINUTES(8)
//   → gate holds → no on-deck match.
//   Assert: "No matches on deck" is still visible after 4s.
//
// Timing safety:
//   Server action + Realtime roundtrip ≈ 1.5s under normal load.
//   All "match appears" waits use 10s timeout (test:e2e timeout=60s).
//   All "no match" checks use 4s grace period before asserting.
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
} from "../fixtures/auth";

// Load secrets from .env.test (Vercel URL, session ID, service key)
dotenv.config({ path: path.resolve(__dirname, "../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), override: false });

// ── Service-role DB client for mid-test mutations and assertions ──
function adminDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// ── One-time global setup ─────────────────────────────────────
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

// ── Per-test setup ────────────────────────────────────────────
// Reset + reseed before every test so each test starts clean.
let seeded: Awaited<ReturnType<typeof seedSession>>;

test.beforeEach(async () => {
  await resetSandboxSession();
  // Tests that need a custom preset override `seeded` inside the test body.
  // The default seed here is for the common "all_waiting" case.
  seeded = await seedSession("all_waiting");
});

// ─────────────────────────────────────────────────────────────
// Test 1 — Auto ON: queue fills → on-deck populates
// ─────────────────────────────────────────────────────────────

test.describe("Engine Flow: Auto ON", () => {
  test("turning Auto ON with ≥4 players waiting causes an on-deck match to appear", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`
      );

      // Wait for the courts tab panel to finish loading
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // ── 1. Verify initial state: no on-deck matches ─────────
      // Auto is OFF by default (resetSandboxSession sets is_auto_matchmaking_on=false)
      await expect(page.getByText("No matches on deck")).toBeVisible({ timeout: 5_000 });

      // Toggle button should show "Auto Off"
      const toggleBtn = page.getByTestId("toggle-auto-matchmaking");
      await expect(toggleBtn).toBeVisible({ timeout: 5_000 });
      await expect(toggleBtn).toHaveText(/Auto Off/i);

      // ── 2. Click the toggle to turn Auto ON ─────────────────
      await toggleBtn.click();

      // Toggle should update to "Auto On" (confirms action completed)
      await expect(toggleBtn).toHaveText(/Auto On/i, { timeout: 8_000 });

      // ── 3. Wait for the engine to generate an on-deck match ─
      // The engine runs synchronously inside toggleAutoMatchmaking,
      // then Realtime propagates the new match to the UI.
      await expect(page.getByText("On Deck #1")).toBeVisible({ timeout: 10_000 });

      // The "matches ready" badge count should be at least 1
      await expect(
        page.getByText(/\d+ match(es)? ready/)
      ).toBeVisible({ timeout: 3_000 });
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Test 2 — Auto OFF: engine stays silent
// ─────────────────────────────────────────────────────────────

test.describe("Engine Flow: Auto OFF", () => {
  test("with Auto OFF, players in queue never generate on-deck matches", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`
      );

      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Verify toggle is OFF
      const toggleBtn = page.getByTestId("toggle-auto-matchmaking");
      await expect(toggleBtn).toHaveText(/Auto Off/i, { timeout: 5_000 });

      // Wait long enough that the engine would have run if auto were ON (~3s)
      await page.waitForTimeout(3_000);

      // On-deck panel should still show the empty state
      await expect(page.getByText("No matches on deck")).toBeVisible({ timeout: 3_000 });

      // Toggle must still read "Auto Off" — we never clicked it
      await expect(toggleBtn).toHaveText(/Auto Off/i);
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Test 3 — Red Zone: player waits ≥25 min → scheduled despite
//           skill gap; match flagged is_mixed_level=true
// ─────────────────────────────────────────────────────────────

test.describe("Engine Flow: Red Zone escalation", () => {
  test("Red Zone anchor (26-min wait, advanced) gets scheduled with intermediates → is_mixed_level=true", async ({
    browser,
  }) => {
    const db = adminDb();

    // ── Mutate alice: advanced skill + joined 26 min ago ───────
    // Skill mapping: advanced=6, intermediate=3.
    // Gap |6-3|=3 > SKILL_VARIANCE_MAX(2) → normal windows fail.
    // alice.wait=26 > CRITICAL_WAIT_MINUTES(25) → Red Zone (score 1026).
    // alice.wait=26 > FALLBACK_WAIT_MINUTES(15) → fallback fires → any 3 players → isMixed.
    await db
      .from("profiles")
      .update({ skill_level: "advanced" })
      .eq("id", seeded.players.alice.userId);

    await db
      .from("queue_entries")
      .update({ joined_at: new Date(Date.now() - 26 * 60_000).toISOString() })
      .eq("session_id", seeded.sessionId)
      .eq("player_id", seeded.players.alice.userId);

    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`
      );

      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // ── Turn Auto ON ─────────────────────────────────────────
      const toggleBtn = page.getByTestId("toggle-auto-matchmaking");
      await toggleBtn.click();
      await expect(toggleBtn).toHaveText(/Auto On/i, { timeout: 8_000 });

      // ── Wait for an on-deck match to appear ──────────────────
      await expect(page.getByText("On Deck #1")).toBeVisible({ timeout: 10_000 });

      // ── UI: "Mixed Level" badge should be visible on the card ─
      // The on-deck card renders a "Mixed Level" badge when is_mixed_level=true.
      await expect(page.getByText("Mixed Level")).toBeVisible({ timeout: 5_000 });

      // ── DB: verify is_mixed_level=true on the created match ──
      const { data: pendingMatches } = await db
        .from("matches")
        .select("id, is_mixed_level")
        .eq("session_id", seeded.sessionId)
        .eq("status", "pending");

      expect(pendingMatches).not.toBeNull();
      expect(pendingMatches!.length).toBeGreaterThan(0);
      // Every match that formed in this Red Zone session must be mixed level
      // (the fallback path always sets is_mixed_level=true)
      expect(pendingMatches!.every((m) => m.is_mixed_level)).toBe(true);

      // ── DB: alice must be in the match (she's the anchor) ────
      const matchId = pendingMatches![0].id;
      const { data: matchPlayers } = await db
        .from("match_players")
        .select("player_id")
        .eq("match_id", matchId);

      const playerIds = (matchPlayers ?? []).map((p) => p.player_id);
      expect(playerIds).toContain(seeded.players.alice.userId);
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Test 4 — Soft gate: pool ≤ GATE_POOL_THRESHOLD with active
//           court → engine defers scheduling
// ─────────────────────────────────────────────────────────────

test.describe("Engine Flow: Soft Gate", () => {
  test("engine defers on-deck generation when pool=4 (≤GATE_POOL_THRESHOLD) and active match exists", async ({
    browser,
  }) => {
    // Re-seed with the soft_gate preset:
    //   court 1 in_use (alice/bob/cara/dan playing)
    //   court 2 available
    //   waiting: eve/frank/grace/henry (4 = GATE_POOL_THRESHOLD)
    //   auto OFF, all players joined_at ≈ now (wait < GATE_HOLD_MINUTES=8)
    await resetSandboxSession();
    seeded = await seedSession("soft_gate");

    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`
      );

      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Confirm initial state: no on-deck, toggle off
      await expect(page.getByText("No matches on deck")).toBeVisible({ timeout: 5_000 });

      // ── Turn Auto ON ─────────────────────────────────────────
      const toggleBtn = page.getByTestId("toggle-auto-matchmaking");
      await toggleBtn.click();

      // Wait for the toggle action to complete (button text changes)
      await expect(toggleBtn).toHaveText(/Auto On/i, { timeout: 8_000 });

      // ── Give the engine enough time to run and for Realtime ──
      // to propagate any change. If the gate weren't working, an
      // on-deck match would appear here within ~1.5s.
      await page.waitForTimeout(4_000);

      // ── Assert: gate held — still no on-deck match ───────────
      await expect(page.getByText("No matches on deck")).toBeVisible({
        timeout: 3_000,
      });

      // The "matches ready" badge must show 0 (or be absent entirely)
      await expect(page.getByText("On Deck #1")).not.toBeVisible();
    } finally {
      await context.close();
    }
  });
});
