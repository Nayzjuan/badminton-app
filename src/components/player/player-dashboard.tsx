"use client";

// ============================================================
// Player Dashboard — Main orchestrator with 3-tab layout
// ============================================================
// Tab 1: "My Status" — personal queue/match state (default)
// Tab 2: "Live Courts" — all in-progress + on-deck matches
// Tab 3: "Waitlist" — full queue with profiles
//
// The MatchAlert full-screen takeover still overrides everything
// when the player has an active match assignment.
// ============================================================

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  User,
  LayoutGrid,
  ListOrdered,
  Eye,
  EyeOff,
  LogOut,
  Trophy,
  MoreVertical,
} from "lucide-react";
import { LeaderboardPage } from "@/components/leaderboard/leaderboard-page";
import { useQueue } from "@/hooks/use-queue";
import { usePlayerMatch } from "@/hooks/use-player-match";
import { useSessionData } from "@/hooks/use-session-data";
import { useVisibilityRefresh } from "@/hooks/use-visibility-refresh";
import { useOrganizerBroadcast } from "@/hooks/use-organizer-broadcast";
import { useMatchAlerts } from "@/hooks/use-match-alerts";
import { NotificationEnrollment } from "@/components/notifications/notification-enrollment";
import { InstallPrompt } from "@/components/notifications/install-prompt";
import { GoogleLinkButton } from "@/components/auth/google-link-button";
import { useClubSlug } from "@/hooks/use-club-slug";
import { clubBase, clubPlay } from "@/lib/club-paths";
import { MatchAlertPresence } from "./match-alert";
import { LiveCourtsTab } from "./live-courts-tab";
import { WaitlistTab } from "./waitlist-tab";
import { SkillBadge } from "@/components/ui/skill-badge";
import { VipTag } from "@/components/ui/vip-tag";
import { checkoutPlayer } from "@/app/actions/queue";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { SignOutButton } from "@/components/sign-out-button";
import { ScoreInputCard } from "./score-input-card";
import { MyStatusTab } from "./my-status-tab";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { Profile, Session } from "@/types/database";

interface PlayerDashboardProps {
  profile: Profile;
  session: Session;
  /** True when the user's Supabase identity list includes a Google provider. */
  hasGoogleLinked: boolean;
}

type Tab = "status" | "courts" | "waitlist" | "leaderboard";

const TABS: { key: Tab; label: string; icon: typeof User }[] = [
  { key: "status", label: "My Status", icon: User },
  { key: "courts", label: "Live Courts", icon: LayoutGrid },
  { key: "waitlist", label: "Waitlist", icon: ListOrdered },
  { key: "leaderboard", label: "Leaderboard", icon: Trophy },
];

export function PlayerDashboard({ profile, session, hasGoogleLinked }: PlayerDashboardProps) {
  const router = useRouter();
  const clubSlug = useClubSlug(); // active club when under /c/[clubSlug]/…, else null
  const [activeTab, setActiveTab] = useState<Tab>("status");
  const [pinVisible, setPinVisible] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerOutside(e: MouseEvent | TouchEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointerOutside);
    document.addEventListener("touchstart", onPointerOutside as EventListener, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerOutside);
      document.removeEventListener("touchstart", onPointerOutside as EventListener);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  async function handleCheckout() {
    setCheckingOut(true);
    await checkoutPlayer(session.id);
    router.push(clubSlug ? clubBase(clubSlug) : "/play");
  }

  const {
    queue,
    myEntry,
    myPosition,
    myWaitMinutes,
    loading: queueLoading,
    joinQueue,
    leaveQueue,
    refresh: refreshQueue,
  } = useQueue(session.id, profile.id);

  const {
    currentMatch,
    upcomingHeld,
    loading: matchLoading,
    refresh: refreshMatch,
  } = usePlayerMatch(session.id, profile.id);

  const {
    inProgressMatches,
    onDeckMatches,
    waitlist,
    loading: sessionLoading,
    refresh: refreshSession,
  } = useSessionData(session.id);

  // Re-fetch all client data + server state when the tab becomes visible
  // (phone unlock, browser tab restore). Throttled to 5 s.
  useVisibilityRefresh(() => {
    refreshQueue();
    refreshMatch();
    refreshSession();
  });

  // Show a toast when the organizer clears an on-deck match or cancels
  // a match that this player is part of. Prevents silent state changes
  // from looking like app glitches.
  useOrganizerBroadcast(session.id, profile.id);

  // Fire audio + push notifications when the player transitions to
  // on_deck (warning chime) or gets a court assigned (court call arpeggio).
  useMatchAlerts({ sessionId: session.id, playerId: profile.id });

  // Player has an active match if they're on_deck or in_progress.
  const hasActiveMatch =
    currentMatch !== null &&
    (currentMatch.match.status === "pending" || currentMatch.match.status === "in_progress");

  const isInQueue = myEntry !== null && myEntry.status !== "left";
  // Include drafted players in the waiting count — they occupy a session
  // slot and are waiting for their match to publish.
  const totalWaiting = queue.filter((q) => q.status === "waiting" || q.status === "drafted").length;

  // Court-call auto-focus: when the player is pulled into a match
  // (hasActiveMatch false→true) while browsing another tab, jump to My Status so
  // the full-screen "Heads Up" / court-call takeover isn't missed — it's scoped
  // to the status tabpanel, so from Live Courts / Waitlist / Leaderboard they'd
  // otherwise only get the header dot + audio beep and could miss the call.
  const prevHasActiveMatchRef = useRef(hasActiveMatch);
  useEffect(() => {
    if (!prevHasActiveMatchRef.current && hasActiveMatch) {
      // Reacting to an external (realtime) state edge — a rare once-per-call
      // tab switch, not a render-loop. Same sanctioned pattern as the realtime
      // hooks (use-queue / use-player-match) that setState from an effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveTab("status");
    }
    prevHasActiveMatchRef.current = hasActiveMatch;
  }, [hasActiveMatch]);

  // Header dot colour.
  const dotColor = hasActiveMatch
    ? currentMatch?.match.status === "in_progress"
      ? "bg-emerald-500 animate-pulse"
      : "bg-amber-400 animate-pulse"
    : myEntry?.is_paused
      ? "bg-slate-400" // Paused — neutral, no pulse
      : isInQueue
        ? "bg-emerald-500 animate-pulse"
        : "bg-slate-300";

  return (
    <div className="min-h-screen bg-background md:flex md:justify-center">
      {/* On md+ screens, constrain to a phone-width column centred on the page */}
      <div className="relative flex flex-col w-full min-h-screen md:max-w-md md:border-x md:border-border">
        {/* ── Header ──────────────────────────────────────────── */}
        <header className="sticky top-0 z-10 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/85">
          <div className="px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-lg font-bold text-foreground truncate">{session.name}</h1>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="text-xs text-muted-foreground">{profile.display_name}</span>
                  {profile.vip_tag && profile.vip_theme && (
                    <VipTag tag={profile.vip_tag} theme={profile.vip_theme} />
                  )}
                  <SkillBadge level={profile.skill_level} />
                  {profile.pin && (
                    <button
                      onClick={() => setPinVisible((v) => !v)}
                      className="flex items-center gap-1 rounded-full bg-muted px-3 py-2
                               min-h-[36px] text-[10px] font-mono text-muted-foreground
                               hover:bg-muted/70 transition-colors"
                      title={pinVisible ? "Hide PIN" : "Show PIN"}
                    >
                      <span>{pinVisible ? profile.pin : `***${profile.pin.slice(-1)}`}</span>
                      {pinVisible ? (
                        <EyeOff className="h-2.5 w-2.5" />
                      ) : (
                        <Eye className="h-2.5 w-2.5" />
                      )}
                    </button>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* Status dot */}
                <div aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${dotColor}`} />
                <span className="sr-only">
                  Status:{" "}
                  {hasActiveMatch ? "Match active" : isInQueue ? "In queue" : "Not in queue"}
                </span>

                {/* Overflow menu — PIN, Theme, Sign Out, Leave Session */}
                <div ref={menuRef} className="relative">
                  <button
                    type="button"
                    onClick={() => setMenuOpen((v) => !v)}
                    aria-label="More options"
                    aria-expanded={menuOpen}
                    className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground
                             hover:bg-muted hover:text-foreground transition-colors"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </button>

                  {menuOpen && (
                    <div
                      className="absolute right-0 top-full z-50 mt-1 w-52 rounded-xl border border-border
                               bg-card shadow-xl py-1"
                      role="menu"
                    >
                      {profile.pin && (
                        <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
                          <span className="text-[11px] text-muted-foreground">Your PIN</span>
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-xs font-bold">
                              {pinVisible ? profile.pin : `•••${profile.pin.slice(-1)}`}
                            </span>
                            <button
                              onClick={() => setPinVisible((v) => !v)}
                              className="text-muted-foreground hover:text-foreground transition-colors"
                              aria-label={pinVisible ? "Hide PIN" : "Show PIN"}
                            >
                              {pinVisible ? (
                                <EyeOff className="h-3 w-3" />
                              ) : (
                                <Eye className="h-3 w-3" />
                              )}
                            </button>
                          </div>
                        </div>
                      )}

                      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
                        <span className="text-[11px] text-muted-foreground">Theme</span>
                        <ThemeToggle className="text-muted-foreground hover:text-foreground hover:bg-muted" />
                      </div>

                      {/* Google account status row */}
                      {hasGoogleLinked ? (
                        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
                          <svg
                            className="h-3.5 w-3.5 shrink-0"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <path
                              fill="#4285F4"
                              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"
                            />
                            <path
                              fill="#34A853"
                              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
                            />
                            <path
                              fill="#FBBC05"
                              d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z"
                            />
                            <path
                              fill="#EA4335"
                              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z"
                            />
                          </svg>
                          <span className="text-[11px] text-muted-foreground">
                            Google · Connected
                          </span>
                        </div>
                      ) : (
                        <div className="px-3 py-2.5 border-b border-border">
                          <GoogleLinkButton
                            next={clubSlug ? clubPlay(clubSlug, session.id) : `/play/${session.id}`}
                          />
                        </div>
                      )}

                      <div className="px-3 py-2.5 border-b border-border">
                        <SignOutButton variant="text" />
                      </div>

                      <button
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          setLeaveDialogOpen(true);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs
                                 font-medium text-destructive hover:bg-destructive/5 transition-colors"
                      >
                        <LogOut className="h-3.5 w-3.5" />
                        Leave Session
                      </button>
                    </div>
                  )}
                </div>

                {/* Controlled leave-session dialog — no AlertDialogTrigger needed */}
                <AlertDialog open={leaveDialogOpen} onOpenChange={setLeaveDialogOpen}>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Leave &ldquo;{session.name}&rdquo;?</AlertDialogTitle>
                      <AlertDialogDescription>
                        You will be removed from the queue and will lose your spot. Any match
                        currently in progress will not be affected. You can rejoin later using your
                        name and PIN.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Stay</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleCheckout}
                        disabled={checkingOut}
                        className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
                      >
                        {checkingOut ? "Leaving…" : "Leave session"}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                    <div className="border-t border-border mt-1 pt-3 text-center">
                      <SignOutButton variant="text" />
                    </div>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </div>

          {/* ── Tab Bar — 4 tabs, mobile-stretch ────────────── */}
          <div
            role="tablist"
            aria-label="Session navigation"
            className="grid grid-cols-4 border-t border-border"
          >
            {TABS.map(({ key, label, icon: Icon }) => {
              const isActive = activeTab === key;
              return (
                <button
                  key={key}
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`tabpanel-${key}`}
                  id={`tab-${key}`}
                  onClick={() => setActiveTab(key)}
                  className={`flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold
                            transition-colors
                            ${
                              isActive
                                ? "text-primary border-b-2 border-primary"
                                : "text-muted-foreground hover:text-foreground"
                            }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              );
            })}
          </div>
        </header>

        {/* ── Pocket Ping enrollment prompt ───────────────────── */}
        {/* Shown once, 2.5 s after mount, if Notification.permission === 'default'.
            Self-suppresses on iOS Safari tabs (push needs an installed PWA). */}
        <NotificationEnrollment userId={profile.id} />

        {/* ── Add-to-Home-Screen nudge ────────────────────────── */}
        {/* iOS-not-installed (required for push) + Android one-tap install.
            Coordinates with enrollment so only one card shows at a time. */}
        <InstallPrompt />

        {/* ── Content ─────────────────────────────────────────── */}
        <main className="relative flex-1 overflow-hidden">
          <div className="px-4 py-5 pb-8">
            {activeTab === "status" && (
              <div role="tabpanel" id="tabpanel-status" aria-labelledby="tab-status">
                {/* MatchAlert full-screen overlay — scoped to the status tabpanel
                so switching tabs (Live Courts / Waitlist / Leaderboard)
                actually reveals the other tabs' content. MatchAlertPresence
                stays mounted (active=null when idle) so it can animate the
                enter slide, the pending↔in_progress crossfade, and the exit. */}
                <MatchAlertPresence
                  active={
                    hasActiveMatch && currentMatch
                      ? {
                          matchStatus: currentMatch.match.status as "pending" | "in_progress",
                          court: currentMatch.court,
                          myDisplayName: profile.display_name,
                          mySkillLevel: profile.skill_level,
                          teammates: currentMatch.teammates,
                          opponents: currentMatch.opponents,
                          isMixedLevel: currentMatch.match.is_mixed_level,
                          onDeckPosition: currentMatch.onDeckPosition,
                          totalOnDeck: currentMatch.totalOnDeck,
                          onLeaveQueue: leaveQueue,
                          upcomingReserved:
                            currentMatch.match.status === "in_progress" && upcomingHeld?.reserved
                              ? { ready: upcomingHeld.ready }
                              : null,
                          scoreSlot:
                            currentMatch.match.status === "in_progress" ? (
                              <ScoreInputCard
                                matchId={currentMatch.match.id}
                                myTeam={currentMatch.myTeam}
                              />
                            ) : null,
                        }
                      : null
                  }
                />
                <MyStatusTab
                  profile={profile}
                  session={session}
                  hasActiveMatch={hasActiveMatch}
                  currentMatch={currentMatch}
                  isInQueue={isInQueue}
                  myEntry={myEntry}
                  myPosition={myPosition}
                  myWaitMinutes={myWaitMinutes}
                  totalWaiting={totalWaiting}
                  queueLoading={queueLoading}
                  matchLoading={matchLoading}
                  joinQueue={joinQueue}
                  leaveQueue={leaveQueue}
                  hasGoogleLinked={hasGoogleLinked}
                />
              </div>
            )}

            {activeTab === "courts" && (
              <div role="tabpanel" id="tabpanel-courts" aria-labelledby="tab-courts">
                <LiveCourtsTab
                  inProgressMatches={inProgressMatches}
                  onDeckMatches={onDeckMatches}
                  loading={sessionLoading}
                  myPlayerId={profile.id}
                />
              </div>
            )}

            {activeTab === "waitlist" && (
              <div role="tabpanel" id="tabpanel-waitlist" aria-labelledby="tab-waitlist">
                <WaitlistTab waitlist={waitlist} myPlayerId={profile.id} loading={sessionLoading} />
              </div>
            )}

            {activeTab === "leaderboard" && (
              <div role="tabpanel" id="tabpanel-leaderboard" aria-labelledby="tab-leaderboard">
                <LeaderboardPage
                  sessionId={session.id}
                  currentUserId={profile.id}
                  variant="player-panel"
                />
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
