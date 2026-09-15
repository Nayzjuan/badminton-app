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
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-8">
      <div className="mb-4 w-full max-w-sm sm:max-w-md">
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-center dark:border-amber-800/50 dark:bg-amber-950/20">
          <p className="mb-1 truncate text-xs font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400">
            {sessionName ? "Joining Session" : "Joining Club"}
          </p>
          <h1 className="truncate text-xl font-black tracking-tight text-foreground">
            {sessionName ?? clubName}
          </h1>
          {sessionName && (
            <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-muted-foreground">
              {clubName}
            </p>
          )}
        </div>
      </div>
      {children}
    </main>
  );
}
