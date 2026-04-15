"use client";

// ============================================================
// MatchHistoryPanel — Organizer view of all completed matches
// ============================================================
// Shows every completed match in the session with scores,
// team compositions, and win/loss indicators. Fetches data
// independently with its own subscription.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Trophy, History, Pencil, RotateCcw } from "lucide-react";
import { createClient } from "@/utils/supabase/client";
import { subscribeToMatches } from "@/lib/realtime";
import { SkillBadge } from "@/components/ui/skill-badge";
import { updateMatchDetails } from "@/app/actions/match";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { Match, MatchPlayer, Profile } from "@/types/database";

interface CompletedMatch extends Match {
  players: (MatchPlayer & { profile: Profile })[];
  courtName: string | null;
}

interface MatchHistoryPanelProps {
  sessionId: string;
}

export function MatchHistoryPanel({ sessionId }: MatchHistoryPanelProps) {
  const supabase = useMemo(() => createClient(), []);
  const [matches, setMatches] = useState<CompletedMatch[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchHistory = useCallback(async () => {
    const { data: rawMatches } = await supabase
      .from("matches")
      .select("*")
      .eq("session_id", sessionId)
      .eq("status", "completed")
      .order("completed_at", { ascending: false });

    if (!rawMatches || rawMatches.length === 0) {
      setMatches([]);
      setLoading(false);
      return;
    }

    const matchIds = rawMatches.map((m) => m.id);

    // Fetch players for all matches.
    const { data: matchPlayers } = await supabase
      .from("match_players")
      .select("*")
      .in("match_id", matchIds);

    // Fetch profiles.
    const playerIds = [...new Set((matchPlayers ?? []).map((mp) => mp.player_id))];
    let profileMap = new Map<string, Profile>();
    if (playerIds.length > 0) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("*")
        .in("id", playerIds);
      profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));
    }

    // Fetch court names.
    const courtIds = [...new Set(rawMatches.map((m) => m.court_id).filter(Boolean))] as string[];
    let courtMap = new Map<string, string>();
    if (courtIds.length > 0) {
      const { data: courts } = await supabase
        .from("courts")
        .select("id, name")
        .in("id", courtIds);
      courtMap = new Map((courts ?? []).map((c) => [c.id, c.name]));
    }

    const enriched: CompletedMatch[] = rawMatches.map((match) => ({
      ...match,
      courtName: match.court_id ? (courtMap.get(match.court_id) ?? null) : null,
      players: (matchPlayers ?? [])
        .filter((mp) => mp.match_id === match.id)
        .map((mp) => ({
          ...mp,
          profile: profileMap.get(mp.player_id) ?? {
            id: mp.player_id,
            display_name: "Unknown",
            skill_level: "beginner" as const,
            pin: null,
            created_at: "",
            updated_at: "",
          },
        })),
    }));

    setMatches(enriched);
    setLoading(false);
  }, [supabase, sessionId]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Real-time: refetch when matches change.
  const fetchRef = useRef(fetchHistory);
  fetchRef.current = fetchHistory;
  useEffect(() => {
    const unsub = subscribeToMatches(
      supabase,
      sessionId,
      () => fetchRef.current(),
      "org-history"
    );
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, sessionId]);

  if (loading) {
    return (
      <div className="py-16 text-center text-sm text-slate-400">
        Loading match history...
      </div>
    );
  }

  if (matches.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 dark:border-border bg-white dark:bg-card px-6 py-12 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 dark:bg-muted">
          <History className="h-5 w-5 text-slate-400 dark:text-muted-foreground" />
        </div>
        <p className="text-sm font-medium text-slate-600 dark:text-foreground">No completed matches yet</p>
        <p className="mt-1 text-xs text-slate-400 dark:text-muted-foreground">
          Matches will appear here once they are scored and ended.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground">
          Completed Matches
        </h2>
        <span className="rounded-full bg-slate-100 dark:bg-muted px-2.5 py-0.5 text-[10px] font-bold text-slate-600 dark:text-foreground">
          {matches.length} match{matches.length !== 1 ? "es" : ""}
        </span>
      </div>

      <div className="space-y-3">
        {matches.map((match, idx) => {
          const teamA = match.players.filter((p) => p.team === "a");
          const teamB = match.players.filter((p) => p.team === "b");
          const scoreA = match.team_a_score ?? 0;
          const scoreB = match.team_b_score ?? 0;
          const aWon = scoreA > scoreB;
          const bWon = scoreB > scoreA;
          const completedAt = match.completed_at
            ? new Date(match.completed_at).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
              })
            : "";

          return (
            <div
              key={match.id}
              className="rounded-2xl border border-slate-200 dark:border-border bg-white dark:bg-card shadow-sm overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between bg-slate-50 dark:bg-muted/50 px-4 py-2.5 border-b border-slate-100 dark:border-border">
                <div className="flex items-center gap-2">
                  <Trophy className="h-3.5 w-3.5 text-slate-400 dark:text-muted-foreground" />
                  <span className="text-sm font-bold text-slate-700 dark:text-foreground">
                    Match #{matches.length - idx}
                  </span>
                  {match.courtName && (
                    <span className="text-xs text-slate-400 dark:text-muted-foreground">
                      &middot; {match.courtName}
                    </span>
                  )}
                  {match.is_mixed_level && (
                    <span className="rounded-full border px-2 py-0.5
                                    text-[10px] font-bold uppercase tracking-wider
                                    bg-amber-100 border-amber-300 text-amber-800
                                    dark:bg-[hsl(35_100%_55%)]/20 dark:border-[hsl(35_100%_60%)]/70 dark:text-[hsl(35_100%_65%)]">
                      Mixed Level
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-400 dark:text-muted-foreground">{completedAt}</span>
                  <EditMatchDialog
                    matchId={match.id}
                    initialScoreA={match.team_a_score ?? 0}
                    initialScoreB={match.team_b_score ?? 0}
                  />
                </div>
              </div>

              {/* Score + Teams */}
              <div className="p-4">
                {/* Score banner */}
                <div className="flex items-center justify-center gap-4 mb-4">
                  <span
                    className={`text-3xl font-black tabular-nums
                                ${aWon ? "text-emerald-600 dark:text-emerald-400" : "text-slate-400 dark:text-muted-foreground"}`}
                  >
                    {scoreA}
                  </span>
                  <span className="text-sm font-bold text-slate-300 dark:text-muted-foreground/50">–</span>
                  <span
                    className={`text-3xl font-black tabular-nums
                                ${bWon ? "text-emerald-600 dark:text-emerald-400" : "text-slate-400 dark:text-muted-foreground"}`}
                  >
                    {scoreB}
                  </span>
                </div>

                {/* Teams side by side */}
                <div className="flex gap-3">
                  {/* Team A */}
                  <div
                    className={`flex-1 rounded-xl p-3 text-center
                                ${aWon ? "bg-emerald-50 dark:bg-emerald-900/20 ring-1 ring-emerald-200 dark:ring-emerald-700/40" : "bg-slate-50 dark:bg-muted/50"}`}
                  >
                    <div className="flex items-center justify-center gap-1.5 mb-2">
                      <p className="text-[10px] font-black uppercase tracking-wider text-slate-500 dark:text-muted-foreground">
                        Team A
                      </p>
                      {aWon && (
                        <span className="rounded-full bg-emerald-500 px-1.5 py-0.5 text-[9px] font-bold text-white uppercase">
                          Win
                        </span>
                      )}
                    </div>
                    {teamA.map((p) => (
                      <div key={p.player_id} className="mb-1 last:mb-0">
                        <p className={`text-sm leading-snug ${aWon ? "font-bold text-emerald-900 dark:text-emerald-300" : "font-medium text-slate-600 dark:text-foreground"}`}>
                          {p.profile.display_name}
                        </p>
                        <SkillBadge level={p.profile.skill_level} className="mt-0.5" />
                      </div>
                    ))}
                  </div>

                  {/* Team B */}
                  <div
                    className={`flex-1 rounded-xl p-3 text-center
                                ${bWon ? "bg-emerald-50 dark:bg-emerald-900/20 ring-1 ring-emerald-200 dark:ring-emerald-700/40" : "bg-slate-50 dark:bg-muted/50"}`}
                  >
                    <div className="flex items-center justify-center gap-1.5 mb-2">
                      <p className="text-[10px] font-black uppercase tracking-wider text-slate-500 dark:text-muted-foreground">
                        Team B
                      </p>
                      {bWon && (
                        <span className="rounded-full bg-emerald-500 px-1.5 py-0.5 text-[9px] font-bold text-white uppercase">
                          Win
                        </span>
                      )}
                    </div>
                    {teamB.map((p) => (
                      <div key={p.player_id} className="mb-1 last:mb-0">
                        <p className={`text-sm leading-snug ${bWon ? "font-bold text-emerald-900 dark:text-emerald-300" : "font-medium text-slate-600 dark:text-foreground"}`}>
                          {p.profile.display_name}
                        </p>
                        <SkillBadge level={p.profile.skill_level} className="mt-0.5" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// EditMatchDialog — Organizer score correction + revert to active
// ─────────────────────────────────────────────────────────────

interface EditMatchDialogProps {
  matchId: string;
  initialScoreA: number;
  initialScoreB: number;
}

function EditMatchDialog({ matchId, initialScoreA, initialScoreB }: EditMatchDialogProps) {
  const [open, setOpen] = useState(false);
  const [scoreA, setScoreA] = useState(String(initialScoreA));
  const [scoreB, setScoreB] = useState(String(initialScoreB));
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Reset form whenever the dialog is opened.
  function handleOpenChange(next: boolean) {
    if (next) {
      setScoreA(String(initialScoreA));
      setScoreB(String(initialScoreB));
      setMessage(null);
    }
    setOpen(next);
  }

  function handleSaveScore() {
    const a = parseInt(scoreA, 10);
    const b = parseInt(scoreB, 10);
    if (isNaN(a) || isNaN(b) || a < 0 || b < 0) {
      setMessage("Enter valid non-negative scores.");
      setIsError(true);
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const result = await updateMatchDetails(matchId, a, b, false);
      setMessage(result.message);
      setIsError(!result.success);
      if (result.success) {
        // Real-time will update the card score; close after a short delay.
        setTimeout(() => setOpen(false), 800);
      }
    });
  }

  function handleRevert() {
    startTransition(async () => {
      const result = await updateMatchDetails(matchId, 0, 0, true);
      setMessage(result.message);
      setIsError(!result.success);
      if (result.success) {
        // Match disappears from history list via real-time. Close dialog.
        setTimeout(() => setOpen(false), 800);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium
                     text-slate-400 hover:text-slate-700 hover:bg-slate-100
                     dark:text-muted-foreground dark:hover:text-foreground dark:hover:bg-muted
                     transition-colors"
          title="Edit scores or revert match"
        >
          <Pencil className="h-3 w-3" />
          Edit
        </button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Edit Match Score</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          {/* Score inputs */}
          <div className="flex items-center gap-3">
            <div className="flex-1 space-y-1 text-center">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-muted-foreground">
                Team A
              </p>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={99}
                value={scoreA}
                onChange={(e) => setScoreA(e.target.value)}
                disabled={isPending}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5
                           text-center text-2xl font-black tabular-nums text-slate-900
                           dark:border-border dark:bg-input dark:text-foreground
                           focus:outline-none focus:ring-2 focus:ring-ring
                           disabled:opacity-50"
              />
            </div>
            <span className="text-sm font-bold text-slate-300 dark:text-muted-foreground/50 mt-5">–</span>
            <div className="flex-1 space-y-1 text-center">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-muted-foreground">
                Team B
              </p>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={99}
                value={scoreB}
                onChange={(e) => setScoreB(e.target.value)}
                disabled={isPending}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5
                           text-center text-2xl font-black tabular-nums text-slate-900
                           dark:border-border dark:bg-input dark:text-foreground
                           focus:outline-none focus:ring-2 focus:ring-ring
                           disabled:opacity-50"
              />
            </div>
          </div>

          {/* Feedback message */}
          {message && (
            <p className={`text-center text-xs ${isError ? "text-red-600" : "text-emerald-600"}`}>
              {message}
            </p>
          )}

          {/* Save score */}
          <button
            onClick={handleSaveScore}
            disabled={isPending}
            className="w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold
                       text-white hover:bg-slate-800 transition-colors
                       dark:bg-primary dark:text-primary-foreground dark:hover:bg-primary/90
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPending ? "Saving…" : "Save Score"}
          </button>

          {/* Divider */}
          <div className="flex items-center gap-2">
            <div className="flex-1 border-t border-slate-100 dark:border-border" />
            <span className="text-[10px] text-slate-400 dark:text-muted-foreground uppercase tracking-widest">or</span>
            <div className="flex-1 border-t border-slate-100 dark:border-border" />
          </div>

          {/* Revert to active */}
          <button
            onClick={handleRevert}
            disabled={isPending}
            className="w-full flex items-center justify-center gap-2 rounded-xl border
                       border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-semibold
                       text-amber-800 hover:bg-amber-100 transition-colors
                       dark:border-[hsl(35_100%_60%)]/50 dark:bg-[hsl(35_100%_55%)]/10
                       dark:text-[hsl(35_100%_65%)] dark:hover:bg-[hsl(35_100%_55%)]/20
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RotateCcw className="h-4 w-4" />
            {isPending ? "Reverting…" : "Revert to Active Court"}
          </button>
          <p className="text-center text-[10px] text-slate-400 dark:text-muted-foreground">
            Use this if a score was submitted by accident. The match returns
            to the Active Courts view and players can re-submit.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
