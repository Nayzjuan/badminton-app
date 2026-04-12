"use client";

// ============================================================
// Organizer Entry — Dashboard hub
// ============================================================
// Section A: Your Active Sessions (prioritized, clickable cards)
// Section B: Start a New Session (create form)
// Section C: Join as Co-Organizer (passcode entry)
// ============================================================

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  ChevronRight,
  Users,
  LayoutGrid,
  Plus,
  KeyRound,
  Clock,
  Zap,
} from "lucide-react";
import { createClient } from "@/utils/supabase/client";
import type { Profile, ScoringFormat } from "@/types/database";
import type { SessionWithStats } from "@/app/organizer/page";

interface OrganizerEntryProps {
  profile: Profile;
  organizedSessions: SessionWithStats[];
}

// ── Helpers ──────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function scoringLabel(s: ScoringFormat): string {
  if (s === "single") return "Single Game";
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Component ────────────────────────────────────────────────

export function OrganizerEntry({
  profile,
  organizedSessions,
}: OrganizerEntryProps) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  // Create session state
  const [sessionName, setSessionName] = useState("");
  const [scoring, setScoring] = useState<ScoringFormat>("single");
  const [passcode, setPasscode] = useState("");
  const [creating, setCreating] = useState(false);

  // Join via passcode state
  const [joinSessionId, setJoinSessionId] = useState("");
  const [joinPasscode, setJoinPasscode] = useState("");
  const [joining, setJoining] = useState(false);

  const [error, setError] = useState<string | null>(null);

  async function handleCreateSession() {
    if (!sessionName.trim()) return;
    setCreating(true);
    setError(null);

    const { data: session, error: err } = await supabase
      .from("sessions")
      .insert({
        name: sessionName.trim(),
        created_by: profile.id,
        scoring,
        organizer_passcode: passcode || null,
      })
      .select()
      .single();

    if (err) {
      setError(err.message);
      setCreating(false);
      return;
    }

    router.push(`/organizer/${session.id}`);
  }

  async function handleJoinAsOrganizer() {
    if (!joinSessionId.trim() || !joinPasscode.trim()) return;
    setJoining(true);
    setError(null);

    const { data: result, error: err } = await supabase.rpc(
      "elevate_to_organizer",
      {
        p_session_id: joinSessionId.trim(),
        p_passcode: joinPasscode.trim(),
      }
    );

    if (err) {
      setError(err.message);
      setJoining(false);
      return;
    }

    if (!result) {
      setError("Invalid passcode. Please check and try again.");
      setJoining(false);
      return;
    }

    router.push(`/organizer/${joinSessionId.trim()}`);
  }

  const hasSessions = organizedSessions.length > 0;

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8 space-y-8">
        {/* ── Header ───────────────────────────────────────────── */}
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-slate-900 shadow-md">
            <span className="text-xl">&#127992;</span>
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
              Organizer Dashboard
            </h1>
            <p className="text-sm text-slate-500">
              Welcome back, {profile.display_name}
            </p>
          </div>
        </div>

        {/* ── Global error ─────────────────────────────────────── */}
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════
            Section A: Your Active Sessions
        ═══════════════════════════════════════════════════════ */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-emerald-500" />
            <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500">
              Your Active Sessions
            </h2>
          </div>

          {hasSessions ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {organizedSessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => router.push(`/organizer/${s.id}`)}
                  className="group relative flex flex-col rounded-2xl border border-slate-200
                             bg-white p-5 text-left shadow-sm
                             transition-all duration-200
                             hover:border-blue-200 hover:shadow-lg hover:-translate-y-0.5
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {/* Card header */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-bold text-slate-900 truncate">
                        {s.name}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        {formatDate(s.created_at)} &middot; {formatTime(s.created_at)}
                      </p>
                    </div>
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full
                                    bg-slate-100 text-slate-400
                                    transition-colors group-hover:bg-blue-50 group-hover:text-blue-600">
                      <ChevronRight className="h-4 w-4" />
                    </div>
                  </div>

                  {/* Stats row */}
                  <div className="mt-4 flex items-center gap-4">
                    <div className="flex items-center gap-1.5 text-xs text-slate-500">
                      <Users className="h-3.5 w-3.5" />
                      <span className="font-semibold text-slate-700">{s.playerCount}</span>
                      <span>player{s.playerCount !== 1 ? "s" : ""}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-slate-500">
                      <LayoutGrid className="h-3.5 w-3.5" />
                      <span className="font-semibold text-slate-700">{s.courtCount}</span>
                      <span>court{s.courtCount !== 1 ? "s" : ""}</span>
                    </div>
                  </div>

                  {/* Footer tags */}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50
                                     border border-emerald-200 px-2 py-0.5 text-[10px]
                                     font-bold uppercase tracking-wider text-emerald-700">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      Active
                    </span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px]
                                     font-semibold text-slate-500">
                      {scoringLabel(s.scoring)}
                    </span>
                    {s.organizer_passcode && (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px]
                                       font-semibold text-slate-500">
                        Passcode set
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-white/60 px-6 py-10 text-center">
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100">
                <Clock className="h-5 w-5 text-slate-400" />
              </div>
              <p className="text-sm font-medium text-slate-600">No active sessions</p>
              <p className="mt-1 text-xs text-slate-400">
                Create a new session below to get started.
              </p>
            </div>
          )}
        </section>

        {/* ═══════════════════════════════════════════════════════
            Section B: Start a New Session
        ═══════════════════════════════════════════════════════ */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-blue-500" />
            <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500">
              Start a New Session
            </h2>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
            {/* Session name */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-700">
                Session Name
              </label>
              <input
                type="text"
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                placeholder="e.g. Saturday Open Play"
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm
                           text-slate-900 placeholder:text-slate-400
                           focus:outline-none focus:ring-2 focus:ring-ring shadow-sm"
              />
            </div>

            {/* Two columns */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-700">
                  Scoring Format
                </label>
                <select
                  value={scoring}
                  onChange={(e) => setScoring(e.target.value as ScoringFormat)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm
                             text-slate-900
                             focus:outline-none focus:ring-2 focus:ring-ring shadow-sm"
                >
                  <option value="single">Single Game</option>
                  <option value="best_of_3">Best of 3</option>
                  <option value="best_of_5">Best of 5</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-700">
                  Organizer Passcode
                </label>
                <input
                  type="text"
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  placeholder="Optional — for co-organizers"
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm
                             text-slate-900 placeholder:text-slate-400
                             focus:outline-none focus:ring-2 focus:ring-ring shadow-sm"
                />
              </div>
            </div>

            <button
              onClick={handleCreateSession}
              disabled={creating || !sessionName.trim()}
              className="w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold
                         text-white shadow-sm
                         hover:bg-slate-800 transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? "Creating…" : "Create Session"}
            </button>
          </div>
        </section>

        {/* ═══════════════════════════════════════════════════════
            Section C: Join as Co-Organizer
        ═══════════════════════════════════════════════════════ */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-violet-500" />
            <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500">
              Join as Co-Organizer
            </h2>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-700">
                Session ID
              </label>
              <input
                type="text"
                value={joinSessionId}
                onChange={(e) => setJoinSessionId(e.target.value)}
                placeholder="Paste the session ID from the organizer"
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm
                           text-slate-900 placeholder:text-slate-400
                           focus:outline-none focus:ring-2 focus:ring-ring shadow-sm"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-700">
                Passcode
              </label>
              <input
                type="text"
                value={joinPasscode}
                onChange={(e) => setJoinPasscode(e.target.value)}
                placeholder="Enter the organizer passcode"
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm
                           text-slate-900 placeholder:text-slate-400
                           focus:outline-none focus:ring-2 focus:ring-ring shadow-sm"
              />
            </div>
            <button
              onClick={handleJoinAsOrganizer}
              disabled={joining || !joinSessionId.trim() || !joinPasscode.trim()}
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm
                         font-semibold text-slate-700 shadow-sm
                         hover:bg-slate-50 transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {joining ? "Joining…" : "Join Session"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
