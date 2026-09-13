// ============================================================
// /auth/callback — OAuth (PKCE) redirect handler
// ============================================================
// Completes the Google handoff started by signInWithGoogle / linkWithGoogle:
//   • error_code=identity_already_exists + intent=link → stash the guest
//     id, send them through a fresh Google sign-in, then merge guest play
//     onto the keeper (merge_guest_play_into_profile — keeper name stays).
//   • intent=link (success) → upgrade of the current anonymous user.
//     exchange + NO-OP on the profile (display_name preserved).
//   • else (fresh sign-in) → exchange, then finalise the OAuth stub.
//     requiresRename → /rename?next=.
// ============================================================

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { ensureOAuthProfile, oauthPostLoginPath } from "@/lib/oauth-provision";
import { ensureClubMembership } from "@/lib/clubs";
import { safeNext } from "@/lib/safe-next";
import { mergeGuestPlayIntoKeeper } from "@/lib/oauth-guest-merge";
import {
  OAUTH_MERGE_COOKIE,
  OAUTH_MERGE_MAX_AGE_SEC,
  createMergeToken,
  readMergeToken,
} from "@/lib/oauth-merge";

export const dynamic = "force-dynamic";

function clearMergeCookie(res: NextResponse): NextResponse {
  res.cookies.set({ name: OAUTH_MERGE_COOKIE, value: "", path: "/", maxAge: 0 });
  return res;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const errorCode = url.searchParams.get("error_code");
  const intent = url.searchParams.get("intent");
  const next = safeNext(url.searchParams.get("next"));
  const clubSlug = url.searchParams.get("club");

  if (errorCode === "identity_already_exists") {
    if (intent === "link") {
      const supabase = await createServerSupabaseClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const res = NextResponse.redirect(
          `${origin}/auth/continue-google?next=${encodeURIComponent(next)}`
        );
        res.cookies.set({
          name: OAUTH_MERGE_COOKIE,
          value: createMergeToken(user.id),
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: OAUTH_MERGE_MAX_AGE_SEC,
        });
        return res;
      }
    }
    const returnPath = intent === "link" ? next : "/";
    return NextResponse.redirect(`${origin}${returnPath}?error=already_linked`);
  }

  if (url.searchParams.get("error") || !code) {
    return NextResponse.redirect(`${origin}/?error=oauth`);
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/?error=oauth`);
  }

  if (intent === "link") {
    return NextResponse.redirect(`${origin}${next}`);
  }

  let requiresRename = false;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    const provisioned = await ensureOAuthProfile(user.id, {
      full_name: user.user_metadata?.full_name ?? null,
      name: user.user_metadata?.name ?? null,
      email: user.email ?? user.user_metadata?.email ?? null,
    });
    requiresRename = provisioned.requiresRename;
    if (clubSlug) await ensureClubMembership(clubSlug, user.id);

    const jar = await cookies();
    const guestId = readMergeToken(jar.get(OAUTH_MERGE_COOKIE)?.value);
    if (guestId && guestId !== user.id) {
      await mergeGuestPlayIntoKeeper(guestId, user.id);
    }
  }

  const dest = oauthPostLoginPath(next, requiresRename);
  return clearMergeCookie(NextResponse.redirect(`${origin}${dest}`));
}
