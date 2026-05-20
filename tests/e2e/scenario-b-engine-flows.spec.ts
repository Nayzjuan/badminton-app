// ============================================================
// Scenario B — Engine Flow Tests
// ============================================================
// Tests the core matchmaking engine behaviours that cannot be
// covered by unit tests alone: they require real DB state,
// real server actions, and real Realtime propagation.
//
// ── Test 1: Auto ON triggers draft generation ────────────────
//   Seed: 5 players waiting, 2 courts, auto OFF (all_waiting).
//   Action: click Auto toggle → turns ON.
//   Assert: draft approval banner "N on-deck matches waiting for
//           approval" appears — engine creates drafts, not
//           published on-deck matches. Organizer must publish.
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
// ── Test 5: Soft gate releases when pool = 5 (> threshold) ───
//   Seed: soft_gate then add E2E_Ida as 5th waiting player.
//   Action: click Auto toggle → turns ON.
//   Engine condition: poolSize(5) > GATE_POOL_THRESHOLD(4)
//   → gate condition is false → engine fires → draft created.
//   Assert: "waiting for approval" draft banner appears.
//
// Timing safety:
//   Server action + Realtime roundtrip ≈ 1.5s under normal load.
//   All "match appears" waits use 10s timeout (test:e2e timeout=60s).
//   All "no match" checks use 4s grace period before asserting.
// ============================================================

import { test, expect } from "@playwright/test";
import { adminDb } from "../helpers/admin-db";
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
      await page.goto(`${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`);

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

      // Toggle should update to "Auto On" (OPTIMISTIC — see comment below)
      await expect(toggleBtn).toHaveText(/Auto On/i, { timeout: 8_000 });

      // The button text update is optimistic (handleToggleAuto sets state
      // before awaiting the server action).  Confirm the DB toggle truly
      // committed before polling for engine output, otherwise a flaky
      // server action can leave the optimistic UI green while the engine
      // never actually ran.
      const db = adminDb();
      await expect
        .poll(
          async () => {
            const { data } = await db
              .from("sessions")
              .select("is_auto_matchmaking_on")
              .eq("id", seeded.sessionId)
              .single();
            return data?.is_auto_matchmaking_on ?? false;
          },
          { timeout: 10_000 }
        )
        .toBe(true);

      // ── 3. Wait for the engine to generate an on-deck match ─
      // The engine runs synchronously inside toggleAutoMatchmaking but the
      // serverless cold start + read-replica lag can stretch the round trip
      // past the previous 10 s window.  20 s gives enough headroom.
      // Filter is_published=false: engine-generated matches are always drafts.
      await expect
        .poll(
          async () => {
            const { data } = await db
              .from("matches")
              .select("id")
              .eq("session_id", seeded.sessionId)
              .eq("status", "pending")
              .eq("is_published", false);
            return data?.length ?? 0;
          },
          { timeout: 20_000, intervals: [500, 1_000, 1_000, 2_000, 2_000] }
        )
        .toBeGreaterThan(0);

      // Give read replicas time to sync with the primary write.
      await page.waitForTimeout(2_000);

      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Engine-generated matches start as drafts (is_published=false).
      // The "Drafts — hidden from players" section appears and the approval
      // banner reads "N on-deck matches waiting for approval".
      await expect(page.getByText(/waiting for approval/)).toBeVisible({ timeout: 10_000 });

      // The "Drafts" section label must also be visible
      await expect(page.getByText("Drafts")).toBeVisible({ timeout: 3_000 });
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Test 2 — Auto OFF: engine stays silent
// ─────────────────────────────────────────────────────────────

test.describe("Engine Flow: Auto OFF", () => {
  test("with Auto OFF, players in queue never generate on-deck matches", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      await page.goto(`${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`);

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
      await page.goto(`${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`);

      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // ── Turn Auto ON ─────────────────────────────────────────
      const toggleBtn = page.getByTestId("toggle-auto-matchmaking");
      await toggleBtn.click();
      await expect(toggleBtn).toHaveText(/Auto On/i, { timeout: 8_000 });

      // The button text update is OPTIMISTIC.  Confirm the DB toggle
      // actually committed before polling for engine output, otherwise
      // a flaky server action (e.g. Vercel cold start mid-toggle) can
      // produce a state where the optimistic UI says ON but the engine
      // never ran — the test then times out checking for matches the
      // engine had no chance to create.
      await expect
        .poll(
          async () => {
            const { data } = await db
              .from("sessions")
              .select("is_auto_matchmaking_on")
              .eq("id", seeded.sessionId)
              .single();
            return data?.is_auto_matchmaking_on ?? false;
          },
          { timeout: 10_000 }
        )
        .toBe(true);

      // Wait for the engine to write a pending Mixed Level match.
      // The engine has to: read the queue + paused, score candidates,
      // detect Red Zone (Alice waited 26 min), trigger the time-based
      // fallback that builds the Mixed Level group, and INSERT via
      // create_match_with_players RPC.  On a cold-started Vercel
      // function this can take 8–12 s end-to-end.
      await expect
        .poll(
          async () => {
            const { data } = await db
              .from("matches")
              .select("id")
              .eq("session_id", seeded.sessionId)
              .eq("status", "pending");
            return data?.length ?? 0;
          },
          { timeout: 20_000, intervals: [500, 1_000, 1_000, 2_000, 2_000] }
        )
        .toBeGreaterThan(0);

      // ── Wait for the draft match to appear ───────────────────
      // Engine-generated matches start as drafts (is_published=false).
      // The draft approval banner and section label are the authoritative
      // UI indicators — reload to flush any Realtime lag.
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      await expect(page.getByText(/waiting for approval/)).toBeVisible({ timeout: 10_000 });

      // ── UI: "Mixed Level" badge should be visible on the draft card ─
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
      await page.goto(`${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`);

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

      // ── Assert: gate held — no match of any kind created ────────
      // Engine now creates drafts (is_published=false), so we check
      // for BOTH "On Deck #1" (published) and "Draft #1" (unpublished).
      // Neither should appear when the soft gate correctly deferred.
      await expect(page.getByText("No matches on deck")).toBeVisible({
        timeout: 3_000,
      });
      await expect(page.getByText("On Deck #1")).not.toBeVisible();
      await expect(page.getByText("Draft #1")).not.toBeVisible();
      await expect(page.getByText(/waiting for approval/)).not.toBeVisible();
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Test 5 — Soft gate RELEASED: pool=5 > threshold → draft created
// ─────────────────────────────────────────────────────────────

test.describe("Engine Flow: Soft Gate released at pool=5", () => {
  test("engine creates a draft when pool=5 exceeds GATE_POOL_THRESHOLD (boundary companion to Test 4)", async ({
    browser,
  }) => {
    // Re-seed with soft_gate preset (4 waiting + 1 active match),
    // then manually add a 5th waiting player "E2E_Ida".
    //   pool(5) > GATE_POOL_THRESHOLD(4) → gate condition is false
    //   → engine fires → draft match created.
    await resetSandboxSession();
    seeded = await seedSession("soft_gate");

    const db = adminDb();

    // ── Create E2E_Ida as the 5th waiting player ──────────────
    const { data: idaData, error: idaErr } = await db.auth.admin.createUser({
      email: "e2e_ida@playwright.local",
      email_confirm: true,
      user_metadata: { display_name: "E2E_Ida" },
    });

    if (idaErr || !idaData.user) {
      throw new Error(`[seed:B-2] Failed to create E2E_Ida: ${idaErr?.message}`);
    }

    const idaId = idaData.user.id;

    const { error: profileErr } = await db
      .from("profiles")
      .upsert(
        { id: idaId, display_name: "E2E_Ida", skill_level: "intermediate", pin: "1234" },
        { onConflict: "id" }
      );

    if (profileErr) {
      throw new Error(`[seed:B-2] Failed to upsert E2E_Ida profile: ${profileErr.message}`);
    }

    // Position 9: alice/bob/cara/dan (1-4, playing) + eve/frank/grace/henry (5-8, waiting)
    const { error: queueErr } = await db.from("queue_entries").insert({
      session_id: seeded.sessionId,
      player_id: idaId,
      status: "waiting",
      games_played: 0,
      position: 9,
    });

    if (queueErr) {
      throw new Error(`[seed:B-2] Failed to insert E2E_Ida queue entry: ${queueErr.message}`);
    }

    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      await page.goto(`${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`);

      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Confirm initial state: no on-deck, toggle off
      await expect(page.getByText("No matches on deck")).toBeVisible({ timeout: 5_000 });

      // ── Turn Auto ON ─────────────────────────────────────────
      const toggleBtn = page.getByTestId("toggle-auto-matchmaking");
      await toggleBtn.click();

      await expect(toggleBtn).toHaveText(/Auto On/i, { timeout: 8_000 });

      // Confirm the DB toggle committed before polling for engine output.
      await expect
        .poll(
          async () => {
            const { data } = await db
              .from("sessions")
              .select("is_auto_matchmaking_on")
              .eq("id", seeded.sessionId)
              .single();
            return data?.is_auto_matchmaking_on ?? false;
          },
          { timeout: 10_000 }
        )
        .toBe(true);

      // ── Wait for the engine to create a draft ────────────────
      // 5 waiting players > GATE_POOL_THRESHOLD(4) → gate opens.
      // Engine picks the best 4 from the waiting pool, creates a
      // pending draft (is_published=false). 1 player stays waiting.
      await expect
        .poll(
          async () => {
            const { data } = await db
              .from("matches")
              .select("id")
              .eq("session_id", seeded.sessionId)
              .eq("status", "pending")
              .eq("is_published", false);
            return data?.length ?? 0;
          },
          { timeout: 20_000, intervals: [500, 1_000, 1_000, 2_000, 2_000] }
        )
        .toBeGreaterThan(0);

      // Reload to flush Realtime lag; confirm the draft approval banner.
      await page.waitForTimeout(2_000);
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      await expect(page.getByText(/waiting for approval/)).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Drafts")).toBeVisible({ timeout: 3_000 });
    } finally {
      await context.close();
    }
  });
});
