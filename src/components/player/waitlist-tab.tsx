"use client";

// ============================================================
// WaitlistTab — Live Standings Board
// ============================================================
// Sporty scoreboard: zero-padded Barlow Condensed rank nums,
// "you" row in amber canvas, JetBrains Mono GP stats,
// BEG/INT/ADV abbreviations. One clean ordered list — no zone
// labels. Rank colour fades with position for visual hierarchy.
//
// Light + dark mode: semantic tokens + fixed OKLCH where needed.
// ============================================================

import { VipTag } from "@/components/ui/vip-tag";
import { useFlipList } from "@/hooks/use-flip-list";
import type { QueueEntryWithProfile } from "@/hooks/use-session-data";
import type { SkillLevel } from "@/types/database";

interface WaitlistTabProps {
  waitlist: QueueEntryWithProfile[];
  myPlayerId: string;
  loading: boolean;
}

const SKILL_ABBREV: Record<SkillLevel, string> = {
  beginner: "BEG",
  lower_intermediate: "BEG",
  intermediate: "INT",
  upper_intermediate: "INT",
  lower_advanced: "ADV",
  advanced: "ADV",
};

// Amber — the app-wide "you are here" colour. Matches the leaderboard's amber
// YouStrip and the MatchAlert on-deck canvas so "amber = you" reads the same
// everywhere. A bright amber fill (fixed OKLCH, identical in both themes) with
// dark warm text keeps the "you" row the boldest thing in the ranked list, and
// clearly distinct from the light-tint (`bg-amber-50/60`) on-deck rows.
// Dark text (L≈0.24) on the bright amber canvas (L≈0.78) ≈ 7:1.
const YOU_BG = "oklch(0.78 0.17 62)";
const YOU_TEXT = "oklch(0.24 0.05 62)";
const YOU_TEXT_DIM = "oklch(0.24 0.05 62 / 0.72)";
const YOU_RANK = "oklch(0.32 0.10 62)";

export function WaitlistTab({ waitlist, myPlayerId, loading }: WaitlistTabProps) {
  // FLIP reorder animation: rows glide to their new rank after every
  // games_played / joined_at resort instead of teleporting. Keyed on
  // membership+order only — a stat ticking up in place doesn't animate.
  // Hook must run unconditionally (before the loading/empty early returns).
  const registerFlip = useFlipList(waitlist.map((e) => e.id).join(","));

  if (loading) {
    // Skeleton shaped like the "Lineup" board header + ranked rows (same
    // 56px/1fr/auto grid). Renders once per mount — `loading` never re-enters.
    return (
      <div role="status" aria-busy="true" aria-label="Loading lineup">
        {/* Header block sized to match the real "● LIVE / Lineup" + count so
            the ranked list below doesn't shove down when data lands. */}
        <div className="flex items-end justify-between pb-3 border-b-[2px] border-foreground/15">
          <div>
            <div className="mb-2 h-2.5 w-14 rounded-full bg-slate-200 dark:bg-muted animate-pulse" />
            <div className="h-12 w-40 rounded-lg bg-slate-200 dark:bg-muted animate-pulse" />
          </div>
          <div className="flex flex-col items-end">
            <div className="h-12 w-14 rounded-lg bg-slate-200 dark:bg-muted animate-pulse" />
            <div className="mt-1.5 h-2 w-10 rounded-full bg-slate-200 dark:bg-muted animate-pulse" />
          </div>
        </div>
        <div className="mt-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="grid items-center py-3 border-b border-border/50"
              style={{
                gridTemplateColumns: "56px 1fr auto",
                gap: "0 10px",
                paddingLeft: "4px",
                paddingRight: "4px",
              }}
            >
              <div className="h-7 w-8 rounded bg-slate-200 dark:bg-muted animate-pulse" />
              <div className="space-y-1.5">
                <div className="h-4 w-32 rounded-full bg-slate-200 dark:bg-muted animate-pulse" />
                <div className="h-2.5 w-10 rounded-full bg-slate-200 dark:bg-muted animate-pulse" />
              </div>
              <div className="h-6 w-8 rounded bg-slate-200 dark:bg-muted animate-pulse ml-auto" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (waitlist.length === 0) {
    return (
      <div className="flex flex-col items-start pt-5 pb-12">
        <div className="flex items-center gap-1.5 mb-2">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
          <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            Queue Empty
          </p>
        </div>
        <h2
          className="font-display font-black italic uppercase leading-[0.88] text-muted-foreground/25"
          style={{ fontSize: "52px", letterSpacing: "-0.03em" }}
        >
          No One
          <br />
          Waiting
        </h2>
        <p className="mt-5 text-sm text-muted-foreground">Be the first in line.</p>
      </div>
    );
  }

  return (
    <div>
      {/* ── Header ───────────────────────────────────────── */}
      <div className="flex items-end justify-between pb-3 border-b-[2px] border-foreground/15">
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <span
              className="h-1.5 w-1.5 rounded-full bg-primary"
              style={{ animation: "status-pulse 1.4s ease-in-out infinite" }}
              aria-hidden="true"
            />
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.28em] text-primary">
              Live
            </p>
          </div>
          <h2
            className="font-display font-black italic uppercase leading-none text-foreground"
            style={{ fontSize: "48px", letterSpacing: "-0.025em" }}
          >
            Lineup
          </h2>
        </div>

        <div className="text-right pb-0.5">
          <div
            className="font-display font-black italic text-foreground/80 leading-none"
            style={{ fontSize: "48px", letterSpacing: "-0.02em" }}
          >
            {waitlist.length}
          </div>
          <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground mt-0.5">
            {waitlist.length === 1 ? "Player" : "Players"}
          </p>
        </div>
      </div>

      {/* ── Ordered list — no zone labels ────────────────── */}
      <div className="mt-1">
        {waitlist.map((entry, idx) => (
          <WaitlistRow
            key={entry.id}
            flipRef={registerFlip(entry.id)}
            entry={entry}
            position={idx + 1}
            isMe={entry.player_id === myPlayerId}
            isLast={idx === waitlist.length - 1}
          />
        ))}
      </div>

      <p className="mt-5 font-mono text-[9px] uppercase tracking-[0.20em] text-muted-foreground/35 text-center">
        Updates in real-time
      </p>
    </div>
  );
}

// ── Individual row ────────────────────────────────────────────

function WaitlistRow({
  entry,
  position,
  isMe,
  isLast,
  flipRef,
}: {
  entry: QueueEntryWithProfile;
  position: number;
  isMe: boolean;
  isLast: boolean;
  /** useFlipList ref — lets the list animate this row to its new rank. */
  flipRef: (el: HTMLElement | null) => void;
}) {
  const rankStr = String(position).padStart(2, "0");
  const skill = SKILL_ABBREV[entry.profile.skill_level];
  const isTop = position <= 4;
  const isOnDeck = entry.status === "on_deck";

  // ── "You" row — amber canvas (app-wide "you" hue) ─────────
  if (isMe) {
    return (
      <div
        ref={flipRef}
        className="grid items-center py-3.5 rounded-xl my-1"
        style={{
          backgroundColor: YOU_BG,
          gridTemplateColumns: "56px 1fr auto",
          gap: "0 10px",
          paddingLeft: "14px",
          paddingRight: "14px",
        }}
      >
        {/* Rank */}
        <div
          className="font-display font-black italic leading-none"
          style={{
            fontSize: "34px",
            letterSpacing: "-0.04em",
            color: YOU_RANK,
          }}
          aria-label={`Position ${position}`}
        >
          {rankStr}
        </div>

        {/* Player info */}
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span
              className="font-display font-black uppercase truncate leading-tight"
              style={{
                fontSize: "18px",
                letterSpacing: "0.02em",
                color: YOU_TEXT,
              }}
            >
              {entry.profile.display_name}
            </span>
            <span
              className="shrink-0 font-mono text-[9px] font-extrabold uppercase tracking-[0.18em]"
              style={{ color: YOU_TEXT_DIM }}
            >
              You
            </span>
            {isOnDeck && (
              <span className="shrink-0 rounded-full bg-amber-900/15 px-2 py-0.5 font-mono text-[9px] font-extrabold uppercase tracking-[0.18em] text-amber-950 ring-1 ring-amber-900/25">
                On Deck
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span
              className="font-mono text-[10px] font-bold uppercase tracking-[0.12em]"
              style={{ color: YOU_TEXT_DIM }}
            >
              {skill}
            </span>
            {entry.profile.vip_tag && entry.profile.vip_theme && (
              <VipTag tag={entry.profile.vip_tag} theme={entry.profile.vip_theme} />
            )}
          </div>
        </div>

        {/* GP stat */}
        <div className="text-right shrink-0">
          <div
            className="font-mono font-black tabular-nums leading-none"
            style={{ fontSize: "26px", color: YOU_TEXT }}
          >
            {entry.games_played}
          </div>
          <p
            className="font-mono text-[8px] uppercase tracking-[0.16em] mt-0.5"
            style={{ color: YOU_TEXT_DIM }}
          >
            GP
          </p>
        </div>
      </div>
    );
  }

  // ── Standard rows ─────────────────────────────────────────
  // Top-4 positions use full primary (emerald), rest fade to muted.
  // #1 gets slightly larger rank numeral for natural emphasis.
  const rankColor =
    position === 1 ? "text-primary" : isTop ? "text-primary/65" : "text-muted-foreground/35";

  const rankSize = position === 1 ? "30px" : isTop ? "28px" : "22px";
  const nameSize = isTop ? "17px" : "15px";
  const gpSize = isTop ? "20px" : "16px";

  return (
    <div
      ref={flipRef}
      className={`grid items-center py-3 transition-colors ${
        isOnDeck
          ? "bg-amber-50/60 dark:bg-amber-950/20 hover:bg-amber-50/80 dark:hover:bg-amber-950/30"
          : "hover:bg-muted/25"
      } ${isLast ? "" : "border-b border-border/50"}`}
      style={{
        gridTemplateColumns: "56px 1fr auto",
        gap: "0 10px",
        paddingLeft: "4px",
        paddingRight: "4px",
      }}
    >
      {/* Rank */}
      <div
        className={`font-display font-black italic leading-none ${rankColor}`}
        style={{ fontSize: rankSize, letterSpacing: "-0.04em" }}
        aria-label={`Position ${position}`}
      >
        {rankStr}
      </div>

      {/* Player info */}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span
            className={`font-display font-bold uppercase truncate leading-tight
              ${isTop ? "text-foreground" : "text-foreground/70"}`}
            style={{ fontSize: nameSize, letterSpacing: "0.02em" }}
          >
            {entry.profile.display_name}
          </span>
          {entry.profile.vip_tag && entry.profile.vip_theme && (
            <VipTag tag={entry.profile.vip_tag} theme={entry.profile.vip_theme} />
          )}
          {isOnDeck && (
            <span className="shrink-0 rounded-full bg-amber-100 dark:bg-amber-900/50 px-2 py-0.5 font-mono text-[9px] font-extrabold uppercase tracking-[0.15em] text-amber-700 dark:text-amber-300">
              On Deck
            </span>
          )}
        </div>
        <span
          className={`font-mono text-[10px] font-semibold uppercase tracking-[0.12em] mt-0.5 block
            ${isTop ? "text-muted-foreground/55" : "text-muted-foreground/40"}`}
        >
          {skill}
        </span>
      </div>

      {/* GP stat */}
      <div className="text-right shrink-0">
        <div
          className={`font-mono font-black tabular-nums leading-none
            ${isTop ? "text-foreground/75" : "text-muted-foreground/45"}`}
          style={{ fontSize: gpSize }}
        >
          {entry.games_played}
        </div>
        <p className="font-mono text-[8px] uppercase tracking-[0.16em] text-muted-foreground/35 mt-0.5">
          GP
        </p>
      </div>
    </div>
  );
}
