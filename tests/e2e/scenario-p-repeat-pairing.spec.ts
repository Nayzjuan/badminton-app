// ============================================================
// Scenario P — Repeat-Pairing Warning (manual match builder)
// ============================================================
// Live end-to-end cover for the advisory repeat-pairing warning on the
// organizer Queue tab. The unit suite pins the logic; what can only be
// proven against a real deployment is here:
//
//   [P-1] The warning fires from REAL partnership counts computed by
//         fetchPartnershipCounts against the real DB — not a mocked map.
//   [P-2] The sticky bar offsets by the REAL dashboard header. The header
//         is `sticky top-0 z-20` and its height is published by a
//         ResizeObserver as --cc-header-h; every local check used a
//         synthetic 56px header, so this is the first proof that the
//         observer measures the real thing (~178px on a phone).
//   [P-3] The warning NEVER blocks creation — the CTA still produces a
//         real match row with the exact teams the preview showed.
//   [P-4] The disclosure lists the actual prior matches behind the count,
//         and the count and the list agree (status parity).
//
// Seed: diversity_pool_8 (8 intermediates waiting + 1 completed match,
// alice/bob vs cara/dan) plus a CLONE of that completed match, which puts
// alice&bob at exactly MAX_PARTNERSHIP_REPEATS (2) — the point at which
// the engine itself refuses the pairing. The 4 extra fresh intermediates
// are what keeps the avoidability gate open.
//
// All writes land in the "🤖 E2E SANDBOX" session and are removed by
// resetSandboxSession() in afterAll.
// ============================================================

import { test, expect, type Page } from "@playwright/test";
import dotenv from "dotenv";
import path from "path";

import { adminDb } from "../helpers/admin-db";
import { resetSandboxSession, seedSession } from "../helpers/teardown";
import { clubOrganizer } from "../../src/lib/club-paths";
import {
  ensureOrganizerAccount,
  signInOrganizerBot,
  ORGANIZER_STORAGE_STATE,
} from "../fixtures/auth";

dotenv.config({ path: path.resolve(__dirname, "../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), override: false });

/**
 * Clone the seeded completed match so its partnership pairs are counted
 * TWICE. Cloning rather than hand-inserting means we never have to guess
 * the matches schema — whatever the seeder produced is what we duplicate.
 */
async function cloneCompletedMatch(sessionId: string): Promise<string> {
  const db = adminDb();

  const { data: src, error: srcErr } = await db
    .from("matches")
    .select("*")
    .eq("session_id", sessionId)
    .eq("status", "completed")
    .limit(1)
    .single();
  if (srcErr || !src) throw new Error(`[P] no completed match to clone: ${srcErr?.message}`);

  const { data: roster, error: rosterErr } = await db
    .from("match_players")
    .select("player_id, team")
    .eq("match_id", src.id);
  if (rosterErr || !roster?.length) throw new Error(`[P] no roster: ${rosterErr?.message}`);

  // Explicit column list, NOT a spread of `*`: `matches` has two GENERATED
  // ALWAYS columns (is_held, final_classification) which Postgres refuses on
  // insert, and an allowlist stays correct if more are added later.
  const { data: clone, error: cloneErr } = await db
    .from("matches")
    .insert({
      session_id: src.session_id,
      // The court was freed long ago; a completed match needs none, and null
      // keeps us clear of the live court rows.
      court_id: null,
      status: "completed",
      team_a_score: src.team_a_score,
      team_b_score: src.team_b_score,
      started_at: src.started_at,
      completed_at: src.completed_at,
      is_mixed_level: src.is_mixed_level,
      is_published: src.is_published,
      created_method: src.created_method,
    })
    .select("id")
    .single();
  if (cloneErr || !clone) throw new Error(`[P] clone insert failed: ${cloneErr?.message}`);

  const { error: mpErr } = await db
    .from("match_players")
    .insert(roster.map((p) => ({ match_id: clone.id, player_id: p.player_id, team: p.team })));
  if (mpErr) throw new Error(`[P] clone roster insert failed: ${mpErr.message}`);

  return clone.id as string;
}

/** Open the Queue tab of the sandbox dashboard on a phone-sized viewport. */
async function openQueueTab(page: Page, clubSlug: string, sessionId: string) {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${process.env.TEST_BASE_URL}${clubOrganizer(clubSlug, sessionId)}`);
  await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 20_000 });
  await page.getByRole("tab", { name: /queue/i }).click();
  await page.waitForSelector('[data-testid="manual-match-bar"]', { timeout: 15_000 });
}

/** Click a player's row in the flat List table. */
async function tapRow(page: Page, name: string) {
  await page.locator("table tr", { hasText: name }).first().click();
}

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

test.afterAll(async () => {
  await resetSandboxSession();
});

let seeded: Awaited<ReturnType<typeof seedSession>>;

test.beforeEach(async () => {
  await resetSandboxSession();
  seeded = await seedSession("diversity_pool_8");
  await cloneCompletedMatch(seeded.sessionId);
});

test.describe("Repeat-pairing warning — live", () => {
  test("[P-1/P-2] real counts drive the warning, and the bar pins under the real header", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await openQueueTab(page, seeded.clubSlug, seeded.sessionId);

      // ── Markers come from REAL partnership counts ──────────────
      // Alice has partnered Bob twice tonight (seed + clone), so with
      // Alice picked, Bob's row must be marked as a would-be 3rd.
      await tapRow(page, "E2E_Alice");

      const bobMarker = page
        .locator("table tr", { hasText: "E2E_Bob" })
        .getByTestId("repeat-marker");
      await expect(bobMarker).toBeVisible({ timeout: 15_000 });
      await expect(bobMarker.getByTestId("repeat-marker-label")).toHaveText("Team 3rd");

      // A fresh intermediate must NOT be marked — this is the avoidability
      // gate's evidence that a clean alternative exists.
      await expect(
        page.locator("table tr", { hasText: "E2E_Frank" }).getByTestId("repeat-marker")
      ).toHaveCount(0);

      // The legend resolves who the glyphs refer to.
      await expect(page.getByTestId("repeat-marker-legend")).toContainText("alongside E2E_Alice");

      // ── The headline, from real counts ─────────────────────────
      await tapRow(page, "E2E_Bob");
      const headline = page.getByTestId("repeat-headline");
      await expect(headline).toBeVisible({ timeout: 10_000 });
      await expect(headline).toContainText("have partnered 2× tonight");

      // ── [P-2] Sticky geometry against the REAL header ──────────
      const headerHeight = await page
        .locator("header")
        .first()
        .evaluate((el) => Math.round(el.getBoundingClientRect().height));
      // Sanity: the real organizer header is a multi-row affair, nothing
      // like the 56px stand-in every local check used.
      expect(headerHeight).toBeGreaterThan(100);

      const bar = page.getByTestId("manual-match-bar");
      const geo = await bar.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          position: cs.position,
          top: cs.top,
          zIndex: cs.zIndex,
          maxHeight: cs.maxHeight,
          overflowY: cs.overflowY,
          background: cs.backgroundColor,
          height: (el as HTMLElement).offsetHeight,
          scrollHeight: el.scrollHeight,
        };
      });

      expect(geo.position).toBe("sticky");
      expect(geo.zIndex).toBe("15");
      // THE assertion this whole spec exists for: --cc-header-h was
      // published from the real header, so the bar pins exactly at its
      // bottom edge rather than at the 176px fallback or at 0.
      expect(Math.round(parseFloat(geo.top))).toBe(headerHeight);
      // Direct proof the ResizeObserver actually ran: the var is set as an
      // inline style on the dashboard root. Without this the assertion above
      // could pass by coincidence — the 176px fallback sits only ~2px from
      // the real header height.
      const publishedVar = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>("div.min-h-screen");
        return root?.style.getPropertyValue("--cc-header-h") ?? "";
      });
      expect(publishedVar).toMatch(/^\d+px$/);
      expect(parseInt(publishedVar, 10)).toBe(headerHeight);
      // No inner scroller (a touch trap inside a sticky element).
      expect(geo.overflowY).not.toBe("auto");
      expect(geo.overflowY).not.toBe("scroll");
      // Opaque: the old bar was 30% translucent and rows showed through.
      expect(geo.background).not.toMatch(/rgba\([^)]+,\s*0?\.\d+\)/);
      // Height cap honoured, and nothing is clipped by it.
      expect(geo.height).toBeLessThanOrEqual(200);
      expect(geo.scrollHeight).toBeLessThanOrEqual(geo.height + 1);

      // ── It really stays pinned while the queue scrolls ─────────
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(400);
      const pinnedTop = await bar.evaluate((el) => Math.round(el.getBoundingClientRect().top));
      expect(pinnedTop).toBe(headerHeight);
      await expect(headline).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("[P-3] the warning never blocks creation — the CTA builds the previewed teams", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await openQueueTab(page, seeded.clubSlug, seeded.sessionId);

      // Deliberately build the flagged pairing: Alice+Bob as teammates.
      await tapRow(page, "E2E_Alice");
      await tapRow(page, "E2E_Bob");
      await tapRow(page, "E2E_Cara");
      await tapRow(page, "E2E_Dan");

      await expect(page.getByTestId("repeat-headline")).toBeVisible({ timeout: 10_000 });

      const cta = page.getByRole("button", { name: /add to on deck/i });
      await expect(cta).toBeEnabled();
      await cta.click();

      // A real pending match, with EXACTLY the teams the preview showed.
      const db = adminDb();
      await expect
        .poll(
          async () => {
            const { data } = await db
              .from("matches")
              .select("id, status, match_players(player_id, team)")
              .eq("session_id", seeded.sessionId)
              .eq("status", "pending");
            return data?.length ?? 0;
          },
          { timeout: 20_000, message: "advisory warning must not block match creation" }
        )
        .toBe(1);

      const { data: created } = await db
        .from("matches")
        .select("id, match_players(player_id, team)")
        .eq("session_id", seeded.sessionId)
        .eq("status", "pending")
        .single();

      const teamOf = (id: string) =>
        (created!.match_players as { player_id: string; team: string }[]).find(
          (p) => p.player_id === id
        )?.team;

      // Slots [A1,A2,B1,B2] = Alice, Bob, Cara, Dan.
      // Team is the lowercase `Team` enum in the DB ("a" | "b"), not the
      // display letter — see src/types/database.ts:82.
      expect(teamOf(seeded.players.alice.userId)).toBe("a");
      expect(teamOf(seeded.players.bob.userId)).toBe("a");
      expect(teamOf(seeded.players.cara.userId)).toBe("b");
      expect(teamOf(seeded.players.dan.userId)).toBe("b");
    } finally {
      await context.close();
    }
  });

  test("[P-4] the disclosure lists the real prior matches behind the count", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: ORGANIZER_STORAGE_STATE });
    const page = await context.newPage();

    try {
      await openQueueTab(page, seeded.clubSlug, seeded.sessionId);
      await tapRow(page, "E2E_Alice");
      await tapRow(page, "E2E_Bob");
      await expect(page.getByTestId("repeat-headline")).toBeVisible({ timeout: 10_000 });

      // Scoped to the bar: the dashboard header also carries a "More options"
      // button, which an unscoped /details|more/ picks up first — that was
      // why this failed on the previous live run.
      await page
        .getByTestId("manual-match-bar")
        .getByRole("button", { name: /details|more/i })
        .click();
      const panel = page.getByTestId("repeat-pair-details");
      await expect(panel).toBeVisible({ timeout: 10_000 });

      const pairRow = panel.getByRole("button", { name: /E2E_Alice & E2E_Bob/ });
      await expect(pairRow).toContainText("2 prior matches");
      await pairRow.click();

      // Status parity: the count said 2, so the list must show 2 — the
      // action filters on the same COMMITTED_MATCH_STATUSES that produced
      // the number, so the list can never contradict it.
      await expect(panel.getByText(/Completed/i)).toHaveCount(2, { timeout: 15_000 });
      await expect(panel.getByText(/same team/i).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
