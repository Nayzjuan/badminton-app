// ============================================================
// /play/join — QR-code entry point for players
// ============================================================
// Reads ?session=<id> from the URL, verifies the session is
// active, then renders the registration form pre-wired to that
// session.  Players who scan the QR code land here and join in
// one step without manually navigating to the right session.
//
// Falls back to /play (the generic lobby) when:
//   • no ?session param is supplied
//   • the session does not exist or is no longer active
// ============================================================

import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { LoginForm } from "@/components/login-form";

interface JoinPageProps {
  searchParams: Promise<{ session?: string }>;
}

export default async function JoinPage({ searchParams }: JoinPageProps) {
  const { session: sessionId } = await searchParams;

  // If no session param, send to the generic lobby.
  if (!sessionId) {
    redirect("/play");
  }

  const supabase = await createClient();

  // Verify the session exists and is still active.
  const { data: session } = await supabase
    .from("sessions")
    .select("id, name, is_active")
    .eq("id", sessionId)
    .single();

  if (!session || !session.is_active) {
    redirect("/play");
  }

  // Check if the user is already logged in + active in THIS session.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    // Case A: already in this session's queue — skip straight to the session.
    const { data: activeEntry } = await supabase
      .from("queue_entries")
      .select("id")
      .eq("session_id", sessionId)
      .eq("player_id", user.id)
      .in("status", ["waiting", "on_deck", "playing"])
      .limit(1)
      .single();

    if (activeEntry) {
      redirect(`/play/${sessionId}`);
    }

    // Case B: authenticated but not yet in this session's queue.
    // If the player has a profile they have already registered before —
    // join them directly without forcing a redundant login screen.
    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", user.id)
      .single();

    if (profile) {
      // Upsert a waiting queue entry so the player appears in the queue,
      // then send them straight to the session dashboard.
      await supabase.from("queue_entries").upsert(
        {
          session_id: sessionId,
          player_id: user.id,
          status: "waiting",
        },
        { onConflict: "session_id,player_id", ignoreDuplicates: true }
      );

      redirect(`/play/${sessionId}`);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-12">
      {/* Session banner — distinct amber container so players know exactly what they're joining */}
      <div className="mb-8 w-full max-w-sm sm:max-w-md">
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-center
                        dark:border-amber-800/50 dark:bg-amber-950/20">
          <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-amber-600 dark:text-amber-400">
            Joining Session
          </p>
          <h1 className="text-xl font-black tracking-tight text-foreground">
            {session.name}
          </h1>
        </div>
      </div>

      {/* Registration form — pre-wired to this session */}
      <LoginForm sessionId={session.id} />
    </main>
  );
}
