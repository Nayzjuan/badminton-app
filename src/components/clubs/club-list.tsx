"use client";

// ============================================================
// ClubList — /clubs roster with inline self-service "Leave club"
// ============================================================
// Each row is a Link to the club (primary action) with a sibling leave
// control (never nested inside the Link — that's invalid HTML and blocks
// the click). Leaving expands to an inline Yes/No confirm instead of a
// modal, then removes the row from local state on success.
// ============================================================

import Link from "next/link";
import { useState, useTransition } from "react";
import { LogOut, Loader2 } from "lucide-react";
import { leaveClub } from "@/app/actions/clubs";
import type { MyClub } from "@/lib/clubs";
import type { ClubRole } from "@/types/database";

const ROLE_LABEL: Record<ClubRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

export function ClubList({ initialClubs }: { initialClubs: MyClub[] }) {
  const [clubs, setClubs] = useState(initialClubs);

  function handleLeft(clubId: string) {
    setClubs((prev) => prev.filter((entry) => entry.club.id !== clubId));
  }

  return (
    <ul className="space-y-2.5">
      {clubs.map((entry) => (
        <ClubListRow key={entry.club.id} entry={entry} onLeft={handleLeft} />
      ))}
    </ul>
  );
}

function ClubListRow({ entry, onLeft }: { entry: MyClub; onLeft: (clubId: string) => void }) {
  const { club, role, activeSessions } = entry;
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleLeave() {
    setError(null);
    startTransition(async () => {
      const result = await leaveClub(club.id, club.slug);
      if (result.success) {
        onLeft(club.id);
      } else {
        setError(result.message);
        setConfirming(false);
      }
    });
  }

  return (
    <li className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-border dark:bg-card">
      <div className="flex items-stretch justify-between gap-2">
        <Link
          href={`/c/${club.slug}`}
          className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-5 py-4 transition-colors hover:bg-slate-50 dark:hover:bg-muted/40"
        >
          <p className="truncate font-bold text-slate-900 dark:text-foreground">{club.name}</p>
          <p className="font-mono text-[11px] text-slate-400 dark:text-muted-foreground">
            /c/{club.slug}
          </p>
        </Link>
        <div className="flex shrink-0 items-center gap-2 py-4 pr-5">
          {activeSessions > 0 && (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
              {activeSessions} live
            </span>
          )}
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:bg-muted dark:text-muted-foreground">
            {ROLE_LABEL[role]}
          </span>

          {!confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              aria-label={`Leave ${club.name}`}
              className="flex h-9 w-9 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-muted-foreground dark:hover:bg-red-950/40 dark:hover:text-red-400"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          ) : (
            <div className="flex items-center gap-1">
              <span className="text-[11px] font-medium text-slate-500 dark:text-muted-foreground">
                Leave?
              </span>
              <button
                type="button"
                onClick={handleLeave}
                disabled={pending}
                className="rounded-full bg-red-600 px-2 py-1 text-[11px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Yes"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={pending}
                className="rounded-full px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-100 disabled:opacity-50 dark:text-muted-foreground dark:hover:bg-muted"
              >
                No
              </button>
            </div>
          )}
        </div>
      </div>
      {error && <p className="px-5 pb-3 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
    </li>
  );
}
