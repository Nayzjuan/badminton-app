// ============================================================
// Session Picker — Choose which game session to join
// ============================================================
// Lists active sessions. If there's only one, auto-redirects.
// Also allows updating profile (name/skill) from here.
// ============================================================

import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import { SessionList } from "@/components/session-list";
import { LayoutDashboard } from "lucide-react";

export default async function PlayPage() {
  const supabase = await createClient();

  // Must be authenticated.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  // Get profile.
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (!profile) redirect("/");

  // Get active sessions.
  const { data: sessions } = await supabase
    .from("sessions")
    .select("*")
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  const activeSessions = sessions ?? [];

  // Auto-redirect if exactly one session.
  if (activeSessions.length === 1) {
    redirect(`/play/${activeSessions[0].id}`);
  }

  return (
    <main className="flex min-h-screen flex-col px-4 py-6">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-foreground">
              Hey, {profile.display_name}!
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Pick a session to join.
            </p>
          </div>

          {/*
            Organizer nav — visible to all authenticated users.
            In PWA standalone mode (no URL bar), this is the only
            way to reach /organizer without typing a URL manually.
          */}
          <Link
            href="/organizer"
            className="shrink-0 flex items-center gap-1.5 rounded-xl
                       border border-border bg-card px-3 py-2
                       text-xs font-semibold text-muted-foreground
                       hover:border-foreground/20 hover:text-foreground
                       hover:bg-accent transition-colors"
          >
            <LayoutDashboard className="h-3.5 w-3.5" />
            Organizer
          </Link>
        </div>

        {/* Session List */}
        {activeSessions.length > 0 ? (
          <SessionList sessions={activeSessions} />
        ) : (
          <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <p className="text-muted-foreground text-sm">
              No active sessions right now.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Ask an organizer to create one, or check back shortly.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
