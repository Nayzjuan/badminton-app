// ============================================================
// Auth Fixture — Programmatic Login Helpers
// ============================================================
// Signs bot accounts into the live app without touching the
// login form UI, keeping test setup fast and deterministic.
//
// Strategy:
//   1. Use the Supabase admin API to generate a fresh session
//      for the organizer bot (a permanent email-based account).
//   2. Inject the session as @supabase/ssr cookies directly
//      into the Playwright browser context — no UI form needed.
//   3. Navigate to /play to let the middleware validate the
//      session and exchange it for refreshed tokens.
//   4. Save the resulting browser storage state so the organizer
//      context can be reused across tests without re-signing-in.
//
// The organizer bot is a fixed account (created once via init-sandbox.ts).
// Player bots are anonymous DB rows — they never need a browser
// session for the Scenario A test (the organizer acts on them).
//
// Cookie format used by @supabase/ssr v0.10.x:
//   name:  sb-{projectRef}-auth-token
//   value: JSON.stringify(session)  (plain, not base64 by default)
//   If encodeURIComponent(value).length > 3180, chunks as .0, .1, …
// ============================================================

import { createClient } from "@supabase/supabase-js";
import type { BrowserContext, Page } from "@playwright/test";
import path from "path";
import fs from "fs";

// ── Admin client (service role) ───────────────────────────────
function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ── Constants ─────────────────────────────────────────────────
const ORGANIZER_EMAIL = process.env.TEST_ORGANIZER_EMAIL ?? "organizer-bot@playwright.local";
const ORGANIZER_PASSWORD = process.env.TEST_ORGANIZER_PASSWORD ?? "E2E_OrganizerBot_2024!";

// Storage state is saved here — gitignored, rebuilt when missing.
export const ORGANIZER_STORAGE_STATE = path.resolve(
  __dirname,
  "../../.playwright/organizer-storage-state.json"
);

// ── ensureOrganizerAccount ─────────────────────────────────────
// Idempotent: creates the organizer bot Supabase account if it
// doesn't exist yet. Run once before the first test of the suite.
export async function ensureOrganizerAccount(): Promise<string> {
  const db = getAdminClient();

  // Check if the organizer already exists
  const { data: existing } = await db.auth.admin.listUsers();
  const found = existing?.users?.find((u) => u.email === ORGANIZER_EMAIL);

  if (found) {
    return found.id;
  }

  // Create the organizer bot account
  const { data, error } = await db.auth.admin.createUser({
    email: ORGANIZER_EMAIL,
    password: ORGANIZER_PASSWORD,
    email_confirm: true,
    user_metadata: {
      display_name: "E2E_OrganizerBot",
    },
  });

  if (error || !data.user) {
    throw new Error(`[auth] Failed to create organizer bot: ${error?.message}`);
  }

  // Upsert profile
  await db.from("profiles").upsert(
    {
      id: data.user.id,
      display_name: "E2E_OrganizerBot",
      skill_level: "intermediate",
      pin: "9999",
    },
    { onConflict: "id" }
  );

  return data.user.id;
}

// ── injectSupabaseCookies ──────────────────────────────────────
// Encodes a Supabase session into @supabase/ssr-compatible cookies
// and injects them into a Playwright browser context.
//
// Mirrors @supabase/ssr v0.10.x chunker.ts (MAX_CHUNK_SIZE = 3180).
// The value is plain JSON; chunked into .0, .1, … when needed.
async function injectSupabaseCookies(
  page: Page,
  session: { access_token: string; refresh_token: string; [key: string]: unknown },
  baseURL: string
): Promise<void> {
  const projectRef = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0];
  const domain = new URL(baseURL).hostname;
  const cookieName = `sb-${projectRef}-auth-token`;
  const sessionJson = JSON.stringify(session);

  // Chunk algorithm matching @supabase/ssr's createChunks()
  const MAX_CHUNK_SIZE = 3180;
  const encoded = encodeURIComponent(sessionJson);

  type PlaywrightCookie = {
    name: string; value: string; domain: string; path: string;
    httpOnly: boolean; secure: boolean; sameSite: "Lax";
  };

  let cookies: PlaywrightCookie[];

  if (encoded.length <= MAX_CHUNK_SIZE) {
    // Fits in a single cookie — no chunking needed
    cookies = [{
      name: cookieName,
      value: sessionJson,
      domain,
      path: "/",
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    }];
  } else {
    // Split into chunks, preserving URI-encoding boundaries.
    // Each chunk value is stored DECODED (plain text), matching how
    // @supabase/ssr stores them — the cookie serializer handles encoding.
    const chunks: string[] = [];
    let remaining = encoded; // URL-encoded string, used only for length measurement

    while (remaining.length > 0) {
      let head = remaining.slice(0, MAX_CHUNK_SIZE);
      // Don't truncate a %-escape sequence (which is always 3 chars: %XX)
      const lastEscape = head.lastIndexOf("%");
      if (lastEscape > MAX_CHUNK_SIZE - 3) {
        head = head.slice(0, lastEscape);
      }
      // Store the decoded value; advance by the encoded slice we consumed
      chunks.push(decodeURIComponent(head));
      remaining = remaining.slice(head.length);
    }

    cookies = chunks.map((value, i) => ({
      name: `${cookieName}.${i}`,
      value,
      domain,
      path: "/",
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    }));
  }

  await page.context().addCookies(cookies);
}

// ── signInOrganizerBot ─────────────────────────────────────────
// Signs the organizer bot into a Playwright browser context by
// injecting Supabase session cookies directly — no UI form needed.
// This bypasses the anonymous login form which is incompatible with
// the email+password organizer bot account.
// Saves storage state for reuse on subsequent calls.
export async function signInOrganizerBot(
  page: Page,
  baseURL: string
): Promise<void> {
  // If we already have a saved storage state, skip sign-in entirely.
  if (fs.existsSync(ORGANIZER_STORAGE_STATE)) {
    return;
  }

  const db = getAdminClient();

  // Sign in with email+password using the standard auth API.
  // signInWithPassword() works with the service-role key client (same as anon key
  // for non-admin auth operations) and returns a full session object.
  const { data: signInData, error: signInErr } = await db.auth.signInWithPassword({
    email: ORGANIZER_EMAIL,
    password: ORGANIZER_PASSWORD,
  });

  if (signInErr || !signInData?.session) {
    throw new Error(
      `[auth] signInWithPassword failed for organizer bot: ${signInErr?.message ?? "no session returned"}.\n` +
        "Ensure the account exists by running: npm run test:setup"
    );
  }

  // Inject the session as @supabase/ssr cookies into the browser context
  await injectSupabaseCookies(page, signInData.session as unknown as Record<string, unknown> & { access_token: string; refresh_token: string }, baseURL);

  // ── Vercel Deployment Protection bypass ────────────────────
  // If Vercel Authentication is enabled, we must get past Vercel's
  // login wall BEFORE our Supabase cookies matter.
  //
  // Strategy A (preferred, stable): VERCEL_BYPASS_SECRET is set in
  // playwright.config.ts extraHTTPHeaders — every request bypasses
  // automatically. No action needed here.
  //
  // Strategy B (fallback, 23-hour window): VERCEL_SHARE_URL is set —
  // append _vercel_share=TOKEN directly to the /play URL so Vercel
  // validates the token AND serves the app page in a single request.
  //
  // ⚠️  Why not navigate to the share URL first?
  // The share URL redirect chains through vercel.com (auth domain), so
  // the _vercel_jwt cookie gets set on vercel.com — NOT on the
  // deployment subdomain. A subsequent navigation to /play then hits
  // Vercel auth again because the deployment domain has no cookie.
  // Appending the token to /play avoids this cross-domain cookie split.
  let playUrl = `${baseURL}/play`;
  const shareUrl = process.env.VERCEL_SHARE_URL;
  if (!process.env.VERCEL_BYPASS_SECRET && shareUrl) {
    const token = new URL(shareUrl).searchParams.get("_vercel_share");
    if (token) {
      playUrl = `${baseURL}/play?_vercel_share=${token}`;
      console.log("[auth] Appending _vercel_share token to /play URL to bypass Vercel auth…");
    }
  }

  // Navigate to /play — middleware will validate cookies and redirect
  // appropriately. The organizer bot has no active queue entry, so it
  // should land on /play (session picker).
  await page.goto(playUrl, { waitUntil: "networkidle" });

  // The middleware may redirect — wait for any /play or /organizer URL
  await page.waitForURL(/\/(play|organizer)/, { timeout: 20_000 });

  // Persist storage state for all subsequent test re-uses
  fs.mkdirSync(path.dirname(ORGANIZER_STORAGE_STATE), { recursive: true });
  await page.context().storageState({ path: ORGANIZER_STORAGE_STATE });

  console.log(`[auth] Organizer bot signed in via cookie injection → saved storage state`);
}

// ── clearOrganizerStorageState ────────────────────────────────
// Call this if the organizer session appears expired or a test
// needs a fresh sign-in (rare — only needed when Supabase rotates
// JWTs or the bot account is recreated).
export function clearOrganizerStorageState(): void {
  if (fs.existsSync(ORGANIZER_STORAGE_STATE)) {
    fs.rmSync(ORGANIZER_STORAGE_STATE);
  }
}

// ── loadOrganizerContext ──────────────────────────────────────
// Applies saved organizer storage state to a browser context so
// every test page starts authenticated without re-signing in.
export async function loadOrganizerContext(
  context: BrowserContext
): Promise<void> {
  if (!fs.existsSync(ORGANIZER_STORAGE_STATE)) {
    throw new Error(
      "[auth] Organizer storage state not found.\n" +
        "Run signInOrganizerBot() in a global setup step first."
    );
  }

  // storageState is already applied at context creation time when
  // the test uses `use: { storageState: ORGANIZER_STORAGE_STATE }`.
  // This function exists for explicit context loading in tests that
  // manage their own context (e.g., multi-context realtime tests).
  const state = JSON.parse(fs.readFileSync(ORGANIZER_STORAGE_STATE, "utf8"));
  await context.addCookies(state.cookies ?? []);
}

// ── getOrganizerUserId ────────────────────────────────────────
// Returns the Supabase user ID of the organizer bot (needed when
// the test needs to assert DB rows owned by the organizer).
export async function getOrganizerUserId(): Promise<string> {
  const db = getAdminClient();
  const { data: existing } = await db.auth.admin.listUsers();
  const found = existing?.users?.find((u) => u.email === ORGANIZER_EMAIL);

  if (!found) {
    throw new Error(
      "[auth] Organizer bot not found. Run ensureOrganizerAccount() first."
    );
  }

  return found.id;
}
