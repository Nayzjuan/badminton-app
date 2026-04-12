"use client";

// ============================================================
// Player Dashboard — Main orchestrator component
// ============================================================
// Three display modes (priority order):
//
//  1. MATCH ACTIVE  (on_deck / in_progress)
//     → Full-screen MatchAlert takeover. Standard queue UI hidden.
//       Player sees: status, court, teammate, opponents.
//
//  2. IN QUEUE (waiting)
//     → QueueStatus (position, wait, games played)
//     → OnDeckAlert approaching nudge (positions 1–4)
//     → Leave Queue button
//
//  3. NOT IN QUEUE
//     → "You're not in the queue" placeholder
//     → Join Queue button
// ============================================================

import { useState } from "react";
import { useQueue } from "@/hooks/use-queue";
import { usePlayerMatch } from "@/hooks/use-player-match";
import { MatchAlert } from "./match-alert";
import { QueueToggle } from "./queue-toggle";
import { QueueStatus } from "./queue-status";
import { OnDeckAlert } from "./on-deck-alert";
import { MatchHistory } from "./match-history";
import { SkillBadge } from "@/components/ui/skill-badge";
import type { Profile, Session } from "@/types/database";

interface PlayerDashboardProps {
  profile: Profile;
  session: Session;
}

type Tab = "queue" | "history";

export function PlayerDashboard({ profile, session }: PlayerDashboardProps) {
  const [activeTab, setActiveTab] = useState<Tab>("queue");

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

  // Player has an active match if they're on_deck or in_progress.
  const hasActiveMatch =
    currentMatch !== null &&
    (currentMatch.match.status === "pending" ||
      currentMatch.match.status === "in_progress");

  const isInQueue = myEntry !== null && myEntry.status !== "left";
  const totalWaiting = queue.filter((q) => q.status === "waiting").length;

  // Header indicator colour:
  //   green pulse  → in queue or in match
  //   amber pulse  → on deck
  //   grey         → not in queue
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
      <header className="sticky top-0 z-10 border-b border-border bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
        <div className="px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-bold text-slate-900 truncate">
                {session.name}
              </h1>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-xs text-slate-500">{profile.display_name}</span>
                <SkillBadge level={profile.skill_level} />
              </div>
            </div>
            <div
              className={`h-2.5 w-2.5 rounded-full ${dotColor}`}
              title={hasActiveMatch ? "Match active" : isInQueue ? "In queue" : "Not in queue"}
            />
          </div>
        </div>

        {/* Tab Bar */}
        <div className="flex border-t border-border">
          <button
            onClick={() => setActiveTab("queue")}
            className={`flex-1 py-2.5 text-sm font-medium text-center transition-colors
                        ${activeTab === "queue"
                          ? "text-slate-900 border-b-2 border-slate-900"
                          : "text-slate-500 hover:text-slate-700"}`}
          >
            Queue
          </button>
          <button
            onClick={() => setActiveTab("history")}
            className={`flex-1 py-2.5 text-sm font-medium text-center transition-colors
                        ${activeTab === "history"
                          ? "text-slate-900 border-b-2 border-slate-900"
                          : "text-slate-500 hover:text-slate-700"}`}
          >
            History
          </button>
        </div>
      </header>

      {/* ── Content ─────────────────────────────────────────── */}
      <main className="flex-1 px-4 py-5 pb-8">
        {activeTab === "queue" ? (
          <QueueTab
            profile={profile}
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
        ) : (
          <MatchHistory sessionId={session.id} playerId={profile.id} />
        )}
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// QueueTab — extracted to keep the parent readable
// ─────────────────────────────────────────────────────────────

interface QueueTabProps {
  profile: Profile;
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

function QueueTab({
  profile,
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
}: QueueTabProps) {
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

        {/* Still show Leave Queue below so they can exit if needed */}
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

  // ── MODE 2: Waiting in queue ────────────────────────────────
  if (isInQueue && myEntry?.status === "waiting") {
    return (
      <div className="space-y-5">
        {/* Approaching alert (positions 1–4) */}
        <OnDeckAlert
          matchStatus={null}
          queueStatus="waiting"
          position={myPosition}
          court={null}
          teammates={[]}
          opponents={[]}
        />

        {/* Position / wait / games board */}
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

  // ── MODE 3: Not in queue ────────────────────────────────────
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
            {myEntry.games_played} game{myEntry.games_played !== 1 ? "s" : ""} played this session.
          </p>
        )}
      </div>

      <QueueToggle isInQueue={false} onJoin={joinQueue} onLeave={leaveQueue} />
    </div>
  );
}
