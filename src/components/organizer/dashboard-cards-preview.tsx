"use client";

// ============================================================
// DashboardCardsPreview — Sandbox: revamped organizer cards
// ============================================================
// Fixes over v1:
//   • Single semantic skill indicator (dot + abbr) — no team dot
//     The column headers (YOUR TEAM / OPPONENTS) already
//     communicate team membership; the second dot was redundant.
//   • Mirrored Team B column — flex-row-reverse on line 2 so
//     player names face each other across the VS badge.
//   • Two-line player rows (name line + skill/VIP line), same
//     structure for every row → consistent row heights → VS
//     badge always perfectly centered regardless of VIP badges.
//   • Explicit gap-y-2 between grid rows for breathing room.
// Route: /sandbox/dashboard-cards
// Remove before shipping.
// ============================================================

import { useState, useEffect } from "react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeftRight, Clock, GripVertical, Trash2, Trophy } from "lucide-react";
import { VipTag } from "@/components/ui/vip-tag";
import type { VipTheme } from "@/lib/vip-config";

// ── Skill config ───────────────────────────────────────────────
// dot    → coloured circle
// abbr   → 3-char label
// Single indicator replaces the two-dot system (team dot was redundant).

type SkillKey = "beginner" | "intermediate" | "advanced";

const SKILL: Record<SkillKey, { dot: string; abbr: string }> = {
  beginner:     { dot: "bg-emerald-500", abbr: "Beg" },
  intermediate: { dot: "bg-sky-500",     abbr: "Int" },
  advanced:     { dot: "bg-violet-500",  abbr: "Adv" },
};

// ── Types ──────────────────────────────────────────────────────
interface MockPlayer {
  id: string;
  name: string;
  skill: SkillKey;
  vipTag: string | null;
  vipTheme: VipTheme | null;
}

interface MockOnDeck {
  id: string;
  queuedAt: string;
  teamA: [MockPlayer, MockPlayer];
  teamB: [MockPlayer, MockPlayer];
}

interface MockActive {
  courtName: string;
  startedSecondsAgo: number;
  teamA: [MockPlayer, MockPlayer];
  teamB: [MockPlayer, MockPlayer];
}

// ── Mock data ─────────────────────────────────────────────────
const INITIAL_ON_DECK: MockOnDeck[] = [
  {
    id: "match-1",
    queuedAt: "7:42 PM",
    teamA: [
      { id: "p1", name: "Marcus",  skill: "advanced",     vipTag: "MVP", vipTheme: "gold-prestige"   },
      { id: "p2", name: "Priya",   skill: "intermediate", vipTag: null,  vipTheme: null              },
    ],
    teamB: [
      { id: "p3", name: "Jordan",  skill: "advanced",     vipTag: null,  vipTheme: null              },
      { id: "p4", name: "Sam",     skill: "beginner",     vipTag: null,  vipTheme: null              },
    ],
  },
  {
    id: "match-2",
    queuedAt: "7:49 PM",
    teamA: [
      { id: "p5", name: "Taylor",  skill: "intermediate", vipTag: null,      vipTheme: null             },
      { id: "p6", name: "Quinn",   skill: "intermediate", vipTag: null,      vipTheme: null             },
    ],
    teamB: [
      { id: "p7", name: "Morgan",  skill: "advanced",     vipTag: "ELITE",   vipTheme: "crimson-elite"  },
      { id: "p8", name: "Casey",   skill: "beginner",     vipTag: null,      vipTheme: null             },
    ],
  },
  {
    id: "match-3",
    queuedAt: "7:55 PM",
    teamA: [
      { id: "p9",  name: "Dylan",   skill: "advanced",    vipTag: null,  vipTheme: null              },
      { id: "p10", name: "Blake",   skill: "beginner",    vipTag: "NEW", vipTheme: "emerald-legend"  },
    ],
    teamB: [
      { id: "p11", name: "Cameron", skill: "intermediate", vipTag: null, vipTheme: null              },
      { id: "p12", name: "Hunter",  skill: "advanced",    vipTag: null,  vipTheme: null              },
    ],
  },
];

const MOCK_ACTIVE: MockActive = {
  courtName: "Court 2",
  startedSecondsAgo: 483,
  teamA: [
    { id: "a1", name: "Dana",  skill: "advanced",     vipTag: null,  vipTheme: null           },
    { id: "a2", name: "Riley", skill: "intermediate", vipTag: "VIP", vipTheme: "violet-spark" },
  ],
  teamB: [
    { id: "a3", name: "Alex",  skill: "advanced",     vipTag: null,  vipTheme: null           },
    { id: "a4", name: "Chris", skill: "intermediate", vipTag: null,  vipTheme: null           },
  ],
};

// ── Helpers ────────────────────────────────────────────────────
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// ── Skill indicator ────────────────────────────────────────────
// One element, one meaning. dot encodes level; abbr makes it readable.
function SkillIndicator({ skill }: { skill: SkillKey }) {
  const { dot, abbr } = SKILL[skill];
  return (
    <div className="flex shrink-0 items-center gap-1" aria-label={skill}>
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
      <span className="text-[9px] font-bold uppercase tracking-wide text-slate-500 leading-none">
        {abbr}
      </span>
    </div>
  );
}

function SkillIndicatorDark({ skill }: { skill: SkillKey }) {
  const { dot, abbr } = SKILL[skill];
  return (
    <div className="flex shrink-0 items-center gap-1" aria-label={skill}>
      <span className={`h-2 w-2 rounded-full ${dot} opacity-80`} aria-hidden="true" />
      <span className="text-[9px] font-bold uppercase tracking-wide text-white/40 leading-none">
        {abbr}
      </span>
    </div>
  );
}

// VipBadgeLight / VipBadgeDark removed — using the real VipTag component instead.

// ── Player rows ────────────────────────────────────────────────
// Two-line structure — same layout for BOTH columns (no flipping):
//   Line 1 — "Name | TAG"
//             name: flex-1 min-w-0 truncate → shortens first when tight
//             separator + tag: flex-shrink-0 → always fully visible
//   Line 2 — skill indicator · swap icon (always rendered → uniform height)

interface LightPlayerRowProps {
  player: MockPlayer;
}

function LightPlayerRow({ player }: LightPlayerRowProps) {
  const hasTag = !!(player.vipTag && player.vipTheme);
  return (
    <div className="group w-full rounded-xl bg-slate-100/70 px-3 py-2 transition-colors hover:bg-amber-50/60">
      {/* Line 1 — "Riley | VIP" as a tight natural-width unit.
            Name: shrink+truncate (no flex-1 = won't expand to fill space).
            Tag:  shrink-0 (never compressed, always fully visible).       */}
      <div className="flex items-center gap-1.5 overflow-hidden">
        <span className="shrink min-w-0 truncate text-[13px] font-bold leading-none text-slate-800">
          {player.name}
        </span>
        {hasTag && (
          <>
            <span className="shrink-0 text-[11px] leading-none text-slate-300 select-none" aria-hidden="true">|</span>
            <span className="shrink-0 leading-none">
              <VipTag tag={player.vipTag!} theme={player.vipTheme!} />
            </span>
          </>
        )}
      </div>
      {/* Line 2 — skill · swap icon */}
      <div className="mt-1 flex items-center gap-1.5">
        <SkillIndicator skill={player.skill} />
        <span className="invisible text-[9px] leading-none" aria-hidden="true">_</span>
        <button
          className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-slate-400 hover:text-slate-600"
          aria-label={`Swap ${player.name}`}
          title="Swap player"
        >
          <ArrowLeftRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

interface DarkPlayerRowProps {
  player: MockPlayer;
  teamColor: string;
}

function DarkPlayerRow({ player, teamColor }: DarkPlayerRowProps) {
  const hasTag = !!(player.vipTag && player.vipTheme);
  return (
    <div className="w-full rounded-xl px-3 py-2 transition-colors hover:bg-white/5" style={{ background: "rgba(255,255,255,0.04)" }}>
      {/* Line 1 — "Riley | VIP" as a tight natural-width unit */}
      <div className="flex items-center gap-1.5 overflow-hidden">
        <span className={`shrink min-w-0 truncate text-[13px] font-bold leading-none ${teamColor}`}>
          {player.name}
        </span>
        {hasTag && (
          <>
            <span className="shrink-0 text-[11px] leading-none text-white/25 select-none" aria-hidden="true">|</span>
            <span className="shrink-0 leading-none">
              <VipTag tag={player.vipTag!} theme={player.vipTheme!} />
            </span>
          </>
        )}
      </div>
      {/* Line 2 — skill */}
      <div className="mt-1 flex items-center gap-1.5">
        <SkillIndicatorDark skill={player.skill} />
        <span className="invisible text-[9px] leading-none" aria-hidden="true">_</span>
      </div>
    </div>
  );
}

// ── VS badge ───────────────────────────────────────────────────
function VsBadge({ dark }: { dark?: boolean }) {
  return (
    <div
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full
        ${dark
          ? "bg-emerald-500/20 ring-1 ring-emerald-500/40"
          : "bg-white ring-1 ring-slate-200 shadow-sm"
        }`}
      aria-hidden="true"
    >
      <span className={`text-[10px] font-black tracking-tight ${dark ? "text-emerald-400" : "text-slate-400"}`}>
        VS
      </span>
    </div>
  );
}

// ── Teams grid ─────────────────────────────────────────────────
// 3-col CSS grid with explicit inline placement.
// gap-y-2 between rows; consistent two-line rows → VS always centered.
//
//  col 1 (1fr)   │ col 2 (40px) │ col 3 (1fr)
//  ──────────────┼──────────────┼──────────────
//  row 1  label  │              │ label
//  row 2  A[0]   │    [VS]      │ B[0] (mirror)
//  row 3  A[1]   │   (span 2)   │ B[1] (mirror)

interface TeamsGridProps {
  teamA: [MockPlayer, MockPlayer];
  teamB: [MockPlayer, MockPlayer];
  dark?: boolean;
  labelA?: string;
  labelB?: string;
}

function TeamsGrid({ teamA, teamB, dark, labelA = "Your Team", labelB = "Opponents" }: TeamsGridProps) {
  return (
    <div
      className="grid gap-y-2 px-3 py-3"
      style={{ gridTemplateColumns: "1fr 40px 1fr" }}
    >
      {/* Row 1 — column labels */}
      <div style={{ gridColumn: 1, gridRow: 1 }}>
        <span className={`text-[9px] font-black uppercase tracking-widest ${dark ? "text-sky-400/70" : "text-sky-600"}`}>
          {labelA}
        </span>
      </div>
      <div style={{ gridColumn: 2, gridRow: 1 }} aria-hidden="true" />
      <div style={{ gridColumn: 3, gridRow: 1 }} className="text-right">
        <span className={`text-[9px] font-black uppercase tracking-widest ${dark ? "text-amber-400/70" : "text-amber-600"}`}>
          {labelB}
        </span>
      </div>

      {/* VS badge — col 2, spans rows 2–3 */}
      <div style={{ gridColumn: 2, gridRow: "2 / span 2" }} className="flex items-center justify-center">
        <VsBadge dark={dark} />
      </div>

      {/* Row 2 — first player pair */}
      <div style={{ gridColumn: 1, gridRow: 2 }}>
        {dark
          ? <DarkPlayerRow player={teamA[0]} teamColor="text-sky-200" />
          : <LightPlayerRow player={teamA[0]} />}
      </div>
      <div style={{ gridColumn: 3, gridRow: 2 }}>
        {dark
          ? <DarkPlayerRow player={teamB[0]} teamColor="text-amber-200" />
          : <LightPlayerRow player={teamB[0]} />}
      </div>

      {/* Row 3 — second player pair */}
      <div style={{ gridColumn: 1, gridRow: 3 }}>
        {dark
          ? <DarkPlayerRow player={teamA[1]} teamColor="text-sky-200" />
          : <LightPlayerRow player={teamA[1]} />}
      </div>
      <div style={{ gridColumn: 3, gridRow: 3 }}>
        {dark
          ? <DarkPlayerRow player={teamB[1]} teamColor="text-amber-200" />
          : <LightPlayerRow player={teamB[1]} />}
      </div>
    </div>
  );
}

// ── OnDeckCardShell ────────────────────────────────────────────
function OnDeckCardShell({
  match,
  index,
  renderHandle,
  dimmed,
}: {
  match: MockOnDeck;
  index: number;
  renderHandle: React.ReactNode;
  dimmed?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border border-amber-100 bg-white shadow-sm overflow-hidden transition-opacity ${dimmed ? "opacity-30" : "opacity-100"}`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 bg-amber-50 border-b border-amber-100">
        {renderHandle}
        <span className="relative flex h-2.5 w-2.5 flex-shrink-0" aria-hidden="true">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
        </span>
        <span className="flex-1 text-[13px] font-semibold text-amber-900 tracking-tight select-none">
          On Deck #{index + 1}
        </span>
        <span className="flex items-center gap-1 text-[11px] text-amber-600/70 flex-shrink-0 select-none">
          <Clock className="h-3 w-3" aria-hidden="true" />
          {match.queuedAt}
        </span>
      </div>

      {/* Teams */}
      <TeamsGrid teamA={match.teamA} teamB={match.teamB} />

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-t border-slate-100">
        <span className="text-[11px] text-slate-400 select-none">
          Hover a player to swap
        </span>
        <button
          className="flex items-center gap-1 text-[11px] font-medium text-slate-400 hover:text-red-400 transition-colors py-1.5 px-2.5 rounded-lg hover:bg-red-50"
          aria-label={`Clear match ${index + 1} from deck`}
        >
          <Trash2 className="h-3 w-3" aria-hidden="true" />
          Clear
        </button>
      </div>
    </div>
  );
}

// ── SortableOnDeckCard — has useSortable hook ─────────────────
function SortableOnDeckCard({ match, index }: { match: MockOnDeck; index: number }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: match.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition, zIndex: isDragging ? 50 : 1 }}
    >
      <OnDeckCardShell
        match={match}
        index={index}
        dimmed={isDragging}
        renderHandle={
          <div
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            suppressHydrationWarning
            className="touch-none select-none cursor-grab active:cursor-grabbing flex items-center justify-center p-1 rounded hover:bg-amber-100/60 transition-colors"
            aria-label="Drag to reorder"
          >
            <GripVertical className="h-4 w-4 text-amber-400 flex-shrink-0" />
          </div>
        }
      />
    </div>
  );
}

// ── OverlayOnDeckCard — NO hooks, purely visual ───────────────
function OverlayOnDeckCard({ match, index }: { match: MockOnDeck; index: number }) {
  return (
    <div className="rotate-1 shadow-2xl">
      <OnDeckCardShell
        match={match}
        index={index}
        renderHandle={
          <div className="flex items-center justify-center p-1 rounded cursor-grabbing">
            <GripVertical className="h-4 w-4 text-amber-400 flex-shrink-0" />
          </div>
        }
      />
    </div>
  );
}

// ── ActiveCourtCard ───────────────────────────────────────────
function ActiveCourtCard({ match }: { match: MockActive }) {
  const [elapsed, setElapsed] = useState(match.startedSecondsAgo);
  useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{ background: "#0D1B2A", boxShadow: "0 0 0 1px rgba(16,185,129,0.3), 0 0 40px rgba(16,185,129,0.12)" }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2.5 px-4 py-2.5 border-b"
        style={{ background: "rgba(255,255,255,0.05)", borderColor: "rgba(255,255,255,0.1)" }}
      >
        <span className="relative flex h-2.5 w-2.5 flex-shrink-0" aria-hidden="true">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
        </span>
        <span className="flex-1 text-[14px] font-semibold text-white tracking-tight">
          {match.courtName}
        </span>
        <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full flex-shrink-0">
          In Progress
        </span>
        <span className="font-mono tabular-nums text-[13px] flex-shrink-0" style={{ color: "rgba(255,255,255,0.55)" }}>
          {formatTime(elapsed)}
        </span>
      </div>

      {/* Teams — organizer sees Team A / Team B (not "your team") */}
      <TeamsGrid teamA={match.teamA} teamB={match.teamB} dark labelA="Team A" labelB="Team B" />

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t" style={{ borderColor: "rgba(255,255,255,0.1)" }}>
        <button className="text-[12px] font-medium py-1.5 px-3 rounded-lg transition-colors text-red-400/80 hover:text-red-400" aria-label="Cancel match">
          Cancel
        </button>
        <button className="flex items-center gap-1.5 text-[12px] font-semibold bg-white text-[#0D1B2A] hover:bg-white/90 transition-colors py-1.5 px-3 rounded-lg" aria-label="Input score and end match">
          <Trophy className="h-3.5 w-3.5" aria-hidden="true" />
          Score &amp; End
        </button>
      </div>
    </div>
  );
}

// ── DashboardCardsPreview ─────────────────────────────────────
export function DashboardCardsPreview() {
  const [onDeckMatches, setOnDeckMatches] = useState<MockOnDeck[]>(INITIAL_ON_DECK);
  const [activeId, setActiveId] = useState<string | null>(null);

  const activeMatch = activeId ? onDeckMatches.find((m) => m.id === activeId) ?? null : null;

  const sensors = useSensors(
    useSensor(MouseSensor,    { activationConstraint: { distance: 3 } }),
    useSensor(TouchSensor,    { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragStart({ active }: DragStartEvent) {
    setActiveId(active.id as string);
  }
  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null);
    if (!over || active.id === over.id) return;
    const oldIndex = onDeckMatches.findIndex((m) => m.id === active.id);
    const newIndex  = onDeckMatches.findIndex((m) => m.id === over.id);
    if (oldIndex !== -1 && newIndex !== -1) {
      setOnDeckMatches((prev) => arrayMove(prev, oldIndex, newIndex));
    }
  }
  function handleDragCancel() { setActiveId(null); }

  return (
    <div className="min-h-screen bg-slate-100 px-6 py-10">
      <div className="max-w-[960px] mx-auto space-y-10">

        {/* Page header */}
        <div>
          <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-1">
            Sandbox — Organizer Dashboard Cards
          </p>
          <h1 className="text-xl font-bold text-slate-900">Revamped Match Cards</h1>
          <p className="text-[13px] text-slate-500 mt-1">
            Drag the <GripVertical className="inline h-3.5 w-3.5 text-slate-400" /> grip to reorder · Hover a player to reveal the swap icon
          </p>
        </div>

        {/* ── On Deck ───────────────────────────────────────── */}
        <section>
          <div className="flex items-center gap-2.5 mb-4">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
            </span>
            <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wider">On Deck</h2>
            <span className="rounded-full px-2 py-0.5 text-xs font-bold bg-amber-100 text-amber-800">
              {onDeckMatches.length} matches ready
            </span>
            <span className="text-xs text-slate-400 hidden sm:block">— drag to reprioritize</span>
          </div>

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <SortableContext items={onDeckMatches.map((m) => m.id)} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {onDeckMatches.map((match, idx) => (
                  <SortableOnDeckCard key={match.id} match={match} index={idx} />
                ))}
              </div>
            </SortableContext>
            <DragOverlay dropAnimation={{ duration: 200, easing: "ease" }}>
              {activeMatch ? (
                <OverlayOnDeckCard
                  match={activeMatch}
                  index={onDeckMatches.findIndex((m) => m.id === activeMatch.id)}
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        </section>

        {/* ── Active Courts ─────────────────────────────────── */}
        <section>
          <div className="flex items-center gap-2.5 mb-4">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
            </span>
            <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wider">Active Courts</h2>
            <span className="rounded-full px-2 py-0.5 text-xs font-bold bg-emerald-100 text-emerald-800">
              1 in progress
            </span>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <ActiveCourtCard match={MOCK_ACTIVE} />
          </div>
        </section>

      </div>
    </div>
  );
}
