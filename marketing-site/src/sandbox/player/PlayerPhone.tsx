// ─────────────────────────────────────────────────────────────────────────────
// PlayerPhone — faithful replica of the real player dashboard, inside a
// CSS phone shell. Design sourced directly from the live app components:
//
//   • match-alert.tsx     → MatchOverlay (full-screen slide-up, amber + dark)
//   • queue-status.tsx    → QueueStatus (88px #N numeral, full-canvas)
//   • on-deck-alert.tsx   → OnDeckAlert (approaching pill, positions 1–4)
//   • my-status-tab.tsx   → MyStatusTab (Queue/History sub-tabs)
//   • live-courts-tab.tsx → LiveCourtsTab (CourtMatchCard + cc-* roster grid)
//   • waitlist-tab.tsx    → WaitlistTab (sporty scoreboard, indigo "you" row)
//   • match-history.tsx   → MatchHistoryTab (stats bar + match cards)
//   • player-dashboard.tsx → Tab bar (icons + labels), header, 4-tab structure
//
// Tabs: My Status · Live Courts · Waitlist · Leaderboard (stub)
// The phone shell (bezel + notch) is dark hardware; screen is light.
// All changes here are automatically propagated to marketing-site via
// `npm run sync` in marketing-site/.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useRef } from "react";
import type { Match, SandboxState, Player, SkillLevel } from "../state/types";
import { YOU_ID } from "./useAutoPlay";
import { playWarningBeep, playCourtCall } from "./audio";

// ── Types ──────────────────────────────────────────────────────────────────────
type Tab = "status" | "courts" | "waitlist" | "leaderboard";
type SubTab = "queue" | "history";

interface Props {
  state: SandboxState;
  soundEnabled: boolean;
}

// ── Static mock history ────────────────────────────────────────────────────────
const MOCK_HISTORY = [
  {
    id: "h1",
    result: "win" as const,
    myScore: 21,
    theirScore: 18,
    teammates: ["Dani"],
    opponents: ["Bria", "Esmé"],
    label: "45 min ago",
  },
  {
    id: "h2",
    result: "loss" as const,
    myScore: 15,
    theirScore: 21,
    teammates: ["Hiro"],
    opponents: ["Fariq", "Gita"],
    label: "1 h 30 min ago",
  },
  {
    id: "h3",
    result: "win" as const,
    myScore: 21,
    theirScore: 12,
    teammates: ["Jules"],
    opponents: ["Carlos", "Ivy"],
    label: "2 h 10 min ago",
  },
];

// ── Skill config ───────────────────────────────────────────────────────────────
// abbr matches real waitlist-tab.tsx (BEG/INT/ADV, no pill badges).
// dotCls matches real match-alert.tsx SKILL_TIER dot colours.
const SKILL_CFG: Record<SkillLevel, { abbr: string; dotCls: string }> = {
  beginner: { abbr: "BEG", dotCls: "bg-emerald-400" },
  intermediate: { abbr: "INT", dotCls: "bg-sky-400" },
  advanced: { abbr: "ADV", dotCls: "bg-purple-500" },
};

// ── WaitlistTab electric-indigo "you" row constants ────────────────────────────
// OKLCH values identical to real waitlist-tab.tsx.
// Font sizes scaled ~15% smaller than real app to fit the 375×780 phone shell.
const YOU_BG = "oklch(0.55 0.24 270)";
const YOU_TEXT = "oklch(0.97 0.008 270)";
const YOU_TEXT_DIM = "oklch(0.97 0.008 270 / 0.65)";
const YOU_RANK = "oklch(0.86 0.14 270)";

// ══════════════════════════════════════════════════════════════════════════════
// OnDeckAlert — approaching pill (positions 1–4), shown above QueueStatus.
// Mirrors on-deck-alert.tsx.
// ══════════════════════════════════════════════════════════════════════════════
function OnDeckAlert({ position }: { position: number }) {
  const isUrgent = position <= 2;
  const label =
    position === 1
      ? "You're Next!"
      : position === 2
        ? "Almost there…"
        : position === 3
          ? "Get ready!"
          : "Coming up soon";
  return (
    <div
      className={`flex items-center justify-center gap-2.5 rounded-full px-4 py-2 mb-4 ${
        isUrgent ? "bg-amber-100 ring-1 ring-amber-300" : "bg-sky-50 ring-1 ring-sky-200"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${isUrgent ? "bg-amber-500" : "bg-sky-500"}`}
        style={{ animation: "status-pulse 1.4s ease-in-out infinite" }}
      />
      <span
        className={`text-[11px] font-bold uppercase tracking-[0.14em] ${
          isUrgent ? "text-amber-800" : "text-sky-800"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// AlertPlayerRow + AlertTeamsGrid — match-alert.tsx style.
// Flat rows (dot + skill abbr + name + "You" tag). No card backgrounds.
// ══════════════════════════════════════════════════════════════════════════════
function AlertPlayerRow({
  player,
  isMe,
  tone,
}: {
  player: Player;
  isMe: boolean;
  tone: "amber" | "navy";
}) {
  const { abbr, dotCls } = SKILL_CFG[player.skill];
  const tierLabelCls = tone === "amber" ? "text-amber-900/60" : "text-slate-500";
  const nameCls = isMe
    ? tone === "amber"
      ? "font-bold text-amber-950"
      : "font-bold text-slate-900"
    : tone === "amber"
      ? "font-medium text-amber-900/80"
      : "font-medium text-slate-700";
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotCls}`} />
      <span
        className={`shrink-0 font-mono text-[9px] font-bold uppercase tracking-[0.1em] ${tierLabelCls}`}
      >
        {abbr}
      </span>
      <span className={`flex-1 truncate text-sm ${nameCls}`}>{player.name}</span>
      {isMe && (
        <span
          className={`ml-1 shrink-0 text-[9px] font-bold uppercase tracking-[0.14em] leading-none ${
            tone === "amber" ? "text-emerald-700" : "text-emerald-600"
          }`}
        >
          You
        </span>
      )}
    </div>
  );
}

function AlertTeamsGrid({
  me,
  teammates,
  opponents,
  tone,
}: {
  me: Player;
  teammates: Player[];
  opponents: Player[];
  tone: "amber" | "navy";
}) {
  const partner = teammates[0] ?? null;
  const opp1 = opponents[0] ?? null;
  const opp2 = opponents[1] ?? null;
  const labelCls = tone === "amber" ? "text-amber-800/90" : "text-slate-500";
  const vsCls = tone === "amber" ? "text-amber-800/80" : "text-slate-400";
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] gap-x-3 items-start">
      <div>
        <p className={`mb-2 text-[10px] font-bold uppercase tracking-[0.14em] ${labelCls}`}>
          Your Team
        </p>
        <AlertPlayerRow player={me} isMe tone={tone} />
        {partner ? (
          <AlertPlayerRow player={partner} isMe={false} tone={tone} />
        ) : (
          <div className="py-1.5 text-sm opacity-30">·</div>
        )}
      </div>
      <div className={`pt-7 text-[11px] font-bold tracking-[0.1em] ${vsCls}`}>VS</div>
      <div>
        <p
          className={`mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-right ${labelCls}`}
        >
          Opponents
        </p>
        {opp1 ? (
          <AlertPlayerRow player={opp1} isMe={false} tone={tone} />
        ) : (
          <div className="py-1.5 text-sm opacity-30">·</div>
        )}
        {opp2 && <AlertPlayerRow player={opp2} isMe={false} tone={tone} />}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MatchOverlay — full-screen slide-up (on-deck amber + in-progress light).
// Mirrors match-alert.tsx: absolute inset-0 z-30, CSS transform transition.
// ══════════════════════════════════════════════════════════════════════════════
function MatchOverlay({
  matchStatus,
  courtLabel,
  me,
  teammates,
  opponents,
  onDeckPosition,
}: {
  matchStatus: "pending" | "in_progress";
  courtLabel: string;
  me: Player;
  teammates: Player[];
  opponents: Player[];
  onDeckPosition: number | null;
}) {
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

  // ── In Progress — light background, emerald hero ───────────────────────────
  if (matchStatus === "in_progress") {
    return (
      <div
        role="alert"
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 30,
          display: "flex",
          flexDirection: "column",
          background: "#f8fafc",
          transform: visible ? "translateY(0)" : "translateY(100%)",
          transition: "transform 380ms cubic-bezier(0.16, 1, 0.3, 1)",
          overflowY: "auto",
        }}
      >
        <div className="flex items-center justify-end px-6 pt-4">
          <span
            className="h-2 w-2 rounded-full bg-emerald-500"
            style={{ animation: "status-pulse 1.4s ease-in-out infinite" }}
          />
        </div>
        <div className="px-6 pt-3">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 ring-1 ring-emerald-200 px-2.5 py-1">
            <span
              className="h-1.5 w-1.5 rounded-full bg-emerald-500"
              style={{ animation: "status-pulse 1.4s ease-in-out infinite" }}
            />
            <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-700">
              Match in Progress
            </span>
          </span>
        </div>
        <div className="px-6 pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Active Court
          </p>
          <h2
            className="mt-1 font-display font-black leading-none tracking-tight text-emerald-600"
            style={{ fontSize: "clamp(48px, 14vw, 72px)" }}
          >
            {courtLabel.toUpperCase()}
          </h2>
        </div>
        <div className="my-5 mx-6 h-px bg-slate-200" />
        <div className="px-6">
          <AlertTeamsGrid me={me} teammates={teammates} opponents={opponents} tone="navy" />
        </div>
      </div>
    );
  }

  // ── On Deck — amber canvas, "Heads Up." hero ───────────────────────────────
  const isNextUp = onDeckPosition === null || onDeckPosition === 1;
  const pillText = isNextUp ? "You're On Deck" : `${onDeckPosition} on deck`;
  const subText = isNextUp ? "Coming Up Next" : `#${onDeckPosition} On Deck`;
  const detailText = isNextUp
    ? "Find your team — a court is opening soon"
    : `${(onDeckPosition ?? 2) - 1} match${(onDeckPosition ?? 2) - 1 !== 1 ? "es" : ""} ahead — get warmed up`;

  return (
    <div
      role="alert"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 30,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "oklch(0.78 0.17 62)",
        transform: visible ? "translateY(0)" : "translateY(100%)",
        transition: "transform 550ms cubic-bezier(0.22, 1, 0.36, 1)",
        overflowY: "auto",
      }}
    >
      <div className="flex items-center justify-end px-6 pt-4">
        <span
          className="h-2 w-2 rounded-full bg-amber-900/40"
          style={{ animation: "status-pulse 1.4s ease-in-out infinite" }}
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
      <div className="my-5 mx-6 h-px bg-amber-900/25" />
      <div className="px-6">
        <AlertTeamsGrid me={me} teammates={teammates} opponents={opponents} tone="amber" />
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// QueueStatus — full-canvas 88px numeral. Mirrors queue-status.tsx.
// ══════════════════════════════════════════════════════════════════════════════
function StatItem({
  value,
  label,
  primary = false,
}: {
  value: string;
  label: string;
  primary?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span
        className={`text-lg font-semibold leading-none tabular-nums ${
          primary ? "text-emerald-600" : "text-slate-700"
        }`}
        style={{ letterSpacing: "-0.02em" }}
      >
        {value}
      </span>
      <span className="text-[9px] font-medium uppercase tracking-[0.1em] text-slate-400">
        {label}
      </span>
    </div>
  );
}

function QueueStatus({
  position,
  waitMinutes,
  gamesPlayed,
  totalInQueue,
  skill,
}: {
  position: number | null;
  waitMinutes: number;
  gamesPlayed: number;
  totalInQueue: number;
  skill: SkillLevel;
}) {
  const isApproaching = position !== null && position <= 2;
  const abbr = SKILL_CFG[skill].abbr;
  return (
    <div className="flex flex-col items-center justify-center py-10 px-4 relative">
      {isApproaching && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 240px 200px at 50% 38%, oklch(0.78 0.16 70 / 0.10), transparent 70%)",
          }}
        />
      )}
      <span
        className={`relative font-display text-[88px] font-black leading-none tabular-nums ${
          isApproaching ? "text-amber-500" : "text-slate-900"
        }`}
        style={{ letterSpacing: "-0.04em" }}
      >
        {position !== null ? `#${position}` : "—"}
      </span>
      <p
        className={`relative mt-3 text-sm font-medium ${
          isApproaching ? "text-amber-700" : "text-slate-500"
        }`}
      >
        {position !== null
          ? `in line · ${totalInQueue} waiting`
          : `${totalInQueue} player${totalInQueue !== 1 ? "s" : ""} ahead`}
      </p>
      <div
        className={`relative my-7 h-px w-8 ${isApproaching ? "bg-amber-400/30" : "bg-slate-200"}`}
      />
      <div className="relative flex items-end gap-10">
        <StatItem value={`${waitMinutes}m`} label="Waited" />
        <StatItem value={String(gamesPlayed)} label="Games" />
        <StatItem value={abbr} label="Skill" primary />
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// LiveCourtsTab — CourtMatchCard with cc-* roster grid.
// Mirrors live-courts-tab.tsx + match-roster.tsx.
// ══════════════════════════════════════════════════════════════════════════════

function CourtPlayerRowLight({ name, abbr, isMe }: { name: string; abbr: string; isMe: boolean }) {
  return (
    <div className="clip-cut-tr px-3 py-2" style={{ background: "oklch(0.91 0.014 235)" }}>
      <div className="flex items-center gap-1.5 overflow-hidden">
        <span
          className={`shrink min-w-0 truncate text-[12px] leading-none ${isMe ? "font-bold" : "font-medium"}`}
          style={{ color: isMe ? "oklch(0.18 0.02 238)" : "oklch(0.40 0.018 238)" }}
        >
          {name}
        </span>
        {isMe && (
          <span
            className="shrink-0 text-[9px] font-bold uppercase tracking-[0.14em]"
            style={{ color: "oklch(0.5 0.18 188)" }}
          >
            You
          </span>
        )}
      </div>
      <div className="mt-1">
        <span
          className="text-[9px] font-bold uppercase tracking-[0.14em] leading-none"
          style={{ color: "oklch(0.5 0.18 188)" }}
        >
          {abbr}
        </span>
      </div>
    </div>
  );
}

function CourtPlayerRowDark({ name, abbr, isMe }: { name: string; abbr: string; isMe: boolean }) {
  return (
    <div className="clip-cut-tr px-3 py-2" style={{ background: "oklch(0.23 0.022 240)" }}>
      <div className="flex items-center gap-1.5 overflow-hidden">
        <span
          className={`shrink min-w-0 truncate text-[12px] leading-none ${isMe ? "font-bold" : "font-medium"}`}
          style={{ color: "oklch(0.94 0.008 238)" }}
        >
          {name}
        </span>
        {isMe && (
          <span
            className="shrink-0 text-[9px] font-bold uppercase tracking-[0.14em]"
            style={{ color: "oklch(0.79 0.18 188)" }}
          >
            You
          </span>
        )}
      </div>
      <div className="mt-1">
        <span
          className="text-[9px] font-bold uppercase tracking-[0.14em] leading-none"
          style={{ color: "oklch(0.79 0.18 188)" }}
        >
          {abbr}
        </span>
      </div>
    </div>
  );
}

function CourtVsBadge({ dark }: { dark: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1" aria-hidden="true">
      <div
        className="w-px h-3.5"
        style={{ background: dark ? "oklch(0.3 0.025 240)" : "oklch(0.8 0.022 235)" }}
      />
      <span
        className="text-[8px] font-bold"
        style={{ color: dark ? "oklch(0.48 0.016 238)" : "oklch(0.58 0.016 238)" }}
      >
        VS
      </span>
      <div
        className="w-px h-3.5"
        style={{ background: dark ? "oklch(0.3 0.025 240)" : "oklch(0.8 0.022 235)" }}
      />
    </div>
  );
}

function CourtTeamsGrid({
  teamA,
  teamB,
  dark,
}: {
  teamA: Player[];
  teamB: Player[];
  dark: boolean;
}) {
  const labelColorA = dark ? "oklch(0.48 0.016 238)" : "oklch(0.48 0.2 255)";
  const labelColorB = dark ? "oklch(0.48 0.016 238)" : "oklch(0.58 0.18 62)";
  const a0 = teamA[0];
  const a1 = teamA[1];
  const b0 = teamB[0];
  const b1 = teamB[1];

  const LightRow = ({ p }: { p: Player | undefined }) =>
    p ? (
      <CourtPlayerRowLight name={p.name} abbr={SKILL_CFG[p.skill].abbr} isMe={p.id === YOU_ID} />
    ) : (
      <div className="h-10 clip-cut-tr" style={{ background: "oklch(0.91 0.014 235)" }} />
    );
  const DarkRow = ({ p }: { p: Player | undefined }) =>
    p ? (
      <CourtPlayerRowDark name={p.name} abbr={SKILL_CFG[p.skill].abbr} isMe={p.id === YOU_ID} />
    ) : (
      <div className="h-10 clip-cut-tr" style={{ background: "oklch(0.23 0.022 240)" }} />
    );

  return (
    <div className="grid gap-y-2 px-3 py-3" style={{ gridTemplateColumns: "1fr 40px 1fr" }}>
      <div style={{ gridColumn: 1, gridRow: 1 }}>
        <span
          className="text-[9px] uppercase tracking-[0.20em] font-bold"
          style={{ color: labelColorA }}
        >
          Team A
        </span>
      </div>
      <div style={{ gridColumn: 2, gridRow: 1 }} />
      <div style={{ gridColumn: 3, gridRow: 1 }} className="text-right">
        <span
          className="text-[9px] uppercase tracking-[0.20em] font-bold"
          style={{ color: labelColorB }}
        >
          Team B
        </span>
      </div>
      <div
        style={{ gridColumn: 2, gridRow: "2 / span 2" }}
        className="flex items-center justify-center"
      >
        <CourtVsBadge dark={dark} />
      </div>
      <div style={{ gridColumn: 1, gridRow: 2 }}>
        {dark ? <DarkRow p={a0} /> : <LightRow p={a0} />}
      </div>
      <div style={{ gridColumn: 3, gridRow: 2 }}>
        {dark ? <DarkRow p={b0} /> : <LightRow p={b0} />}
      </div>
      <div style={{ gridColumn: 1, gridRow: 3 }}>
        {dark ? <DarkRow p={a1} /> : <LightRow p={a1} />}
      </div>
      <div style={{ gridColumn: 3, gridRow: 3 }}>
        {dark ? <DarkRow p={b1} /> : <LightRow p={b1} />}
      </div>
    </div>
  );
}

function CourtMatchCard({
  match,
  players,
  courtLabel,
  isActive,
}: {
  match: Match;
  players: SandboxState["players"];
  courtLabel: string;
  isActive: boolean;
}) {
  const teamA = [...match.teamA].map((id) => players[id]).filter(Boolean) as Player[];
  const teamB = [...match.teamB].map((id) => players[id]).filter(Boolean) as Player[];

  if (isActive) {
    return (
      <div
        className="overflow-hidden rounded-2xl"
        style={{
          background: "oklch(0.10 0.014 245)",
          boxShadow: "0 0 0 1px oklch(0.76 0.17 155 / 0.35), 0 0 24px oklch(0.76 0.17 155 / 0.10)",
        }}
      >
        <div
          className="flex items-center justify-between px-4 py-2.5 border-b"
          style={{ borderColor: "oklch(1 0 0 / 0.1)" }}
        >
          <span
            className="text-[11px] font-bold uppercase tracking-[0.08em]"
            style={{ color: "oklch(1 0 0 / 0.6)" }}
          >
            {courtLabel}
          </span>
          <span
            className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.06em]"
            style={{
              background: "oklch(0.76 0.17 155 / 0.15)",
              color: "oklch(0.76 0.17 155)",
            }}
          >
            In Progress
          </span>
        </div>
        <CourtTeamsGrid teamA={teamA} teamB={teamB} dark />
      </div>
    );
  }

  return (
    <div
      className="overflow-hidden rounded-2xl shadow-sm border bg-white"
      style={{ borderColor: "oklch(0.92 0.02 70)" }}
    >
      <div
        className="flex items-center justify-between px-4 py-2.5 border-b"
        style={{ background: "oklch(0.98 0.01 70)", borderColor: "oklch(0.92 0.02 70)" }}
      >
        <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-amber-800">
          On Deck
        </span>
        <span className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.06em] bg-amber-100 text-amber-700">
          Waiting
        </span>
      </div>
      <CourtTeamsGrid teamA={teamA} teamB={teamB} dark={false} />
    </div>
  );
}

function LiveCourtsTab({ state }: { state: SandboxState }) {
  const active = state.matches.filter((m) => m.status === "in_progress");
  const onDeck = state.matches.filter((m) => m.status === "pending");

  if (active.length === 0 && onDeck.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center">
          <svg
            className="h-5 w-5 text-slate-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
          </svg>
        </div>
        <p className="text-sm font-medium text-slate-700">No active matches</p>
        <p className="text-xs text-slate-400">
          Matches appear here once the organizer starts them.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4">
      {active.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <h2 className="text-xs font-bold uppercase tracking-widest text-slate-400">
              Now Playing
            </h2>
            <span className="rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
              {active.length}
            </span>
          </div>
          <div className="space-y-3">
            {active.map((m, i) => (
              <CourtMatchCard
                key={m.id}
                match={m}
                players={state.players}
                courtLabel={`Court ${i + 1}`}
                isActive
              />
            ))}
          </div>
        </section>
      )}
      {onDeck.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
            </span>
            <h2 className="text-xs font-bold uppercase tracking-widest text-slate-400">On Deck</h2>
            <span className="rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[10px] font-bold text-amber-700">
              {onDeck.length}
            </span>
          </div>
          <div className="space-y-3">
            {onDeck.map((m, i) => (
              <CourtMatchCard
                key={m.id}
                match={m}
                players={state.players}
                courtLabel={`On Deck · ${i + 1}`}
                isActive={false}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// WaitlistTab — sporty scoreboard. Mirrors waitlist-tab.tsx.
// Zero-padded Barlow Condensed italic ranks, JetBrains Mono GP stats,
// BEG/INT/ADV abbrevs, electric-indigo "you" canvas row.
// Font sizes scaled ~15% smaller than real app to fit the 375×780 phone shell.
// ══════════════════════════════════════════════════════════════════════════════
function WaitlistTab({ state }: { state: SandboxState }) {
  const queued = state.queueOrder.filter((id) => {
    const s = state.players[id]?.status;
    return s && s !== "left";
  });

  if (queued.length === 0) {
    return (
      <div className="flex flex-col items-start px-4 pt-5 pb-12">
        <div className="flex items-center gap-1.5 mb-2">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
          <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-slate-400">
            Queue Empty
          </p>
        </div>
        <div
          className="font-display font-black italic uppercase leading-[0.88] text-slate-200"
          style={{ fontSize: "44px", letterSpacing: "-0.03em" }}
        >
          No One
          <br />
          Waiting
        </div>
        <p className="mt-4 text-sm text-slate-400">Be the first in line.</p>
      </div>
    );
  }

  return (
    <div className="px-3 pt-3 pb-4">
      {/* Header: LINEUP + player count */}
      <div className="flex items-end justify-between pb-3 border-b-2 border-slate-200 mb-1">
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <span
              className="h-1.5 w-1.5 rounded-full bg-emerald-500"
              style={{ animation: "status-pulse 1.4s ease-in-out infinite" }}
            />
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.28em] text-emerald-600">
              Live
            </p>
          </div>
          <div
            className="font-display font-black italic uppercase leading-none text-slate-900"
            style={{ fontSize: "40px", letterSpacing: "-0.025em" }}
          >
            Lineup
          </div>
        </div>
        <div className="text-right pb-0.5">
          <div
            className="font-display font-black italic text-slate-700 leading-none"
            style={{ fontSize: "40px", letterSpacing: "-0.02em" }}
          >
            {queued.length}
          </div>
          <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-slate-400 mt-0.5">
            {queued.length === 1 ? "Player" : "Players"}
          </p>
        </div>
      </div>

      {/* Rows */}
      {queued.map((id, idx) => {
        const p = state.players[id];
        if (!p) return null;
        const isMe = id === YOU_ID;
        const position = idx + 1;
        const rankStr = String(position).padStart(2, "0");
        const isTop = position <= 4;
        const isLast = idx === queued.length - 1;
        const abbr = SKILL_CFG[p.skill].abbr;

        if (isMe) {
          return (
            <div
              key={id}
              className="grid items-center rounded-xl my-1"
              style={{
                backgroundColor: YOU_BG,
                gridTemplateColumns: "48px 1fr auto",
                gap: "0 10px",
                padding: "14px",
              }}
            >
              <div
                className="font-display font-black italic leading-none"
                style={{ fontSize: "30px", letterSpacing: "-0.04em", color: YOU_RANK }}
              >
                {rankStr}
              </div>
              <div className="min-w-0">
                <div
                  className="font-display font-black uppercase truncate leading-tight"
                  style={{ fontSize: "15px", letterSpacing: "0.02em", color: YOU_TEXT }}
                >
                  {p.name}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span
                    className="font-mono text-[9px] font-extrabold uppercase tracking-[0.12em]"
                    style={{ color: YOU_TEXT_DIM }}
                  >
                    {abbr}
                  </span>
                  <span
                    className="font-mono text-[8px] font-extrabold uppercase tracking-widest"
                    style={{ color: YOU_TEXT_DIM }}
                  >
                    You
                  </span>
                </div>
              </div>
              <div className="text-right shrink-0">
                <div
                  className="font-mono font-black tabular-nums leading-none"
                  style={{ fontSize: "22px", color: YOU_TEXT }}
                >
                  {p.gamesPlayed}
                </div>
                <p
                  className="font-mono text-[8px] uppercase tracking-[0.16em] mt-0.5"
                  style={{ color: YOU_TEXT_DIM }}
                >
                  GP
                </p>
              </div>
            </div>
          );
        }

        const rankColor =
          position === 1 ? "text-emerald-600" : isTop ? "text-emerald-600/65" : "text-slate-300";
        const rankSize = position === 1 ? "26px" : isTop ? "24px" : "19px";
        const nameSize = isTop ? "15px" : "13px";
        const gpSize = isTop ? "17px" : "13px";

        return (
          <div
            key={id}
            className={`grid items-center py-2.5 ${isLast ? "" : "border-b border-slate-100"}`}
            style={{
              gridTemplateColumns: "48px 1fr auto",
              gap: "0 10px",
              paddingLeft: "2px",
              paddingRight: "2px",
            }}
          >
            <div
              className={`font-display font-black italic leading-none ${rankColor}`}
              style={{ fontSize: rankSize, letterSpacing: "-0.04em" }}
            >
              {rankStr}
            </div>
            <div className="min-w-0">
              <div
                className={`font-display font-bold uppercase truncate leading-tight ${
                  isTop ? "text-slate-800" : "text-slate-400"
                }`}
                style={{ fontSize: nameSize, letterSpacing: "0.02em" }}
              >
                {p.name}
              </div>
              <span
                className={`font-mono text-[9px] font-semibold uppercase tracking-[0.12em] ${
                  isTop ? "text-slate-400" : "text-slate-300"
                }`}
              >
                {abbr}
              </span>
            </div>
            <div className="text-right shrink-0">
              <div
                className={`font-mono font-black tabular-nums leading-none ${
                  isTop ? "text-slate-600" : "text-slate-300"
                }`}
                style={{ fontSize: gpSize }}
              >
                {p.gamesPlayed}
              </div>
              <p className="font-mono text-[7px] uppercase tracking-[0.14em] text-slate-300 mt-0.5">
                GP
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MatchHistoryTab — stats bar + match cards. Mirrors match-history.tsx.
// ══════════════════════════════════════════════════════════════════════════════
function MatchHistoryTab() {
  const wins = MOCK_HISTORY.filter((m) => m.result === "win").length;
  const losses = MOCK_HISTORY.filter((m) => m.result === "loss").length;

  return (
    <div className="space-y-3">
      {/* Stats bar */}
      <div className="flex items-center justify-between rounded-xl bg-white border border-slate-200 px-4 py-3 shadow-sm">
        <div className="flex items-center gap-2">
          <svg
            className="h-4 w-4 text-slate-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M6 9H4.5a2.5 2.5 0 010-5H6" />
            <path d="M18 9h1.5a2.5 2.5 0 000-5H18" />
            <path d="M4 22h16" />
            <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
            <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
            <path d="M18 2H6v7a6 6 0 0012 0V2z" />
          </svg>
          <span className="text-sm font-bold text-slate-800">{MOCK_HISTORY.length} matches</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="font-bold text-emerald-600">{wins}W</span>
          <span className="text-slate-300">/</span>
          <span className="font-bold text-red-500">{losses}L</span>
        </div>
      </div>

      {/* Match cards */}
      {MOCK_HISTORY.map((match, i) => {
        const won = match.result === "win";
        const borderColor = won ? "border-emerald-200" : "border-slate-200";
        const headerBg = won ? "bg-emerald-50 border-emerald-100" : "bg-slate-50 border-slate-100";
        const badgeStyle = won ? "bg-emerald-500 text-white" : "bg-red-100 text-red-700";

        return (
          <div
            key={match.id}
            className={`rounded-2xl border overflow-hidden bg-white shadow-sm ${borderColor}`}
          >
            <div className={`flex items-center justify-between px-4 py-2 border-b ${headerBg}`}>
              <span className="text-xs font-medium text-slate-500">
                Match {MOCK_HISTORY.length - i}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-400">{match.label}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${badgeStyle}`}
                >
                  {won ? "Won" : "Lost"}
                </span>
              </div>
            </div>
            <div className="px-4 py-3">
              <div className="flex items-center justify-center gap-3 mb-3">
                <span
                  className={`text-3xl font-black tabular-nums ${
                    won ? "text-emerald-600" : "text-slate-400"
                  }`}
                >
                  {match.myScore}
                </span>
                <span className="text-sm font-bold text-slate-300">–</span>
                <span
                  className={`text-3xl font-black tabular-nums ${
                    !won ? "text-red-500" : "text-slate-400"
                  }`}
                >
                  {match.theirScore}
                </span>
              </div>
              <div className="flex items-center justify-center gap-3 text-xs text-slate-500">
                <div className="text-center">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-0.5">
                    Partner
                  </p>
                  <p className="font-medium text-slate-700">{match.teammates.join(", ")}</p>
                </div>
                <span className="text-slate-300">vs</span>
                <div className="text-center">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-0.5">
                    Opponents
                  </p>
                  <p className="font-medium text-slate-700">{match.opponents.join(" & ")}</p>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// QueueContent — the Queue sub-tab body inside MyStatusTab.
// Hoisted to module scope to avoid react/no-unstable-nested-components.
// ══════════════════════════════════════════════════════════════════════════════
function QueueContent({
  hasActiveMatch,
  playerStatus,
  position,
  waitMinutes,
  gamesPlayed,
  totalInQueue,
  skill,
}: {
  hasActiveMatch: boolean;
  playerStatus: string;
  position: number | null;
  waitMinutes: number;
  gamesPlayed: number;
  totalInQueue: number;
  skill: SkillLevel;
}) {
  if (hasActiveMatch) return null; // MatchOverlay handles it

  if (playerStatus === "drafted") {
    return (
      <div className="flex flex-col items-center">
        <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
          <h2
            className="text-3xl font-extrabold leading-tight text-slate-900"
            style={{ letterSpacing: "-0.02em" }}
          >
            Match Forming
          </h2>
          <p className="mt-3 text-sm text-slate-500">
            Hang tight — you&apos;ve been selected for the next match.
          </p>
          <div className="my-7 h-px w-8 bg-slate-200" />
          <span className="text-sm font-medium text-slate-500">Match forming</span>
          <p className="mt-1 text-xs text-slate-400">selected from {totalInQueue} queued</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center">
      {position !== null && position <= 4 && <OnDeckAlert position={position} />}
      <QueueStatus
        position={position}
        waitMinutes={waitMinutes}
        gamesPlayed={gamesPlayed}
        totalInQueue={totalInQueue}
        skill={skill}
      />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MyStatusTab — waiting / drafted / on_deck / in_progress + Queue/History sub-tabs
// ══════════════════════════════════════════════════════════════════════════════
function MyStatusTab({ state }: { state: SandboxState }) {
  const [subTab, setSubTab] = useState<SubTab>("queue");

  const alex = state.players[YOU_ID];
  if (!alex) return <div className="p-5 text-sm text-slate-400">Player not found</div>;

  const waitingIds = state.queueOrder.filter((id) => state.players[id]?.status === "waiting");
  const alexPos = waitingIds.indexOf(YOU_ID);
  const position = alexPos >= 0 ? alexPos + 1 : null;
  const totalInQueue = state.queueOrder.filter((id) => {
    const s = state.players[id]?.status;
    return s && s !== "left";
  }).length;
  // eslint-disable-next-line react-hooks/purity -- demo component, Date.now() is intentional
  const waitMinutes = Math.round((Date.now() - alex.joinedAt) / 60000);

  const alexMatch =
    state.matches.find(
      (m) =>
        (m.status === "pending" || m.status === "in_progress") &&
        ([...m.teamA, ...m.teamB] as string[]).includes(YOU_ID)
    ) ?? null;
  const hasActiveMatch =
    (alex.status === "on_deck" || alex.status === "in_progress") && alexMatch !== null;

  return (
    <div className="space-y-4 p-4">
      {/* Queue / History sub-tab toggle — mirrors my-status-tab.tsx */}
      <div className="flex rounded-xl bg-slate-100 p-1">
        <button
          onClick={() => setSubTab("queue")}
          className={`flex-1 rounded-lg py-2 text-xs font-semibold transition-colors ${
            subTab === "queue"
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          Queue
        </button>
        <button
          onClick={() => setSubTab("history")}
          className={`flex-1 rounded-lg py-2 text-xs font-semibold transition-colors ${
            subTab === "history"
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          History
        </button>
      </div>

      {subTab === "queue" ? (
        <QueueContent
          hasActiveMatch={hasActiveMatch}
          playerStatus={alex.status}
          position={position}
          waitMinutes={waitMinutes}
          gamesPlayed={alex.gamesPlayed}
          totalInQueue={totalInQueue}
          skill={alex.skill}
        />
      ) : (
        <MatchHistoryTab />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// LeaderboardStub — placeholder for the Leaderboard tab
// ══════════════════════════════════════════════════════════════════════════════
function LeaderboardStub() {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <div className="text-4xl mb-4" aria-hidden="true">
        🏆
      </div>
      <h2 className="text-xl font-extrabold text-slate-900" style={{ letterSpacing: "-0.02em" }}>
        Live Rankings
      </h2>
      <p className="mt-3 text-sm text-slate-500 max-w-[220px] leading-relaxed">
        Join a real session to see your stats and rankings appear here.
      </p>
    </div>
  );
}

// ── Tab bar inline SVG icons (no lucide dependency) ────────────────────────────
function IconStatus() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  );
}
function IconCourts() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  );
}
function IconWaitlist() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <circle cx="3" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="3" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="3" cy="18" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
function IconLeaderboard() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M6 9H4.5a2.5 2.5 0 010-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 000-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0012 0V2z" />
    </svg>
  );
}

const TAB_DEFS: { id: Tab; label: string; Icon: () => React.ReactElement }[] = [
  { id: "status", label: "My Status", Icon: IconStatus },
  { id: "courts", label: "Live Courts", Icon: IconCourts },
  { id: "waitlist", label: "Waitlist", Icon: IconWaitlist },
  { id: "leaderboard", label: "Leaderboard", Icon: IconLeaderboard },
];

// ── Phone status bar (9:41, signal, battery) ───────────────────────────────────
function PhoneStatusBar() {
  return (
    <div className="flex items-center justify-between bg-white px-6 pt-3 pb-1 h-11 shrink-0">
      <span className="text-[13px] font-semibold text-slate-900">9:41</span>
      <div className="flex items-center gap-1.5">
        <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
          <rect x="0" y="8" width="3" height="4" rx="0.5" fill="#1e293b" />
          <rect x="4.5" y="5.5" width="3" height="6.5" rx="0.5" fill="#1e293b" />
          <rect x="9" y="3" width="3" height="9" rx="0.5" fill="#1e293b" />
          <rect x="13.5" y="0" width="2.5" height="12" rx="0.5" fill="#1e293b" />
        </svg>
        <svg width="22" height="12" viewBox="0 0 22 12" fill="none">
          <rect
            x="0.5"
            y="0.5"
            width="18"
            height="11"
            rx="2.5"
            stroke="#1e293b"
            strokeOpacity="0.4"
          />
          <rect x="2" y="2" width="14" height="8" rx="1.5" fill="#1e293b" />
          <path d="M19.5 4V8C20.5 7.5 20.5 4.5 19.5 4Z" fill="#1e293b" fillOpacity="0.4" />
        </svg>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Main PlayerPhone
// ══════════════════════════════════════════════════════════════════════════════
export default function PlayerPhone({ state, soundEnabled }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("status");

  const alex = state.players[YOU_ID];
  const alexStatus = alex?.status;

  // Auto-switch to My Status when match becomes active
  useEffect(() => {
    if (alexStatus === "on_deck" || alexStatus === "in_progress") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- demo component, local-only tab state
      setActiveTab("status");
    }
  }, [alexStatus]);

  // Sound alerts on status transitions
  const prevStatusRef = useRef(alexStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    if (prev !== alexStatus) prevStatusRef.current = alexStatus;
    if (!soundEnabled) return;
    if (prev !== "on_deck" && alexStatus === "on_deck") playWarningBeep().catch(() => {});
    if (prev !== "in_progress" && alexStatus === "in_progress") playCourtCall().catch(() => {});
  }, [alexStatus, soundEnabled]);

  // Header status dot — mirrors player-dashboard.tsx dotColor logic
  const hasActiveMatch = alexStatus === "on_deck" || alexStatus === "in_progress";
  const dotCls = hasActiveMatch
    ? alexStatus === "in_progress"
      ? "bg-emerald-500 animate-pulse"
      : "bg-amber-400 animate-pulse"
    : alexStatus === "waiting" || alexStatus === "drafted"
      ? "bg-emerald-500 animate-pulse"
      : "bg-slate-300";

  // Derive active match data for the overlay
  const alexMatch = alex
    ? (state.matches.find(
        (m) =>
          (m.status === "pending" || m.status === "in_progress") &&
          ([...m.teamA, ...m.teamB] as string[]).includes(YOU_ID)
      ) ?? null)
    : null;
  const showOverlay =
    hasActiveMatch && alexMatch !== null && activeTab === "status" && alex != null;

  const alexTeam = alexMatch && ([...alexMatch.teamA] as string[]).includes(YOU_ID) ? "a" : "b";
  const myTeamIds = alexMatch
    ? alexTeam === "a"
      ? [...alexMatch.teamA]
      : [...alexMatch.teamB]
    : [];
  const oppTeamIds = alexMatch
    ? alexTeam === "a"
      ? [...alexMatch.teamB]
      : [...alexMatch.teamA]
    : [];
  const teammates = myTeamIds
    .filter((id) => id !== YOU_ID)
    .map((id) => state.players[id])
    .filter(Boolean) as Player[];
  const opponents = oppTeamIds.map((id) => state.players[id]).filter(Boolean) as Player[];
  const pendingPublished = state.matches.filter((m) => m.status === "pending");
  const alexPendingIndex = alexMatch
    ? pendingPublished.findIndex((m) => ([...m.teamA, ...m.teamB] as string[]).includes(YOU_ID))
    : -1;
  const onDeckPosition = alexPendingIndex >= 0 ? alexPendingIndex + 1 : null;

  // Court label for in-progress overlay — derive from index in active list
  // so "Court 2" shows correctly if Alex's match is not the first active.
  const activeMatches = state.matches.filter((m) => m.status === "in_progress");
  const alexActiveIndex = alexMatch ? activeMatches.findIndex((m) => m.id === alexMatch.id) : -1;
  const courtLabel =
    alexMatch?.status === "in_progress" && alexActiveIndex >= 0
      ? `Court ${alexActiveIndex + 1}`
      : "Court 1";

  return (
    /* ── Outer phone bezel ── */
    <div
      style={{
        width: 375,
        height: 780,
        background: "oklch(3.5% 0.008 245)",
        borderRadius: 52,
        padding: 10,
        boxShadow: `
          0 0 0 1px oklch(28% 0.025 245),
          0 0 0 2px oklch(12% 0.015 245),
          0 40px 100px -16px oklch(0% 0 0 / 0.85),
          0 16px 40px -8px oklch(0% 0 0 / 0.5),
          inset 0 1px 0 oklch(38% 0.028 245 / 0.4)
        `,
        flexShrink: 0,
        position: "relative",
      }}
    >
      {/* Dynamic Island notch */}
      <div
        style={{
          position: "absolute",
          top: 18,
          left: "50%",
          transform: "translateX(-50%)",
          width: 120,
          height: 34,
          background: "oklch(2% 0.005 245)",
          borderRadius: 20,
          zIndex: 40,
          boxShadow: "0 0 0 1px oklch(15% 0.018 245)",
        }}
      />

      {/* ── Phone screen ── */}
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#f8fafc",
          borderRadius: 44,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <PhoneStatusBar />

        {/* Sticky app header — mirrors player-dashboard.tsx header */}
        <div className="shrink-0 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="px-4 py-2.5">
            <div className="flex items-center justify-between">
              <div>
                {/* Session name — mirrors real app h1 showing session.name */}
                <h1 className="text-base font-bold text-slate-900 leading-tight">
                  Tuesday Session
                </h1>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="text-xs text-slate-500">Alex</span>
                  {/* Skill indicator inline — INT dot */}
                  <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-700">
                    <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                    INT
                  </span>
                  <span className={`ml-1 h-2 w-2 rounded-full ${dotCls}`} aria-hidden="true" />
                </div>
              </div>
            </div>
          </div>

          {/* Tab bar — 4 tabs with icons, mirrors player-dashboard.tsx */}
          <div role="tablist" className="grid grid-cols-4 border-t border-slate-100">
            {TAB_DEFS.map(({ id, label, Icon }) => {
              const isActive = activeTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveTab(id)}
                  className={`flex flex-col items-center gap-0.5 py-2 text-[10px] font-semibold transition-colors ${
                    isActive
                      ? "text-emerald-600 border-b-2 border-emerald-600"
                      : "text-slate-400 hover:text-slate-600"
                  }`}
                >
                  <Icon />
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Scrollable content — position:relative scopes the MatchOverlay */}
        <div className="flex-1 overflow-y-auto bg-slate-50 relative">
          {/* Full-screen overlay for on_deck / in_progress — only in status tab */}
          {showOverlay && alex && (
            <MatchOverlay
              matchStatus={alexMatch!.status as "pending" | "in_progress"}
              courtLabel={courtLabel}
              me={alex}
              teammates={teammates}
              opponents={opponents}
              onDeckPosition={onDeckPosition}
            />
          )}

          {activeTab === "status" && <MyStatusTab state={state} />}
          {activeTab === "courts" && <LiveCourtsTab state={state} />}
          {activeTab === "waitlist" && <WaitlistTab state={state} />}
          {activeTab === "leaderboard" && <LeaderboardStub />}
        </div>
      </div>
    </div>
  );
}
