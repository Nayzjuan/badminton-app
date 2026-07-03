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

const ROLE_BADGE: Record<ClubRole, string> = {
  owner: "bg-command/12 text-command",
  admin: "bg-cc-blue-dim text-cc-blue",
  member: "bg-cc-bg-3 text-cc-t2",
};

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
    <li className="clip-cut overflow-hidden border border-cc-border bg-cc-bg-2">
      <div className="flex items-stretch justify-between gap-2">
        <Link
          href={`/c/${club.slug}`}
          className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-5 py-4 transition-colors hover:bg-cc-bg-3"
        >
          <p className="truncate font-display text-base font-bold uppercase italic tracking-tight text-cc-t1">
            {club.name}
          </p>
          <p className="font-mono text-[11px] text-cc-t3">/c/{club.slug}</p>
        </Link>
        <div className="flex shrink-0 items-center gap-2 py-4 pr-5">
          {activeSessions > 0 && (
            <span className="clip-cut-badge bg-cc-live-dim px-2 py-0.5 font-command text-[10px] font-bold uppercase tracking-wide text-cc-live">
              {activeSessions} live
            </span>
          )}
          <span
            className={`clip-cut-badge px-2.5 py-0.5 font-command text-[10px] font-bold uppercase tracking-wide ${ROLE_BADGE[role]}`}
          >
            {ROLE_LABEL[role]}
          </span>

          {!confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              aria-label={`Leave ${club.name}`}
              className="clip-cut-sm flex h-9 w-9 items-center justify-center text-cc-t3 transition-colors hover:bg-cc-red-dim hover:text-cc-red"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          ) : (
            <div className="flex items-center gap-1">
              <span className="font-command text-[11px] font-medium uppercase tracking-wide text-cc-t2">
                Leave?
              </span>
              <button
                type="button"
                onClick={handleLeave}
                disabled={pending}
                className="clip-cut-sm bg-cc-red px-2 py-1 text-[11px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Yes"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={pending}
                className="clip-cut-sm px-2 py-1 text-[11px] font-medium text-cc-t2 transition-colors hover:bg-cc-bg-3 disabled:opacity-50"
              >
                No
              </button>
            </div>
          )}
        </div>
      </div>
      {error && <p className="px-5 pb-3 text-[11px] text-cc-red">{error}</p>}
    </li>
  );
}
