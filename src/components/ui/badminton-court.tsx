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

import { SkillBadge } from "@/components/ui/skill-badge";
import type { SkillLevel } from "@/types/database";

interface PlayerInfo {
  player_id: string;
  display_name: string;
  skill_level: SkillLevel;
}

interface BadmintonCourtProps {
  teamA: PlayerInfo[];
  teamB: PlayerInfo[];
  /** If true, uses amber/muted styling for on-deck matches. */
  isOnDeck?: boolean;
}

export function BadmintonCourt({
  teamA,
  teamB,
  isOnDeck = false,
}: BadmintonCourtProps) {
  return (
    <div
      className="relative rounded-xl bg-emerald-700 dark:bg-[hsl(0_0%_2%)]
                 ring-[3px] ring-inset ring-white/70 dark:ring-[hsl(180_100%_70%)]/70
                 overflow-hidden"
    >
      {/* ── Service line markings (decorative) ─────────────── */}
      <div className="absolute inset-x-4 top-1/4 border-t border-white/20 dark:border-[hsl(180_100%_70%)]/25" />
      <div className="absolute inset-x-4 bottom-1/4 border-t border-white/20 dark:border-[hsl(180_100%_70%)]/25" />
      <div className="absolute inset-y-4 left-1/2 border-l border-white/15 dark:border-[hsl(180_100%_70%)]/20" />

      {/* ── Team A (top half) ──────────────────────────────── */}
      <div className="relative px-4 pt-5 pb-4">
        <p className="mb-3 text-center text-[10px] font-black uppercase tracking-[0.2em]
                      text-white/50 dark:text-[hsl(180_100%_70%)]/60">
          Team A
        </p>
        <div className="flex items-center justify-center gap-3 flex-wrap">
          {teamA.map((p) => (
            <PlayerPill key={p.player_id} player={p} />
          ))}
        </div>
      </div>

      {/* ── Net (center divider) ───────────────────────────── */}
      <div className="relative flex items-center px-3">
        <div className="flex-1 border-t-[3px] border-dashed border-white/60 dark:border-[hsl(180_100%_70%)]" />
        <span className="mx-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full
                         bg-white/20 dark:bg-[hsl(180_100%_50%)]/15
                         text-[9px] font-black text-white/80 dark:text-[hsl(180_100%_70%)]
                         backdrop-blur-sm">
          VS
        </span>
        <div className="flex-1 border-t-[3px] border-dashed border-white/60 dark:border-[hsl(180_100%_70%)]" />
      </div>

      {/* ── Team B (bottom half) ───────────────────────────── */}
      <div className="relative px-4 pt-4 pb-5">
        <p className="mb-3 text-center text-[10px] font-black uppercase tracking-[0.2em]
                      text-white/50 dark:text-[hsl(180_100%_70%)]/60">
          Team B
        </p>
        <div className="flex items-center justify-center gap-3 flex-wrap">
          {teamB.map((p) => (
            <PlayerPill key={p.player_id} player={p} />
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
// ─────────────────────────────────────────────────────────────

function PlayerPill({ player }: { player: PlayerInfo }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span
        className="rounded-full px-4 py-2 text-sm font-bold shadow-md
                   bg-white text-slate-900 shadow-black/15
                   dark:bg-black/60 dark:text-[hsl(80_100%_60%)]
                   dark:[text-shadow:0_0_10px_hsl(80_100%_60%/0.7)]
                   dark:ring-1 dark:ring-[hsl(80_100%_60%)]/30"
      >
        {player.display_name}
      </span>
      <SkillBadge
        level={player.skill_level}
        className="!bg-white/20 !text-white/90 dark:!bg-[hsl(180_100%_50%)]/10 dark:!text-[hsl(180_100%_75%)] text-[10px] backdrop-blur-sm"
      />
    </div>
  );
}
