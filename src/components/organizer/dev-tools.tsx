"use client";

// ============================================================
// Dev Tools — Test Data Controls for Organizer Dashboard
// ============================================================
// A collapsible panel for seeding/clearing test data.
// Visually distinct with dashed red border + warning styling
// so it's obviously a developer-only feature.
// ============================================================

import { useState } from "react";
import {
  seedTestData,
  clearSessionData,
  type SeedResult,
  type ClearResult,
} from "@/app/actions/dev";

interface DevToolsProps {
  sessionId: string;
}

interface Toast {
  type: "success" | "error" | "warning";
  message: string;
}

export function DevTools({ sessionId }: DevToolsProps) {
  const [expanded, setExpanded] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [confirmNuke, setConfirmNuke] = useState(false);

  function showToast(t: Toast) {
    setToast(t);
    setTimeout(() => setToast(null), 4000);
  }

  async function handleSeed() {
    setSeeding(true);
    const result: SeedResult = await seedTestData(sessionId, 35);
    showToast({
      type: result.success ? "success" : "error",
      message: result.message,
    });
    setSeeding(false);
  }

  async function handleClear() {
    if (!confirmNuke) {
      setConfirmNuke(true);
      setTimeout(() => setConfirmNuke(false), 3000);
      return;
    }

    setClearing(true);
    setConfirmNuke(false);
    const result: ClearResult = await clearSessionData(sessionId);
    showToast({
      type: result.success ? "success" : "error",
      message: result.message,
    });
    setClearing(false);
  }

  return (
    <div className="relative">
      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-4 right-4 z-50 max-w-sm rounded-xl border-2 p-3 shadow-lg
                      animate-in slide-in-from-bottom-2 fade-in duration-300
                      ${
                        toast.type === "success"
                          ? "border-emerald-400 bg-emerald-50"
                          : toast.type === "warning"
                          ? "border-amber-400 bg-amber-50"
                          : "border-red-400 bg-red-50"
                      }`}
        >
          <div className="flex items-center gap-2">
            <span className="text-base">
              {toast.type === "success" ? "\u2705" : toast.type === "warning" ? "\u26A0\uFE0F" : "\u274C"}
            </span>
            <p className="text-sm font-medium">{toast.message}</p>
            <button
              onClick={() => setToast(null)}
              className="ml-auto text-muted-foreground hover:text-foreground"
            >
              &times;
            </button>
          </div>
        </div>
      )}

      {/* Toggle Button */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground
                   transition-colors px-2 py-1 rounded border border-dashed border-red-300
                   hover:border-red-400 hover:bg-red-50"
      >
        <span className="text-red-400">{"\u26A0"}</span>
        <span>Dev Tools</span>
        <span className="text-[10px]">{expanded ? "\u25B2" : "\u25BC"}</span>
      </button>

      {/* Expanded Panel */}
      {expanded && (
        <div className="absolute right-0 top-full mt-2 w-80 rounded-xl border-2 border-dashed border-red-300
                        bg-background shadow-xl z-30 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-200">
          {/* Header */}
          <div className="bg-red-50 border-b border-red-200 px-4 py-2.5">
            <p className="text-xs font-semibold text-red-800 uppercase tracking-wider">
              Developer Tools
            </p>
            <p className="text-[10px] text-red-600 mt-0.5">
              For testing only — do not use in production
            </p>
          </div>

          {/* Actions */}
          <div className="p-4 space-y-3">
            {/* Seed Players */}
            <div className="space-y-1.5">
              <button
                onClick={handleSeed}
                disabled={seeding}
                className="w-full rounded-lg border-2 border-dashed border-amber-400 bg-amber-50
                           px-4 py-2.5 text-sm font-medium text-amber-900 hover:bg-amber-100
                           disabled:opacity-50 disabled:cursor-not-allowed transition-colors
                           flex items-center justify-center gap-2"
              >
                {seeding ? (
                  <>
                    <span className="inline-block h-3.5 w-3.5 border-2 border-amber-600
                                     border-t-transparent rounded-full animate-spin" />
                    Seeding players...
                  </>
                ) : (
                  <>
                    <span>&#x1F9EA;</span>
                    Seed ~35 Test Players
                  </>
                )}
              </button>
              <p className="text-[10px] text-muted-foreground px-1">
                Creates dummy players with randomized skill levels, wait times (3-5 bottlenecks &gt; 20min),
                and game counts.
              </p>
            </div>

            {/* Divider */}
            <div className="border-t border-red-200" />

            {/* Clear Data */}
            <div className="space-y-1.5">
              <button
                onClick={handleClear}
                disabled={clearing}
                className={`w-full rounded-lg border-2 border-dashed px-4 py-2.5 text-sm font-medium
                           disabled:opacity-50 disabled:cursor-not-allowed transition-all
                           flex items-center justify-center gap-2
                           ${
                             confirmNuke
                               ? "border-red-500 bg-red-100 text-red-900 animate-pulse"
                               : "border-red-400 bg-red-50 text-red-800 hover:bg-red-100"
                           }`}
              >
                {clearing ? (
                  <>
                    <span className="inline-block h-3.5 w-3.5 border-2 border-red-600
                                     border-t-transparent rounded-full animate-spin" />
                    Clearing...
                  </>
                ) : confirmNuke ? (
                  <>
                    <span>&#x26A0;&#xFE0F;</span>
                    Click again to confirm
                  </>
                ) : (
                  <>
                    <span>&#x1F4A3;</span>
                    Nuke Session Data
                  </>
                )}
              </button>
              <p className="text-[10px] text-muted-foreground px-1">
                Deletes all matches, match players, and queue entries. Resets courts to Available.
                Keeps profiles and the session itself.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
