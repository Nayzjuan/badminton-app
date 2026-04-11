"use client";

// ============================================================
// Player Dashboard — Main orchestrator component
// ============================================================
// Composes: QueueToggle, QueueStatus, OnDeckAlert, MatchHistory
// All wired to real-time hooks.
// ============================================================

import { useState } from "react";
import { useQueue } from "@/hooks/use-queue";
import { usePlayerMatch } from "@/hooks/use-player-match";
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

  const isInQueue =
    myEntry !== null && myEntry.status !== "left";

  const totalWaiting = queue.filter((q) => q.status === "waiting").length;

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-bold text-foreground truncate">
                {session.name}
              </h1>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-xs text-muted-foreground">{profile.display_name}</span>
                <SkillBadge level={profile.skill_level} />
              </div>
            </div>
            <div
              className={`h-2.5 w-2.5 rounded-full ${
                isInQueue ? "bg-emerald-500 animate-pulse" : "bg-muted"
              }`}
              title={isInQueue ? "In queue" : "Not in queue"}
            />
          </div>
        </div>

        {/* Tab Bar */}
        <div className="flex border-t border-border">
          <button
            onClick={() => setActiveTab("queue")}
            className={`flex-1 py-2.5 text-sm font-medium text-center transition-colors
                        ${
                          activeTab === "queue"
                            ? "text-foreground border-b-2 border-primary"
                            : "text-muted-foreground"
                        }`}
          >
            Queue
          </button>
          <button
            onClick={() => setActiveTab("history")}
            className={`flex-1 py-2.5 text-sm font-medium text-center transition-colors
                        ${
                          activeTab === "history"
                            ? "text-foreground border-b-2 border-primary"
                            : "text-muted-foreground"
                        }`}
          >
            History
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 px-4 py-5 space-y-5 pb-8">
        {activeTab === "queue" ? (
          <>
            {/* On-Deck Alert (shows above everything when active) */}
            {!queueLoading && !matchLoading && (
              <OnDeckAlert
                matchStatus={currentMatch?.match.status ?? null}
                queueStatus={myEntry?.status ?? null}
                position={myPosition}
                court={currentMatch?.court ?? null}
                teammates={currentMatch?.teammates ?? []}
                opponents={currentMatch?.opponents ?? []}
              />
            )}

            {/* Queue Status Board */}
            {isInQueue && (
              <QueueStatus
                position={myPosition}
                waitMinutes={myWaitMinutes}
                gamesPlayed={myEntry?.games_played ?? 0}
                totalInQueue={totalWaiting}
              />
            )}

            {/* Not in queue — show invitation */}
            {!isInQueue && !queueLoading && (
              <div className="rounded-xl border border-dashed border-border p-6 text-center">
                <p className="text-muted-foreground text-sm">
                  You&apos;re not in the queue.
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {totalWaiting > 0
                    ? `${totalWaiting} player${totalWaiting !== 1 ? "s" : ""} currently waiting.`
                    : "Be the first to join!"}
                </p>
              </div>
            )}

            {/* Loading State */}
            {queueLoading && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Loading queue...
              </div>
            )}

            {/* Queue Toggle (always visible, anchored to bottom area) */}
            <div className="pt-2">
              <QueueToggle
                isInQueue={isInQueue}
                onJoin={joinQueue}
                onLeave={leaveQueue}
              />
            </div>

            {/* Mini games count when not in queue */}
            {!isInQueue && myEntry && myEntry.games_played > 0 && (
              <p className="text-center text-xs text-muted-foreground">
                You&apos;ve played {myEntry.games_played} game
                {myEntry.games_played !== 1 ? "s" : ""} this session.
              </p>
            )}
          </>
        ) : (
          /* History Tab */
          <MatchHistory sessionId={session.id} playerId={profile.id} />
        )}
      </main>
    </div>
  );
}
