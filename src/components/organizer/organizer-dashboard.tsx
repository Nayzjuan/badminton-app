"use client";

// ============================================================
// Organizer Dashboard — Main shell with tab navigation
// ============================================================

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useOrganizerData } from "@/hooks/use-organizer-data";
import { ActiveCourts } from "./active-courts";
import { OnDeckPanel } from "./on-deck-panel";
import { QueueControl } from "./queue-control";
import { WaitTimeMonitor } from "./wait-time-monitor";
import { MatchHistoryPanel } from "./match-history-panel";
import { DevTools } from "./dev-tools";
import { ShareSessionDialog } from "./share-session-dialog";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { closeSession } from "@/app/actions/sessions";
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
import { ChevronDown, ArrowLeft, Repeat, Power, Tv2 } from "lucide-react";
import type { Profile, Session } from "@/types/database";

interface OrganizerDashboardProps {
  profile: Profile;
  session: Session;
  otherSessions?: Session[];
}

type Tab = "courts" | "queue" | "monitor" | "history";

export function OrganizerDashboard({ profile, session, otherSessions = [] }: OrganizerDashboardProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>(session.is_active ? "courts" : "history");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);

  async function handleCloseSession() {
    setClosing(true);
    const result = await closeSession(session.id);
    if (result.success) {
      router.push("/organizer");
    } else {
      setClosing(false);
      alert(result.message);
    }
  }

  // Close switcher on outside click.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setSwitcherOpen(false);
      }
    }
    if (switcherOpen) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [switcherOpen]);

  const {
    courts,
    queue,
    activeMatches,
    onDeckMatches,
    loading,
    addCourt,
    updateCourtStatus,
    removeCourt,
    callNextMatch,
    generateOnDeckMatches,
    createManualMatch,
    endMatch,
    cancelMatch,
    removeFromQueue,
  } = useOrganizerData(session.id);

  const isClosed = !session.is_active;
  const bottleneckCount = queue.filter((q) => q.is_bottleneck).length;

  const tabs: { key: Tab; label: string; badge?: number }[] = isClosed
    ? [{ key: "history", label: "Match History" }]
    : [
        { key: "courts", label: "Active Courts" },
        { key: "queue", label: "Queue & Match Control" },
        { key: "monitor", label: "Wait Time Monitor", badge: bottleneckCount > 0 ? bottleneckCount : undefined },
        { key: "history", label: "Match History" },
      ];

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Loading organizer dashboard...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FAFAF7] dark:bg-background">
      {/* Top Header */}
      <header className="sticky top-0 z-20 bg-[#1D3A6F] shadow-lg
                         dark:bg-[hsl(268_60%_14%)] dark:shadow-[0_4px_24px_hsl(180_100%_50%/0.18)]
                         dark:border-b dark:border-[hsl(180_100%_50%/0.25)]">
        <div className="max-w-7xl mx-auto px-6 py-4">
          {/* Back link */}
          <div className="mb-2">
            <button
              onClick={() => router.push("/organizer")}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-white/60
                         hover:text-white hover:bg-white/10 transition-colors -ml-1 px-1 py-0.5 rounded"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              All Sessions
            </button>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              {/* Session name + switcher */}
              <div className="relative min-w-0" ref={switcherRef}>
                <button
                  onClick={() => otherSessions.length > 0 && setSwitcherOpen(!switcherOpen)}
                  className={`flex items-center gap-2 min-w-0 rounded-lg px-2 py-1 -mx-2 -my-1
                              transition-colors
                              ${otherSessions.length > 0
                                ? "hover:bg-white/10 cursor-pointer"
                                : "cursor-default"}`}
                >
                  <h1 className="text-xl font-bold text-white truncate">{session.name}</h1>
                  {otherSessions.length > 0 && (
                    <ChevronDown className={`h-4 w-4 text-white/60 shrink-0 transition-transform
                                             ${switcherOpen ? "rotate-180" : ""}`} />
                  )}
                </button>

                {/* Dropdown */}
                {switcherOpen && otherSessions.length > 0 && (
                  <div className="absolute left-0 top-full mt-2 w-72 rounded-xl border border-slate-200
                                  bg-white shadow-xl z-50 overflow-hidden
                                  animate-in fade-in slide-in-from-top-1 duration-150">
                    <div className="px-3 py-2 bg-slate-50 border-b border-slate-100">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                        Switch Session
                      </p>
                    </div>
                    <div className="max-h-60 overflow-y-auto py-1">
                      {otherSessions.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => {
                            setSwitcherOpen(false);
                            router.push(`/organizer/${s.id}`);
                          }}
                          className="flex items-center gap-3 w-full px-3 py-2.5 text-left
                                     hover:bg-slate-50 transition-colors"
                        >
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg
                                          bg-slate-100">
                            <Repeat className="h-3.5 w-3.5 text-slate-500" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-slate-800 truncate">{s.name}</p>
                            <p className="text-[10px] text-slate-400">
                              Created {new Date(s.created_at).toLocaleDateString("en-US", {
                                weekday: "short", month: "short", day: "numeric",
                              })}
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                    <div className="border-t border-slate-100 px-3 py-2">
                      <button
                        onClick={() => {
                          setSwitcherOpen(false);
                          router.push("/organizer");
                        }}
                        className="flex items-center gap-2 w-full text-xs font-medium text-blue-600
                                   hover:text-blue-800 transition-colors py-1"
                      >
                        <ArrowLeft className="h-3 w-3" />
                        View all sessions & create new
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <p className="text-sm text-white/60 hidden sm:block">
                — {profile.display_name}
              </p>

              {/* Closed badge inline with title */}
              {isClosed && (
                <span className="inline-flex items-center gap-1 rounded-full bg-white/15
                                 border border-white/30 px-2.5 py-0.5 text-[10px]
                                 font-bold uppercase tracking-wider text-white/80">
                  Closed
                </span>
              )}
            </div>

            {!isClosed && (
              <div className="flex items-center gap-4 text-sm text-white/70">
                <span className="hidden sm:inline">{courts.length} court{courts.length !== 1 ? "s" : ""}</span>
                <span className="text-white/25 hidden sm:inline">|</span>
                <span className="hidden sm:inline">{queue.length} in queue</span>
                <span className="text-white/25 hidden sm:inline">|</span>
                <span className="hidden sm:inline">{activeMatches.length} active match{activeMatches.length !== 1 ? "es" : ""}</span>
                <span className="text-white/25 hidden sm:inline">|</span>
                <ThemeToggle className="text-white/60 hover:text-white hover:bg-white/10
                                        dark:text-primary dark:hover:bg-primary/10" />
                <DevTools sessionId={session.id} />

                {/* TV Scoreboard link */}
                <a
                  href={`/tv/${session.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/30
                             bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/80
                             hover:bg-white/20 hover:text-white hover:border-white/50
                             transition-colors"
                  title="Open TV scoreboard in a new tab"
                >
                  <Tv2 className="h-3.5 w-3.5" />
                  TV View
                </a>

                {/* Share Session */}
                <ShareSessionDialog sessionId={session.id} sessionName={session.name} />

                {/* Close Session */}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <button
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-300/50
                                 bg-white/10 px-3 py-1.5 text-xs font-semibold text-red-300
                                 hover:bg-red-500/20 hover:border-red-300 transition-colors"
                    >
                      <Power className="h-3.5 w-3.5" />
                      Close Session
                    </button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Close &ldquo;{session.name}&rdquo;?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will permanently end the session. All remaining players will be
                        removed from the queue, any in-progress or on-deck matches will be
                        cancelled, and courts will be closed. Completed match history will
                        be preserved.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={handleCloseSession} disabled={closing}>
                        {closing ? "Closing..." : "Yes, close session"}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="max-w-7xl mx-auto px-6">
          <nav className="flex gap-1 pt-2">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`relative px-5 py-2.5 text-sm font-medium transition-colors rounded-t-lg
                            ${
                              activeTab === tab.key
                                ? "bg-[#FAFAF7] text-[#1D3A6F] font-semibold shadow-sm dark:bg-muted dark:text-primary dark:shadow-none"
                                : "text-white/70 hover:text-white hover:bg-white/10 dark:hover:bg-white/5"
                            }`}
              >
                {tab.label}
                {tab.badge !== undefined && (
                  <span className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-red-500 text-white
                                   text-xs flex items-center justify-center font-bold animate-pulse">
                    {tab.badge}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-7xl mx-auto px-6 py-6">
        {activeTab === "courts" && (
          <div className="space-y-6">
            {/* On-deck panel — always visible, collapses to empty state when no matches */}
            <OnDeckPanel
              matches={onDeckMatches}
              onGenerate={generateOnDeckMatches}
            />

            <ActiveCourts
              courts={courts}
              activeMatches={activeMatches}
              onAddCourt={addCourt}
              onUpdateCourtStatus={updateCourtStatus}
              onRemoveCourt={removeCourt}
              onCallNextMatch={callNextMatch}
              onEndMatch={endMatch}
              onCancelMatch={cancelMatch}
            />
          </div>
        )}

        {activeTab === "queue" && (
          <QueueControl
            queue={queue}
            courts={courts}
            onCreateManualMatch={createManualMatch}
            onRemoveFromQueue={removeFromQueue}
          />
        )}

        {activeTab === "monitor" && (
          <WaitTimeMonitor
            queue={queue}
            onRemoveFromQueue={removeFromQueue}
          />
        )}

        {activeTab === "history" && (
          <MatchHistoryPanel sessionId={session.id} />
        )}
      </main>
    </div>
  );
}
