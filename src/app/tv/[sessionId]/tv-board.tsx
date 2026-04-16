"use client";

// ============================================================
// TvBoard — Real-time scoreboard for display screens
// ============================================================
// • Full-screen, read-only layout — no interactive buttons
// • Two columns: Active Courts (in_progress) | On Deck (pending)
// • TV-sized player name pills (text-xl) for long-distance legibility
// • Real-time via anon Supabase client + 15s polling fallback
//   (polling ensures freshness even if anon role lacks RT events)
// • ThemeToggle for Vantablack Neon dark mode
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { MatchTimer } from "@/components/ui/match-timer";
import { getTvData } from "@/app/actions/tv";
import type { TvMatch, TvSession } from "@/app/actions/tv";
import { subscribeToMatches, subscribeToMatchPlayers } from "@/lib/realtime";

// ─── Props ────────────────────────────────────────────────────

interface TvBoardProps {
  sessionId: string;
  session: TvSession;
  initialMatches: TvMatch[];
}

// ─── Root board ───────────────────────────────────────────────

export function TvBoard({ sessionId, session, initialMatches }: TvBoardProps) {
  const [matches, setMatches] = useState<TvMatch[]>(initialMatches);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const supabase = useMemo(() => createClient(), []);

  const refresh = useCallback(async () => {
    const { matches: fresh } = await getTvData(sessionId);
    setMatches(fresh);
    setLastUpdated(new Date());
  }, [sessionId]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    // Real-time subscriptions (fire when match state or players change)
    const unsubMatches = subscribeToMatches(
      supabase,
      sessionId,
      () => refreshRef.current(),
      "tv"
    );
    const unsubPlayers = subscribeToMatchPlayers(
      supabase,
      sessionId,
      () => refreshRef.current(),
      "tv"
    );

    // Polling fallback — fires every 15 s even if anon RT events are
    // filtered by RLS. Ensures the board never goes stale.
    const poll = setInterval(() => refreshRef.current(), 15_000);

    return () => {
      unsubMatches();
      unsubPlayers();
      clearInterval(poll);
    };
  }, [supabase, sessionId]);

  const inProgress = matches.filter((m) => m.status === "in_progress");
  const onDeck = matches.filter((m) => m.status === "pending");

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-[#FAFAF7] dark:bg-background">

      {/* ── Header ──────────────────────────────────────────── */}
      <header
        className="shrink-0 flex items-center justify-between px-8 py-4
                   bg-[#1D3A6F] dark:bg-[hsl(217_30%_11%)]
                   dark:border-b dark:border-border shadow-lg"
      >
        <div>
          <h1 className="text-2xl font-black text-white tracking-tight">
            {session.name}
          </h1>
          <p className="text-xs font-medium text-white/50 mt-0.5 uppercase tracking-widest">
            Live Scoreboard
          </p>
        </div>

        <div className="flex items-center gap-5">
          <LiveClock />
          {!session.is_active && (
            <span className="rounded-full bg-white/15 border border-white/30 px-3 py-1
                             text-[10px] font-bold uppercase tracking-wider text-white/70">
              Session Closed
            </span>
          )}
          <ThemeToggle
            className="text-white/60 hover:text-white hover:bg-white/10
                       dark:text-primary dark:hover:bg-primary/10"
          />
        </div>
      </header>

      {/* ── Two-column body ─────────────────────────────────── */}
      <div className="flex-1 grid grid-cols-2 min-h-0">

        {/* Active Courts */}
        <section className="border-r border-slate-200 dark:border-border overflow-y-auto p-6 space-y-5">
          <SectionLabel
            label="Active Courts"
            count={inProgress.length}
            dotColor="bg-blue-500"
            badgeClass="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
          />
          {inProgress.length === 0 ? (
            <EmptyState message="No courts in play right now" />
          ) : (
            inProgress.map((match) => (
              <TvCourtCard key={match.id} match={match} />
            ))
          )}
        </section>

        {/* On Deck */}
        <section className="overflow-y-auto p-6 space-y-5">
          <SectionLabel
            label="On Deck"
            count={onDeck.length}
            dotColor="bg-amber-500 animate-pulse"
            badgeClass="bg-amber-100 text-amber-800 dark:bg-[hsl(35_100%_55%)]/20 dark:text-[hsl(35_100%_65%)]"
          />
          {onDeck.length === 0 ? (
            <EmptyState message="No matches queued yet" />
          ) : (
            onDeck.map((match, idx) => (
              <TvOnDeckCard key={match.id} match={match} index={idx} />
            ))
          )}
        </section>
      </div>

      {/* ── Footer ─────────────────────────────────────────── */}
      <footer
        className="shrink-0 border-t border-slate-200 dark:border-border
                   px-8 py-2 flex items-center justify-between
                   bg-white/80 dark:bg-card/80 backdrop-blur"
      >
        <p className="text-[10px] text-muted-foreground uppercase tracking-widest">
          Read-only view · updates automatically
        </p>
        {lastUpdated && (
          <p className="text-[10px] text-muted-foreground tabular-nums">
            Last sync{" "}
            {lastUpdated.toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              second: "2-digit",
            })}
          </p>
        )}
      </footer>
    </div>
  );
}

// ─── Active Court Card ────────────────────────────────────────

function TvCourtCard({ match }: { match: TvMatch }) {
  const teamA = match.players.filter((p) => p.team === "a");
  const teamB = match.players.filter((p) => p.team === "b");

  return (
    <div className="rounded-2xl bg-white dark:bg-card shadow-md overflow-hidden">
      {/* Card header */}
      <div
        className="flex items-center gap-3 px-6 py-4
                   bg-slate-50 dark:bg-muted/50
                   border-b border-slate-100 dark:border-border"
      >
        <h3 className="text-2xl font-black text-gray-900 dark:text-foreground">
          {match.court_name ?? "Court"}
        </h3>
        <span
          className="shrink-0 rounded-full border px-3 py-0.5
                     text-xs font-bold uppercase tracking-widest
                     bg-blue-600 text-white border-blue-700
                     dark:bg-[hsl(220_100%_58%)] dark:border-[hsl(220_100%_65%)]
                     dark:shadow-[0_0_8px_hsl(220_100%_60%/0.4)]"
        >
          In Progress
        </span>
        {/* Live match timer — TV-scale text for long-distance legibility */}
        {match.started_at && (
          <MatchTimer
            startedAt={match.started_at}
            variant="live"
            className="text-base"
          />
        )}
        {match.is_mixed_level && <MixedLevelBadge />}
      </div>

      {/* TV court graphic */}
      <div className="p-4">
        <TvBadmintonCourt teamA={teamA} teamB={teamB} />
      </div>
    </div>
  );
}

// ─── On-Deck Card ─────────────────────────────────────────────

function TvOnDeckCard({ match, index }: { match: TvMatch; index: number }) {
  const teamA = match.players.filter((p) => p.team === "a");
  const teamB = match.players.filter((p) => p.team === "b");
  const minutesWaiting = Math.floor(
    (Date.now() - new Date(match.created_at).getTime()) / 60_000
  );

  return (
    <div
      className="rounded-2xl overflow-hidden shadow-sm
                 border border-amber-100 dark:border-amber-900/40
                 bg-white dark:bg-card"
    >
      {/* Card header */}
      <div
        className="flex items-center justify-between px-5 py-3
                   bg-amber-50/70 dark:bg-amber-900/20
                   border-b border-amber-100 dark:border-amber-900/40"
      >
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold text-amber-900 dark:text-amber-300">
            On Deck #{index + 1}
          </span>
          {match.is_mixed_level && <MixedLevelBadge />}
        </div>
        <span className="text-sm font-medium text-amber-600 dark:text-amber-400">
          {minutesWaiting === 0
            ? "Just formed"
            : `${minutesWaiting}m ago`}
        </span>
      </div>

      {/* TV court graphic */}
      <div className="p-4">
        <TvBadmintonCourt teamA={teamA} teamB={teamB} />
      </div>

      {/* Footer hint */}
      <div
        className="px-5 py-2.5 bg-slate-50 dark:bg-muted/50
                   border-t border-slate-100 dark:border-border"
      >
        <p className="text-center text-sm text-slate-400 dark:text-muted-foreground">
          Auto-assigns when a court frees up
        </p>
      </div>
    </div>
  );
}

// ─── TV-Sized Badminton Court Graphic ─────────────────────────
// Identical structure to BadmintonCourt but with larger fonts
// and padding for long-distance TV legibility.

interface TvPlayerInfo {
  player_id: string;
  display_name: string;
}

function TvBadmintonCourt({
  teamA,
  teamB,
}: {
  teamA: TvPlayerInfo[];
  teamB: TvPlayerInfo[];
}) {
  return (
    <div
      className="relative rounded-xl overflow-hidden
                 bg-emerald-700 dark:bg-[hsl(0_0%_2%)]
                 ring-[3px] ring-inset ring-white/70 dark:ring-[hsl(180_100%_70%)]/70"
    >
      {/* Service line markings */}
      <div className="absolute inset-x-4 top-1/4 border-t border-white/20 dark:border-[hsl(180_100%_70%)]/25" />
      <div className="absolute inset-x-4 bottom-1/4 border-t border-white/20 dark:border-[hsl(180_100%_70%)]/25" />
      <div className="absolute inset-y-4 left-1/2 border-l border-white/15 dark:border-[hsl(180_100%_70%)]/20" />

      {/* Team A */}
      <div className="relative px-6 pt-8 pb-6">
        <p
          className="mb-4 text-center text-[11px] font-black uppercase tracking-[0.25em]
                     text-white/50 dark:text-[hsl(180_100%_70%)]/60"
        >
          Team A
        </p>
        <div className="flex items-center justify-center gap-4 flex-wrap">
          {teamA.map((p) => (
            <TvPlayerPill key={p.player_id} name={p.display_name} />
          ))}
        </div>
      </div>

      {/* Net */}
      <div className="relative flex items-center px-4">
        <div className="flex-1 border-t-[3px] border-dashed border-white/60 dark:border-[hsl(180_100%_70%)]" />
        <span
          className="mx-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-full
                     text-xs font-black backdrop-blur-sm
                     bg-white/20 dark:bg-[hsl(180_100%_50%)]/15
                     text-white/80 dark:text-[hsl(180_100%_70%)]"
        >
          VS
        </span>
        <div className="flex-1 border-t-[3px] border-dashed border-white/60 dark:border-[hsl(180_100%_70%)]" />
      </div>

      {/* Team B */}
      <div className="relative px-6 pt-6 pb-8">
        <p
          className="mb-4 text-center text-[11px] font-black uppercase tracking-[0.25em]
                     text-white/50 dark:text-[hsl(180_100%_70%)]/60"
        >
          Team B
        </p>
        <div className="flex items-center justify-center gap-4 flex-wrap">
          {teamB.map((p) => (
            <TvPlayerPill key={p.player_id} name={p.display_name} />
          ))}
        </div>
      </div>
    </div>
  );
}

function TvPlayerPill({ name }: { name: string }) {
  return (
    <span
      className="rounded-full px-6 py-3 text-xl font-bold shadow-md
                 bg-white text-slate-900 shadow-black/20
                 dark:bg-black/60 dark:text-[hsl(80_100%_60%)]
                 dark:[text-shadow:0_0_12px_hsl(80_100%_60%/0.7)]
                 dark:ring-1 dark:ring-[hsl(80_100%_60%)]/30"
    >
      {name}
    </span>
  );
}

// ─── Shared small components ──────────────────────────────────

function MixedLevelBadge() {
  return (
    <span
      className="shrink-0 rounded-full border px-2.5 py-0.5
                 text-[10px] font-bold uppercase tracking-wider
                 bg-amber-100 border-amber-300 text-amber-800
                 dark:bg-[hsl(35_100%_55%)]/20 dark:border-[hsl(35_100%_60%)]/70
                 dark:text-[hsl(35_100%_65%)]"
    >
      Mixed Level
    </span>
  );
}

function SectionLabel({
  label,
  count,
  dotColor,
  badgeClass,
}: {
  label: string;
  count: number;
  dotColor: string;
  badgeClass: string;
}) {
  return (
    <div className="flex items-center gap-2.5 pb-1">
      <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${dotColor}`} />
      <h2 className="text-xs font-black uppercase tracking-[0.2em] text-slate-500 dark:text-muted-foreground">
        {label}
      </h2>
      <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${badgeClass}`}>
        {count}
      </span>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 dark:border-border py-20 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function LiveClock() {
  const [time, setTime] = useState<string>("");

  useEffect(() => {
    function tick() {
      setTime(
        new Date().toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        })
      );
    }
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, []);

  return (
    <span className="text-sm font-mono font-medium tabular-nums text-white/70 dark:text-primary/80">
      {time}
    </span>
  );
}
