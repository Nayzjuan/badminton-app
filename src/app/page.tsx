// ============================================================
// Home Page — Player Login / Profile Setup
// ============================================================
// If already authenticated and in an active session, redirects
// straight to that session dashboard. Otherwise shows the
// name + skill level + PIN entry form.
// ============================================================

import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { LoginForm } from "@/components/login-form";
import { Feather } from "lucide-react";

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    // Check if the player is actively in a session (queued or playing).
    const { data: activeEntry } = await supabase
      .from("queue_entries")
      .select("session_id, sessions!inner(is_active)")
      .eq("player_id", user.id)
      .in("status", ["waiting", "on_deck", "playing"])
      .limit(1)
      .single();

    if (activeEntry) {
      redirect(`/play/${activeEntry.session_id}`);
    }

    // Has auth but no active session — go to session picker.
    redirect("/play");
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm sm:max-w-md space-y-8 text-center">
        {/* Branding */}
        <div className="space-y-2">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <Feather className="h-7 w-7" aria-hidden="true" />
          </div>
          <h1 className="text-3xl font-black tracking-tight text-foreground">
            Badminton Queue
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Enter your name and skill level to get started.
          </p>
        </div>

        {/* Login Form */}
        <LoginForm />
      </div>
    </main>
  );
}
