// ─────────────────────────────────────────────────────────────────────────────
// PlayerPhone — faithful replica of the real player dashboard, inside a
// CSS phone shell. Design sourced directly from the live app:
//
//   • Light theme (bg-slate-50 / white cards) — matches the real app
//   • Sticky header with session name + player info + tab bar at the TOP
//   • MatchAlert renders as a CARD replacing content (not a full-screen overlay)
//   • TeamsGrid: grid-cols-[1fr_36px_1fr] with VS badge spanning two rows
//   • PlayerRow: rounded-xl with amber/emerald ring border for "you"
//   • QueueStatus: big #N position number as primary signal
//
// The phone shell (bezel + notch) stays dark — it's physical hardware.
// The screen inside is light, matching the real mobile experience.
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useRef } from "react";
import type { SandboxState, Player, SkillLevel } from "../state/types";
import { YOU_ID } from "./useAutoPlay";
import { playWarningBeep, playCourtCall } from "./audio";

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = "status" | "courts" | "waitlist" | "history";

interface Props {
  state: SandboxState;
  soundEnabled: boolean;
}

// ── Static mock history ───────────────────────────────────────────────────────

const MOCK_HISTORY = [
  {
    id: "h1",
    result: "win" as const,
    scoreA: 21,
    scoreB: 18,
    teammates: ["Dani"],
    opponents: ["Bria", "Esmé"],
    label: "45 min ago",
  },
  {
    id: "h2",
    result: "loss" as const,
    scoreA: 15,
    scoreB: 21,
    teammates: ["Hiro"],
    opponents: ["Fariq", "Gita"],
    label: "1 h 30 min ago",
  },
  {
    id: "h3",
    result: "win" as const,
    scoreA: 21,
    scoreB: 12,
    teammates: ["Jules"],
    opponents: ["Carlos", "Ivy"],
    label: "2 h 10 min ago",
  },
];

// ── Skill helpers (3 levels matching sandbox) ─────────────────────────────────

const SKILL_CFG: Record<SkillLevel, { dot: string; abbr: string; badge: string }> = {
  beginner: {
    dot: "bg-emerald-500",
    abbr: "Beg",
    badge: "bg-emerald-100 text-emerald-700 border-emerald-200",
  },
  intermediate: { dot: "bg-sky-500", abbr: "Int", badge: "bg-sky-100 text-sky-700 border-sky-200" },
  advanced: {
    dot: "bg-purple-500",
    abbr: "Adv",
    badge: "bg-purple-100 text-purple-700 border-purple-200",
  },
};

function SkillBadge({ skill }: { skill: SkillLevel }) {
  const c = SKILL_CFG[skill];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${c.badge}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
      {c.abbr}
    </span>
  );
}

function SkillIndicator({ skill }: { skill: SkillLevel }) {
  const c = SKILL_CFG[skill];
  return (
    <div className="flex shrink-0 items-center gap-1">
      <div className={`h-2 w-2 rounded-full ${c.dot}`} />
      <span className="text-[10px] font-bold uppercase tracking-wide leading-none text-slate-400">
        {c.abbr}
      </span>
    </div>
  );
}

// ── PlayerRow — matches real match-alert.tsx ──────────────────────────────────

function PlayerRow({
  player,
  isMe,
  accentColor,
}: {
  player: Player;
  isMe: boolean;
  accentColor: "amber" | "emerald";
}) {
  return (
    <div
      className={`w-full overflow-hidden rounded-xl px-3 py-2.5 transition-all ${
        isMe && accentColor === "amber"
          ? "bg-amber-100 ring-1 ring-amber-300"
          : isMe && accentColor === "emerald"
            ? "bg-emerald-50 ring-1 ring-emerald-300"
            : "bg-slate-100/70"
      }`}
    >
      <p
        className={`w-full truncate text-[14px] font-bold leading-snug ${
          isMe && accentColor === "amber"
            ? "text-amber-900"
            : isMe && accentColor === "emerald"
              ? "text-emerald-900"
              : "text-slate-800"
        }`}
      >
        {player.name}
      </p>
      <div className="mt-0.5 flex items-center justify-between gap-1">
        <div className="flex items-center gap-1.5">
          {isMe ? (
            <span
              className={`text-[10px] font-black uppercase tracking-widest leading-none ${
                accentColor === "amber" ? "text-amber-600" : "text-emerald-600"
              }`}
            >
              You
            </span>
          ) : (
            <span className="invisible text-[10px] leading-none" aria-hidden="true">
              You
            </span>
          )}
        </div>
        <SkillIndicator skill={player.skill} />
      </div>
    </div>
  );
}

function EmptyRow() {
  return (
    <div className="w-full overflow-hidden rounded-xl bg-slate-100/50 px-3 py-2.5">
      <p className="invisible text-[14px] font-bold leading-snug">·</p>
      <div className="mt-0.5 flex items-center justify-between">
        <span className="invisible text-[10px] leading-none">You</span>
      </div>
    </div>
  );
}

// ── VsBadge ───────────────────────────────────────────────────────────────────

function VsBadge() {
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-800 text-[11px] font-black text-white shadow-md">
      VS
    </div>
  );
}

// ── TeamsGrid — matches real match-alert.tsx grid-cols-[1fr_36px_1fr] ─────────

function TeamsGrid({
  me,
  teammates,
  opponents,
  accentColor,
}: {
  me: Player;
  teammates: Player[];
  opponents: Player[];
  accentColor: "amber" | "emerald";
}) {
  const partner = teammates[0] ?? null;
  const opp1 = opponents[0] ?? null;
  const opp2 = opponents[1] ?? null;

  return (
    <div className="grid grid-cols-[1fr_36px_1fr] gap-x-2 gap-y-2">
      {/* Row 1: labels */}
      <p
        className={`col-start-1 row-start-1 text-center text-[10px] font-black uppercase tracking-widest ${
          accentColor === "emerald" ? "text-emerald-600" : "text-amber-600"
        }`}
      >
        Your Team
      </p>
      <div className="col-start-2 row-start-1" />
      <p className="col-start-3 row-start-1 text-center text-[10px] font-black uppercase tracking-widest text-rose-500">
        Opponents
      </p>

      {/* VS badge — spans rows 2 & 3 */}
      <div className="col-start-2 row-start-2 row-span-2 flex items-center justify-center">
        <VsBadge />
      </div>

      {/* Row 2 */}
      <div className="col-start-1 row-start-2">
        <PlayerRow player={me} isMe accentColor={accentColor} />
      </div>
      <div className="col-start-3 row-start-2">
        {opp1 ? <PlayerRow player={opp1} isMe={false} accentColor={accentColor} /> : <EmptyRow />}
      </div>

      {/* Row 3 */}
      <div className="col-start-1 row-start-3">
        {partner ? (
          <PlayerRow player={partner} isMe={false} accentColor={accentColor} />
        ) : (
          <EmptyRow />
        )}
      </div>
      <div className="col-start-3 row-start-3">
        {opp2 ? <PlayerRow player={opp2} isMe={false} accentColor={accentColor} /> : <EmptyRow />}
      </div>
    </div>
  );
}

// ── MatchAlert card — matches real match-alert.tsx ────────────────────────────

function MatchAlertCard({
  matchStatus,
  courtName,
  me,
  teammates,
  opponents,
  onDeckPosition,
}: {
  matchStatus: "pending" | "in_progress";
  courtName: string | null;
  me: Player;
  teammates: Player[];
  opponents: Player[];
  onDeckPosition: number | null;
}) {
  if (matchStatus === "in_progress") {
    return (
      <div className="overflow-hidden rounded-3xl border border-emerald-900/50 shadow-lg">
        {/* Dark navy hero — exact match to real app's bg-[#0E1C3A] */}
        <div
          className="relative overflow-hidden px-6 pb-7 pt-8 text-center"
          style={{ background: "#0E1C3A" }}
        >
          {/* Pulsing rings */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <div className="h-64 w-64 animate-ping rounded-full border border-emerald-500/10 [animation-duration:3s]" />
          </div>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <div className="h-44 w-44 animate-ping rounded-full border border-emerald-500/10 [animation-duration:3s] [animation-delay:0.8s]" />
          </div>

          {/* Live dot */}
          <div aria-hidden="true" className="relative mb-4 flex justify-center">
            <span className="relative flex h-4 w-4">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-4 w-4 rounded-full bg-emerald-500" />
            </span>
          </div>

          <p className="relative mb-2 text-[10px] font-black uppercase tracking-[0.28em] text-emerald-400">
            It&apos;s your turn!
          </p>

          <h2
            className="relative font-black leading-none tracking-tight text-white drop-shadow-[0_2px_24px_rgba(16,185,129,0.3)]"
            style={{ fontSize: "clamp(36px, 12vw, 60px)" }}
          >
            {courtName ?? "Head to court!"}
          </h2>

          <p className="relative mt-4 text-sm font-semibold text-emerald-300">
            Your match is starting now 🏸
          </p>
        </div>

        {/* Teams */}
        <div className="bg-slate-50 px-4 pb-6 pt-5">
          <TeamsGrid me={me} teammates={teammates} opponents={opponents} accentColor="emerald" />
        </div>
      </div>
    );
  }

  // On deck
  const posLabel =
    !onDeckPosition || onDeckPosition === 1 ? "Next Available Court" : `#${onDeckPosition} On Deck`;
  const posSubline =
    !onDeckPosition || onDeckPosition === 1
      ? "Find your team — a court is opening soon 🏸"
      : `${onDeckPosition - 1} match${onDeckPosition - 1 !== 1 ? "es" : ""} ahead of you — get warmed up! 🏸`;
  const eyebrow =
    onDeckPosition && onDeckPosition > 1
      ? `${onDeckPosition} of several on deck`
      : "You're On Deck";

  return (
    <div className="overflow-hidden rounded-3xl border border-amber-200 shadow-xl">
      {/* Amber header */}
      <div className="bg-amber-50 px-6 pb-6 pt-7 text-center">
        <div aria-hidden="true" className="mb-3 flex justify-center">
          <span className="relative flex h-3.5 w-3.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-60" />
            <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-amber-500" />
          </span>
        </div>

        <p className="mb-2 text-[10px] font-black uppercase tracking-[0.22em] text-amber-600">
          {eyebrow}
        </p>
        <h2 className="text-4xl font-black leading-none text-slate-900">{posLabel}</h2>
        <p className="mt-3 text-sm font-medium text-slate-500">{posSubline}</p>
      </div>

      {/* Teams */}
      <div className="bg-white px-4 pb-6 pt-5">
        <TeamsGrid me={me} teammates={teammates} opponents={opponents} accentColor="amber" />
        <p className="mt-5 text-center text-[10px] font-medium text-slate-400">
          You&apos;ll be directed to a court as soon as one opens up
        </p>
      </div>
    </div>
  );
}

// ── QueueStatus card — matches real queue-status.tsx ─────────────────────────

function QueueStatus({
  position,
  waitMinutes,
  gamesPlayed,
  totalInQueue,
  isDrafted = false,
}: {
  position: number | null;
  waitMinutes: number;
  gamesPlayed: number;
  totalInQueue: number;
  isDrafted?: boolean;
}) {
  const ordinal =
    position === null
      ? null
      : position === 1
        ? "1st"
        : position === 2
          ? "2nd"
          : position === 3
            ? "3rd"
            : `${position}th`;

  return (
    <div className="rounded-xl bg-white border border-slate-200 px-5 py-4 shadow-sm">
      <div className="flex items-center gap-3">
        {isDrafted ? (
          <span className="relative flex h-10 w-10 shrink-0 items-center justify-center">
            <span className="absolute inline-flex h-7 w-7 animate-ping rounded-full bg-sky-500 opacity-25" />
            <span className="relative inline-flex h-4 w-4 rounded-full bg-sky-500" />
          </span>
        ) : (
          <span className="text-5xl font-extrabold tabular-nums leading-none text-slate-900">
            {position !== null ? `#${position}` : "—"}
          </span>
        )}
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-slate-900 leading-tight">
            {isDrafted ? "Match forming" : ordinal ? `${ordinal} in line` : "Not in queue"}
          </span>
          <span className="text-xs text-slate-500 mt-0.5">
            {isDrafted
              ? `selected from ${totalInQueue} queued`
              : position !== null
                ? `of ${totalInQueue} · ~${waitMinutes} min wait`
                : `${totalInQueue} player${totalInQueue !== 1 ? "s" : ""} ahead`}
          </span>
        </div>
      </div>
      <p className="mt-3 pt-3 border-t border-slate-100 text-xs text-slate-500">
        <span className="font-medium text-slate-900">{gamesPlayed}</span> game
        {gamesPlayed !== 1 ? "s" : ""} played this session
      </p>
    </div>
  );
}

// ── My Status tab ─────────────────────────────────────────────────────────────

function MyStatusTab({ state }: { state: SandboxState }) {
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

  // Active match for Alex
  const alexMatch =
    state.matches.find(
      (m) =>
        (m.status === "pending" || m.status === "in_progress") &&
        ([...m.teamA, ...m.teamB] as string[]).includes(YOU_ID)
    ) ?? null;

  const hasActiveMatch =
    (alex.status === "on_deck" || alex.status === "in_progress") && alexMatch !== null;

  if (hasActiveMatch && alexMatch) {
    const alexTeam = ([...alexMatch.teamA] as string[]).includes(YOU_ID) ? "a" : "b";
    const myTeamIds = alexTeam === "a" ? [...alexMatch.teamA] : [...alexMatch.teamB];
    const oppTeamIds = alexTeam === "a" ? [...alexMatch.teamB] : [...alexMatch.teamA];
    const teammates = myTeamIds
      .filter((id) => id !== YOU_ID)
      .map((id) => state.players[id])
      .filter(Boolean) as Player[];
    const opponents = oppTeamIds.map((id) => state.players[id]).filter(Boolean) as Player[];

    // On-deck position: count published pending matches, find Alex's rank
    const pendingPublished = state.matches.filter((m) => m.status === "pending");
    const alexPendingIndex = pendingPublished.findIndex((m) =>
      ([...m.teamA, ...m.teamB] as string[]).includes(YOU_ID)
    );
    const onDeckPosition = alexPendingIndex >= 0 ? alexPendingIndex + 1 : null;

    return (
      <div className="space-y-5 p-4">
        <MatchAlertCard
          matchStatus={alexMatch.status === "in_progress" ? "in_progress" : "pending"}
          courtName={alexMatch.status === "in_progress" ? "Court 1" : null}
          me={alex}
          teammates={teammates}
          opponents={opponents}
          onDeckPosition={onDeckPosition}
        />
      </div>
    );
  }

  if (alex.status === "drafted") {
    return (
      <div className="space-y-4 p-4">
        <div className="rounded-2xl border-2 border-slate-200 bg-slate-50 p-6 text-center">
          <div className="flex justify-center mb-3 text-3xl" aria-hidden="true">
            🏸
          </div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Match Forming</p>
          <p className="mt-1 text-lg font-bold text-slate-700">Hang tight…</p>
          <p className="mt-2 text-sm text-slate-500">
            You&apos;ve been selected for an upcoming match. The organizer will confirm it shortly.
          </p>
        </div>
        <QueueStatus
          position={null}
          isDrafted
          waitMinutes={waitMinutes}
          gamesPlayed={alex.gamesPlayed}
          totalInQueue={totalInQueue}
        />
      </div>
    );
  }

  // Waiting
  return (
    <div className="space-y-4 p-4">
      <QueueStatus
        position={position}
        waitMinutes={waitMinutes}
        gamesPlayed={alex.gamesPlayed}
        totalInQueue={totalInQueue}
      />

      {/* Simple "queue" context card */}
      {position !== null && position <= 4 && (
        <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-center">
          <p className="text-xs font-semibold text-amber-700">
            You&apos;re in the top 4 — a court may open soon!
          </p>
        </div>
      )}
    </div>
  );
}

// ── Live Courts tab ───────────────────────────────────────────────────────────

function LiveCourtsTab({ state }: { state: SandboxState }) {
  const active = state.matches.filter((m) => m.status === "in_progress");
  const onDeck = state.matches.filter((m) => m.status === "pending");

  if (active.length === 0 && onDeck.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
        <span className="text-4xl">🏸</span>
        <p className="text-sm text-slate-500">No active or on-deck matches yet.</p>
      </div>
    );
  }

  const renderMatch = (
    match: (typeof state.matches)[number],
    courtLabel: string,
    isActive: boolean
  ) => {
    const teamA = [...match.teamA].map((id) => state.players[id]).filter(Boolean) as Player[];
    const teamB = [...match.teamB].map((id) => state.players[id]).filter(Boolean) as Player[];
    const hasAlex = ([...match.teamA, ...match.teamB] as string[]).includes(YOU_ID);

    return (
      <div
        key={match.id}
        className={`overflow-hidden rounded-2xl border shadow-sm ${
          isActive ? "border-emerald-200 bg-white" : "border-slate-200 bg-slate-50"
        } ${hasAlex ? "ring-2 ring-sky-400" : ""}`}
      >
        <div
          className={`flex items-center justify-between px-4 py-2.5 ${
            isActive
              ? "bg-emerald-50 border-b border-emerald-100"
              : "bg-white border-b border-slate-100"
          }`}
        >
          <span className="text-xs font-bold text-slate-600">{courtLabel}</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
              isActive ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
            }`}
          >
            {isActive ? "Live" : "On Deck"}
          </span>
        </div>

        <div className="grid grid-cols-[1fr_auto_1fr] gap-2 px-4 py-3">
          <div className="space-y-1.5">
            {teamA.map((p) => (
              <div key={p.id} className="flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 rounded-full ${SKILL_CFG[p.skill].dot}`} />
                <span
                  className={`text-xs font-medium ${p.id === YOU_ID ? "font-bold text-slate-900" : "text-slate-600"}`}
                >
                  {p.name}
                  {p.id === YOU_ID ? " (you)" : ""}
                </span>
              </div>
            ))}
          </div>
          <span className="self-center text-[10px] font-bold text-slate-300">vs</span>
          <div className="space-y-1.5">
            {teamB.map((p) => (
              <div key={p.id} className="flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 rounded-full ${SKILL_CFG[p.skill].dot}`} />
                <span
                  className={`text-xs font-medium ${p.id === YOU_ID ? "font-bold text-slate-900" : "text-slate-600"}`}
                >
                  {p.name}
                  {p.id === YOU_ID ? " (you)" : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3 p-4">
      {active.map((m, i) => renderMatch(m, `Court ${i + 1}`, true))}
      {onDeck.map((m, i) => renderMatch(m, `On Deck · ${i + 1}`, false))}
    </div>
  );
}

// ── Waitlist tab ──────────────────────────────────────────────────────────────

function WaitlistTab({ state }: { state: SandboxState }) {
  const queued = state.queueOrder.filter((id) => {
    const s = state.players[id]?.status;
    return s && s !== "left";
  });
  const waitingOnly = queued.filter((id) => state.players[id]?.status === "waiting");

  if (queued.length === 0) {
    return <div className="p-6 text-center text-sm text-slate-400">Queue is empty</div>;
  }

  return (
    <div className="divide-y divide-slate-100">
      {queued.map((id) => {
        const p = state.players[id];
        if (!p) return null;
        const isAlex = id === YOU_ID;
        const waitPos = p.status === "waiting" ? waitingOnly.indexOf(id) + 1 : null;

        return (
          <div
            key={id}
            className={`flex items-center gap-3 px-4 py-3 ${isAlex ? "bg-sky-50" : "bg-white"}`}
          >
            {/* Position badge */}
            <div
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold ${
                isAlex
                  ? "bg-sky-500 text-white"
                  : waitPos && waitPos <= 4
                    ? "bg-slate-200 text-slate-700"
                    : "bg-slate-100 text-slate-400"
              }`}
            >
              {waitPos ?? "—"}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span
                  className={`text-sm font-semibold truncate ${isAlex ? "text-sky-700" : "text-slate-800"}`}
                >
                  {p.name}
                </span>
                {isAlex && (
                  <span className="text-[9px] font-black uppercase tracking-widest text-sky-500">
                    You
                  </span>
                )}
                <SkillBadge skill={p.skill} />
              </div>
              <p className="text-[10px] text-slate-400 mt-0.5 capitalize">
                {p.status.replace("_", " ")}
              </p>
            </div>

            <div className="shrink-0 text-right">
              <span className="text-base font-bold text-slate-800">{p.gamesPlayed}</span>
              <p className="text-[10px] text-slate-400">games</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Match History tab ─────────────────────────────────────────────────────────

function MatchHistoryTab() {
  const wins = MOCK_HISTORY.filter((m) => m.result === "win").length;
  const losses = MOCK_HISTORY.filter((m) => m.result === "loss").length;
  const winPct = Math.round((wins / (wins + losses)) * 100);

  return (
    <div>
      {/* Stats summary */}
      <div className="flex border-b border-slate-100 bg-white">
        {[
          { label: "W", value: String(wins), color: "text-emerald-600" },
          { label: "L", value: String(losses), color: "text-rose-500" },
          { label: "Win%", value: `${winPct}%`, color: "text-slate-700" },
        ].map(({ label, value, color }) => (
          <div
            key={label}
            className="flex-1 py-4 text-center border-r border-slate-100 last:border-r-0"
          >
            <p className={`text-xl font-extrabold tabular-nums ${color}`}>{value}</p>
            <p className="text-[10px] uppercase tracking-wide text-slate-400 mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {/* Match cards */}
      <div className="divide-y divide-slate-100">
        {MOCK_HISTORY.map((match) => (
          <div key={match.id} className="bg-white px-4 py-3.5">
            <div className="flex items-start justify-between mb-2">
              <span
                className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                  match.result === "win"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-rose-200 bg-rose-50 text-rose-600"
                }`}
              >
                {match.result === "win" ? "Win" : "Loss"}
              </span>
              <span className="text-lg font-extrabold tabular-nums text-slate-800">
                {match.scoreA} — {match.scoreB}
              </span>
            </div>
            <p className="text-xs text-slate-600">
              <span className="font-semibold text-slate-800">Alex</span>
              {match.teammates.map((t) => (
                <span key={t}> + {t}</span>
              ))}
              <span className="text-slate-400"> vs </span>
              {match.opponents.join(" + ")}
            </p>
            <p className="mt-1 text-[10px] text-slate-400">{match.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tab bar (top, matches real app) ──────────────────────────────────────────

const TAB_DEFS: { id: Tab; label: string }[] = [
  { id: "status", label: "My Status" },
  { id: "courts", label: "Courts" },
  { id: "waitlist", label: "Waitlist" },
  { id: "history", label: "History" },
];

// ── Status bar ────────────────────────────────────────────────────────────────

function PhoneStatusBar() {
  return (
    <div className="flex items-center justify-between bg-white px-6 pt-3 pb-1 h-11 shrink-0">
      <span className="text-[13px] font-semibold text-slate-900">9:41</span>
      <div className="flex items-center gap-1.5">
        {/* Signal */}
        <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
          <rect x="0" y="8" width="3" height="4" rx="0.5" fill="#1e293b" />
          <rect x="4.5" y="5.5" width="3" height="6.5" rx="0.5" fill="#1e293b" />
          <rect x="9" y="3" width="3" height="9" rx="0.5" fill="#1e293b" />
          <rect x="13.5" y="0" width="2.5" height="12" rx="0.5" fill="#1e293b" />
        </svg>
        {/* Battery */}
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

// ── Main PlayerPhone component ─────────────────────────────────────────────────

export default function PlayerPhone({ state, soundEnabled }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("status");

  const alex = state.players[YOU_ID];
  const alexStatus = alex?.status;

  // Auto-switch to My Status on significant alerts
  useEffect(() => {
    if (alexStatus === "on_deck" || alexStatus === "in_progress") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- demo component, local-only tab state
      setActiveTab("status");
    }
  }, [alexStatus]);

  // Sound alerts on status transitions (same logic as useMatchAlerts in real app)
  const prevStatusRef = useRef(alexStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    // Advance ref only on real status changes so that re-enabling sound
    // while already in a steady state (e.g. on_deck) never re-triggers the alert.
    if (prev !== alexStatus) {
      prevStatusRef.current = alexStatus;
    }
    if (!soundEnabled) return;
    if (prev !== "on_deck" && alexStatus === "on_deck") playWarningBeep().catch(() => {});
    if (prev !== "in_progress" && alexStatus === "in_progress") playCourtCall().catch(() => {});
  }, [alexStatus, soundEnabled]);

  // Header dot color (matches real app dotColor logic)
  const hasActiveMatch = alexStatus === "on_deck" || alexStatus === "in_progress";
  const dotCls = hasActiveMatch
    ? alexStatus === "in_progress"
      ? "bg-emerald-500 animate-pulse"
      : "bg-amber-400 animate-pulse"
    : alexStatus === "waiting" || alexStatus === "drafted"
      ? "bg-emerald-500 animate-pulse"
      : "bg-slate-300";

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

      {/* ── Phone screen — LIGHT theme matching real app ── */}
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#f8fafc", // slate-50
          borderRadius: 44,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <PhoneStatusBar />

        {/* Sticky app header — matches real player-dashboard.tsx header */}
        <div className="shrink-0 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="px-4 py-2.5">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-base font-bold text-slate-900 leading-tight">
                  Badminton Queue
                </h1>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="text-xs text-slate-500">Alex</span>
                  <SkillBadge skill="intermediate" />
                  {/* Status dot */}
                  <span className={`ml-1 h-2 w-2 rounded-full ${dotCls}`} aria-hidden="true" />
                </div>
              </div>
            </div>
          </div>

          {/* Tab bar — top, matching real app grid-cols-4 */}
          <div role="tablist" className="grid grid-cols-4 border-t border-slate-100">
            {TAB_DEFS.map(({ id, label }) => {
              const isActive = activeTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveTab(id)}
                  className={`py-2.5 text-[11px] font-semibold transition-colors ${
                    isActive
                      ? "text-slate-900 border-b-2 border-slate-900"
                      : "text-slate-400 hover:text-slate-600"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto bg-slate-50">
          {activeTab === "status" && <MyStatusTab state={state} />}
          {activeTab === "courts" && <LiveCourtsTab state={state} />}
          {activeTab === "waitlist" && <WaitlistTab state={state} />}
          {activeTab === "history" && <MatchHistoryTab />}
        </div>
      </div>
    </div>
  );
}
