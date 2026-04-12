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

import { useState } from "react";
import { User, LayoutGrid, ListOrdered } from "lucide-react";
import { useQueue } from "@/hooks/use-queue";
import { usePlayerMatch } from "@/hooks/use-player-match";
import { useSessionData } from "@/hooks/use-session-data";
import { MatchAlert } from "./match-alert";
import { QueueToggle } from "./queue-toggle";
import { QueueStatus } from "./queue-status";
import { OnDeckAlert } from "./on-deck-alert";
import { MatchHistory } from "./match-history";
import { LiveCourtsTab } from "./live-courts-tab";
import { WaitlistTab } from "./waitlist-tab";
import { SkillBadge } from "@/components/ui/skill-badge";
import type { Profile, Session } from "@/types/database";

interface PlayerDashboardProps {
  profile: Profile;
  session: Session;
}

type Tab = "status" | "courts" | "waitlist";

const TABS: { key: Tab; label: string; icon: typeof User }[] = [
  { key: "status", label: "My Status", icon: User },
  { key: "courts", label: "Live Courts", icon: LayoutGrid },
  { key: "waitlist", label: "Waitlist", icon: ListOrdered },
];

export function PlayerDashboard({ profile, session }: PlayerDashboardProps) {
  const [activeTab, setActiveTab] = useState<Tab>("status");

  const {
    queue,
    myEntry,
    myPosition,
    myWaitMinutes,
    loading: queueLoading,
    joinQueue,
    leaveQueue,
  } = useQueue(session.id, profile.id);

  const { currentMatch, loading: matchLoading } = usePlayerMatch(
    session.id,
    profile.id
  );

  const {
    inProgressMatches,
    onDeckMatches,
    waitlist,
    loading: sessionLoading,
  } = useSessionData(session.id);

  // Player has an active match if they're on_deck or in_progress.
  const hasActiveMatch =
    currentMatch !== null &&
    (currentMatch.match.status === "pending" ||
      currentMatch.match.status === "in_progress");

  const isInQueue = myEntry !== null && myEntry.status !== "left";
  const totalWaiting = queue.filter((q) => q.status === "waiting").length;

  // Header dot colour.
  const dotColor = hasActiveMatch
    ? currentMatch?.match.status === "in_progress"
      ? "bg-emerald-500 animate-pulse"
      : "bg-amber-400 animate-pulse"
    : isInQueue
    ? "bg-emerald-500 animate-pulse"
    : "bg-slate-300";

  return (
    <div className="flex flex-col min-h-screen bg-slate-50">
      {/* ── Header ──────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
        <div className="px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-bold text-slate-900 truncate">
                {session.name}
              </h1>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-xs text-slate-500">
                  {profile.display_name}
                </span>
                <SkillBadge level={profile.skill_level} />
              </div>
            </div>
            <div
              className={`h-2.5 w-2.5 rounded-full ${dotColor}`}
              title={
                hasActiveMatch
                  ? "Match active"
                  : isInQueue
                  ? "In queue"
                  : "Not in queue"
              }
            />
          </div>
        </div>

        {/* ── Tab Bar — 3 tabs, mobile-stretch ────────────── */}
        <div className="grid grid-cols-3 border-t border-slate-200">
          {TABS.map(({ key, label, icon: Icon }) => {
            const isActive = activeTab === key;
            return (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold
                            transition-colors
                            ${
                              isActive
                                ? "text-slate-900 border-b-2 border-slate-900"
                                : "text-slate-400 hover:text-slate-600"
                            }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            );
          })}
        </div>
      </header>

      {/* ── Content ─────────────────────────────────────────── */}
      <main className="flex-1 px-4 py-5 pb-8">
        {activeTab === "status" && (
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
        )}

        {activeTab === "courts" && (
          <LiveCourtsTab
            inProgressMatches={inProgressMatches}
            onDeckMatches={onDeckMatches}
            loading={sessionLoading}
          />
        )}

        {activeTab === "waitlist" && (
          <WaitlistTab
            waitlist={waitlist}
            myPlayerId={profile.id}
            loading={sessionLoading}
          />
        )}
      </main>
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
          teammates={currentMatch.teammates}
          opponents={currentMatch.opponents}
          isMixedLevel={currentMatch.match.is_mixed_level}
        />

        <div className="pt-1">
          <QueueToggle
            isInQueue={isInQueue}
            onJoin={joinQueue}
            onLeave={leaveQueue}
          />
        </div>
      </div>
    );
  }

  // ── Loading ─────────────────────────────────────────────────
  if (queueLoading || matchLoading) {
    return (
      <div className="py-16 text-center text-sm text-slate-400">
        Loading...
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Sub-tabs: Queue / History */}
      <div className="flex rounded-xl bg-slate-100 p-1">
        <button
          onClick={() => setSubTab("queue")}
          className={`flex-1 rounded-lg py-2 text-xs font-semibold transition-colors
                      ${
                        subTab === "queue"
                          ? "bg-white text-slate-900 shadow-sm"
                          : "text-slate-500 hover:text-slate-700"
                      }`}
        >
          Queue
        </button>
        <button
          onClick={() => setSubTab("history")}
          className={`flex-1 rounded-lg py-2 text-xs font-semibold transition-colors
                      ${
                        subTab === "history"
                          ? "bg-white text-slate-900 shadow-sm"
                          : "text-slate-500 hover:text-slate-700"
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

function QueueSubTab({
  isInQueue,
  myEntry,
  myPosition,
  myWaitMinutes,
  totalWaiting,
  joinQueue,
  leaveQueue,
}: QueueSubTabProps) {
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
      <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center">
        <p className="text-base font-semibold text-slate-700">
          You&apos;re not in the queue
        </p>
        <p className="text-sm text-slate-400 mt-1">
          {totalWaiting > 0
            ? `${totalWaiting} player${totalWaiting !== 1 ? "s" : ""} currently waiting.`
            : "Be the first to join!"}
        </p>
        {myEntry && myEntry.games_played > 0 && (
          <p className="text-xs text-slate-400 mt-3">
            {myEntry.games_played} game{myEntry.games_played !== 1 ? "s" : ""}{" "}
            played this session.
          </p>
        )}
      </div>

      <QueueToggle isInQueue={false} onJoin={joinQueue} onLeave={leaveQueue} />
    </div>
  );
}
