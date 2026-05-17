"use client";

// ============================================================
// MyStatusTab + QueueSubTab — player queue/history combined view
// ============================================================

import { useState } from "react";
import { PauseCircle } from "lucide-react";
import { QueueStatus } from "./queue-status";
import { OnDeckAlert } from "./on-deck-alert";
import { MatchHistory } from "./match-history";
import type { useQueue } from "@/hooks/use-queue";
import type { usePlayerMatch } from "@/hooks/use-player-match";
import type { Profile, Session } from "@/types/database";

// ─────────────────────────────────────────────────────────────
// MyStatusTab
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

export function MyStatusTab({
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

  // ── MODE 1: Active match ────────────────────────────────────
  // The parent PlayerDashboard renders MatchAlert as an absolute overlay
  // and injects ScoreInputCard via the `scoreSlot` prop when in_progress.
  // Leave Queue is a button inside the overlay too. Nothing to render
  // here — return null so the queue/history sub-tabs don't bleed through.
  if (!matchLoading && hasActiveMatch && currentMatch) {
    return null;
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
          skillLevel={profile.skill_level}
          sessionName={session.name}
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
  /** Used to render the skill abbreviation in the stats row. */
  skillLevel: Profile["skill_level"];
  /** Shown as eyebrow text in the "not in queue" empty state. */
  sessionName: string;
}

function QueueSubTab({
  isInQueue,
  myEntry,
  myPosition,
  myWaitMinutes,
  totalWaiting,
  joinQueue,
  leaveQueue,
  skillLevel,
  sessionName,
}: QueueSubTabProps) {
  // ── Paused by organizer ─────────────────────────────────────
  if (isInQueue && myEntry?.is_paused) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
        <div className="mb-5" aria-hidden="true">
          <PauseCircle className="h-12 w-12 text-muted-foreground/35 mx-auto" />
        </div>
        <p className="text-base font-semibold text-muted-foreground">On a break</p>
        <p className="mt-3 max-w-xs text-xs leading-relaxed text-muted-foreground/80">
          You won&apos;t be called for matches while paused. Your spot is saved — the organizer will
          resume you when you&apos;re ready.
        </p>
        <button
          onClick={() => leaveQueue()}
          className="mt-10 rounded-xl border border-border bg-transparent px-5 py-2 text-xs font-medium
                     text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
        >
          Leave Queue
        </button>
      </div>
    );
  }

  // ── Waiting in queue ────────────────────────────────────────
  if (isInQueue && myEntry?.status === "waiting") {
    const isApproaching = myPosition !== null && myPosition <= 2;
    return (
      <div className="flex flex-col items-center">
        {/* Approaching banner — only shows for positions 1–4 */}
        {myPosition !== null && myPosition <= 4 && (
          <div className="mb-2">
            <OnDeckAlert matchStatus={null} queueStatus="waiting" position={myPosition} />
          </div>
        )}

        <QueueStatus
          position={myPosition}
          waitMinutes={myWaitMinutes}
          gamesPlayed={myEntry.games_played}
          totalInQueue={totalWaiting}
          skillLevel={skillLevel}
          approaching={isApproaching}
        />

        <button
          onClick={() => leaveQueue()}
          className="mt-2 rounded-xl border border-border bg-transparent px-5 py-2 text-xs font-medium
                     text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
        >
          Leave Queue
        </button>
      </div>
    );
  }

  // ── Not in queue ────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground/70">
        {sessionName}
      </p>
      <h2
        className="mt-3 text-3xl font-extrabold leading-tight text-foreground"
        style={{ letterSpacing: "-0.02em" }}
      >
        Ready
        <br />
        to play?
      </h2>
      <p className="mt-3 text-sm text-muted-foreground">
        {totalWaiting > 0
          ? `${totalWaiting} player${totalWaiting !== 1 ? "s" : ""} currently waiting`
          : "Be the first to join!"}
      </p>
      <button
        onClick={() => joinQueue()}
        className="mt-10 rounded-2xl bg-primary px-12 py-4 text-base font-extrabold text-primary-foreground
                   transition-all hover:brightness-110 active:scale-[0.98]"
      >
        Join Queue
      </button>
      <p className="mt-4 text-[11px] text-muted-foreground/70">No commitment — leave anytime</p>
    </div>
  );
}
