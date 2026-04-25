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
//
// Team identity: Team A = sky-blue dot, Team B = amber dot.
// Each pill carries a small colored circle so teammates are
// visually grouped at a glance even across the VS divider.
//
// Tap-to-Swap v2 visual state (on-deck only):
//   selectedPlayerId   — this player's pill gets the amber ring
//                        + scale-up ("I'm the one being swapped")
//   isSwapModeActive   — all OTHER tappable pills show the
//                        valid-target treatment (amber border on
//                        hover, cursor:pointer, subtle scale)
//   Neither prop set   — idle state (existing hover ring only)
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
   * opens the Tap-to-Swap interaction. The button carries both dnd-kit
   * isolation defences: data-no-dnd + onPointerDown stopPropagation.
   */
  onPlayerClick?: (player: PlayerInfo, team: "a" | "b") => void;
  /**
   * The player_id of the currently selected (first-tapped) player.
   * That pill gets an amber ring + slight scale-up.
   * Only meaningful when onPlayerClick is set and picking mode is active.
   */
  selectedPlayerId?: string;
  /**
   * When true and a player has been selected, all OTHER tappable pills
   * show the valid-target treatment (amber hover border + cursor-pointer).
   * When false or absent, pills use the standard idle hover ring.
   */
  isSwapModeActive?: boolean;
}

export function BadmintonCourt({
  teamA,
  teamB,
  isOnDeck = false,
  onPlayerClick,
  selectedPlayerId,
  isSwapModeActive = false,
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

      {/* ── Team A (top half) — sky-blue identity ──────────── */}
      <div className="relative px-4 pt-5 pb-4">
        <p className="mb-3 text-center text-[10px] font-black uppercase tracking-[0.2em]
                      text-white/50 dark:text-[hsl(var(--court-cyan-hsl))]/60">
          Team A
        </p>
        <div className="grid grid-cols-2 gap-3">
          {teamA.map((p) => (
            <PlayerPill
              key={p.player_id}
              player={p}
              team="a"
              onPlayerClick={onPlayerClick ? (pl) => onPlayerClick(pl, "a") : undefined}
              isSelected={selectedPlayerId === p.player_id}
              isValidTarget={isSwapModeActive && selectedPlayerId !== p.player_id}
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

      {/* ── Team B (bottom half) — amber identity ──────────── */}
      <div className="relative px-4 pt-4 pb-5">
        <p className="mb-3 text-center text-[10px] font-black uppercase tracking-[0.2em]
                      text-white/50 dark:text-[hsl(var(--court-cyan-hsl))]/60">
          Team B
        </p>
        <div className="grid grid-cols-2 gap-3">
          {teamB.map((p) => (
            <PlayerPill
              key={p.player_id}
              player={p}
              team="b"
              onPlayerClick={onPlayerClick ? (pl) => onPlayerClick(pl, "b") : undefined}
              isSelected={selectedPlayerId === p.player_id}
              isValidTarget={isSwapModeActive && selectedPlayerId !== p.player_id}
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
// Team identity dot: sky-blue for team A, amber for team B.
// Sits at the leading edge of the pill so teammates share a
// consistent color cue regardless of name length or VIP tag.
//
// Tap-to-Swap v2 visual states (on-deck only, when onPlayerClick set):
//   isSelected    — amber ring-2, ring-offset-1, scale-105
//                   ("this player is selected for swapping out")
//   isValidTarget — amber border + amber-tinted hover bg
//                   ("tap me to swap with the selected player")
//   idle          — existing white ring on hover (default)
//
// VIP tag display is preserved in all three states — the tag
// is always rendered inside the pill bubble, unaffected by
// ring/border/scale changes which are on the outer button wrapper.
//
// dnd-kit isolation defences:
//   1. onPointerDown stopPropagation — hard stop, prevents any
//      dnd sensor from capturing the event before it reaches here
//   2. data-no-dnd="true"           — declarative opt-out label
//      for custom sensor constraint filtering (future-proof)
// ─────────────────────────────────────────────────────────────

interface PlayerPillProps {
  player: PlayerInfo;
  team: "a" | "b";
  onPlayerClick?: (player: PlayerInfo) => void;
  /** This pill is the first-tapped player in picking mode. */
  isSelected?: boolean;
  /** Swap mode is active and this is NOT the selected player. */
  isValidTarget?: boolean;
}

function PlayerPill({ player, team, onPlayerClick, isSelected = false, isValidTarget = false }: PlayerPillProps) {
  const teamDot = (
    <span
      aria-hidden
      className={[
        "inline-block h-2 w-2 shrink-0 rounded-full",
        team === "a" ? "bg-sky-400" : "bg-amber-400",
      ].join(" ")}
    />
  );

  // ── Inner pill bubble — identical for static + interactive ──
  // VIP tag is always inside this bubble so it's unaffected by
  // the outer button's ring/border changes.
  const pillBubble = (isInteractive: boolean) => (
    <span
      className={[
        "relative inline-flex items-center gap-1.5 rounded-full px-3 py-2",
        "text-sm font-bold shadow-md",
        "bg-white text-slate-900 shadow-black/15",
        "dark:bg-black/60 dark:text-[hsl(var(--court-lime-hsl))]",
        "dark:ring-1 dark:ring-[hsl(var(--court-lime-hsl))]/30",
        isInteractive && !isSelected && !isValidTarget
          ? "group-hover:bg-slate-100 dark:group-hover:bg-[hsl(var(--court-lime-hsl))]/10 group-hover:ring-2 group-hover:ring-slate-300 dark:group-hover:ring-[hsl(var(--court-lime-hsl))]/50"
          : "",
        // Selected state: amber-tinted bubble
        isSelected
          ? "ring-0 bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200 dark:ring-1 dark:ring-amber-500/60"
          : "",
        // Valid-target state: amber border on hover
        isValidTarget && !isSelected
          ? "group-hover:bg-amber-50 dark:group-hover:bg-amber-950/40 group-hover:ring-2 group-hover:ring-amber-400 dark:group-hover:ring-amber-500/60"
          : "",
        "transition-all duration-150",
      ].filter(Boolean).join(" ")}
      title={player.display_name}
    >
      {teamDot}
      <span className="min-w-0 max-w-[6rem] truncate">{player.display_name}</span>
      {player.vip_tag && player.vip_theme && (
        <>
          <span className="shrink-0 select-none font-normal text-slate-300 dark:text-white/20">|</span>
          <VipTag tag={player.vip_tag} theme={player.vip_theme} />
        </>
      )}
      {isInteractive && (
        <ArrowLeftRight
          className={[
            "h-3 w-3 shrink-0 transition-opacity duration-150",
            isSelected
              ? "opacity-90 text-amber-600 dark:text-amber-400"
              : isValidTarget
                ? "opacity-40 group-hover:opacity-70 text-amber-500 dark:text-amber-400"
                : "opacity-50 group-hover:opacity-80 text-slate-400 dark:text-[hsl(var(--court-lime-hsl))]",
          ].join(" ")}
        />
      )}
    </span>
  );

  const skillBadge = (
    <SkillBadge
      level={player.skill_level}
      className="!bg-white/20 !text-white/90 dark:!bg-[hsl(var(--court-cyan-hsl))]/10 dark:!text-[hsl(var(--court-cyan-hsl))] text-[10px] backdrop-blur-sm"
    />
  );

  if (!onPlayerClick) {
    return (
      <div className="flex flex-col items-center gap-1">
        {pillBubble(false)}
        {skillBadge}
      </div>
    );
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
        aria-label={
          isSelected
            ? `${player.display_name} selected — tap another player to swap, or tap again to cancel`
            : isValidTarget
              ? `Swap with ${player.display_name}`
              : `Swap out ${player.display_name}`
        }
        aria-pressed={isSelected}
        className={[
          "relative flex flex-col items-center gap-1 rounded-full transition-transform",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
          // Selected: lifted + amber ring around the entire button
          isSelected
            ? "scale-105 ring-2 ring-amber-400 ring-offset-2 ring-offset-emerald-700 dark:ring-offset-[hsl(0_0%_2%)]"
            : "",
          // Valid target: scale on hover
          isValidTarget && !isSelected
            ? "hover:scale-[1.03] active:scale-95"
            : "active:scale-95",
        ].filter(Boolean).join(" ")}
      >
        {pillBubble(true)}
        {skillBadge}
      </button>
    </div>
  );
}
