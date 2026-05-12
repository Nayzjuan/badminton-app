"use client";

// ============================================================
// StadiumLeaderboard — Player-panel Stadium layout
// ============================================================
// Six-region composition that reads at arm's length:
//   1. Header     — big Barlow Condensed "LEADERBOARD" + count
//   2. YOU strip  — current user's amber-tinted summary row
//   3. Podium     — asymmetric [#2 #1 #3] with the winner taller
//                   and an oversized ghost numeral watermark
//   4. Sort bar   — visual only (no state) for now
//   5. Col header — 6-column grid (# · PLAYER · GP · W-L · WIN% · Δ)
//   6. Rows 4-N   — same grid template
// ============================================================

import { RefreshCw, Zap } from "lucide-react";
import type { LeaderboardRow } from "@/types/leaderboard";

interface StadiumLeaderboardProps {
  sessionName?: string;
  rows: LeaderboardRow[];
  currentUserId: string | null;
  /** Optional refresh handler — when omitted, refresh button is hidden. */
  onRefresh?: () => void;
}

const GRID_COLS = "34px 1fr 30px 64px 52px 26px";

export function StadiumLeaderboard({
  sessionName,
  rows,
  currentUserId,
  onRefresh,
}: StadiumLeaderboardProps) {
  const me = currentUserId
    ? rows.find((r) => r.player_id === currentUserId) ?? null
    : null;

  // Podium positions 1-3 (with sparse fallback if fewer than 3 ranked players).
  const podium = [rows[0] ?? null, rows[1] ?? null, rows[2] ?? null];
  const tail = rows.slice(3);

  return (
    <div className="flex flex-col">
      {/* ── 1. Header ────────────────────────────────────── */}
      <header className="flex items-end justify-between px-1 pt-2 pb-3 border-b border-border">
        <div>
          {sessionName && (
            <p className="font-mono text-[9.5px] font-bold uppercase tracking-[0.2em] text-accent">
              {sessionName}
            </p>
          )}
          <h1
            className="font-display font-black italic uppercase leading-[0.85] text-foreground"
            style={{ fontSize: "52px", letterSpacing: "-0.02em" }}
          >
            LEADER
            <br />
            BOARD
          </h1>
        </div>
        <div className="flex items-end gap-2.5 pb-1">
          <div className="text-right">
            <div
              className="font-display font-black italic text-accent leading-[0.9]"
              style={{ fontSize: "44px" }}
            >
              {rows.length}
            </div>
            <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground mt-0.5">
              {rows.length === 1 ? "PLAYER" : "PLAYERS"}
            </div>
          </div>
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className="grid h-9 w-9 place-items-center rounded-[10px] border border-border bg-transparent
                         text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              aria-label="Refresh leaderboard"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </header>

      {/* ── 2. YOU strip ─────────────────────────────────── */}
      {me && (
        <div
          className="flex items-center gap-2.5 px-4 py-2.5 border-b border-accent/25"
          style={{
            background:
              "linear-gradient(to right, oklch(0.68 0.17 62 / 0.18), transparent)",
          }}
        >
          <span
            className="shrink-0 font-mono text-[9px] font-extrabold uppercase tracking-[0.18em]
                       px-1.5 py-[3px] bg-accent text-accent-foreground"
          >
            YOU
          </span>
          <span
            className="shrink-0 font-display font-black italic text-accent leading-none"
            style={{ fontSize: "22px" }}
          >
            #{me.rank}
          </span>
          <span className="flex-1 min-w-0 truncate font-display font-bold uppercase text-foreground"
                style={{ fontSize: "18px", letterSpacing: "0.02em" }}>
            {me.display_name}
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
            {me.wins}W–{me.losses}L
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
            {me.win_pct.toFixed(1)}%
          </span>
        </div>
      )}

      {/* ── 3. Podium ────────────────────────────────────── */}
      {rows.length > 0 && (
        <section className="px-4 pt-3 pb-4">
          <div className="mb-2.5 flex items-center gap-2">
            <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.2em] text-accent">
              Top 3
            </span>
            <span
              className="flex-1 h-px"
              style={{
                background:
                  "linear-gradient(to right, oklch(0.78 0.17 62), transparent)",
              }}
            />
            <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.2em] text-muted-foreground/40">
              Session
            </span>
          </div>

          <div className="grid grid-cols-[1fr_1.2fr_1fr] gap-1.5">
            <PodiumCell row={podium[1]} place={2} isMe={podium[1]?.player_id === currentUserId} />
            <PodiumCell row={podium[0]} place={1} isMe={podium[0]?.player_id === currentUserId} />
            <PodiumCell row={podium[2]} place={3} isMe={podium[2]?.player_id === currentUserId} />
          </div>
        </section>
      )}

      {/* ── 4. Column header ─────────────────────────────── */}
      <div
        className="grid items-center px-4 py-1.5 border-y border-border bg-muted/40
                   font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground"
        style={{ gridTemplateColumns: GRID_COLS, gap: "6px" }}
      >
        <span className="text-left">#</span>
        <span className="text-left">Player</span>
        <span className="text-right">GP</span>
        <span className="text-right">W–L</span>
        <span className="text-right">Win%</span>
        <span className="text-right">Δ</span>
      </div>

      {/* ── 5. Rows 4-N ──────────────────────────────────── */}
      <div>
        {tail.map((row) => (
          <StadiumRow
            key={row.player_id}
            row={row}
            isMe={row.player_id === currentUserId}
          />
        ))}
        {tail.length === 0 && rows.length > 0 && rows.length < 4 && (
          <p className="px-4 py-6 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            {rows.length === 1
              ? "One ranked player so far"
              : `${rows.length} ranked players so far`}
          </p>
        )}
      </div>

      <p className="px-4 pt-3 pb-4 text-center font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/60">
        Min. 3 GP to appear · Ranked by win rate
      </p>
    </div>
  );
}

// ── Podium cell ───────────────────────────────────────────────

function PodiumCell({
  row,
  place,
  isMe,
}: {
  row: LeaderboardRow | null;
  place: 1 | 2 | 3;
  isMe: boolean;
}) {
  const isFirst = place === 1;
  const rankSize = isFirst ? 88 : 68;
  const rankColor =
    place === 1
      ? "text-accent dark:text-accent"
      : place === 2
      ? "text-foreground/50 dark:text-muted-foreground"
      : "text-amber-600 dark:text-amber-500";

  return (
    <div
      className={`relative overflow-hidden rounded-[14px] border
        ${
          isFirst
            ? "border-accent/55 px-2.5 pb-3 pt-5 bg-[oklch(0.91_0.014_245)] dark:bg-[oklch(0.15_0.018_245)]"
            : isMe
            ? "border-accent/35 px-2.5 py-3 bg-accent/10"
            : "border-border px-2.5 py-3 bg-card"
        }`}
    >
      {/* Oversized ghost watermark for #1 */}
      {isFirst && (
        <span
          className="pointer-events-none absolute -top-3 -right-1 font-display font-black italic leading-none select-none"
          style={{
            fontSize: "100px",
            color: "oklch(0.68 0.17 62 / 0.14)",
          }}
          aria-hidden="true"
        >
          1
        </span>
      )}

      <div
        className={`relative font-display font-black italic leading-[0.82] ${rankColor}`}
        style={{ fontSize: rankSize, letterSpacing: "-0.02em" }}
      >
        #{place}
      </div>

      <div
        className={`relative mt-1 truncate font-display font-bold uppercase
          ${isMe ? "text-accent" : "text-foreground"}`}
        style={{ fontSize: isFirst ? "14px" : "13px", letterSpacing: "0.03em" }}
      >
        {row ? row.display_name : "—"}
      </div>

      {row && (
        <div className="relative mt-0.5 flex items-center gap-1 font-mono text-[10px]">
          <span className="text-primary">{row.wins}W</span>
          <span className="text-muted-foreground/30">·</span>
          <span className="text-destructive">{row.losses}L</span>
          <span className="text-muted-foreground/30">·</span>
          <span className="text-foreground/70">{Math.round(row.win_pct)}%</span>
        </div>
      )}

      {/* Win-streak bolts on #1 only */}
      {row && isFirst && row.win_streak > 0 && (
        <div className="relative mt-1.5 flex items-center gap-0.5 font-mono text-[10px] font-bold text-accent">
          <Zap className="h-3 w-3 fill-current" />
          <span>×{row.win_streak}</span>
        </div>
      )}

      {/* YOU label on #3 if it's the current user */}
      {!isFirst && isMe && (
        <div className="relative mt-1 font-mono text-[8px] font-extrabold uppercase tracking-[0.16em] text-accent opacity-80">
          You
        </div>
      )}
    </div>
  );
}

// ── Tail rows (rank 4+) ───────────────────────────────────────

function StadiumRow({
  row,
  isMe,
}: {
  row: LeaderboardRow;
  isMe: boolean;
}) {
  const delta = row.rank_movement;
  const deltaCls =
    delta && delta > 0
      ? "text-primary"
      : delta && delta < 0
      ? "text-destructive"
      : "text-muted-foreground/40";
  const deltaText =
    delta == null
      ? "✦"
      : delta === 0
      ? "·"
      : delta > 0
      ? `↑${delta}`
      : `↓${Math.abs(delta)}`;

  return (
    <div
      data-flash={isMe ? undefined : "false"}
      className={`grid items-center px-4 py-2.5 border-b border-border transition-colors
        ${isMe ? "bg-accent/10" : "hover:bg-muted/30"}`}
      style={{ gridTemplateColumns: GRID_COLS, gap: "6px" }}
    >
      <span className="font-mono text-[11px] font-bold text-muted-foreground text-left">
        {row.rank}
      </span>
      <span className="flex items-center gap-1.5 min-w-0">
        {isMe && (
          <span className="shrink-0 font-mono text-[8.5px] font-extrabold uppercase tracking-[0.14em]
                           px-1.5 py-0.5 bg-accent text-accent-foreground">
            YOU
          </span>
        )}
        <span
          className="truncate font-display font-bold uppercase text-foreground"
          style={{ fontSize: "18px", letterSpacing: "0.02em" }}
        >
          {row.display_name}
        </span>
      </span>
      <span className="font-mono text-[11px] text-muted-foreground text-right">{row.games_played}</span>
      <span className="font-mono text-[11px] font-semibold text-right tabular-nums">
        <span className="text-primary">{row.wins}W</span>
        <span className="text-muted-foreground/40 mx-0.5">–</span>
        <span className="text-destructive">{row.losses}L</span>
      </span>
      <span
        className="font-display font-bold italic text-right text-foreground/85"
        style={{ fontSize: "16px" }}
      >
        {row.win_pct.toFixed(1)}%
      </span>
      <span className={`font-mono text-[10px] font-bold text-right ${deltaCls}`}>
        {deltaText}
      </span>
    </div>
  );
}
