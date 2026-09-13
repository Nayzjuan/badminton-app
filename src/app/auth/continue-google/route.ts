// ============================================================
// /auth/continue-google — second hop after identity_already_exists
// ============================================================
// The guest is still signed in. A signed merge cookie names them. This
// starts a FRESH Google sign-in (not linkIdentity) so they land as the
// keeper account that already owns that Google identity.
// ============================================================

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { safeNext } from "@/lib/safe-next";
import { OAUTH_MERGE_COOKIE, readMergeToken } from "@/lib/oauth-merge";

export const dynamic = "force-dynamic";

function siteUrl(requestUrl: URL): string {
  return process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? requestUrl.origin;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  const jar = await cookies();
  const token = jar.get(OAUTH_MERGE_COOKIE)?.value;

  if (!readMergeToken(token)) {
    return NextResponse.redirect(`${url.origin}${next}?error=already_linked`);
  }

  if (process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED !== "true") {
    return NextResponse.redirect(`${url.origin}${next}?error=oauth`);
  }

  const supabase = await createServerSupabaseClient();
  const redirectTo = `${siteUrl(url)}/auth/callback?next=${encodeURIComponent(next)}&merge=1`;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo },
  });

  if (error || !data?.url) {
    return NextResponse.redirect(`${url.origin}${next}?error=oauth`);
  }

  return NextResponse.redirect(data.url);
}
