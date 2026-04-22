"use client";

// ============================================================
// Wrapped Preview — Static design mockup
// ============================================================
// Route: /wrapped/preview
// Purpose: Visual preview of award cards and no-awards state.
// No database queries — all data is hardcoded mock data.
// Safe to delete once the real /wrapped route is built.
// ============================================================

import { useState } from "react";
import { WrappedIntro } from "@/components/wrapped/wrapped-intro";

// ── Types ────────────────────────────────────────────────────

type Archetype = "performance" | "smart" | "social" | "comedic" | "chaos" | "grind";
type Rarity = "common" | "uncommon" | "rare" | "legendary";

interface AwardDef {
  key: string;
  emoji: string;
  name: string;
  archetype: Archetype;
  rarity: Rarity;
  tagline: string;           // short punchy one-liner shown on the card
  flavour: string;           // longer description shown below
  stat?: string;             // optional hero stat (e.g. "11 matches")
  subStat?: string;          // optional secondary stat
  partnerChip?: {            // for social awards that reference another player
    name: string;
    skill: string;
    skillColor: string;
  };
}

// ── Award Definitions (mock sample) ─────────────────────────

const AWARDS: AwardDef[] = [
  // ── Performance
  {
    key: "marathoner",
    emoji: "🏃",
    name: "The Marathoner",
    archetype: "performance",
    rarity: "uncommon",
    tagline: "Last one off the court.",
    flavour: "Most completed matches in the session. You never sat down.",
    stat: "11 matches",
    subStat: "≈ 143 min of play",
  },
  {
    key: "undefeated",
    emoji: "🏆",
    name: "The Undefeated",
    archetype: "performance",
    rarity: "rare",
    tagline: "Not once. Not even close.",
    flavour: "Won every single match in the session. A perfect night.",
    stat: "6W – 0L",
    subStat: "100% win rate",
  },
  {
    key: "assassin",
    emoji: "🗡️",
    name: "The Assassin",
    archetype: "performance",
    rarity: "uncommon",
    tagline: "Wins big. Every time.",
    flavour: "Highest average winning margin per match. Clinical.",
    stat: "+18 avg margin",
    subStat: "across 7 wins",
  },
  {
    key: "hot_hand",
    emoji: "🔥",
    name: "The Hot Hand",
    archetype: "performance",
    rarity: "uncommon",
    tagline: "Nobody could stop the run.",
    flavour: "Longest win streak at any point in the session.",
    stat: "5 in a row",
  },
  {
    key: "top_dog",
    emoji: "👑",
    name: "Session Top Dog",
    archetype: "performance",
    rarity: "uncommon",
    tagline: "Best in the building tonight.",
    flavour: "Ranked #1 on the session leaderboard.",
    stat: "#1 of 18 players",
    subStat: "78% win rate",
  },
  {
    key: "shutout_artist",
    emoji: "🚫",
    name: "The Shutout Artist",
    archetype: "performance",
    rarity: "rare",
    tagline: "They barely touched the shuttle.",
    flavour: "Won a match where the opponent scored 10 or fewer points.",
    stat: "31 – 7",
    subStat: "one-sided domination",
  },

  // ── Smart / Tactical
  {
    key: "surgeon",
    emoji: "🔬",
    name: "The Surgeon",
    archetype: "smart",
    rarity: "uncommon",
    tagline: "Precise. Efficient. Ruthless.",
    flavour: "Highest win percentage among players with 5+ matches.",
    stat: "83% win rate",
    subStat: "5 matches played",
  },
  {
    key: "stone_cold",
    emoji: "🪨",
    name: "Stone Cold",
    archetype: "smart",
    rarity: "rare",
    tagline: "Close games? You just don't lose them.",
    flavour: "Never lost a match decided by 3 or fewer points all session.",
    stat: "3 clutch games",
    subStat: "3W – 0L in close ones",
  },
  {
    key: "slow_burn",
    emoji: "🕯️",
    name: "The Slow Burn",
    archetype: "smart",
    rarity: "uncommon",
    tagline: "You warmed up eventually.",
    flavour: "Win rate in the second half of the session was significantly higher.",
    stat: "33% → 83%",
    subStat: "first half vs second half",
  },
  {
    key: "fortress",
    emoji: "🛡️",
    name: "The Fortress",
    archetype: "smart",
    rarity: "uncommon",
    tagline: "Scoring on you is a privilege.",
    flavour: "Fewest points conceded per match. Airtight defence.",
    stat: "12.4 pts against / match",
    subStat: "best in session",
  },

  // ── Social / Partner
  {
    key: "dynamic_duo",
    emoji: "🤝",
    name: "Dynamic Duo",
    archetype: "social",
    rarity: "uncommon",
    tagline: "Some partnerships just click.",
    flavour: "Highest win rate with a single partner across 3+ games together.",
    stat: "6W – 1L together",
    partnerChip: { name: "Marcus", skill: "Intermediate", skillColor: "#3B82F6" },
  },
  {
    key: "glue",
    emoji: "🫂",
    name: "The Glue",
    archetype: "social",
    rarity: "uncommon",
    tagline: "Played with everyone.",
    flavour: "Most unique partners across the session. The social hub of the night.",
    stat: "6 different partners",
  },
  {
    key: "catalyst",
    emoji: "⚡",
    name: "The Catalyst",
    archetype: "social",
    rarity: "rare",
    tagline: "Everyone wins more with you.",
    flavour: "Partners had a significantly higher win rate when playing WITH you than without.",
    stat: "+31% uplift",
    subStat: "across 5 partners",
  },

  // ── Nemesis
  {
    key: "nemesis",
    emoji: "⚔️",
    name: "The Nemesis",
    archetype: "social",
    rarity: "uncommon",
    tagline: "Your white whale.",
    flavour: "The opponent you've faced most across your entire history.",
    stat: "Lifetime: 5W – 9L",
    subStat: "14 matches across 6 sessions",
    partnerChip: { name: "Jay", skill: "Advanced", skillColor: "#9333EA" },
  },

  // ── Clutch
  {
    key: "ice_in_veins",
    emoji: "🧊",
    name: "Ice in the Veins",
    archetype: "performance",
    rarity: "uncommon",
    tagline: "Pressure is just a word.",
    flavour: "Most wins decided by 3 points or fewer. You live for the close ones.",
    stat: "4 clutch wins",
    subStat: "out of 5 close games",
  },
  {
    key: "thirty_all",
    emoji: "🎱",
    name: "The 30-All",
    archetype: "chaos",
    rarity: "legendary",
    tagline: "31 – 30. Absolute cinema.",
    flavour: "Won a match at the most dramatic possible scoreline.",
    stat: "31 – 30",
    subStat: "you held your nerve",
  },

  // ── Chaos / Freak
  {
    key: "thrill_seeker",
    emoji: "😤",
    name: "The Thrill Seeker",
    archetype: "chaos",
    rarity: "uncommon",
    tagline: "You don't do comfortable games.",
    flavour: "Most total matches decided by 3 or fewer points, wins or losses.",
    stat: "6 close games",
  },
  {
    key: "human_yoyo",
    emoji: "🪀",
    name: "The Human Yo-Yo",
    archetype: "chaos",
    rarity: "uncommon",
    tagline: "W. L. W. L. W. L. Perfectly cursed.",
    flavour: "Alternating win-loss-win-loss for 8 consecutive matches.",
    stat: "8-match streak",
    subStat: "alternating results",
  },
  {
    key: "ghost",
    emoji: "👻",
    name: "The Ghost",
    archetype: "chaos",
    rarity: "legendary",
    tagline: "Every single game. A coin flip.",
    flavour: "Played 6+ matches and every single one was decided by ≤ 3 points.",
    stat: "8 matches",
    subStat: "max margin: 3 pts",
  },

  // ── Grind / Time
  {
    key: "iron_shuttle",
    emoji: "🦾",
    name: "The Iron Shuttle",
    archetype: "grind",
    rarity: "rare",
    tagline: "You did not stop.",
    flavour: "7+ matches with no break longer than 15 minutes. Relentless.",
    stat: "9 matches",
    subStat: "zero real breaks",
  },
  {
    key: "speed_demon",
    emoji: "⚡",
    name: "The Speed Demon",
    archetype: "chaos",
    rarity: "rare",
    tagline: "Fastest win of the night.",
    flavour: "Won the fastest match in the session.",
    stat: "8 min 41 sec",
    subStat: "shortest completed match",
  },

  // ── Comedic
  {
    key: "generous",
    emoji: "🎁",
    name: "The Philanthropist",
    archetype: "comedic",
    rarity: "common",
    tagline: "Very generous of you.",
    flavour: "Conceded the most total points to opponents across the session.",
    stat: "247 gift points",
    subStat: "to grateful opponents",
  },
  {
    key: "fade",
    emoji: "🌅",
    name: "The Fade",
    archetype: "comedic",
    rarity: "uncommon",
    tagline: "You left it all on the court. Early.",
    flavour: "Win rate dropped by 40+ percentage points from first half to second.",
    stat: "75% → 25%",
    subStat: "first half vs second half",
  },
  {
    key: "philosopher",
    emoji: "🤔",
    name: "The Philosopher",
    archetype: "comedic",
    rarity: "uncommon",
    tagline: "A deep observer of the game.",
    flavour: "Spent more time waiting between matches than actually playing.",
    stat: "94 min watching",
    subStat: "62 min playing",
  },
  {
    key: "one_that_got_away",
    emoji: "🤦",
    name: "The One That Got Away",
    archetype: "comedic",
    rarity: "rare",
    tagline: "2 matches. 1 point each. We don't talk about it.",
    flavour: "Lost 2+ matches by exactly 1 point.",
    stat: "2 one-point losses",
    subStat: "31 – 30, twice",
  },

  // ── Floor award
  {
    key: "participation",
    emoji: "🏅",
    name: "The Participation Trophy",
    archetype: "comedic",
    rarity: "common",
    tagline: "You showed up. You played.",
    flavour: "That's the whole thing, honestly. Not everyone does.",
    stat: "1 match played",
  },
];

// ── Colour maps ───────────────────────────────────────────────

const ARCHETYPE_STYLES: Record<Archetype, {
  bg: string; border: string; iconBg: string;
  label: string; labelColor: string;
  statColor: string;
}> = {
  performance: {
    bg: "from-amber-950 to-amber-900",
    border: "border-amber-700/40",
    iconBg: "bg-amber-500/20",
    label: "PERFORMANCE",
    labelColor: "text-amber-400",
    statColor: "text-amber-300",
  },
  smart: {
    bg: "from-blue-950 to-blue-900",
    border: "border-blue-700/40",
    iconBg: "bg-blue-500/20",
    label: "TACTICAL",
    labelColor: "text-blue-400",
    statColor: "text-blue-300",
  },
  social: {
    bg: "from-rose-950 to-pink-900",
    border: "border-rose-700/40",
    iconBg: "bg-rose-500/20",
    label: "SOCIAL",
    labelColor: "text-rose-400",
    statColor: "text-rose-300",
  },
  comedic: {
    bg: "from-slate-800 to-slate-900",
    border: "border-slate-600/40",
    iconBg: "bg-slate-500/20",
    label: "TONIGHT'S TRUTH",
    labelColor: "text-slate-400",
    statColor: "text-slate-300",
  },
  chaos: {
    bg: "from-purple-950 to-violet-900",
    border: "border-purple-700/40",
    iconBg: "bg-purple-500/20",
    label: "CHAOS",
    labelColor: "text-purple-400",
    statColor: "text-purple-300",
  },
  grind: {
    bg: "from-emerald-950 to-green-900",
    border: "border-emerald-700/40",
    iconBg: "bg-emerald-500/20",
    label: "HUSTLE",
    labelColor: "text-emerald-400",
    statColor: "text-emerald-300",
  },
};

const RARITY_LABEL: Record<Rarity, { text: string; color: string }> = {
  common:    { text: "Common",    color: "text-slate-400" },
  uncommon:  { text: "Uncommon",  color: "text-blue-400" },
  rare:      { text: "Rare",      color: "text-amber-400" },
  legendary: { text: "✦ Legendary", color: "text-yellow-300" },
};

// ── AwardCard component ───────────────────────────────────────

function AwardCard({ award, compact = false }: { award: AwardDef; compact?: boolean }) {
  const style = ARCHETYPE_STYLES[award.archetype];
  const rarity = RARITY_LABEL[award.rarity];

  return (
    <div
      className={`
        relative flex flex-col rounded-2xl border ${style.border}
        bg-gradient-to-br ${style.bg}
        overflow-hidden
        ${compact ? "p-4 gap-2" : "p-5 gap-3"}
      `}
    >
      {/* Rarity & archetype header row */}
      <div className="flex items-center justify-between">
        <span className={`text-[10px] font-black uppercase tracking-widest ${style.labelColor}`}>
          {style.label}
        </span>
        <span className={`text-[10px] font-semibold ${rarity.color}`}>
          {rarity.text}
        </span>
      </div>

      {/* Icon + name row */}
      <div className="flex items-center gap-3">
        <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${style.iconBg}`}>
          <span className="text-2xl">{award.emoji}</span>
        </div>
        <div className="min-w-0">
          <p className="text-base font-black text-white leading-tight">{award.name}</p>
          <p className="text-xs text-white/60 leading-snug mt-0.5 italic">{award.tagline}</p>
        </div>
      </div>

      {/* Hero stat */}
      {award.stat && (
        <div>
          <p className={`text-2xl font-black tabular-nums leading-none ${style.statColor}`}>
            {award.stat}
          </p>
          {award.subStat && (
            <p className="text-[11px] text-white/50 mt-0.5">{award.subStat}</p>
          )}
        </div>
      )}

      {/* Partner chip (for social awards) */}
      {award.partnerChip && (
        <div className="flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/20 text-xs font-bold text-white">
            {award.partnerChip.name[0]}
          </div>
          <span className="text-sm font-semibold text-white">{award.partnerChip.name}</span>
          <span
            className="ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
            style={{ backgroundColor: award.partnerChip.skillColor + "40", color: award.partnerChip.skillColor }}
          >
            {award.partnerChip.skill}
          </span>
        </div>
      )}

      {/* Flavour text */}
      {!compact && (
        <p className="text-[12px] text-white/50 leading-relaxed border-t border-white/10 pt-3">
          {award.flavour}
        </p>
      )}
    </div>
  );
}

// ── Base Stats Card ───────────────────────────────────────────

function BaseStatsCard({ name, gp, w, l, winPct, rank, total }: {
  name: string; gp: number; w: number; l: number;
  winPct: number; rank: number; total: number;
}) {
  return (
    <div className="rounded-2xl border border-[#1D3A6F]/60 bg-[#0E1C3A] p-6 space-y-5">
      {/* Header */}
      <div className="space-y-0.5">
        <p className="text-[10px] font-black uppercase tracking-widest text-white/40">
          Your Session
        </p>
        <p className="text-2xl font-black text-white">{name}</p>
        <p className="text-xs text-white/40">Tuesday · Apr 22 · Night Session</p>
      </div>

      {/* Big stat row */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Played", value: gp, color: "text-white" },
          { label: "Won",    value: w,  color: "text-emerald-400" },
          { label: "Lost",   value: l,  color: "text-red-400" },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-xl bg-white/5 px-3 py-3 text-center">
            <p className={`text-3xl font-black tabular-nums leading-none ${color}`}>{value}</p>
            <p className="text-[10px] text-white/40 mt-1 uppercase tracking-wide">{label}</p>
          </div>
        ))}
      </div>

      {/* Win rate bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-white/40">Win Rate</span>
          <span className="text-xl font-black text-amber-400 tabular-nums">{winPct}%</span>
        </div>
        <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full rounded-full bg-amber-400"
            style={{ width: `${winPct}%` }}
          />
        </div>
      </div>

      {/* Session rank */}
      <div className="flex items-center gap-3 rounded-xl bg-amber-500/10 border border-amber-500/20 px-4 py-3">
        <span className="text-amber-400 text-lg">🏅</span>
        <div>
          <p className="text-white font-bold text-sm">
            Session Rank <span className="text-amber-400">#{rank}</span> of {total}
          </p>
          <p className="text-[11px] text-white/40">Based on win rate and point diff</p>
        </div>
      </div>
    </div>
  );
}

// ── No Awards State ───────────────────────────────────────────

function NoAwardsCard({ name, gp }: { name: string; gp: number }) {
  return (
    <div className="rounded-2xl border border-slate-700/40 bg-gradient-to-br from-slate-800 to-slate-900 p-6 space-y-4">
      {/* Icon */}
      <div className="flex items-center justify-center h-16 w-16 rounded-2xl bg-slate-700/50 mx-auto">
        <span className="text-3xl">🏅</span>
      </div>

      {/* Text */}
      <div className="text-center space-y-1.5">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
          Tonight&apos;s Truth
        </p>
        <p className="text-xl font-black text-white">The Participation Trophy</p>
        <p className="text-sm text-white/40 italic">You showed up. You played.</p>
      </div>

      {/* Stat */}
      <div className="text-center">
        <p className="text-4xl font-black tabular-nums text-slate-400">
          {gp}
        </p>
        <p className="text-xs text-slate-500 mt-1">match{gp !== 1 ? "es" : ""} played tonight</p>
      </div>

      <p className="text-[12px] text-slate-500 text-center leading-relaxed border-t border-slate-700 pt-4">
        Not everyone makes it out. Not everyone laces up and shows face.
        You did. That&apos;s the whole thing, honestly.
      </p>

      {/* Encouragement */}
      <div className="rounded-xl bg-slate-700/40 px-4 py-3 text-center">
        <p className="text-[11px] text-slate-400">
          Come back next session — the awards are waiting. 🏸
        </p>
      </div>
    </div>
  );
}

// ── Scenario tabs ─────────────────────────────────────────────

type Scenario = "many_awards" | "few_awards" | "no_awards";

const SCENARIO_AWARDS: Record<Scenario, string[]> = {
  many_awards:  ["top_dog", "undefeated", "dynamic_duo", "stone_cold", "thirty_all", "iron_shuttle"],
  few_awards:   ["slow_burn", "generous"],
  no_awards:    [],
};

const SCENARIO_PLAYER: Record<Scenario, {
  name: string; gp: number; w: number; l: number; winPct: number; rank: number;
}> = {
  many_awards:  { name: "Miggy",  gp: 9,  w: 8, l: 1, winPct: 89, rank: 1 },
  few_awards:   { name: "Carlos", gp: 8,  w: 4, l: 4, winPct: 50, rank: 9 },
  no_awards:    { name: "Sam",    gp: 2,  w: 0, l: 2, winPct: 0,  rank: 18 },
};

// ── Main Page ─────────────────────────────────────────────────

export default function WrappedPreview() {
  const [activeScenario, setActiveScenario] = useState<Scenario>("many_awards");
  const [showAll, setShowAll] = useState(false);
  const [showIntro, setShowIntro] = useState(false);

  const scenarioAwardKeys = SCENARIO_AWARDS[activeScenario];
  const player = SCENARIO_PLAYER[activeScenario];
  const scenarioAwards = AWARDS.filter(a => scenarioAwardKeys.includes(a.key));
  const displayedAwards = showAll ? AWARDS : AWARDS.slice(0, 12);

  return (
    <div className="min-h-screen bg-[#080F1C] text-white pb-24">

      {/* ── Animated intro overlay ───────────────────────────── */}
      {showIntro && (
        <WrappedIntro
          playerName={SCENARIO_PLAYER[activeScenario].name}
          games={SCENARIO_PLAYER[activeScenario].gp}
          wins={SCENARIO_PLAYER[activeScenario].w}
          onDismiss={() => setShowIntro(false)}
        />
      )}

      {/* ── Top banner ─────────────────────────────────────── */}
      <div className="border-b border-white/10 bg-[#0E1C3A]/80 backdrop-blur px-4 py-3 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto flex items-center justify-between gap-2">
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-amber-400">Preview Mode</p>
            <p className="text-sm font-semibold text-white/70">Session Wrapped — Design Preview</p>
          </div>
          <div className="flex items-center gap-2">
            {/* Trigger the animated intro */}
            <button
              onClick={() => setShowIntro(true)}
              className="flex items-center gap-1.5 rounded-full
                         bg-amber-500 hover:bg-amber-400 active:scale-95
                         px-3 py-1.5 text-[11px] font-black uppercase tracking-widest
                         text-[#060D1B] transition-all"
            >
              ▶ Play Intro
            </button>
            <span className="text-[10px] bg-amber-500/20 text-amber-400 border border-amber-500/30
                             rounded-full px-2.5 py-1 font-bold hidden sm:inline">
              Static / No DB
            </span>
          </div>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 space-y-12 pt-8">

        {/* ── Section 1: Scenario switcher ───────────────────── */}
        <section className="space-y-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-1">
              Player Scenario
            </p>
            <h2 className="text-xl font-black text-white">What does each player see?</h2>
            <p className="text-sm text-white/40 mt-1">
              Switch between three scenarios to see how the Wrapped experience adapts.
            </p>
          </div>

          {/* Tabs */}
          <div className="grid grid-cols-3 gap-2">
            {(["many_awards", "few_awards", "no_awards"] as Scenario[]).map((s) => {
              const labels: Record<Scenario, { title: string; sub: string; emoji: string }> = {
                many_awards: { title: "The Champion",  sub: "8W–1L · 6 awards",   emoji: "🏆" },
                few_awards:  { title: "The Average",   sub: "4W–4L · 2 awards",   emoji: "🤷" },
                no_awards:   { title: "Rough Night",   sub: "0W–2L · 0 awards",   emoji: "🥲" },
              };
              const l = labels[s];
              return (
                <button
                  key={s}
                  onClick={() => setActiveScenario(s)}
                  className={`flex flex-col items-center rounded-2xl border px-3 py-4 transition-all text-center
                    ${activeScenario === s
                      ? "bg-amber-500/10 border-amber-500/40 text-amber-400"
                      : "bg-white/5 border-white/10 text-white/50 hover:bg-white/10"
                    }`}
                >
                  <span className="text-2xl mb-1.5">{l.emoji}</span>
                  <span className="text-xs font-bold leading-tight">{l.title}</span>
                  <span className="text-[10px] mt-0.5 opacity-60">{l.sub}</span>
                </button>
              );
            })}
          </div>

          {/* Base stats card for this player */}
          <BaseStatsCard
            name={player.name}
            gp={player.gp}
            w={player.w}
            l={player.l}
            winPct={player.winPct}
            rank={player.rank}
            total={18}
          />

          {/* Awards for this scenario */}
          {activeScenario === "no_awards" ? (
            <div className="space-y-3">
              <p className="text-[11px] font-semibold text-white/30 uppercase tracking-widest">
                No performance awards earned
              </p>
              <NoAwardsCard name={player.name} gp={player.gp} />
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-[11px] font-semibold text-white/30 uppercase tracking-widest">
                {scenarioAwards.length} award{scenarioAwards.length !== 1 ? "s" : ""} earned this session
              </p>
              <div className="space-y-3">
                {scenarioAwards.map(a => (
                  <AwardCard key={a.key} award={a} />
                ))}
              </div>
            </div>
          )}
        </section>

        {/* ── Divider ────────────────────────────────────────── */}
        <div className="border-t border-white/10" />

        {/* ── Section 2: Full award catalogue preview ─────────── */}
        <section className="space-y-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-1">
              Full Catalogue
            </p>
            <h2 className="text-xl font-black text-white">All award card designs</h2>
            <p className="text-sm text-white/40 mt-1">
              Every archetype and rarity shown with sample data.
            </p>
          </div>

          {/* Archetype legend */}
          <div className="flex flex-wrap gap-2">
            {(Object.entries(ARCHETYPE_STYLES) as [Archetype, typeof ARCHETYPE_STYLES[Archetype]][]).map(([key, s]) => (
              <span key={key} className={`text-[10px] font-bold uppercase tracking-widest ${s.labelColor}
                                          bg-white/5 rounded-full px-2.5 py-1`}>
                {s.label}
              </span>
            ))}
          </div>

          {/* Grid */}
          <div className="space-y-3">
            {displayedAwards.map(a => (
              <AwardCard key={a.key} award={a} />
            ))}
          </div>

          {!showAll && (
            <button
              onClick={() => setShowAll(true)}
              className="w-full rounded-2xl border border-white/10 bg-white/5 py-3
                         text-sm font-semibold text-white/50 hover:bg-white/10 hover:text-white
                         transition-colors"
            >
              Show all {AWARDS.length} awards ↓
            </button>
          )}
        </section>

        {/* ── Section 3: Compact variant ───────────────────────── */}
        <section className="space-y-4">
          <div className="border-t border-white/10 pt-8">
            <p className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-1">
              Compact Variant
            </p>
            <h2 className="text-xl font-black text-white">Awards in a grid</h2>
            <p className="text-sm text-white/40 mt-1">
              When a player has many awards, they stack in a denser 2-column layout.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {AWARDS.filter(a =>
              ["marathoner","hot_hand","glue","human_yoyo","slow_burn","stone_cold"].includes(a.key)
            ).map(a => (
              <AwardCard key={a.key} award={a} compact />
            ))}
          </div>
        </section>

        {/* ── Footer ─────────────────────────────────────────── */}
        <div className="border-t border-white/10 pt-8 pb-4 text-center space-y-2">
          <p className="text-xs text-white/20">
            This is a static design preview. No database queries. All data is mocked.
          </p>
          <p className="text-xs text-white/20">
            Delete <code className="text-amber-400/60 text-[10px]">src/app/wrapped/preview/</code> once the real route is built.
          </p>
        </div>

      </div>
    </div>
  );
}
