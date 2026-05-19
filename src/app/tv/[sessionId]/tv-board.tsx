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

import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { MatchTimer } from "@/components/ui/match-timer";
import { VipTag } from "@/components/ui/vip-tag";
import type { TvMatch, TvSession } from "@/app/actions/tv";
import { useTvBoard } from "@/hooks/use-tv-board";
import { SKILL_META } from "@/lib/constants";
import type { SkillLevel } from "@/types/database";

// ─── Props ────────────────────────────────────────────────────

type TvBoardProps = {
  sessionId: string;
  session: TvSession;
  initialMatches: TvMatch[];
};

// ─── Root board ───────────────────────────────────────────────

export function TvBoard({ sessionId, session, initialMatches }: TvBoardProps) {
  const { inProgress, onDeck, lastUpdated } = useTvBoard(sessionId, initialMatches);

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-[#FAFAF7] dark:bg-background">
      {/* ── Header ──────────────────────────────────────────── */}
      <header
        className="shrink-0 flex items-center justify-between px-8 py-4
                   bg-[#1D3A6F] dark:bg-[hsl(217_30%_11%)]
                   dark:border-b dark:border-border shadow-lg"
      >
        <div>
          <h1 className="text-2xl font-black text-white tracking-tight">{session.name}</h1>
          <p className="text-xs font-medium text-white/50 mt-0.5 uppercase tracking-widest">
            Live Scoreboard
          </p>
        </div>

        <div className="flex items-center gap-5">
          <LiveClock />
          {!session.is_active && (
            <span
              className="rounded-full bg-white/15 border border-white/30 px-3 py-1
                             text-[10px] font-bold uppercase tracking-wider text-white/70"
            >
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
            dotColor="bg-emerald-500 animate-pulse"
            badgeClass="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
          />
          {inProgress.length === 0 ? (
            <EmptyState message="No courts in play right now" />
          ) : (
            inProgress.map((match) => <TvCourtCard key={match.id} match={match} />)
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
            onDeck.map((match, idx) => <TvOnDeckCard key={match.id} match={match} index={idx} />)
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
    <div
      className="rounded-2xl overflow-hidden shadow-md"
      style={{
        background: "#0D1B2A",
        boxShadow: "0 0 0 1px rgba(16,185,129,0.3), 0 0 32px rgba(16,185,129,0.1)",
      }}
    >
      {/* Card header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-white/10">
        <h3 className="text-2xl font-black text-white">{match.court_name ?? "Court"}</h3>
        <span
          className="shrink-0 rounded-full border px-3 py-0.5
                     text-xs font-bold uppercase tracking-widest
                     bg-emerald-500/20 border-emerald-500/40 text-emerald-300"
        >
          In Progress
        </span>
        {/* Live match timer — TV-scale text for long-distance legibility */}
        {match.started_at && (
          <MatchTimer startedAt={match.started_at} variant="live" className="text-base" />
        )}
        {match.is_mixed_level && <MixedLevelBadge />}
      </div>

      {/* TV roster grid — dark variant */}
      <TvTeamsGrid teamA={teamA} teamB={teamB} dark />
    </div>
  );
}

// ─── On-Deck Card ─────────────────────────────────────────────

function TvOnDeckCard({ match, index }: { match: TvMatch; index: number }) {
  const teamA = match.players.filter((p) => p.team === "a");
  const teamB = match.players.filter((p) => p.team === "b");
  // Date.now() is intentionally read during render — the TV board refreshes
  // every 15 s via polling, so each render naturally reflects current time.
  // eslint-disable-next-line react-hooks/purity
  const minutesWaiting = Math.floor((Date.now() - new Date(match.created_at).getTime()) / 60_000);

  return (
    <div
      className="rounded-2xl overflow-hidden shadow-sm
                 border border-amber-100 dark:border-amber-500/20
                 bg-white dark:bg-card"
    >
      {/* Card header */}
      <div
        className="flex items-center justify-between px-5 py-3
                   bg-amber-50/70 dark:bg-amber-500/10
                   border-b border-amber-100 dark:border-amber-500/20"
      >
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold text-amber-900 dark:text-amber-300">
            On Deck #{index + 1}
          </span>
          {match.is_mixed_level && <MixedLevelBadge />}
        </div>
        <span className="text-sm font-medium text-amber-600 dark:text-amber-400">
          {minutesWaiting === 0 ? "Just formed" : `${minutesWaiting}m ago`}
        </span>
      </div>

      {/* TV roster grid — light variant */}
      <TvTeamsGrid teamA={teamA} teamB={teamB} />

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

// ─── TV-Scale Teams Grid ──────────────────────────────────────
// Mirrors the 3-column CSS-grid layout of TeamsGrid in
// match-roster.tsx but scaled up for long-distance TV legibility
// (text-xl names, h-12 VS badge, larger row padding).

type TvPlayerInfo = {
  player_id: string;
  display_name: string;
  skill_level: SkillLevel;
  vip_tag: string | null;
  vip_theme: string | null;
};

// SKILL_META from constants.ts provides dot + abbr for all 6 levels.

function TvTeamsGrid({
  teamA,
  teamB,
  dark,
}: {
  teamA: TvPlayerInfo[];
  teamB: TvPlayerInfo[];
  dark?: boolean;
}) {
  const a0 = teamA[0];
  const a1 = teamA[1];
  const b0 = teamB[0];
  const b1 = teamB[1];

  if (!a0 || !a1 || !b0 || !b1) return null;

  return (
    <div className="grid gap-y-3 px-4 py-4" style={{ gridTemplateColumns: "1fr 64px 1fr" }}>
      {/* Row 1 — column labels */}
      <div style={{ gridColumn: 1, gridRow: 1 }}>
        <span
          className={`text-[10px] font-black uppercase tracking-widest ${
            dark ? "text-sky-400/70" : "text-sky-600 dark:text-sky-400"
          }`}
        >
          Team A
        </span>
      </div>
      <div style={{ gridColumn: 2, gridRow: 1 }} aria-hidden="true" />
      <div style={{ gridColumn: 3, gridRow: 1 }} className="text-right">
        <span
          className={`text-[10px] font-black uppercase tracking-widest ${
            dark ? "text-amber-400/70" : "text-amber-600 dark:text-amber-400"
          }`}
        >
          Team B
        </span>
      </div>

      {/* VS badge — col 2, spans rows 2–3 */}
      <div
        style={{ gridColumn: 2, gridRow: "2 / span 2" }}
        className="flex items-center justify-center"
      >
        <div
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${
            dark
              ? "bg-emerald-500/20 ring-1 ring-emerald-500/40"
              : "bg-white dark:bg-white/10 ring-1 ring-slate-200 dark:ring-white/20 shadow-sm dark:shadow-none"
          }`}
          aria-hidden="true"
        >
          <span
            className={`text-xs font-black tracking-tight ${
              dark ? "text-emerald-400" : "text-slate-400 dark:text-white/50"
            }`}
          >
            VS
          </span>
        </div>
      </div>

      {/* Row 2 — first player pair */}
      <div style={{ gridColumn: 1, gridRow: 2 }}>
        <TvPlayerRow player={a0} dark={dark} teamColor="text-sky-200" />
      </div>
      <div style={{ gridColumn: 3, gridRow: 2 }}>
        <TvPlayerRow player={b0} dark={dark} teamColor="text-amber-200" />
      </div>

      {/* Row 3 — second player pair */}
      <div style={{ gridColumn: 1, gridRow: 3 }}>
        <TvPlayerRow player={a1} dark={dark} teamColor="text-sky-200" />
      </div>
      <div style={{ gridColumn: 3, gridRow: 3 }}>
        <TvPlayerRow player={b1} dark={dark} teamColor="text-amber-200" />
      </div>
    </div>
  );
}

function TvPlayerRow({
  player,
  dark,
  teamColor,
}: {
  player: TvPlayerInfo;
  dark?: boolean;
  teamColor: string;
}) {
  const hasTag = !!(player.vip_tag && player.vip_theme);
  const { dot, abbr } = SKILL_META[player.skill_level] ?? { dot: "bg-slate-400", abbr: "?" };

  return (
    <div
      className={`w-full rounded-xl px-4 py-3 transition-colors ${
        dark ? "hover:bg-white/5" : "bg-slate-100/70 dark:bg-white/[0.06]"
      }`}
      style={dark ? { background: "rgba(255,255,255,0.04)" } : undefined}
    >
      {/* Line 1 — name + optional VIP tag */}
      <div className="flex items-center gap-2 overflow-hidden">
        <span
          className={`shrink min-w-0 truncate text-xl font-bold leading-tight ${
            dark
              ? teamColor
              : teamColor === "text-sky-200"
                ? "text-sky-800 dark:text-sky-200"
                : "text-amber-800 dark:text-amber-200"
          }`}
        >
          {player.display_name}
        </span>
        {hasTag && (
          <>
            <span
              className={`shrink-0 text-sm leading-none select-none ${
                dark ? "text-white/25" : "text-slate-300 dark:text-white/20"
              }`}
              aria-hidden="true"
            >
              |
            </span>
            <span className="shrink-0 leading-none">
              <VipTag tag={player.vip_tag!} theme={player.vip_theme!} />
            </span>
          </>
        )}
      </div>
      {/* Line 2 — skill dot */}
      <div className="mt-1.5 flex items-center gap-1.5" aria-label={player.skill_level}>
        <span
          className={`h-2 w-2 rounded-full shrink-0 ${dot} ${dark ? "opacity-80" : ""}`}
          aria-hidden="true"
        />
        <span
          className={`text-[9px] font-bold uppercase tracking-wide leading-none ${
            dark ? "text-white/40" : "text-slate-500 dark:text-slate-400"
          }`}
        >
          {abbr}
        </span>
      </div>
    </div>
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
    <span className="text-sm font-medium tabular-nums text-white/70 dark:text-primary/80">
      {time}
    </span>
  );
}
