"use client";

// ============================================================
// Session List — Clickable cards for active sessions
// ============================================================

import { useRouter } from "next/navigation";
import type { Session } from "@/types/database";

interface SessionListProps {
  sessions: Session[];
}

export function SessionList({ sessions }: SessionListProps) {
  const router = useRouter();

  return (
    <div className="space-y-3">
      {sessions.map((session) => (
        <button
          key={session.id}
          onClick={() => router.push(`/play/${session.id}`)}
          className="w-full rounded-xl border border-border bg-card p-4 text-left
                     transition-colors hover:bg-accent active:scale-[0.99]"
        >
          <p className="font-semibold text-foreground">{session.name}</p>
          <p className="text-xs text-muted-foreground mt-1">
            Scoring: {session.scoring === "single" ? "Single game" : session.scoring.replace(/_/g, " ")}
          </p>
        </button>
      ))}
    </div>
  );
}
