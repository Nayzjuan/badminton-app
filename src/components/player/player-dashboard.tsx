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

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { User, LayoutGrid, ListOrdered, Eye, EyeOff, LogOut, Trophy } from "lucide-react";
import { LeaderboardPage } from "@/components/leaderboard/leaderboard-page";
import { useQueue } from "@/hooks/use-queue";
import { usePlayerMatch } from "@/hooks/use-player-match";
import { useSessionData } from "@/hooks/use-session-data";
import { useVisibilityRefresh } from "@/hooks/use-visibility-refresh";
import { useOrganizerBroadcast } from "@/hooks/use-organizer-broadcast";
import { useMatchAlerts } from "@/hooks/use-match-alerts";
import { NotificationEnrollment } from "@/components/notifications/notification-enrollment";
import { MatchAlert } from "./match-alert";
import { QueueToggle } from "./queue-toggle";
import { QueueStatus } from "./queue-status";
import { OnDeckAlert } from "./on-deck-alert";
import { MatchHistory } from "./match-history";
import { LiveCourtsTab } from "./live-courts-tab";
import { WaitlistTab } from "./waitlist-tab";
import { SkillBadge } from "@/components/ui/skill-badge";
import { VipTag } from "@/components/ui/vip-tag";
import { submitMatchScore } from "@/app/actions/match";
import { checkoutPlayer } from "@/app/actions/queue";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { SignOutButton } from "@/components/sign-out-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { Profile, Session } from "@/types/database";

interface PlayerDashboardProps {
  profile: Profile;
  session: Session;
}

type Tab = "status" | "courts" | "waitlist" | "leaderboard";

const TABS: { key: Tab; label: string; icon: typeof User }[] = [
  { key: "status", label: "My Status", icon: User },
  { key: "courts", label: "Live Courts", icon: LayoutGrid },
  { key: "waitlist", label: "Waitlist", icon: ListOrdered },
  { key: "leaderboard", label: "Leaderboard", icon: Trophy },
];

export function PlayerDashboard({ profile, session }: PlayerDashboardProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>("status");
  const [pinVisible, setPinVisible] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);

  async function handleCheckout() {
    setCheckingOut(true);
    await checkoutPlayer(session.id);
    router.push("/play");
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
  // Include "drafted" players — they are committed to a pending draft and
  // still occupy a session slot; excluding them understates the queue size.
  const totalWaiting = queue.filter((q) => q.status === "waiting" || q.status === "drafted").length;

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
    <div className="min-h-screen bg-slate-50 dark:bg-background md:flex md:justify-center">
      {/* On md+ screens, constrain to a phone-width column centred on the page */}
      <div className="flex flex-col w-full min-h-screen md:max-w-md md:border-x md:border-slate-200 dark:md:border-border">
        {/* ── Header ──────────────────────────────────────────── */}
        <header
          className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80
                         dark:bg-background/95 dark:border-border"
        >
          <div className="px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-lg font-bold text-slate-900 dark:text-foreground truncate">
                  {session.name}
                </h1>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="text-xs text-slate-500 dark:text-muted-foreground">
                    {profile.display_name}
                  </span>
                  {profile.vip_tag && profile.vip_theme && (
                    <VipTag tag={profile.vip_tag} theme={profile.vip_theme} />
                  )}
                  <SkillBadge level={profile.skill_level} />
                  {profile.pin && (
                    <button
                      onClick={() => setPinVisible((v) => !v)}
                      className="flex items-center gap-1 rounded-full bg-slate-100 dark:bg-muted px-3 py-2
                               min-h-[36px] text-[10px] font-mono text-slate-500 dark:text-muted-foreground
                               hover:bg-slate-200 dark:hover:bg-muted/80 transition-colors"
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
                <ThemeToggle
                  className="text-slate-500 hover:text-slate-900 hover:bg-slate-100
                                      dark:text-primary dark:hover:bg-primary/10"
                />
                <SignOutButton variant="icon" />
                {/* Status dot — aria-hidden since the sr-only span carries the label */}
                <div aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${dotColor}`} />
                <span className="sr-only">
                  Status:{" "}
                  {hasActiveMatch ? "Match active" : isInQueue ? "In queue" : "Not in queue"}
                </span>
                {/* Leave Session */}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <button
                      className="flex items-center gap-1 rounded-lg px-3 py-2.5 min-h-[44px] text-xs font-medium
                               text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors"
                      title="Leave this session"
                    >
                      <LogOut className="h-3.5 w-3.5" />
                      Leave
                    </button>
                  </AlertDialogTrigger>
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
                    {/* Secondary escape hatch — full sign-out for device handoff */}
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
            className="grid grid-cols-4 border-t border-slate-200 dark:border-border"
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
                                ? "text-slate-900 border-b-2 border-slate-900 dark:text-primary dark:border-primary"
                                : "text-slate-400 hover:text-slate-600 dark:text-muted-foreground dark:hover:text-foreground"
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
        {/* Shown once, 2.5 s after mount, if Notification.permission === 'default'. */}
        <NotificationEnrollment userId={profile.id} />

        {/* ── Content ─────────────────────────────────────────── */}
        <main className="flex-1 px-4 py-5 pb-8">
          {activeTab === "status" && (
            <div role="tabpanel" id="tabpanel-status" aria-labelledby="tab-status">
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
              />
            </div>
          )}

          {activeTab === "courts" && (
            <div role="tabpanel" id="tabpanel-courts" aria-labelledby="tab-courts">
              <LiveCourtsTab
                inProgressMatches={inProgressMatches}
                onDeckMatches={onDeckMatches}
                loading={sessionLoading}
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
        </main>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MyStatusTab — the original "Queue" + "History" combined view
// ─────────────────────────────────────────────────────────────

interface MyStatusTabProps {
  profile: Profile;
  session: Session;
  hasActiveMatch: boolean;
  currentMatch: ReturnType<typeof usePlayerMatch>["currentMatch"];
  isInQueue: boolean;
  myEntry: ReturnType<typeof useQueue>["myEntry"];
  myPosition: ReturnType<typeof useQueue>["myPosition"];
  myWaitMinutes: number;
  totalWaiting: number;
  queueLoading: boolean;
  matchLoading: boolean;
  joinQueue: () => Promise<{ error?: string }>;
  leaveQueue: () => Promise<{ error?: string }>;
}

type SubTab = "queue" | "history";

function MyStatusTab({
  profile,
  session,
  hasActiveMatch,
  currentMatch,
  isInQueue,
  myEntry,
  myPosition,
  myWaitMinutes,
  totalWaiting,
  queueLoading,
  matchLoading,
  joinQueue,
  leaveQueue,
}: MyStatusTabProps) {
  const [subTab, setSubTab] = useState<SubTab>("queue");

  // ── MODE 1: Active match — full takeover ────────────────────
  if (!matchLoading && hasActiveMatch && currentMatch) {
    return (
      <div className="space-y-5">
        <MatchAlert
          matchStatus={currentMatch.match.status as "pending" | "in_progress"}
          court={currentMatch.court}
          myDisplayName={profile.display_name}
          mySkillLevel={profile.skill_level}
          myVipTag={profile.vip_tag}
          myVipTheme={profile.vip_theme}
          teammates={currentMatch.teammates}
          opponents={currentMatch.opponents}
          isMixedLevel={currentMatch.match.is_mixed_level}
          onDeckPosition={currentMatch.onDeckPosition}
          totalOnDeck={currentMatch.totalOnDeck}
        />

        {/* Score input — only when the match is actually in progress */}
        {currentMatch.match.status === "in_progress" && (
          <ScoreInputCard matchId={currentMatch.match.id} myTeam={currentMatch.myTeam} />
        )}

        <div className="pt-1">
          <QueueToggle isInQueue={isInQueue} onJoin={joinQueue} onLeave={leaveQueue} />
        </div>
      </div>
    );
  }

  // ── Loading ─────────────────────────────────────────────────
  if (queueLoading || matchLoading) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="space-y-5">
      {/* Sub-tabs: Queue / History */}
      <div className="flex rounded-xl bg-slate-100 dark:bg-muted p-1">
        <button
          onClick={() => setSubTab("queue")}
          className={`flex-1 rounded-lg py-2 text-xs font-semibold transition-colors
                      ${
                        subTab === "queue"
                          ? "bg-white dark:bg-background text-slate-900 dark:text-foreground shadow-sm"
                          : "text-slate-500 dark:text-muted-foreground hover:text-slate-700 dark:hover:text-foreground"
                      }`}
        >
          Queue
        </button>
        <button
          onClick={() => setSubTab("history")}
          className={`flex-1 rounded-lg py-2 text-xs font-semibold transition-colors
                      ${
                        subTab === "history"
                          ? "bg-white dark:bg-background text-slate-900 dark:text-foreground shadow-sm"
                          : "text-slate-500 dark:text-muted-foreground hover:text-slate-700 dark:hover:text-foreground"
                      }`}
        >
          History
        </button>
      </div>

      {subTab === "queue" ? (
        <QueueSubTab
          isInQueue={isInQueue}
          myEntry={myEntry}
          myPosition={myPosition}
          myWaitMinutes={myWaitMinutes}
          totalWaiting={totalWaiting}
          joinQueue={joinQueue}
          leaveQueue={leaveQueue}
        />
      ) : (
        <MatchHistory sessionId={session.id} playerId={profile.id} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// QueueSubTab — position card + on-deck alert + toggle
// ─────────────────────────────────────────────────────────────

interface QueueSubTabProps {
  isInQueue: boolean;
  myEntry: ReturnType<typeof useQueue>["myEntry"];
  myPosition: ReturnType<typeof useQueue>["myPosition"];
  myWaitMinutes: number;
  totalWaiting: number;
  joinQueue: () => Promise<{ error?: string }>;
  leaveQueue: () => Promise<{ error?: string }>;
}

// ─────────────────────────────────────────────────────────────
// ScoreInputCard — lets any player in the match submit the score
// ─────────────────────────────────────────────────────────────

interface ScoreInputCardProps {
  matchId: string;
  myTeam: "a" | "b";
}

function ScoreInputCard({ matchId, myTeam }: ScoreInputCardProps) {
  const [teamAScore, setTeamAScore] = useState<string>("");
  const [teamBScore, setTeamBScore] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [isPending, startTransition] = useTransition();

  const myScoreLabel = myTeam === "a" ? "Your Team" : "Opponents";
  const theirScoreLabel = myTeam === "a" ? "Opponents" : "Your Team";
  const myScoreValue = myTeam === "a" ? teamAScore : teamBScore;
  const theirScoreValue = myTeam === "a" ? teamBScore : teamAScore;

  function handleMyScore(val: string) {
    if (myTeam === "a") setTeamAScore(val);
    else setTeamBScore(val);
  }
  function handleTheirScore(val: string) {
    if (myTeam === "a") setTeamBScore(val);
    else setTeamAScore(val);
  }

  function handleSubmit() {
    const a = parseInt(teamAScore, 10);
    const b = parseInt(teamBScore, 10);

    if (isNaN(a) || isNaN(b)) {
      setError("Enter scores for both teams.");
      return;
    }
    if (a < 0 || b < 0) {
      setError("Scores cannot be negative.");
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await submitMatchScore(matchId, a, b);
      if (!result.success) {
        setError(result.message);
      } else {
        setSubmitted(true);
        // Real-time will clear the match from this player's view.
      }
    });
  }

  if (submitted) {
    return (
      <div className="rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20 px-5 py-4 text-center">
        <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
          ✅ Score submitted! Returning you to queue…
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-border bg-white dark:bg-card shadow-sm overflow-hidden">
      {/* Header */}
      <div className="border-b border-slate-100 dark:border-border bg-slate-50 dark:bg-muted px-4 py-3">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-muted-foreground">
          📊 Submit Final Score
        </p>
      </div>

      <div className="px-4 py-4 space-y-4">
        {/* Score inputs */}
        <div className="flex items-center gap-3">
          {/* My team score */}
          <div className="flex-1 text-center space-y-1">
            <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
              {myScoreLabel}
            </p>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={99}
              value={myScoreValue}
              onChange={(e) => handleMyScore(e.target.value)}
              disabled={isPending}
              placeholder="0"
              className="w-full rounded-xl border border-slate-200 dark:border-border bg-white dark:bg-background px-3 py-3
                         text-center text-2xl font-black tabular-nums text-slate-900 dark:text-foreground
                         focus:outline-none focus:ring-2 focus:ring-emerald-400 dark:focus:ring-emerald-500
                         disabled:opacity-50"
            />
          </div>

          <span className="text-lg font-bold text-slate-300 dark:text-muted-foreground mt-5">
            –
          </span>

          {/* Their team score */}
          <div className="flex-1 text-center space-y-1">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-muted-foreground">
              {theirScoreLabel}
            </p>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={99}
              value={theirScoreValue}
              onChange={(e) => handleTheirScore(e.target.value)}
              disabled={isPending}
              placeholder="0"
              className="w-full rounded-xl border border-slate-200 dark:border-border bg-white dark:bg-background px-3 py-3
                         text-center text-2xl font-black tabular-nums text-slate-900 dark:text-foreground
                         focus:outline-none focus:ring-2 focus:ring-slate-400 dark:focus:ring-slate-500
                         disabled:opacity-50"
            />
          </div>
        </div>

        {/* Error */}
        {error && <p className="text-center text-xs text-red-600 dark:text-red-400">{error}</p>}

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={isPending || !teamAScore || !teamBScore}
          className="w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold
                     text-white hover:bg-slate-800 transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed
                     flex items-center justify-center gap-2"
        >
          {isPending ? (
            <>
              <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              Submitting…
            </>
          ) : (
            "Submit Final Score"
          )}
        </button>

        <p className="text-center text-[10px] text-muted-foreground">
          Any player in the match can submit. This ends the match for everyone.
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// QueueSubTab — position card + on-deck alert + toggle
// ─────────────────────────────────────────────────────────────

function QueueSubTab({
  isInQueue,
  myEntry,
  myPosition,
  myWaitMinutes,
  totalWaiting,
  joinQueue,
  leaveQueue,
}: QueueSubTabProps) {
  // ── Paused by organizer ─────────────────────────────────────
  // is_paused is set on the queue_entries row without changing
  // joined_at or games_played — queue position is fully preserved.
  if (isInQueue && myEntry?.is_paused) {
    return (
      <div className="space-y-5">
        <div
          className="rounded-2xl border-2 border-slate-300 dark:border-border
                        bg-slate-50 dark:bg-muted/50 p-6 text-center"
        >
          <div className="flex justify-center mb-3 text-3xl" aria-hidden="true">
            ⏸
          </div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-muted-foreground">
            Paused by Organizer
          </p>
          <p className="mt-1 text-lg font-bold text-slate-700 dark:text-foreground">
            You are taking a break
          </p>
          <p className="mt-2 text-sm text-slate-500 dark:text-muted-foreground">
            You will not be called for matches while paused. Your queue position is saved — the
            organizer will resume you when you&apos;re ready to play.
          </p>
        </div>
        <QueueToggle isInQueue onJoin={joinQueue} onLeave={leaveQueue} />
      </div>
    );
  }

  // ── Drafted — selected for an unpublished draft match ────────
  // Players are "drafted" from the moment the engine drafts them until
  // the organizer publishes. They have no visible match yet but should
  // not see "You're not in the queue". Show a neutral holding state.
  if (isInQueue && myEntry?.status === "drafted") {
    return (
      <div className="space-y-5">
        <div
          className="rounded-2xl border-2 border-slate-200 dark:border-border
                        bg-slate-50 dark:bg-muted/50 p-6 text-center"
        >
          <div className="flex justify-center mb-3 text-3xl" aria-hidden="true">
            🏸
          </div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-muted-foreground">
            Match Forming
          </p>
          <p className="mt-1 text-lg font-bold text-slate-700 dark:text-foreground">Hang tight…</p>
          <p className="mt-2 text-sm text-slate-500 dark:text-muted-foreground">
            You&apos;ve been selected for an upcoming match. The organizer will confirm it shortly —
            you&apos;ll get an alert the moment it&apos;s confirmed.
          </p>
        </div>
        <QueueToggle isInQueue onJoin={joinQueue} onLeave={leaveQueue} />
      </div>
    );
  }

  // ── Waiting in queue ────────────────────────────────────────
  if (isInQueue && myEntry?.status === "waiting") {
    return (
      <div className="space-y-5">
        <OnDeckAlert
          matchStatus={null}
          queueStatus="waiting"
          position={myPosition}
          court={null}
          teammates={[]}
          opponents={[]}
        />

        <QueueStatus
          position={myPosition}
          waitMinutes={myWaitMinutes}
          gamesPlayed={myEntry.games_played}
          totalInQueue={totalWaiting}
        />

        <QueueToggle isInQueue onJoin={joinQueue} onLeave={leaveQueue} />
      </div>
    );
  }

  // ── Not in queue ────────────────────────────────────────────
  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-dashed border-slate-200 dark:border-border bg-white dark:bg-card p-8 text-center">
        <p className="text-base font-semibold text-slate-700 dark:text-foreground">
          You&apos;re not in the queue
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          {totalWaiting > 0
            ? `${totalWaiting} player${totalWaiting !== 1 ? "s" : ""} currently waiting.`
            : "Be the first to join!"}
        </p>
        {myEntry && myEntry.games_played > 0 && (
          <p className="text-xs text-muted-foreground mt-3">
            {myEntry.games_played} game{myEntry.games_played !== 1 ? "s" : ""} played this session.
          </p>
        )}
      </div>

      <QueueToggle isInQueue={false} onJoin={joinQueue} onLeave={leaveQueue} />
    </div>
  );
}
