"use client";

// ============================================================
// BadmintonCourt — Shared top-down court UI component
// ============================================================
// A reusable court graphic that looks like a literal top-down
// badminton court. Used in both player LiveCourtsTab and the
// organizer ActiveCourts / OnDeckPanel.
//
// Light mode: Rich emerald green court surface.
// Dark mode:  Vantablack/near-black surface (hsl(0 0% 2%)),
//             neon-cyan court lines, glowing neon-lime player pills.
// ============================================================

import { ArrowLeftRight } from "lucide-react";
import { SkillBadge } from "@/components/ui/skill-badge";
import { VipTag } from "@/components/ui/vip-tag";
import type { SkillLevel } from "@/types/database";

interface PlayerInfo {
  player_id: string;
  display_name: string;
  skill_level: SkillLevel;
  /** VIP display label, e.g. "DEV". null = no tag shown. */
  vip_tag?: string | null;
  /** VIP theme key, e.g. "cyber-neon". Must pair with vip_tag. */
  vip_theme?: string | null;
}

interface BadmintonCourtProps {
  teamA: PlayerInfo[];
  teamB: PlayerInfo[];
  /** If true, uses amber/muted styling for on-deck matches. */
  isOnDeck?: boolean;
  /**
   * When provided, each player pill becomes a clickable button that
   * opens the Tap-to-Swap sheet. The button carries both dnd-kit
   * isolation defences: data-no-dnd + onPointerDown stopPropagation.
   */
  onPlayerClick?: (player: PlayerInfo, team: "a" | "b") => void;
}

export function BadmintonCourt({
  teamA,
  teamB,
  isOnDeck = false,
  onPlayerClick,
}: BadmintonCourtProps) {
  return (
    <div
      className="relative rounded-xl bg-emerald-700 dark:bg-[hsl(0_0%_2%)]
                 ring-[3px] ring-inset ring-white/70 dark:ring-[hsl(var(--court-cyan-hsl))]/70
                 overflow-hidden"
    >
      {/* ── Service line markings (decorative) ─────────────── */}
      <div className="absolute inset-x-4 top-1/4 border-t border-white/20 dark:border-[hsl(var(--court-cyan-hsl))]/25" />
      <div className="absolute inset-x-4 bottom-1/4 border-t border-white/20 dark:border-[hsl(var(--court-cyan-hsl))]/25" />
      <div className="absolute inset-y-4 left-1/2 border-l border-white/15 dark:border-[hsl(180_100%_70%)]/20" />

      {/* ── Team A (top half) ──────────────────────────────── */}
      <div className="relative px-4 pt-5 pb-4">
        <p className="mb-3 text-center text-[10px] font-black uppercase tracking-[0.2em]
                      text-white/50 dark:text-[hsl(var(--court-cyan-hsl))]/60">
          Team A
        </p>
        <div className="flex items-center justify-center gap-3 flex-wrap">
          {teamA.map((p) => (
            <PlayerPill
              key={p.player_id}
              player={p}
              onPlayerClick={onPlayerClick ? (pl) => onPlayerClick(pl, "a") : undefined}
            />
          ))}
        </div>
      </div>

      {/* ── Net (center divider) ───────────────────────────── */}
      <div className="relative flex items-center px-3">
        <div className="flex-1 border-t border-dashed border-white/25 dark:border-[hsl(var(--court-cyan-hsl))]/40" />
        <span className="mx-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full
                         bg-white/20 dark:bg-[hsl(180_100%_50%)]/15
                         text-[9px] font-black text-white/80 dark:text-[hsl(var(--court-cyan-hsl))]
                         backdrop-blur-sm">
          VS
        </span>
        <div className="flex-1 border-t border-dashed border-white/25 dark:border-[hsl(var(--court-cyan-hsl))]/40" />
      </div>

      {/* ── Team B (bottom half) ───────────────────────────── */}
      <div className="relative px-4 pt-4 pb-5">
        <p className="mb-3 text-center text-[10px] font-black uppercase tracking-[0.2em]
                      text-white/50 dark:text-[hsl(var(--court-cyan-hsl))]/60">
          Team B
        </p>
        <div className="flex items-center justify-center gap-3 flex-wrap">
          {teamB.map((p) => (
            <PlayerPill
              key={p.player_id}
              player={p}
              onPlayerClick={onPlayerClick ? (pl) => onPlayerClick(pl, "b") : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// PlayerPill — Player "jersey" on the court
// Light: white bubble, dark text
// Dark:  near-transparent dark bubble, neon-lime glowing name
//
// When onPlayerClick is provided (on-deck cards) the pill becomes
// an interactive button. The swap icon (ArrowLeftRight) is always
// visible at 50% opacity, rising to 80% on hover — no hidden gap.
//
// dnd-kit isolation defences:
//   1. onPointerDown stopPropagation — hard stop, prevents any
//      dnd sensor from capturing the event before it reaches here
//   2. data-no-dnd="true"           — declarative opt-out label
//      for custom sensor constraint filtering (future-proof)
// ─────────────────────────────────────────────────────────────

interface PlayerPillProps {
  player: PlayerInfo;
  onPlayerClick?: (player: PlayerInfo) => void;
}

function PlayerPill({ player, onPlayerClick }: PlayerPillProps) {
  const pillContent = (
    <>
      <span
        className="inline-block max-w-[9rem] truncate rounded-full px-4 py-2 text-sm font-bold shadow-md
                   bg-white text-slate-900 shadow-black/15
                   dark:bg-black/60 dark:text-[hsl(var(--court-lime-hsl))]
                   dark:ring-1 dark:ring-[hsl(var(--court-lime-hsl))]/30"
        title={player.display_name}
      >
        {player.display_name}
      </span>
      {player.vip_tag && player.vip_theme && (
        <VipTag tag={player.vip_tag} theme={player.vip_theme} />
      )}
      <SkillBadge
        level={player.skill_level}
        className="!bg-white/20 !text-white/90 dark:!bg-[hsl(var(--court-cyan-hsl))]/10 dark:!text-[hsl(var(--court-cyan-hsl))] text-[10px] backdrop-blur-sm"
      />
    </>
  );

  if (!onPlayerClick) {
    return <div className="flex flex-col items-center gap-1">{pillContent}</div>;
  }

  return (
    <div className="flex flex-col items-center gap-1 group">
      <button
        // ── dnd-kit isolation: Defense 1 (hard stop) ──────────
        onPointerDown={(e) => e.stopPropagation()}
        // ── dnd-kit isolation: Defense 2 (declarative label) ──
        data-no-dnd="true"
        data-testid={`player-pill-${player.player_id}`}
        onClick={() => onPlayerClick(player)}
        aria-label={`Swap ${player.display_name}`}
        className="relative flex flex-col items-center gap-1
                   rounded-full transition-transform active:scale-95
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        {/* Name pill — swap icon always visible */}
        <span
          className="relative inline-flex items-center gap-1.5 max-w-[9rem] rounded-full px-3 py-2
                     text-sm font-bold shadow-md
                     bg-white text-slate-900 shadow-black/15
                     dark:bg-black/60 dark:text-[hsl(var(--court-lime-hsl))]
                     dark:ring-1 dark:ring-[hsl(var(--court-lime-hsl))]/30
                     group-hover:bg-slate-100 dark:group-hover:bg-[hsl(var(--court-lime-hsl))]/10
                     group-hover:ring-2 group-hover:ring-slate-300
                     dark:group-hover:ring-[hsl(var(--court-lime-hsl))]/50
                     transition-all duration-150"
          title={player.display_name}
        >
          <span className="min-w-0 truncate">{player.display_name}</span>
          <ArrowLeftRight
            className="h-3 w-3 shrink-0 opacity-50 group-hover:opacity-80
                       transition-opacity duration-150 text-slate-400
                       dark:text-[hsl(var(--court-lime-hsl))]"
          />
        </span>

        {player.vip_tag && player.vip_theme && (
          <VipTag tag={player.vip_tag} theme={player.vip_theme} />
        )}

        <SkillBadge
          level={player.skill_level}
          className="!bg-white/20 !text-white/90 dark:!bg-[hsl(var(--court-cyan-hsl))]/10 dark:!text-[hsl(var(--court-cyan-hsl))] text-[10px] backdrop-blur-sm"
        />
      </button>
    </div>
  );
}
