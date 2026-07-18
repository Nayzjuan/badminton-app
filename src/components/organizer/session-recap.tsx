// ============================================================
// SessionRecap — read-only recap of an ended session
// ============================================================
// Rendered when a club member opens a CLOSED session from the
// "Past Sessions" list. The live command center (OrganizerDashboard)
// is redirect-guarded for closed sessions — a stale live board would
// look joinable — so this read-only recap replaces that bounce,
// surfacing every completed/cancelled match of the session via the
// same MatchHistoryPanel the live dashboard's History tab uses.
// ============================================================

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { MatchHistoryPanel } from "./match-history-panel";
import { clubOrganizer } from "@/lib/club-paths";

interface SessionRecapProps {
  sessionId: string;
  sessionName: string;
  endedAt: string | null;
  clubSlug: string;
}

function formatEnded(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function SessionRecap({ sessionId, sessionName, endedAt, clubSlug }: SessionRecapProps) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 space-y-6">
      <Link
        href={clubOrganizer(clubSlug)}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground
                   hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to sessions
      </Link>

      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold text-foreground">{sessionName}</h1>
          <span
            className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold uppercase
                       tracking-wide text-muted-foreground"
          >
            Ended
          </span>
        </div>
        {endedAt && (
          <p className="text-sm text-muted-foreground">
            Ended {formatEnded(endedAt)} &middot; Read-only recap
          </p>
        )}
      </header>

      <MatchHistoryPanel sessionId={sessionId} />
    </div>
  );
}
