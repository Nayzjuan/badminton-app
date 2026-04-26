// ============================================================
// Session Picker — Choose which game session to join
// ============================================================
// Lists active sessions. If there's only one, auto-redirects.
// Also allows updating profile (name/skill) from here.
// ============================================================

import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { SessionList } from "@/components/session-list";
import { SignOutButton } from "@/components/sign-out-button";
import { AllSessionsHistory } from "@/components/player/all-sessions-history";
import { VipTag } from "@/components/ui/vip-tag";
import { Trophy } from "lucide-react";

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
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-foreground">
                Hey, {profile.display_name}!
              </h1>
              {profile.vip_tag && profile.vip_theme && (
                <VipTag tag={profile.vip_tag} theme={profile.vip_theme} />
              )}
            </div>
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
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <span className="text-xl" aria-hidden="true">🏸</span>
            </div>
            <p className="text-sm font-semibold text-foreground">No active sessions yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Ask an organizer to start one, or check back in a moment.
            </p>
          </div>
        )}

        {/* Leaderboard shortcut */}
        <Link
          href="/leaderboard"
          className="flex items-center justify-between gap-3 rounded-xl border border-border
                     bg-card px-4 py-3 hover:bg-muted/50 transition-colors"
        >
          <div className="flex items-center gap-2.5">
            <Trophy className="h-4 w-4 text-amber-500 shrink-0" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-foreground">Leaderboard</p>
              <p className="text-xs text-muted-foreground">All-Time &amp; per-session rankings</p>
            </div>
          </div>
          <span className="text-muted-foreground text-sm">›</span>
        </Link>

        {/* Match History — grouped by session */}
        <div className="space-y-3">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-muted-foreground">
            Match History
          </p>
          <AllSessionsHistory playerId={profile.id} />
        </div>
      </div>
    </main>
  );
}
