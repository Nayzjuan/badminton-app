"use client";

// ============================================================
// WaitlistTab — Live Standings Board
// ============================================================
// Sporty scoreboard: zero-padded Barlow Condensed rank nums,
// "you" row in electric indigo canvas, JetBrains Mono GP stats,
// BEG/INT/ADV abbreviations. One clean ordered list — no zone
// labels. Rank colour fades with position for visual hierarchy.
//
// Light + dark mode: semantic tokens + fixed OKLCH where needed.
// ============================================================

import { VipTag } from "@/components/ui/vip-tag";
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

// Electric indigo — the "you are here" colour.
// Fixed OKLCH so it renders identically in light and dark modes.
// White text (oklch 0.97) on oklch(0.55 L) ≈ 5:1 contrast.
const YOU_BG = "oklch(0.55 0.24 270)";
const YOU_TEXT = "oklch(0.97 0.008 270)";
const YOU_TEXT_DIM = "oklch(0.97 0.008 270 / 0.65)";
const YOU_RANK = "oklch(0.86 0.14 270)";

export function WaitlistTab({ waitlist, myPlayerId, loading }: WaitlistTabProps) {
  if (loading) {
    return (
      <div className="py-16 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.20em] text-muted-foreground">
          Loading…
        </p>
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
}: {
  entry: QueueEntryWithProfile;
  position: number;
  isMe: boolean;
  isLast: boolean;
}) {
  const rankStr = String(position).padStart(2, "0");
  const skill = SKILL_ABBREV[entry.profile.skill_level];
  const isTop = position <= 4;

  // ── "You" row — electric indigo canvas ───────────────────
  if (isMe) {
    return (
      <div
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
      className={`grid items-center py-3 transition-colors hover:bg-muted/25 ${
        isLast ? "" : "border-b border-border/50"
      }`}
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
