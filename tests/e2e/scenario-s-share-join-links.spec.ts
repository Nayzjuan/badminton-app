// ============================================================
// Scenario S — Share / join links (in-app browser regressions)
// ============================================================
// Reclub-class in-app browsers 404 a `?session=` share URL when they
// encode `?` into the path. These tests pin the deployed contract:
//
//   [S-1] /j/<sessionId> shows the join form, not 404
//   [S-2] /c/<slug>/join/<sessionId> is the same form
//   [S-3] /play/join?session=<id> 308s onto /j/<id>
//   [S-4] a path with %3Fsession= does not land on 404
//   [S-5] the join HTML carries Open Graph tags
//   [S-6] the join response allows framing (no XFO DENY)
//   [S-7] Share Session copies a /j/<id> URL (no query string)
//
// Runs against TEST_BASE_URL (live Vercel, or localhost while
// developing). Needs the new routes to be deployed.
// ============================================================

import { test, expect, type Browser } from "@playwright/test";
import dotenv from "dotenv";
import path from "path";

import { resetSandboxSession, getSandboxClubSlug } from "../helpers/teardown";
import { clubJoin, clubOrganizer, sessionShare } from "../../src/lib/club-paths";
import { ensureOrganizerAccount, signInOrganizerBot } from "../fixtures/auth";

dotenv.config({ path: path.resolve(__dirname, "../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../.env.local"), override: false });

const BASE_URL = process.env.TEST_BASE_URL!;
const SESSION_ID = process.env.TEST_SESSION_ID!;
let CLUB_SLUG: string;

const BYPASS_HEADERS: Record<string, string> = process.env.VERCEL_BYPASS_SECRET
  ? { "x-vercel-protection-bypass": process.env.VERCEL_BYPASS_SECRET }
  : {};

test.beforeAll(async ({ browser }) => {
  await ensureOrganizerAccount();
  CLUB_SLUG = await getSandboxClubSlug();

  const context = await browser.newContext({ extraHTTPHeaders: BYPASS_HEADERS });
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

function anonContext(browser: Browser) {
  return browser.newContext({ extraHTTPHeaders: BYPASS_HEADERS });
}

test.describe("Share / join links — [S-1] short /j/ URL", () => {
  test("anonymous visitor opening /j/<sessionId> sees the join form, not 404", async ({
    browser,
  }) => {
    const context = await anonContext(browser);
    const page = await context.newPage();
    try {
      const res = await page.goto(`${BASE_URL}${sessionShare(SESSION_ID)}`, {
        waitUntil: "domcontentloaded",
      });
      expect(res?.status(), "the short share URL itself 404'd").not.toBe(404);
      await expect(page.getByRole("heading", { name: /page not found/i })).toHaveCount(0);
      await expect(page.getByText(/joining session|joining club/i)).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByRole("button", { name: /join session/i })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

test.describe("Share / join links — [S-2] club path-based join", () => {
  test("anonymous visitor opening /c/<slug>/join/<id> sees the join form", async ({ browser }) => {
    const context = await anonContext(browser);
    const page = await context.newPage();
    try {
      const res = await page.goto(`${BASE_URL}${clubJoin(CLUB_SLUG, SESSION_ID)}`, {
        waitUntil: "domcontentloaded",
      });
      expect(res?.status(), "the club path-based join 404'd").not.toBe(404);
      await expect(page.getByText(/joining session|joining club/i)).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await context.close();
    }
  });
});

test.describe("Share / join links — [S-3] legacy query string", () => {
  test("/play/join?session=<uuid> permanently redirects onto /j/<uuid>", async ({ browser }) => {
    const context = await anonContext(browser);
    const request = context.request;
    try {
      const res = await request.get(`${BASE_URL}/play/join?session=${SESSION_ID}`, {
        maxRedirects: 0,
      });
      expect(res.status()).toBe(308);
      const location = res.headers().location ?? "";
      expect(location).toContain(`/j/${SESSION_ID}`);
      expect(location, "the 308 re-printed ?session= on /j/").not.toContain("?");
    } finally {
      await context.close();
    }
  });
});

test.describe("Share / join links — [S-4] encoded ? in the path", () => {
  test("a %3Fsession= path does not land on the 404 page", async ({ browser }) => {
    const context = await anonContext(browser);
    const page = await context.newPage();
    try {
      const encoded = `${BASE_URL}/c/${CLUB_SLUG}/join%3Fsession%3D${SESSION_ID}`;
      const res = await page.goto(encoded, { waitUntil: "domcontentloaded" });
      expect(res?.status(), "the encoded join path 404'd").not.toBe(404);
      await expect(page.getByRole("heading", { name: /page not found/i })).toHaveCount(0);
      await expect(page.getByText(/joining session|joining club/i)).toBeVisible({
        timeout: 15_000,
      });
      expect(new URL(page.url()).pathname).toBe(`/c/${CLUB_SLUG}/join/${SESSION_ID}`);
    } finally {
      await context.close();
    }
  });
});

test.describe("Share / join links — [S-5] Open Graph", () => {
  test("/j/<id> HTML includes og:title so unfurlers get a card", async ({ browser }) => {
    const context = await anonContext(browser);
    const page = await context.newPage();
    try {
      await page.goto(`${BASE_URL}${sessionShare(SESSION_ID)}`, {
        waitUntil: "domcontentloaded",
      });
      const og = page.locator('meta[property="og:title"]');
      await expect(og).toHaveCount(1);
      const content = await og.getAttribute("content");
      expect(content, "og:title was empty").toBeTruthy();
    } finally {
      await context.close();
    }
  });
});

test.describe("Share / join links — [S-6] framing allowed", () => {
  test("the join response does not send X-Frame-Options: DENY", async ({ browser }) => {
    const context = await anonContext(browser);
    const page = await context.newPage();
    try {
      const res = await page.goto(`${BASE_URL}${sessionShare(SESSION_ID)}`, {
        waitUntil: "domcontentloaded",
      });
      expect(res, "no response from /j/").toBeTruthy();
      const xfo = (res!.headers()["x-frame-options"] ?? "").toLowerCase();
      expect(xfo, "join route still sends X-Frame-Options: DENY").not.toBe("deny");
      const csp = res!.headers()["content-security-policy"] ?? "";
      expect(csp).toContain("frame-ancestors *");
    } finally {
      await context.close();
    }
  });
});

test.describe("Share / join links — [S-7] organizer copy link", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test("Share Session shows a /j/<sessionId> URL with no query string", async ({ browser }) => {
    const context = await browser.newContext({
      extraHTTPHeaders: BYPASS_HEADERS,
      viewport: { width: 1400, height: 900 },
    });
    const page = await context.newPage();
    try {
      await signInOrganizerBot(page, BASE_URL, { force: true });
      await page.goto(`${BASE_URL}${clubOrganizer(CLUB_SLUG, SESSION_ID)}`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForSelector('[id="tabpanel-courts"]', { timeout: 20_000 });
      await page.getByRole("button", { name: "Share Session" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      const expectedPath = sessionShare(SESSION_ID);
      const urlLine = dialog.getByText(expectedPath);
      await expect(urlLine).toBeVisible({ timeout: 15_000 });
      const shown = (await urlLine.textContent()) ?? "";
      expect(shown).not.toContain("?session=");
      expect(shown).toContain(expectedPath);
    } finally {
      await context.close();
    }
  });
});
