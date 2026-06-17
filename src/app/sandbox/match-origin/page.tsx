// ============================================================
// Sandbox preview — MatchOriginTag visual states
// Route: /sandbox/match-origin
// ============================================================
// Shows the 6 final_classification label states across the card
// contexts where the tag appears. No DB queries — hardcoded data.
// Safe to delete once the feature ships to production review.
// ============================================================

import { MatchOriginTag } from "@/components/organizer/match-origin-tag";
import type { MatchClassification } from "@/types/database";

const ALL: { c: MatchClassification; desc: string }[] = [
  { c: "auto_clean", desc: "Engine-generated, untouched — silent (nothing renders)" },
  { c: "auto_modified", desc: "Engine match, roster edited — muted Edited" },
  { c: "manual_clean", desc: "Organizer composed — amber Manual" },
  { c: "manual_modified", desc: "Manual match, later edited — Manual · Edited" },
  { c: "held_clean", desc: "Cross-court held draft — violet Held" },
  { c: "held_modified", desc: "Held draft, later edited — Held · Edited" },
];

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 text-xs font-bold uppercase tracking-widest text-muted-foreground">
      {children}
    </p>
  );
}

function HistoryCard({
  teams,
  score,
  c,
}: {
  teams: string;
  score: string;
  c: MatchClassification;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{teams}</span>
          <MatchOriginTag classification={c} />
        </div>
        <span className="font-mono text-sm tabular-nums text-foreground">{score}</span>
      </div>
    </div>
  );
}

export default function MatchOriginPreviewPage() {
  return (
    <div className="min-h-screen bg-background px-6 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8">
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            Sandbox / match-origin
          </p>
          <h1 className="mt-1 text-2xl font-black text-foreground">MatchOriginTag</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The 6 final_classification label states (created_method × modified?).
          </p>
        </div>

        <SectionLabel>1 — Label states in isolation</SectionLabel>
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-border bg-muted/30 p-6">
          {ALL.map(({ c, desc }) => (
            <div key={c} className="flex flex-col items-start gap-2">
              <div className="flex h-10 w-full items-center rounded-lg border border-border bg-card px-3">
                {c === "auto_clean" ? (
                  <span className="text-xs italic text-muted-foreground">(nothing rendered)</span>
                ) : (
                  <MatchOriginTag classification={c} />
                )}
              </div>
              <p className="text-xs font-mono font-bold text-foreground">{c}</p>
              <p className="text-xs text-muted-foreground">{desc}</p>
            </div>
          ))}
        </div>

        <div className="my-10" />

        <SectionLabel>2 — Match History rows</SectionLabel>
        <div className="space-y-3">
          <HistoryCard teams="Alex & Ben vs Chris & Dan" score="21 – 18" c="auto_clean" />
          <HistoryCard teams="Eve & Frank vs Grace & Hal" score="21 – 14" c="manual_clean" />
          <HistoryCard teams="Ivy & Jack vs Kim & Leo" score="21 – 19" c="auto_modified" />
          <HistoryCard teams="Mia & Ned vs Omar & Pia" score="21 – 12" c="held_modified" />
        </div>

        <p className="mt-12 text-center text-xs text-muted-foreground">
          Sandbox page — remove before final production review
        </p>
      </div>
    </div>
  );
}
