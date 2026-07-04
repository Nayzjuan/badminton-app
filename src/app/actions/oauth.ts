"use server";

// ============================================================
// OAuth Server Actions — Google sign-in & account upgrade
// ============================================================
// signInWithGoogle — fresh OAuth sign-in (new or returning Google user).
// linkWithGoogle    — upgrade: links Google to the CURRENT (anonymous)
//                     user, keeping the same id → display_name preserved.
//
// Both kick off the PKCE redirect and return the provider URL for the
// client to navigate to. The handoff completes in /auth/callback.
// Gated by NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED so the feature is dark until
// the Google provider + credentials are configured in Supabase.
// ============================================================

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { safeNext } from "@/lib/safe-next";

type OAuthStart = { success: true; url: string } | { success: false; error: string };

function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
}

function oauthEnabled(): boolean {
  return process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED === "true";
}

/**
 * Begin a fresh "Continue with Google" sign-in.
 *
 * `clubSlug` — set when the sign-in was started from a /c/[clubSlug] context
 * (e.g. a QR-join page) so /auth/callback can enroll the user in that club,
 * mirroring the club_slug threading signInAnonymously already does.
 */
export async function signInWithGoogle(next?: string, clubSlug?: string): Promise<OAuthStart> {
  if (!oauthEnabled()) return { success: false, error: "Google sign-in is not enabled." };

  const supabase = await createServerSupabaseClient();
  let redirectTo = `${siteUrl()}/auth/callback?next=${encodeURIComponent(safeNext(next))}`;
  if (clubSlug) redirectTo += `&club=${encodeURIComponent(clubSlug)}`;

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo },
  });

  if (error) return { success: false, error: error.message };
  if (!data?.url) return { success: false, error: "No redirect URL returned." };
  return { success: true, url: data.url };
}

/**
 * Begin the "Upgrade to Google" flow for a signed-in (anonymous) user. Links the
 * Google identity to the SAME user id, so the profile — and display_name — is
 * preserved. Requires Manual Linking enabled in Supabase. intent=link tells the
 * callback to leave the profile untouched.
 */
export async function linkWithGoogle(next?: string): Promise<OAuthStart> {
  if (!oauthEnabled()) return { success: false, error: "Google sign-in is not enabled." };

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "You must be signed in to upgrade." };

  const redirectTo = `${siteUrl()}/auth/callback?intent=link&next=${encodeURIComponent(
    safeNext(next)
  )}`;

  const { data, error } = await supabase.auth.linkIdentity({
    provider: "google",
    options: { redirectTo },
  });

  if (error) return { success: false, error: error.message };
  if (!data?.url) return { success: false, error: "No redirect URL returned." };
  return { success: true, url: data.url };
}
