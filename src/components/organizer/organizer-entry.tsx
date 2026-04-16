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
  Archive,
  Trophy,
  ChevronDown,
  Hash,
} from "lucide-react";
import { createClient } from "@/utils/supabase/client";
import { joinAsCoOrganizer, toSessionCode } from "@/app/actions/sessions";
import type { Profile, ScoringFormat } from "@/types/database";
import type { SessionWithStats } from "@/app/organizer/page";

interface OrganizerEntryProps {
  profile: Profile;
  activeSessions: SessionWithStats[];
  pastSessions: SessionWithStats[];
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
  activeSessions,
  pastSessions,
}: OrganizerEntryProps) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  // Create session state
  const [sessionName, setSessionName] = useState("");
  const [scoring, setScoring] = useState<ScoringFormat>("single");
  const [passcode, setPasscode] = useState("");
  const [creating, setCreating] = useState(false);

  // Join via session code state
  const [joinCode, setJoinCode] = useState("");
  const [joinPasscode, setJoinPasscode] = useState("");
  const [joining, setJoining] = useState(false);

  // Past sessions accordion
  const [pastExpanded, setPastExpanded] = useState(false);

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
    if (!joinCode.trim() || !joinPasscode.trim()) return;
    setJoining(true);
    setError(null);

    const result = await joinAsCoOrganizer(joinCode.trim(), joinPasscode.trim());

    if (!result.success) {
      setError(result.message);
      setJoining(false);
      return;
    }

    router.push(`/organizer/${result.sessionId}`);
  }

  const hasSessions = activeSessions.length > 0;

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
              {activeSessions.map((s) => (
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

                    {/* Session Code — primary organizer reads this to co-organizers */}
                    {s.organizer_passcode && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full
                                   bg-violet-50 border border-violet-200
                                   px-2 py-0.5 text-[10px] font-bold tracking-widest
                                   text-violet-700 font-mono"
                        title="Share this code with your co-organizer"
                      >
                        <Hash className="h-2.5 w-2.5" />
                        {toSessionCode(s.id)}
                      </span>
                    )}

                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px]
                                     font-semibold text-slate-500">
                      {scoringLabel(s.scoring)}
                    </span>
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
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-700">
                  Session Code
                </label>
                <input
                  type="text"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-F0-9]/g, "").slice(0, 6))}
                  placeholder="e.g. ABC123"
                  maxLength={6}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5
                             text-sm font-mono tracking-widest uppercase text-slate-900
                             placeholder:text-slate-400 placeholder:font-sans placeholder:tracking-normal
                             focus:outline-none focus:ring-2 focus:ring-ring shadow-sm"
                />
                <p className="text-[10px] text-slate-400">
                  6-character code from the primary organizer
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-700">
                  Passcode
                </label>
                <input
                  type="text"
                  value={joinPasscode}
                  onChange={(e) => setJoinPasscode(e.target.value)}
                  placeholder="Organizer passcode"
                  autoComplete="off"
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm
                             text-slate-900 placeholder:text-slate-400
                             focus:outline-none focus:ring-2 focus:ring-ring shadow-sm"
                />
              </div>
            </div>
            <button
              onClick={handleJoinAsOrganizer}
              disabled={joining || joinCode.trim().length !== 6 || !joinPasscode.trim()}
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm
                         font-semibold text-slate-700 shadow-sm
                         hover:bg-slate-50 transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {joining ? "Joining…" : "Join Session"}
            </button>
          </div>
        </section>

        {/* ═══════════════════════════════════════════════════════
            Section D: Past Sessions
        ═══════════════════════════════════════════════════════ */}
        {pastSessions.length > 0 && (
          <section className="space-y-3">
            <button
              onClick={() => setPastExpanded(!pastExpanded)}
              className="flex items-center gap-2 group"
            >
              <Archive className="h-4 w-4 text-slate-400" />
              <h2 className="text-xs font-bold uppercase tracking-widest text-slate-400
                             group-hover:text-slate-500 transition-colors">
                Past Sessions ({pastSessions.length})
              </h2>
              <ChevronDown
                className={`h-3.5 w-3.5 text-slate-400 transition-transform
                            ${pastExpanded ? "rotate-180" : ""}`}
              />
            </button>

            {pastExpanded && (
              <div className="space-y-2">
                {pastSessions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => router.push(`/organizer/${s.id}`)}
                    className="group flex items-center gap-4 w-full rounded-xl border border-slate-100
                               bg-slate-50/80 px-4 py-3 text-left
                               transition-all duration-150
                               hover:bg-white hover:border-slate-200 hover:shadow-sm"
                  >
                    {/* Icon */}
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg
                                    bg-slate-100 text-slate-400 group-hover:bg-slate-200
                                    transition-colors">
                      <Archive className="h-4 w-4" />
                    </div>

                    {/* Info */}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-slate-600 truncate
                                    group-hover:text-slate-800 transition-colors">
                        {s.name}
                      </p>
                      <p className="text-[11px] text-slate-400">
                        {formatDate(s.created_at)}
                        {s.ended_at && (
                          <> &middot; Ended {formatDate(s.ended_at)} at {formatTime(s.ended_at)}</>
                        )}
                      </p>
                    </div>

                    {/* Stats */}
                    <div className="flex items-center gap-3 shrink-0">
                      {s.matchCount > 0 && (
                        <div className="flex items-center gap-1 text-[11px] text-slate-400">
                          <Trophy className="h-3 w-3" />
                          <span>{s.matchCount} match{s.matchCount !== 1 ? "es" : ""}</span>
                        </div>
                      )}
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px]
                                       font-semibold text-slate-400">
                        Closed
                      </span>
                    </div>

                    {/* Arrow */}
                    <ChevronRight className="h-4 w-4 text-slate-300 shrink-0
                                             group-hover:text-slate-500 transition-colors" />
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
