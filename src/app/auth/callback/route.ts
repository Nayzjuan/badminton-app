// ============================================================
// /auth/callback — OAuth (PKCE) redirect handler
// ============================================================
// Completes the Google handoff started by signInWithGoogle / linkWithGoogle:
//   • error_code=identity_already_exists → the Google email already belongs to
//     another account: the collision-MERGE case (Phase 3, stubbed below).
//   • intent=link → upgrade of the current anonymous user. exchange + NO-OP on
//     the profile (display_name preserved by construction).
//   • else (fresh sign-in) → exchange, then finalise the OAuth stub profile
//     (derive name + PIN + uniqueness). The /rename gate catches collisions.
//
// force-dynamic so the code exchange + cookies are never cached.
// ============================================================

import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { ensureOAuthProfile } from "@/lib/oauth-provision";
import { ensureClubMembership } from "@/lib/clubs";
import { safeNext } from "@/lib/safe-next";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const errorCode = url.searchParams.get("error_code");
  const intent = url.searchParams.get("intent");
  const next = safeNext(url.searchParams.get("next"));
  const clubSlug = url.searchParams.get("club");

  // Link collision: the OAuth email is already attached to a different user.
  // Detected via the redirect query param (NOT an inline linkIdentity error).
  if (errorCode === "identity_already_exists") {
    // Phase 3: authenticate as the existing Google account and merge the
    // current anonymous user's history into it via migrate_player_identity.
    // Stubbed here — redirect back to where they came from with an error so
    // the link card can surface a human-readable explanation.
    const returnPath = intent === "link" ? next : "/";
    return NextResponse.redirect(`${origin}${returnPath}?error=already_linked`);
  }

  // Any other provider error, or a missing code.
  if (url.searchParams.get("error") || !code) {
    return NextResponse.redirect(`${origin}/?error=oauth`);
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/?error=oauth`);
  }

  // Upgrade flow: keep the existing profile/display_name exactly as-is.
  if (intent === "link") {
    return NextResponse.redirect(`${origin}${next}`);
  }

  // Fresh sign-in: finalise the OAuth stub profile (name + PIN + uniqueness).
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    await ensureOAuthProfile(user.id, {
      full_name: user.user_metadata?.full_name ?? null,
      name: user.user_metadata?.name ?? null,
      email: user.email ?? user.user_metadata?.email ?? null,
    });
    // Club QR-join started this sign-in — enroll now, mirroring the club_slug
    // handling in signInAnonymously (both new and returning users need this,
    // since a returning user may be reconnecting from a DIFFERENT club's QR).
    if (clubSlug) await ensureClubMembership(clubSlug, user.id);
  }

  // A collision left needs_rename=true; the page-level rename gate routes them
  // to /rename. A unique name was assigned silently → straight to `next`.
  return NextResponse.redirect(`${origin}${next}`);
}
