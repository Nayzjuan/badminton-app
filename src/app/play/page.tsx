// ============================================================
// Session Picker — Choose which game session to join
// ============================================================
// Lists active sessions and lets the player pick one.
// Direct entry only happens via the QR/share link (/play/join).
// Also allows updating profile (name/skill) from here.
// ============================================================

import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { enforceRenameGate } from "@/lib/rename-gate";
import { getPrimaryClubSlug, getClubBySlug } from "@/lib/clubs";
import { PUBLIC_PROFILE_COLUMNS, PUBLIC_SESSION_COLUMNS } from "@/types/database";
import { SessionList } from "@/components/session-list";
import { SignOutButton } from "@/components/sign-out-button";
import { AllSessionsHistory } from "@/components/player/all-sessions-history";
import { VipTag } from "@/components/ui/vip-tag";
import { GoogleLinkCard } from "@/components/notifications/google-link-card";
import { Trophy } from "lucide-react";

export default async function PlayPage() {
  const supabase = await createServerSupabaseClient();

  // Must be authenticated.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  // Get profile + resolve the primary club in parallel — both depend only on
  // user.id (was two serial hops). Explicit column list — this page (session
  // picker) never displays the player's own PIN, and the browser client's
  // column privilege on profiles no longer includes it
  // (20260701000010_column_lockdown_fix_table_grants.sql).
  //
  // primaryClubSlug = the club of their last-attended session (falling back to
  // last-joined). No club → they registered via the plain link with no QR;
  // route them to the join-via-QR screen. For a multi-club player this scopes
  // the picker to the club they last actively used, not every club at once.
  const [{ data: profileRow }, primaryClubSlug] = await Promise.all([
    supabase.from("profiles").select(PUBLIC_PROFILE_COLUMNS).eq("id", user.id).single(),
    getPrimaryClubSlug(user.id),
  ]);

  if (!profileRow) redirect("/");
  const profile = { ...profileRow, pin: null };

  // Duplicate-name gate (L1): route flagged duplicates to /rename first.
  await enforceRenameGate(profile, "/play");

  const hasGoogleLinked = user.identities?.some((id) => id.provider === "google") ?? false;

  if (!primaryClubSlug) redirect("/welcome");
  const primaryClub = await getClubBySlug(primaryClubSlug);
  const clubIds = primaryClub ? [primaryClub.id] : [];

  // SessionList doesn't display organizer_passcode — explicit column list.
  const activeSessionRows =
    clubIds.length === 0
      ? []
      : ((
          await supabase
            .from("sessions")
            .select(PUBLIC_SESSION_COLUMNS)
            .eq("is_active", true)
            .in("club_id", clubIds)
            .order("created_at", { ascending: false })
        ).data ?? []);
  const activeSessions = activeSessionRows.map((s) => ({ ...s, organizer_passcode: null }));

  return (
    <main className="flex min-h-screen flex-col px-4 py-6">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-foreground">Hey, {profile.display_name}!</h1>
              {profile.vip_tag && profile.vip_theme && (
                <VipTag tag={profile.vip_tag} theme={profile.vip_theme} />
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-1">Pick a session to join.</p>
            {hasGoogleLinked && (
              <div className="flex items-center gap-1.5 mt-1.5">
                <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    fill="#4285F4"
                  />
                  <path
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    fill="#34A853"
                  />
                  <path
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
                    fill="#FBBC05"
                  />
                  <path
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    fill="#EA4335"
                  />
                </svg>
                <span className="text-[11px] text-muted-foreground">Google · Connected</span>
              </div>
            )}
          </div>

          <SignOutButton variant="icon" />
        </div>

        {/* Google upgrade card — shown to anonymous players who haven't linked Google */}
        {!hasGoogleLinked && (
          <Suspense>
            <GoogleLinkCard next="/play" />
          </Suspense>
        )}

        {/* Session List */}
        {activeSessions.length > 0 ? (
          <SessionList sessions={activeSessions} />
        ) : (
          <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <span className="text-xl" aria-hidden="true">
                🏸
              </span>
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
