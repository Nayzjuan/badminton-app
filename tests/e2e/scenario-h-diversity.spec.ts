// ============================================================
// Scenario H — Engine Diversity Tests
// ============================================================
// Verifies the matchmaking engine's anti-repeat / partner
// rotation behaviour end-to-end against the live DB.
//
// Diversity is implemented by three cooperating helpers in
// matchmaking-core (all unit-tested separately):
//   - isDiversityViolation:   blocks a proposed group if it
//                             shares 3+ players with any
//                             roster from the recent window
//   - getEffectiveLookback:   scales the recent-roster window
//                             to the eligible pool size
//   - rotatedDraft:           cycles through 3 team splits when
//                             the same 4 players must replay
//
// These tests pin the wiring: that the action layer correctly
// fetches recent rosters from the DB, threads them into the
// algorithm, and produces a diverse match (or rotates teams)
// when forced repeats are unavoidable.
//
// ── Test [H-1]: Anti-repeat with abundant pool ───────────────
//   Seed: diversity_pool_8 — 8 intermediate players waiting,
//         1 completed match (alice/bob vs cara/dan, just ended)
//   Action: turn Auto ON.
//   Engine: anchor + 3 lowest-overlap companions → fresh players
//           win the score race because the completed roster has
//           overlap=1 vs fresh=0 (penalty 10_000× per overlap).
//   Assert: the FIRST pending match has ≤ 2 players from the
//           completed roster {alice, bob, cara, dan} — proves
//           the anti-repeat path actively suppresses the recent
//           4 in favour of fresh alternatives.
//
// ── Test [H-2]: Forced repeat → rotated team split ───────────
//   Seed: diversity_pool_4 — only alice/bob/cara/dan waiting
//         (skills lower-int / int / int / upper-int, variance=2),
//         1 completed match with split {alice+dan vs bob+cara}.
//   Action: turn Auto ON.
//   Engine: anchor + 3 (only choice) → diversity violation →
//           Tier-1 swap fails (no other players) → Tier-2 expand
//           fails (no fresh candidates) → Tier-3 rotatedDraft
//           fires with repeatCount=1 (splitIndex=1: top pair
//           vs bottom pair).
//   Assert: the new pending match contains exactly the same 4
//           players AND the partnership pair {teamA_set, teamB_set}
//           differs from the completed match's partnership pair —
//           proves rotatedDraft produced a different team split.
//
// Timing safety:
//   Same shape as scenario-b's "Auto ON" test: poll the primary DB
//   directly after the toggle click. Both H-1 and H-2 assert against
//   adminDb() only — no UI assertions — so the read-replica reload
//   pattern from scenario-b's Test 3 is unnecessary here.
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

// ── Service-role DB client for assertions ─────────────────────
function adminDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// ── Helper: normalize a team's player_ids to a sorted joined string ──
// Used to compare partnership pairs as unordered sets so that "team A
// = [alice, dan]" and "team A = [dan, alice]" compare equal, and
// flipping team A↔B in the new match doesn't produce a false positive.
function partnershipPair(
  teamA: string[],
  teamB: string[]
): { sets: Set<string>; description: string } {
  const a = [...teamA].sort().join(",");
  const b = [...teamB].sort().join(",");
  return {
    sets: new Set([a, b]),
    description: `{${a}} vs {${b}}`,
  };
}

function partnershipsEqual(p1: Set<string>, p2: Set<string>): boolean {
  if (p1.size !== p2.size) return false;
  for (const s of p1) if (!p2.has(s)) return false;
  return true;
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
let seeded: Awaited<ReturnType<typeof seedSession>>;

test.beforeEach(async () => {
  await resetSandboxSession();
});

// ─────────────────────────────────────────────────────────────
// Test [H-1] — Anti-repeat with abundant pool
// ─────────────────────────────────────────────────────────────

test.describe("Engine Diversity — [H-1] Anti-repeat with abundant pool", () => {
  test("with 8 fresh alternatives, the next match avoids 3+ players from the most recent completed roster", async ({
    browser,
  }) => {
    seeded = await seedSession("diversity_pool_8");

    const completedRosterIds = new Set([
      seeded.players.alice.userId,
      seeded.players.bob.userId,
      seeded.players.cara.userId,
      seeded.players.dan.userId,
    ]);

    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`
      );
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      // Auto starts OFF (resetSandboxSession sets is_auto_matchmaking_on=false).
      const toggleBtn = page.getByTestId("toggle-auto-matchmaking");
      await expect(toggleBtn).toHaveText(/Auto Off/i, { timeout: 5_000 });

      // Click toggle to fire the engine.
      await toggleBtn.click();
      await expect(toggleBtn).toHaveText(/Auto On/i, { timeout: 8_000 });

      // ── Wait for the engine to populate at least one pending match ──
      const db = adminDb();
      await expect.poll(
        async () => {
          const { data } = await db
            .from("matches")
            .select("id")
            .eq("session_id", seeded.sessionId)
            .eq("status", "pending");
          return data?.length ?? 0;
        },
        { timeout: 10_000, intervals: [500, 500, 500, 1_000, 1_000] }
      ).toBeGreaterThan(0);

      // ── Fetch the FIRST on-deck match (oldest by created_at) ──
      // Note: engine-created matches leave `sort_order` NULL (only the
      // organizer's drag-and-drop sets it). Among 2+ NULL-sort_order rows,
      // ordering by created_at ASC deterministically picks the FIRST match
      // the engine emitted — which is the one with the freshest companion
      // pool and therefore the diversity-respecting one. The second match
      // (Tier-3 rotated repeat using the leftovers) is expected to overlap
      // heavily with the completed roster — that's not what this test
      // asserts; H-2 covers the rotation case directly.
      const { data: pending, error: pendingErr } = await db
        .from("matches")
        .select("id, created_at")
        .eq("session_id", seeded.sessionId)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(1);

      expect(pendingErr).toBeNull();
      expect(pending).not.toBeNull();
      expect(pending!.length).toBe(1);
      const firstMatchId = pending![0].id;

      const { data: matchPlayers } = await db
        .from("match_players")
        .select("player_id, team")
        .eq("match_id", firstMatchId);

      const playerIds = (matchPlayers ?? []).map((p) => p.player_id);
      expect(playerIds.length).toBe(4);

      // ── Diversity assertion ─────────────────────────────────
      // The completed roster was {alice, bob, cara, dan}. The
      // engine should NOT propose a 4-player group with 3 or
      // more of those players (that's the diversity threshold).
      // Tier-1 swap or fresh-anchor selection should keep the
      // overlap to ≤ 2.
      const overlapCount = playerIds.filter((id) =>
        completedRosterIds.has(id)
      ).length;

      expect(
        overlapCount,
        `expected ≤ 2 overlap with completed roster {alice,bob,cara,dan}, ` +
          `got ${overlapCount}. Match player_ids=${JSON.stringify(playerIds)}`
      ).toBeLessThanOrEqual(2);
    } finally {
      await context.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Test [H-2] — Forced repeat → rotated team split
// ─────────────────────────────────────────────────────────────

test.describe("Engine Diversity — [H-2] Forced repeat triggers rotatedDraft", () => {
  test("when only the 4 recently played players are available, the new match has the same roster but a rotated team split", async ({
    browser,
  }) => {
    seeded = await seedSession("diversity_pool_4");

    const expectedRosterIds = new Set([
      seeded.players.alice.userId,
      seeded.players.bob.userId,
      seeded.players.cara.userId,
      seeded.players.dan.userId,
    ]);

    // Capture the COMPLETED match's partnership pair for comparison.
    const db = adminDb();
    const { data: completedRows } = await db
      .from("matches")
      .select("id")
      .eq("session_id", seeded.sessionId)
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(1);

    expect(completedRows).not.toBeNull();
    expect(completedRows!.length).toBe(1);
    const completedMatchId = completedRows![0].id;

    const { data: completedMps } = await db
      .from("match_players")
      .select("player_id, team")
      .eq("match_id", completedMatchId);

    const completedTeamA = (completedMps ?? [])
      .filter((p) => p.team === "a")
      .map((p) => p.player_id);
    const completedTeamB = (completedMps ?? [])
      .filter((p) => p.team === "b")
      .map((p) => p.player_id);
    const completedPartnership = partnershipPair(
      completedTeamA,
      completedTeamB
    );

    const context = await browser.newContext({
      storageState: ORGANIZER_STORAGE_STATE,
    });
    const page = await context.newPage();

    try {
      await page.goto(
        `${process.env.TEST_BASE_URL}/organizer/${seeded.sessionId}`
      );
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 15_000 });

      const toggleBtn = page.getByTestId("toggle-auto-matchmaking");
      await expect(toggleBtn).toHaveText(/Auto Off/i, { timeout: 5_000 });
      await toggleBtn.click();
      await expect(toggleBtn).toHaveText(/Auto On/i, { timeout: 8_000 });

      // ── Wait for the rotated repeat match to materialise ────
      await expect.poll(
        async () => {
          const { data } = await db
            .from("matches")
            .select("id")
            .eq("session_id", seeded.sessionId)
            .eq("status", "pending");
          return data?.length ?? 0;
        },
        { timeout: 10_000, intervals: [500, 500, 500, 1_000, 1_000] }
      ).toBeGreaterThan(0);

      // ── Fetch the new pending match ─────────────────────────
      // Pool of 4 → engine fills exactly 1 slot before exhausting the
      // queue, so there's only one pending match here. Order by
      // created_at for consistency with H-1 (sort_order is NULL).
      const { data: pending } = await db
        .from("matches")
        .select("id")
        .eq("session_id", seeded.sessionId)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(1);

      expect(pending).not.toBeNull();
      expect(pending!.length).toBe(1);
      const pendingMatchId = pending![0].id;

      const { data: pendingMps } = await db
        .from("match_players")
        .select("player_id, team")
        .eq("match_id", pendingMatchId);

      const pendingTeamA = (pendingMps ?? [])
        .filter((p) => p.team === "a")
        .map((p) => p.player_id);
      const pendingTeamB = (pendingMps ?? [])
        .filter((p) => p.team === "b")
        .map((p) => p.player_id);

      // ── Roster identity: same 4 players ─────────────────────
      // With only 4 eligible players, the pool is exhausted —
      // rotatedDraft cannot pick a different roster.
      const allPendingIds = [...pendingTeamA, ...pendingTeamB];
      expect(allPendingIds.length).toBe(4);
      for (const id of allPendingIds) {
        expect(expectedRosterIds.has(id)).toBe(true);
      }

      // ── Team split: must differ from the completed match ────
      // partnershipPair normalizes order so that flipping A↔B
      // does NOT register as a different split. A genuine
      // rotation (A=[alice,bob],B=[cara,dan] vs A=[alice,cara],
      // B=[bob,dan]) WILL register because the partnerships
      // form a different unordered set.
      const newPartnership = partnershipPair(pendingTeamA, pendingTeamB);

      expect(
        partnershipsEqual(newPartnership.sets, completedPartnership.sets),
        `rotatedDraft did not change the partnership: ` +
          `completed=${completedPartnership.description}, ` +
          `new=${newPartnership.description}`
      ).toBe(false);
    } finally {
      await context.close();
    }
  });
});
