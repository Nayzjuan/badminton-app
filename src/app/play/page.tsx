// ============================================================
// Session Picker — Choose which game session to join
// ============================================================
// Lists active sessions. If there's only one, auto-redirects.
// Also allows updating profile (name/skill) from here.
// ============================================================

import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { SessionList } from "@/components/session-list";
import { SignOutButton } from "@/components/sign-out-button";
import { MatchHistory } from "@/components/player/match-history";

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

          <SignOutButton variant="icon" />
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

        {/* Recent Match History */}
        <div className="space-y-3">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-muted-foreground">
            Recent Matches
          </p>
          <MatchHistory playerId={profile.id} limit={10} />
        </div>
      </div>
    </main>
  );
}
