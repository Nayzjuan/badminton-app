// ============================================================
// Co-organizer invite — /o/[token]
// ============================================================
// Public scan target. Create UI lives on organizer screens; this route
// cannot sit under member-gated /c/[slug]/organizer or non-members bounce
// to /play before enroll. Token is not the session UUID.

import type { Metadata } from "next";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { lookupCoOrganizerInvite } from "@/lib/resolve-co-organizer-invite";
import { sessionCoOrgShare } from "@/lib/club-paths";
import { joinPageMetadata } from "@/lib/join-metadata";
import { isCoOrganizerInviteTokenShape, decodeInviteTokenParam } from "@/lib/co-organizer-invite";
import { LoginForm } from "@/components/login-form";
import { CoOrganizerJoinFinalizer } from "@/components/join/co-organizer-join-finalizer";

interface PageProps {
  params: Promise<{ token: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token: raw } = await params;
  const token = decodeInviteTokenParam(raw);
  const found = isCoOrganizerInviteTokenShape(token)
    ? await lookupCoOrganizerInvite(token)
    : { ok: false as const };
  return joinPageMetadata({
    sessionName: found.ok ? found.name : null,
    clubName: found.ok ? found.clubName : null,
    canonicalPath: isCoOrganizerInviteTokenShape(token) ? sessionCoOrgShare(token) : "/o/invite",
    kind: "co-organizer",
  });
}

export default async function CoOrganizerInvitePage({ params }: PageProps) {
  const { token: raw } = await params;
  const token = decodeInviteTokenParam(raw);
  const found = isCoOrganizerInviteTokenShape(token)
    ? await lookupCoOrganizerInvite(token)
    : { ok: false as const };

  if (!found.ok) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-start bg-cc-bg px-4 py-8 sm:justify-center">
        <div className="w-full max-w-sm rounded-lg border border-cc-border bg-cc-bg-2 px-4 py-8 text-center">
          <p className="text-sm text-cc-t1">This invite is invalid or expired.</p>
        </div>
      </main>
    );
  }

  const next = sessionCoOrgShare(token);
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let body;
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", user.id)
      .maybeSingle();
    body = profile ? (
      <CoOrganizerJoinFinalizer token={token} />
    ) : (
      <LoginForm next={next} clubSlug={found.clubSlug} />
    );
  } else {
    body = <LoginForm next={next} clubSlug={found.clubSlug} />;
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-start bg-cc-bg px-4 py-8 sm:justify-center">
      <div className="mb-3 w-full max-w-sm sm:max-w-md">
        <div className="rounded-lg border border-cc-accent/40 bg-cc-accent-dim px-3 py-2 text-center">
          <p className="truncate text-[11px] font-semibold uppercase tracking-widest text-cc-accent">
            Co-organizer invite · {found.clubName}
          </p>
          <h1 className="truncate text-lg font-black tracking-tight text-cc-t1">{found.name}</h1>
        </div>
      </div>
      {body}
    </main>
  );
}
