// ============================================================
// Sandbox preview — MatchOriginTag visual states
// Route: /sandbox/match-origin
// ============================================================
// Shows all three origin label states (auto / manual / modified)
// rendered in the card contexts where they actually appear:
//   • Court card header (Active Courts tab)
//   • On-deck card    (On Deck panel)
//   • Match history   (History tab)
//
// No database queries — all data is hardcoded.
// Safe to delete once the feature ships to production review.
// ============================================================

import { MatchOriginTag } from "@/components/organizer/match-origin-tag";
import type { MatchOrigin } from "@/types/database";

// ── Tiny helpers for the mockup cards ──────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 text-xs font-bold uppercase tracking-widest text-muted-foreground">
      {children}
    </p>
  );
}

function Divider() {
  return <hr className="my-10 border-border" />;
}

// ── Court Card Header mockup ────────────────────────────────

function CourtCardHeader({
  courtName,
  origin,
  isMixed,
  statusLabel,
  statusCls,
}: {
  courtName: string;
  origin: MatchOrigin;
  isMixed?: boolean;
  statusLabel: string;
  statusCls: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-[hsl(217_30%_14%)] shadow-md">
      {/* Header row — mirrors active-courts.tsx */}
      <div className="flex flex-wrap items-center justify-between gap-y-2 border-b border-white/10 px-5 py-3">
        {/* Left: name + badges + origin tag */}
        <div className="flex items-center gap-2">
          <h3 className="truncate text-base font-bold text-white">{courtName}</h3>
          {isMixed && (
            <span className="shrink-0 rounded-full border border-amber-500/50 bg-amber-500/20 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-amber-400">
              Mixed Level
            </span>
          )}
          <MatchOriginTag origin={origin} />
        </div>
        {/* Right: status badge */}
        <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-bold uppercase tracking-widest ${statusCls}`}>
          {statusLabel}
        </span>
      </div>
      {/* Body stub */}
      <div className="px-5 py-4 text-xs text-white/30 italic">
        (court body — players / VS graphic)
      </div>
    </div>
  );
}

// ── On-Deck Card Header mockup ──────────────────────────────

function OnDeckCard({
  matchLabel,
  origin,
  isMixed,
}: {
  matchLabel: string;
  origin: MatchOrigin;
  isMixed?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{matchLabel}</span>
          {isMixed && (
            <span className="rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-800 dark:border-amber-500/50 dark:bg-amber-500/20 dark:text-amber-400">
              Mixed
            </span>
          )}
          <MatchOriginTag origin={origin} />
        </div>
        <span className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-bold uppercase tracking-widest text-amber-700 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-400">
          On Deck
        </span>
      </div>
      <div className="px-4 py-3 text-xs text-muted-foreground italic">
        (team A vs team B players)
      </div>
    </div>
  );
}

// ── Match History Row mockup ────────────────────────────────

function HistoryCard({
  teams,
  score,
  origin,
}: {
  teams: string;
  score: string;
  origin: MatchOrigin;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{teams}</span>
          <MatchOriginTag origin={origin} />
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm tabular-nums text-foreground">{score}</span>
          <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 text-xs font-bold uppercase tracking-widest text-emerald-700 dark:border-emerald-500/50 dark:bg-emerald-500/10 dark:text-emerald-400">
            Done
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Isolated label showcase ─────────────────────────────────

function LabelShowcase({ origin, desc }: { origin: MatchOrigin; desc: string }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex h-12 w-40 items-center justify-center rounded-lg border border-border bg-card">
        {origin === "auto" ? (
          <span className="text-xs italic text-muted-foreground">(nothing rendered)</span>
        ) : (
          <MatchOriginTag origin={origin} />
        )}
      </div>
      <div className="text-center">
        <p className="text-xs font-mono font-bold text-foreground">
          origin: &ldquo;{origin}&rdquo;
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────

export default function MatchOriginPreviewPage() {
  return (
    <div className="min-h-screen bg-background px-6 py-10">
      <div className="mx-auto max-w-2xl">
        {/* Header */}
        <div className="mb-8">
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            Sandbox / match-origin
          </p>
          <h1 className="mt-1 text-2xl font-black text-foreground">
            MatchOriginTag
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Visual preview of the three origin label states across every card
            context where they appear in the organizer dashboard.
          </p>
        </div>

        {/* ── 1. Isolated label states ─────────────────── */}
        <SectionLabel>1 — Label states in isolation</SectionLabel>
        <div className="flex flex-wrap items-start justify-around gap-6 rounded-xl border border-border bg-muted/30 p-6">
          <LabelShowcase origin="auto"     desc="Engine-generated — silent" />
          <LabelShowcase origin="manual"   desc="Organizer composed — amber" />
          <LabelShowcase origin="modified" desc="Engine match, edited — muted" />
        </div>

        <Divider />

        {/* ── 2. Active Court cards ────────────────────── */}
        <SectionLabel>2 — Active Court cards (dark theme)</SectionLabel>
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs text-muted-foreground">Auto (default) — no label</p>
            <CourtCardHeader
              courtName="Court 1"
              origin="auto"
              statusLabel="In Progress"
              statusCls="border-emerald-500/50 bg-emerald-500/20 text-emerald-400"
            />
          </div>
          <div>
            <p className="mb-2 text-xs text-muted-foreground">Manual — amber MANUAL label</p>
            <CourtCardHeader
              courtName="Court 2"
              origin="manual"
              statusLabel="In Progress"
              statusCls="border-emerald-500/50 bg-emerald-500/20 text-emerald-400"
            />
          </div>
          <div>
            <p className="mb-2 text-xs text-muted-foreground">
              Modified + Mixed Level — both badges visible
            </p>
            <CourtCardHeader
              courtName="Court 3"
              origin="modified"
              isMixed
              statusLabel="In Progress"
              statusCls="border-emerald-500/50 bg-emerald-500/20 text-emerald-400"
            />
          </div>
          <div>
            <p className="mb-2 text-xs text-muted-foreground">Manual + Mixed Level — stacked badges</p>
            <CourtCardHeader
              courtName="Court 4"
              origin="manual"
              isMixed
              statusLabel="Pending"
              statusCls="border-amber-500/50 bg-amber-500/10 text-amber-400"
            />
          </div>
        </div>

        <Divider />

        {/* ── 3. On-Deck panel cards ───────────────────── */}
        <SectionLabel>3 — On-Deck panel cards (light/dark adaptive)</SectionLabel>
        <div className="space-y-3">
          <div>
            <p className="mb-2 text-xs text-muted-foreground">Auto — no label</p>
            <OnDeckCard matchLabel="Match #7" origin="auto" />
          </div>
          <div>
            <p className="mb-2 text-xs text-muted-foreground">Manual</p>
            <OnDeckCard matchLabel="Match #8" origin="manual" />
          </div>
          <div>
            <p className="mb-2 text-xs text-muted-foreground">Modified + Mixed</p>
            <OnDeckCard matchLabel="Match #9" origin="modified" isMixed />
          </div>
        </div>

        <Divider />

        {/* ── 4. Match History rows ────────────────────── */}
        <SectionLabel>4 — Match History rows</SectionLabel>
        <div className="space-y-3">
          <HistoryCard teams="Alex & Ben  vs  Chris & Dan"  score="21 – 18" origin="auto" />
          <HistoryCard teams="Eve & Frank vs  Grace & Hal"  score="21 – 14" origin="manual" />
          <HistoryCard teams="Ivy & Jack  vs  Kim & Leo"    score="21 – 19" origin="modified" />
        </div>

        {/* Footer */}
        <p className="mt-12 text-center text-xs text-muted-foreground">
          Sandbox page — remove before final production review
        </p>
      </div>
    </div>
  );
}
