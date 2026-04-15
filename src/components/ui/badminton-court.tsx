"use client";

// ============================================================
// BadmintonCourt — Shared top-down court UI component
// ============================================================
// A reusable court graphic that looks like a literal top-down
// badminton court. Used in both player LiveCourtsTab and the
// organizer ActiveCourts / OnDeckPanel.
//
// Features:
//   • Rich green court surface (bg-emerald-700)
//   • White inner court lines (ring inset)
//   • Dashed net line through the middle
//   • Player "jersey" pills on the court surface
//   • Optional header bar above court with badges
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
  // All court cards — active or on-deck — use the same rich green surface.
  const courtBg = "bg-emerald-700";
  const ringColor = "ring-white/70";

  return (
    <div
      className={`relative rounded-xl ${courtBg} ${ringColor}
                  ring-[3px] ring-inset overflow-hidden`}
    >
      {/* ── Service line markings (decorative) ─────────────── */}
      <div className="absolute inset-x-4 top-1/4 border-t border-white/20" />
      <div className="absolute inset-x-4 bottom-1/4 border-t border-white/20" />
      <div className="absolute inset-y-4 left-1/2 border-l border-white/15" />

      {/* ── Team A (top half) ──────────────────────────────── */}
      <div className="relative px-4 pt-5 pb-4">
        <p className="mb-3 text-center text-[10px] font-black uppercase tracking-[0.2em] text-white/50">
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
        <div className="flex-1 border-t-[3px] border-dashed border-white/60" />
        <span className="mx-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full
                         bg-white/20 text-[9px] font-black text-white/80 backdrop-blur-sm">
          VS
        </span>
        <div className="flex-1 border-t-[3px] border-dashed border-white/60" />
      </div>

      {/* ── Team B (bottom half) ───────────────────────────── */}
      <div className="relative px-4 pt-4 pb-5">
        <p className="mb-3 text-center text-[10px] font-black uppercase tracking-[0.2em] text-white/50">
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
// ─────────────────────────────────────────────────────────────

function PlayerPill({ player }: { player: PlayerInfo }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="rounded-full bg-white px-4 py-2 text-sm font-bold text-slate-900
                       shadow-md shadow-black/15">
        {player.display_name}
      </span>
      <SkillBadge
        level={player.skill_level}
        className="!bg-white/20 !text-white/90 text-[10px] backdrop-blur-sm"
      />
    </div>
  );
}
