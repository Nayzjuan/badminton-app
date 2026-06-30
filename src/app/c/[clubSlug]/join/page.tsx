// ============================================================
// Club QR / join entry — /c/[clubSlug]/join?session=<id>
// ============================================================
// PUBLIC (outside the (app)/(full) membership gate — a fresh scanner isn't a
// member yet). Resolves the club + (optional) session, then:
//   • authed + has profile → auto-enroll in the club, queue them for the
//     session (if any), and route to the club-scoped destination.
//   • fresh visitor → registration form pre-wired with the club + session, so
//     signInAnonymously enrolls them and routes into the club in one step.
// The session lookup uses the anon-safe SECURITY DEFINER RPC (now also returns
// club_slug) so anonymous scanners never read `sessions` directly.
// ============================================================

import { redirect, notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { getClubBySlug, ensureClubMembership } from "@/lib/clubs";
import { clubPlay, clubBase } from "@/lib/club-paths";
import { LoginForm } from "@/components/login-form";

interface ClubJoinPageProps {
  params: Promise<{ clubSlug: string }>;
  searchParams: Promise<{ session?: string }>;
}

export default async function ClubJoinPage({ params, searchParams }: ClubJoinPageProps) {
  const { clubSlug } = await params;
  const { session: sessionId } = await searchParams;

  const club = await getClubBySlug(clubSlug);
  if (!club) notFound();

  const supabase = await createServerSupabaseClient();

  // Validate the session (if a QR carried ?session=): must be active AND belong
  // to THIS club. A bad / inactive / cross-club id degrades to a plain club join.
  let sessionName: string | null = null;
  if (sessionId) {
    const { data: lookup } = await supabase.rpc("lookup_active_session", {
      p_session_id: sessionId,
    });
    const s = lookup?.[0] ?? null;
    if (s && s.is_active && s.club_slug === clubSlug) {
      sessionName = s.name;
    }
  }
  const validSessionId = sessionName ? sessionId : undefined;

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", user.id)
      .single();
    if (profile) {
      // Returning player — enroll in the club, queue for the session, route in.
      await ensureClubMembership(clubSlug, user.id);
      if (validSessionId) {
        await supabase
          .from("queue_entries")
          .upsert(
            { session_id: validSessionId, player_id: user.id, status: "waiting" },
            { onConflict: "session_id,player_id", ignoreDuplicates: true }
          );
        redirect(clubPlay(clubSlug, validSessionId));
      }
      redirect(clubBase(clubSlug));
    }
  }

  // Fresh visitor — registration enrolls + routes via the club_slug hidden field.
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-12">
      <div className="mb-8 w-full max-w-sm sm:max-w-md">
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-center dark:border-amber-800/50 dark:bg-amber-950/20">
          <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-amber-600 dark:text-amber-400">
            {sessionName ? "Joining Session" : "Joining Club"}
          </p>
          <h1 className="text-xl font-black tracking-tight text-foreground">
            {sessionName ?? club.name}
          </h1>
          {sessionName && (
            <p className="mt-0.5 text-xs text-slate-500 dark:text-muted-foreground">{club.name}</p>
          )}
        </div>
      </div>

      <LoginForm sessionId={validSessionId} clubSlug={clubSlug} />
    </main>
  );
}
