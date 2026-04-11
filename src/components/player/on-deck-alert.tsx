"use client";

// ============================================================
// On-Deck Alert — Shows when player is assigned to a match
// ============================================================
// Displays different visual states:
//   • "on_deck" with queue status → "Get ready!" approaching alert
//   • "pending" match → "You're Next!" with court + player names
//   • "in_progress" match → "Now Playing" active state
// ============================================================

import { SkillBadge } from "@/components/ui/skill-badge";
import type { Court, Profile, MatchStatus, QueueStatus as QueueStatusType } from "@/types/database";

interface OnDeckAlertProps {
  matchStatus: MatchStatus | null;
  queueStatus: QueueStatusType | null;
  position: number | null;
  court: Court | null;
  teammates: Profile[];
  opponents: Profile[];
}

export function OnDeckAlert({
  matchStatus,
  queueStatus,
  position,
  court,
  teammates,
  opponents,
}: OnDeckAlertProps) {
  // Nothing to show if player is just waiting normally.
  if (!matchStatus && queueStatus === "waiting" && (position === null || position > 4)) {
    return null;
  }

  // Approaching alerts (4th, 3rd, 2nd in line).
  if (!matchStatus && queueStatus === "waiting" && position !== null && position <= 4) {
    const urgencyStyles =
      position <= 2
        ? "bg-amber-50 border-amber-400 text-amber-900"
        : "bg-blue-50 border-blue-300 text-blue-900";

    const label =
      position === 1
        ? "You're Next!"
        : position === 2
        ? "Almost there..."
        : position === 3
        ? "Get ready!"
        : "Coming up soon";

    return (
      <div
        className={`rounded-2xl border-2 p-5 text-center animate-in fade-in slide-in-from-top-2 duration-300 ${urgencyStyles}`}
      >
        <p className="text-sm font-medium uppercase tracking-wide opacity-75">
          #{position} in line
        </p>
        <p className="text-xl font-bold mt-1">{label}</p>
      </div>
    );
  }

  // Match assigned — pending (on-deck, about to go to court).
  if (matchStatus === "pending" || queueStatus === "on_deck") {
    return (
      <div className="rounded-2xl border-2 border-emerald-400 bg-emerald-50 p-5 text-center animate-in fade-in slide-in-from-top-2 duration-300">
        <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
          Match Ready
        </p>
        <p className="text-2xl font-bold text-emerald-900 mt-1">
          {court ? `Head to ${court.name}!` : "Court assigning..."}
        </p>

        {/* Player names */}
        <div className="mt-4 space-y-3">
          <div>
            <p className="text-xs font-medium text-emerald-600 uppercase tracking-wider">
              Your Partner
            </p>
            {teammates.length > 0 ? (
              teammates.map((t) => (
                <div key={t.id} className="flex items-center justify-center gap-1.5 mt-1">
                  <span className="text-base font-semibold text-emerald-900">
                    {t.display_name}
                  </span>
                  <SkillBadge level={t.skill_level} />
                </div>
              ))
            ) : (
              <p className="text-base font-semibold text-emerald-900 mt-0.5">Assigning...</p>
            )}
          </div>
          <div className="border-t border-emerald-200 pt-3">
            <p className="text-xs font-medium text-emerald-600 uppercase tracking-wider">
              Opponents
            </p>
            {opponents.length > 0 ? (
              opponents.map((o) => (
                <div key={o.id} className="flex items-center justify-center gap-1.5 mt-1">
                  <span className="text-base font-semibold text-emerald-900">
                    {o.display_name}
                  </span>
                  <SkillBadge level={o.skill_level} />
                </div>
              ))
            ) : (
              <p className="text-base font-semibold text-emerald-900 mt-0.5">Assigning...</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Match in progress — now playing.
  if (matchStatus === "in_progress" || queueStatus === "playing") {
    return (
      <div className="rounded-2xl border-2 border-violet-400 bg-violet-50 p-5 text-center">
        <p className="text-sm font-semibold uppercase tracking-wide text-violet-700">
          Now Playing
        </p>
        <p className="text-2xl font-bold text-violet-900 mt-1">
          {court?.name ?? "On Court"}
        </p>

        <div className="mt-4 flex items-start justify-center gap-4 text-sm">
          <div className="flex flex-col items-center gap-1">
            <p className="text-[10px] text-violet-600 uppercase font-medium">You &amp; Partner</p>
            {teammates.map((t) => (
              <div key={t.id} className="flex items-center gap-1.5">
                <span className="text-xs text-violet-800 font-semibold">{t.display_name}</span>
                <SkillBadge level={t.skill_level} />
              </div>
            ))}
          </div>
          <span className="text-violet-400 font-black text-lg mt-2">vs</span>
          <div className="flex flex-col items-center gap-1">
            <p className="text-[10px] text-violet-600 uppercase font-medium">Opponents</p>
            {opponents.map((o) => (
              <div key={o.id} className="flex items-center gap-1.5">
                <span className="text-xs text-violet-800 font-semibold">{o.display_name}</span>
                <SkillBadge level={o.skill_level} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
