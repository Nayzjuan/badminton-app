import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { getClubBySlug } from "@/lib/clubs";
import { isValidUUID } from "@/lib/validate";
import { LoginForm } from "@/components/login-form";
import { JoinFinalizer } from "@/components/join/join-finalizer";
import { lookupActiveJoinSession } from "@/lib/resolve-session-join";

/**
 * Shared join body for /c/[clubSlug]/join[/sessionId] and /j/[sessionId].
 * Authenticated players with a profile render JoinFinalizer (client) rather
 * than mutating membership/queue during this Server Component render.
 */
export async function ClubJoinScreen({
  clubSlug,
  sessionId,
}: {
  clubSlug: string;
  sessionId?: string;
}) {
  const club = await getClubBySlug(clubSlug);
  if (!club) notFound();

  const validSessionId = sessionId && isValidUUID(sessionId) ? sessionId : undefined;
  const sessionLookup = validSessionId ? await lookupActiveJoinSession(validSessionId) : null;
  const bound = sessionLookup?.ok && sessionLookup.clubSlug === club.slug ? sessionLookup : null;
  const sessionName = bound?.name;
  const boundSessionId = bound?.sessionId;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", user.id)
      .maybeSingle();
    if (profile) {
      return (
        <JoinChrome sessionName={sessionName} clubName={club.name}>
          <JoinFinalizer clubSlug={club.slug} sessionId={boundSessionId} />
        </JoinChrome>
      );
    }
  }

  return (
    <JoinChrome sessionName={sessionName} clubName={club.name}>
      <LoginForm sessionId={boundSessionId} clubSlug={clubSlug} />
    </JoinChrome>
  );
}

function JoinChrome({
  sessionName,
  clubName,
  children,
}: {
  sessionName?: string;
  clubName: string;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-start bg-cc-bg px-4 py-8 sm:justify-center">
      <div className="mb-3 w-full max-w-sm sm:max-w-md">
        <div className="rounded-lg border border-cc-amber/40 bg-cc-amber-dim px-3 py-2 text-center">
          <p className="truncate text-[11px] font-semibold uppercase tracking-widest text-cc-amber">
            {sessionName ? "Joining Session" : "Joining Club"}
            {sessionName ? ` · ${clubName}` : ""}
          </p>
          <h1 className="truncate text-lg font-black tracking-tight text-cc-t1">
            {sessionName ?? clubName}
          </h1>
        </div>
      </div>
      {children}
    </main>
  );
}
