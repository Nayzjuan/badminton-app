"use client";

// ============================================================
// Organizer Dashboard — Main shell with tab navigation
// ============================================================

import { useState } from "react";
import { useOrganizerData } from "@/hooks/use-organizer-data";
import { ActiveCourts } from "./active-courts";
import { OnDeckPanel } from "./on-deck-panel";
import { QueueControl } from "./queue-control";
import { WaitTimeMonitor } from "./wait-time-monitor";
import { DevTools } from "./dev-tools";
import type { Profile, Session } from "@/types/database";

interface OrganizerDashboardProps {
  profile: Profile;
  session: Session;
}

type Tab = "courts" | "queue" | "monitor";

export function OrganizerDashboard({ profile, session }: OrganizerDashboardProps) {
  const [activeTab, setActiveTab] = useState<Tab>("courts");

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

  const bottleneckCount = queue.filter((q) => q.is_bottleneck).length;

  const tabs: { key: Tab; label: string; badge?: number }[] = [
    { key: "courts", label: "Active Courts" },
    { key: "queue", label: "Queue & Match Control" },
    { key: "monitor", label: "Wait Time Monitor", badge: bottleneckCount > 0 ? bottleneckCount : undefined },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Loading organizer dashboard...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Top Header */}
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-foreground">{session.name}</h1>
              <p className="text-sm text-muted-foreground">
                Organizer: {profile.display_name}
              </p>
            </div>
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <span>{courts.length} court{courts.length !== 1 ? "s" : ""}</span>
              <span className="text-border">|</span>
              <span>{queue.length} in queue</span>
              <span className="text-border">|</span>
              <span>{activeMatches.length} active match{activeMatches.length !== 1 ? "es" : ""}</span>
              <span className="text-border">|</span>
              <DevTools sessionId={session.id} />
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="max-w-7xl mx-auto px-6">
          <nav className="flex gap-1 -mb-px">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`relative px-5 py-3 text-sm font-medium transition-colors rounded-t-lg
                            ${
                              activeTab === tab.key
                                ? "text-foreground bg-muted border-b-2 border-primary"
                                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
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
      </main>
    </div>
  );
}
