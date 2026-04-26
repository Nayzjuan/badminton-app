"use client";

// ============================================================
// WaitlistTab — Full queue view for players
// ============================================================
// Clean, mobile-optimized list showing every waiting player:
// position number, name, skill badge, and games played.
// The current player's row is highlighted.
// ============================================================

import { ListOrdered } from "lucide-react";
import { SkillBadge } from "@/components/ui/skill-badge";
import { VipTag } from "@/components/ui/vip-tag";
import type { QueueEntryWithProfile } from "@/hooks/use-session-data";

interface WaitlistTabProps {
  waitlist: QueueEntryWithProfile[];
  myPlayerId: string;
  loading: boolean;
}

export function WaitlistTab({ waitlist, myPlayerId, loading }: WaitlistTabProps) {
  if (loading) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        Loading waitlist...
      </div>
    );
  }

  if (waitlist.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 dark:border-border bg-white dark:bg-card px-6 py-12 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100">
          <ListOrdered className="h-5 w-5 text-slate-400" />
        </div>
        <p className="text-sm font-medium text-slate-600 dark:text-foreground">
          No one is waiting
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          The queue is empty — join to be first in line!
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground">
          Waiting Queue
        </h2>
        <span className="rounded-full bg-slate-100 dark:bg-muted px-2.5 py-0.5 text-[10px] font-bold text-slate-600 dark:text-muted-foreground">
          {waitlist.length} player{waitlist.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* List */}
      <div className="rounded-2xl border border-slate-200 dark:border-border bg-white dark:bg-card overflow-hidden divide-y divide-slate-100 dark:divide-border">
        {waitlist.map((entry, idx) => {
          const isMe = entry.player_id === myPlayerId;
          const position = idx + 1;

          return (
            <div
              key={entry.id}
              className={`flex items-center gap-3 px-4 py-3 transition-colors
                          ${isMe ? "bg-amber-50/60 dark:bg-amber-950/20" : "hover:bg-slate-50/60 dark:hover:bg-muted/30"}`}
            >
              {/* Position badge */}
              <div
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold
                            ${
                              isMe
                                ? "bg-amber-500 dark:bg-amber-500 text-white"
                                : position <= 4
                                ? "bg-slate-800 dark:bg-slate-600 text-white"
                                : "bg-slate-100 dark:bg-muted text-slate-600 dark:text-muted-foreground"
                            }`}
              >
                {position}
              </div>

              {/* Player info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <p
                      className={`text-sm truncate ${
                        isMe
                          ? "font-bold text-amber-900 dark:text-amber-200"
                          : "font-semibold text-slate-900 dark:text-foreground"
                      }`}
                    >
                      {entry.profile.display_name}
                    </p>
                    {entry.profile.vip_tag && entry.profile.vip_theme && (
                      <VipTag tag={entry.profile.vip_tag} theme={entry.profile.vip_theme} />
                    )}
                    {isMe && (
                      <span className="text-[10px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                        You
                      </span>
                    )}
                  </div>
                </div>
                <SkillBadge level={entry.profile.skill_level} className="mt-0.5" />
              </div>

              {/* Games played */}
              <div className="shrink-0 text-right">
                <p className="text-xs font-semibold text-slate-500 dark:text-muted-foreground">
                  {entry.games_played}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  game{entry.games_played !== 1 ? "s" : ""}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
