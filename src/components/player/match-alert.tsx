"use client";

// ============================================================
// MatchAlert — Full-screen slide-up takeover
// ============================================================
// Mounts as an absolute overlay over the main content area
// (header + bottom tab bar remain visible). Slides up from
// the bottom with an expo-out curve.
//
// Two states:
//   "pending"     → amber canvas, "Heads Up." hero (large, Barlow),
//                   optional position chip when not next up.
//   "in_progress" → dark navy canvas, massive COURT N hero
//                   with pulsing dot. ScoreInputCard via scoreSlot.
//
// Animation intentionally differs:
//   pending     — 550ms, soft expo-out (breathe, "get ready")
//   in_progress — 380ms, sharp expo-out (snap to action)
// ============================================================

import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import type { Court, Profile, SkillLevel } from "@/types/database";

// ── Types ─────────────────────────────────────────────────────

interface MatchAlertProps {
  matchStatus: "pending" | "in_progress";
  court: Court | null;
  myDisplayName: string;
  mySkillLevel: SkillLevel;
  teammates: Profile[];
  opponents: Profile[];
  isMixedLevel?: boolean;
  /** 1-based position among pending on-deck matches (1 = next court). */
  onDeckPosition?: number | null;
  /** Total pending on-deck matches right now. */
  totalOnDeck?: number;
  /** Optional leave-queue callback rendered inside the overlay. */
  onLeaveQueue?: () => Promise<{ error?: string } | void>;
  /** Score input slot — rendered inside the in_progress overlay. */
  scoreSlot?: ReactNode;
}

// ── Skill tier map — 3 tiers for quick scanning ──────────────
// 6 raw levels collapsed to 3 readable abbreviations.
// Dot color + label both shown for redundancy.

const SKILL_TIER: Record<SkillLevel, { label: string; dotCls: string }> = {
  beginner: { label: "BEG", dotCls: "bg-emerald-400" },
  lower_intermediate: { label: "BEG", dotCls: "bg-emerald-400" },
  intermediate: { label: "INT", dotCls: "bg-sky-400" },
  upper_intermediate: { label: "INT", dotCls: "bg-sky-500" },
  lower_advanced: { label: "ADV", dotCls: "bg-purple-400" },
  advanced: { label: "ADV", dotCls: "bg-purple-500" },
};

// ── Player row inside the teams grid ──────────────────────────

function PlayerRow({
  name,
  skill,
  isMe = false,
  tone,
}: {
  name: string;
  skill: SkillLevel;
  isMe?: boolean;
  tone: "amber" | "navy";
}) {
  const tier = SKILL_TIER[skill];

  // Amber tone is always on a bright amber canvas (oklch 0.78 0.17 62) —
  // no dark: overrides needed; text stays dark in both light and dark mode.
  // Navy tone uses semantic tokens so it works on both the dark bg (dark mode)
  // and the light bg (light mode) versions of the in_progress overlay.
  const tierLabelCls = tone === "amber" ? "text-amber-900/60" : "text-muted-foreground/70";

  const nameCls = isMe
    ? tone === "amber"
      ? "font-bold text-amber-950"
      : "font-bold text-foreground"
    : tone === "amber"
      ? "font-medium text-amber-900/80"
      : "font-medium text-foreground/80";

  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tier.dotCls}`} />
      <span
        className={`shrink-0 font-mono text-[9px] font-bold uppercase tracking-[0.1em] ${tierLabelCls}`}
      >
        {tier.label}
      </span>
      <span className={`flex-1 truncate text-sm ${nameCls}`}>{name}</span>
      {isMe && (
        <span
          className={`ml-1 shrink-0 text-[9px] font-bold uppercase tracking-[0.14em] leading-none
            ${tone === "amber" ? "text-emerald-700" : "text-primary dark:text-emerald-400"}`}
        >
          You
        </span>
      )}
    </div>
  );
}

// ── Teams grid (Your Team | VS | Opponents) ──────────────────

function TeamsGrid({
  me,
  teammates,
  opponents,
  tone,
}: {
  me: { name: string; skill: SkillLevel };
  teammates: Profile[];
  opponents: Profile[];
  tone: "amber" | "navy";
}) {
  const partner = teammates[0] ?? null;
  const opp1 = opponents[0] ?? null;
  const opp2 = opponents[1] ?? null;

  // Amber canvas is always bright; no dark: variants for amber tone.
  const labelCls = tone === "amber" ? "text-amber-800/90" : "text-muted-foreground";

  const vsCls = tone === "amber" ? "text-amber-800/80" : "text-muted-foreground/60";

  return (
    <div className="grid grid-cols-[1fr_auto_1fr] gap-x-3 items-start">
      <div>
        <p className={`mb-2 text-[10px] font-bold uppercase tracking-[0.14em] ${labelCls}`}>
          Your Team
        </p>
        <PlayerRow name={me.name} skill={me.skill} isMe tone={tone} />
        {partner ? (
          <PlayerRow name={partner.display_name} skill={partner.skill_level} tone={tone} />
        ) : (
          <div className="py-1.5 text-sm opacity-30">·</div>
        )}
      </div>
      <div className={`pt-7 text-[11px] font-bold tracking-[0.1em] ${vsCls}`}>VS</div>
      <div>
        <p className={`mb-2 text-[10px] font-bold uppercase tracking-[0.14em] ${labelCls}`}>
          Opponents
        </p>
        {opp1 ? (
          <PlayerRow name={opp1.display_name} skill={opp1.skill_level} tone={tone} />
        ) : (
          <div className="py-1.5 text-sm opacity-30">·</div>
        )}
        {opp2 ? (
          <PlayerRow name={opp2.display_name} skill={opp2.skill_level} tone={tone} />
        ) : (
          <div className="py-1.5 text-sm opacity-30">·</div>
        )}
      </div>
    </div>
  );
}

// ── Mixed Level banner ────────────────────────────────────────

function MixedLevelBanner({ tone }: { tone: "amber" | "navy" }) {
  return (
    <div
      className={`mx-6 mt-3 flex items-center justify-center gap-2 rounded-lg px-3 py-2
        ${
          tone === "amber"
            ? "bg-amber-900/15 ring-1 ring-amber-900/25"
            : "bg-amber-50 dark:bg-amber-500/10 ring-1 ring-amber-200 dark:ring-amber-500/30"
        }`}
    >
      <AlertTriangle
        className={`h-3.5 w-3.5 shrink-0 ${
          tone === "amber" ? "text-amber-900" : "text-amber-600 dark:text-amber-400"
        }`}
        aria-hidden="true"
      />
      <span
        className={`text-[10px] font-extrabold uppercase tracking-[0.14em]
          ${tone === "amber" ? "text-amber-900" : "text-amber-700 dark:text-amber-300"}`}
      >
        Mixed Level Match
      </span>
    </div>
  );
}

// ── Main Export ───────────────────────────────────────────────

export function MatchAlert({
  matchStatus,
  court,
  myDisplayName,
  mySkillLevel,
  teammates,
  opponents,
  isMixedLevel = false,
  onDeckPosition = null,
  totalOnDeck = 0,
  onLeaveQueue,
  scoreSlot,
}: MatchAlertProps) {
  const me = { name: myDisplayName, skill: mySkillLevel };

  // Slide-up animation — trigger on mount via state flip.
  // Two rAF IDs must both be cancellable from effect cleanup.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let r2 = 0;
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => setVisible(true));
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, []);

  // ── In Progress — snappy (380ms), action-immediate ──────────
  if (matchStatus === "in_progress") {
    return (
      <div
        role="alert"
        aria-label={`Match starting${court ? ` — head to ${court.name}` : ""}`}
        className="absolute inset-0 z-30 flex flex-col overflow-y-auto bg-background"
        style={{
          transform: visible ? "translateY(0)" : "translateY(100%)",
          transition: "transform 380ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        <div className="flex items-center justify-end px-6 pt-4">
          <span
            className="h-2 w-2 rounded-full bg-emerald-500"
            style={{ animation: "status-pulse 1.4s ease-in-out infinite" }}
            aria-hidden="true"
          />
        </div>

        <div className="px-6 pt-3">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 dark:bg-emerald-500/15 ring-1 ring-emerald-200 dark:ring-emerald-500/30 px-2.5 py-1">
            <span
              className="h-1.5 w-1.5 rounded-full bg-emerald-500"
              style={{ animation: "status-pulse 1.4s ease-in-out infinite" }}
            />
            <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-700 dark:text-emerald-300">
              Match in Progress
            </span>
          </span>
        </div>

        <div className="px-6 pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Active Court
          </p>
          <h2
            className="mt-1 font-display font-black leading-none tracking-tight text-primary dark:text-emerald-400"
            style={{ fontSize: "clamp(48px, 14vw, 72px)" }}
          >
            {court ? court.name.toUpperCase() : "COURT"}
          </h2>
        </div>

        {isMixedLevel && <MixedLevelBanner tone="navy" />}

        <div className="my-5 mx-6 h-px bg-border" />

        <div className="px-6">
          <TeamsGrid me={me} teammates={teammates} opponents={opponents} tone="navy" />
        </div>

        {scoreSlot && <div className="px-6 pt-5">{scoreSlot}</div>}

        {onLeaveQueue && (
          <div className="mt-auto px-6 pt-4 pb-5">
            <LeaveQueueButton tone="navy" onClick={onLeaveQueue} />
          </div>
        )}
      </div>
    );
  }

  // ── On Deck (pending) — breathing room (550ms) ───────────────
  const isNextUp = onDeckPosition === null || onDeckPosition === 1;

  const pillText = isNextUp ? "You're On Deck" : `${onDeckPosition} of ${totalOnDeck} on deck`;

  const subText = isNextUp ? "Coming Up Next" : `#${onDeckPosition} On Deck`;

  const detailText = isNextUp
    ? "Find your team — a court is opening soon"
    : onDeckPosition === 2
      ? "1 match ahead — get warmed up"
      : `${(onDeckPosition ?? 1) - 1} matches ahead — be ready soon`;

  return (
    <div
      role="alert"
      aria-label="You're on deck — a court is opening soon"
      className="absolute inset-0 z-30 flex flex-col"
      style={{
        backgroundColor: "oklch(0.78 0.17 62)",
        transform: visible ? "translateY(0)" : "translateY(100%)",
        transition: "transform 550ms cubic-bezier(0.22, 1, 0.36, 1)",
      }}
    >
      <div className="flex items-center justify-end px-6 pt-4">
        <span
          className="h-2 w-2 rounded-full bg-amber-900/40"
          style={{ animation: "status-pulse 1.4s ease-in-out infinite" }}
          aria-hidden="true"
        />
      </div>

      <div className="px-6 pt-3">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-900/15 ring-1 ring-amber-900/25 px-2.5 py-1">
          <span
            className="h-1.5 w-1.5 rounded-full bg-amber-900/70"
            style={{ animation: "status-pulse 1.4s ease-in-out infinite" }}
          />
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-amber-950">
            {pillText}
          </span>
        </span>
      </div>

      {!isNextUp && (
        <div className="px-6 pt-2">
          <span className="font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-amber-950/70">
            {(onDeckPosition ?? 2) === 2
              ? "1 MATCH AHEAD IN LINE"
              : `${(onDeckPosition ?? 1) - 1} MATCHES AHEAD IN LINE`}
          </span>
        </div>
      )}

      <div className="px-6 pt-3">
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-amber-950/80">
          {subText}
        </p>
        <h2
          className="mt-1 font-display font-black leading-[0.95] tracking-tight text-amber-950"
          style={{ fontSize: "clamp(56px, 16vw, 88px)" }}
        >
          Heads
          <br />
          Up.
        </h2>
        <p className="mt-2.5 text-[13px] font-medium leading-snug text-amber-950/85">
          {detailText}
        </p>
      </div>

      {isMixedLevel && <MixedLevelBanner tone="amber" />}

      <div className="my-5 mx-6 h-px bg-amber-900/25" />

      <div className="px-6">
        <TeamsGrid me={me} teammates={teammates} opponents={opponents} tone="amber" />
      </div>

      {onLeaveQueue && (
        <div className="mt-auto px-6 pt-4 pb-5">
          <LeaveQueueButton tone="amber" onClick={onLeaveQueue} />
        </div>
      )}
    </div>
  );
}

// ── Leave Queue button (rendered inside both overlay variants) ────

function LeaveQueueButton({
  tone,
  onClick,
}: {
  tone: "amber" | "navy";
  onClick: () => Promise<{ error?: string } | void>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          const result = await onClick();
          if (result && "error" in result && result.error) {
            toast.error(result.error);
          }
        } finally {
          setPending(false);
        }
      }}
      className={`w-full rounded-2xl px-4 py-3 text-sm font-semibold transition-colors
        disabled:opacity-50 disabled:cursor-not-allowed
        ${
          tone === "amber"
            ? "border border-amber-900/30 bg-amber-900/10 text-red-700 hover:bg-amber-900/15"
            : "border border-border dark:border-slate-700/60 bg-destructive/5 dark:bg-slate-900/40 text-destructive dark:text-red-400 hover:bg-destructive/10 dark:hover:bg-slate-800/50"
        }`}
    >
      {pending ? "Leaving…" : "Leave Queue"}
    </button>
  );
}
