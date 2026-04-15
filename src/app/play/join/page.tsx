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
    const { data: activeEntry } = await supabase
      .from("queue_entries")
      .select("id")
      .eq("session_id", sessionId)
      .eq("player_id", user.id)
      .in("status", ["waiting", "on_deck", "playing"])
      .limit(1)
      .single();

    if (activeEntry) {
      // Already in this session — skip registration.
      redirect(`/play/${sessionId}`);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-12">
      {/* Session banner */}
      <div className="mb-8 text-center">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">
          Joining session
        </p>
        <h1 className="text-2xl font-bold text-foreground">{session.name}</h1>
      </div>

      {/* Registration form — pre-wired to this session */}
      <LoginForm sessionId={session.id} />
    </main>
  );
}
