"use client";

// ============================================================
// Streak Indicator Preview — Design Options A / B / C
// /sandbox/streak-preview
// ============================================================

import { Flame } from "lucide-react";

// ── Mock data ─────────────────────────────────────────────────

type MockPlayer = {
  display_name: string;
  skill_level: string;
  vip_tag: string | null;
  vip_theme: string | null;
  win_streak: number;
};

const HOT: MockPlayer = {
  display_name: "Miguel",
  skill_level: "Intermediate",
  vip_tag: "GOAT",
  vip_theme: "gold",
  win_streak: 4,
};

const COLD: MockPlayer = {
  display_name: "Esmé",
  skill_level: "Advanced",
  vip_tag: null,
  vip_theme: null,
  win_streak: 0,
};

const STREAKING_NO_VIP: MockPlayer = {
  display_name: "Jordan",
  skill_level: "Beginner",
  vip_tag: null,
  vip_theme: null,
  win_streak: 3,
};

// ── Shared sub-components ─────────────────────────────────────

function SkillBadge({ level }: { level: string }) {
  const color =
    level === "Advanced"
      ? "text-cc-blue"
      : level === "Intermediate"
        ? "text-cc-accent"
        : "text-cc-t3";
  return (
    <span className={`font-command text-[9px] uppercase tracking-[0.12em] ${color}`}>{level}</span>
  );
}

function VipTag({ tag }: { tag: string }) {
  return (
    <span
      className="clip-cut-badge shrink-0 px-1.5 py-0.5
                 font-command text-[8px] uppercase tracking-[0.12em]
                 bg-[oklch(0.78_0.17_62/0.18)] border border-[oklch(0.78_0.17_62/0.4)]
                 text-cc-amber"
    >
      {tag}
    </span>
  );
}

// ── Team pairing mock ─────────────────────────────────────────
// Two variants of the match roster layout for preview context

function VsBadge() {
  return (
    <div className="flex items-center justify-center">
      <span className="font-command text-[9px] font-bold tracking-[0.12em] text-cc-t3">VS</span>
    </div>
  );
}

// ── OPTION A — Inline Status Chip ─────────────────────────────

function OptionARowDark({ player }: { player: MockPlayer }) {
  const hasStreak = player.win_streak >= 3;
  return (
    <div className="w-full clip-cut-tr bg-cc-bg-3 px-3 py-2 transition-colors hover:bg-cc-border">
      <div className="flex items-center gap-1.5 overflow-hidden">
        <span className="shrink min-w-0 truncate font-command text-[12px] leading-none font-medium text-cc-t1">
          {player.display_name}
        </span>
        {hasStreak && (
          <span
            className="clip-cut-badge shrink-0 flex items-center gap-[3px]
                       bg-cc-amber-dim border border-cc-amber/40
                       font-command text-[9px] uppercase tracking-[0.10em] text-cc-amber
                       px-2 py-0.5"
            aria-label={`Win streak: ${player.win_streak}`}
          >
            <Flame className="h-2.5 w-2.5" />
            {player.win_streak}W
          </span>
        )}
        {player.vip_tag && <VipTag tag={player.vip_tag} />}
      </div>
      <div className="mt-1">
        <SkillBadge level={player.skill_level} />
      </div>
    </div>
  );
}

function OptionARowLight({ player }: { player: MockPlayer }) {
  const hasStreak = player.win_streak >= 3;
  return (
    <div className="w-full clip-cut-tr bg-cc-bg-3 px-3 py-2 transition-colors hover:bg-cc-border">
      <div className="flex items-center gap-1.5 overflow-hidden">
        <span className="shrink min-w-0 truncate font-command text-[12px] leading-none font-medium text-cc-t1">
          {player.display_name}
        </span>
        {hasStreak && (
          <span
            className="clip-cut-badge shrink-0 flex items-center gap-[3px]
                       bg-cc-amber-dim border border-cc-amber/40
                       font-command text-[9px] uppercase tracking-[0.10em] text-cc-amber
                       px-2 py-0.5"
            aria-label={`Win streak: ${player.win_streak}`}
          >
            <Flame className="h-2.5 w-2.5" />
            {player.win_streak}W
          </span>
        )}
        {player.vip_tag && <VipTag tag={player.vip_tag} />}
      </div>
      <div className="mt-1">
        <SkillBadge level={player.skill_level} />
      </div>
    </div>
  );
}

// ── OPTION B — Full Pill Tint ─────────────────────────────────

function OptionBRowDark({ player }: { player: MockPlayer }) {
  const hasStreak = player.win_streak >= 3;
  return (
    <div
      className={[
        "w-full clip-cut-tr px-3 py-2 transition-all duration-200",
        hasStreak
          ? "bg-cc-amber-dim border border-cc-amber/30 hover:bg-[oklch(0.78_0.17_62/0.2)]"
          : "bg-cc-bg-3 hover:bg-cc-border",
      ].join(" ")}
    >
      <div className="flex items-center justify-between gap-1.5 overflow-hidden">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="shrink min-w-0 truncate font-command text-[12px] leading-none font-medium text-cc-t1">
            {player.display_name}
          </span>
          {player.vip_tag && <VipTag tag={player.vip_tag} />}
        </div>
        {hasStreak && (
          <span
            className="shrink-0 flex items-center gap-[3px] font-command text-[10px] font-bold text-cc-amber"
            aria-label={`Win streak: ${player.win_streak}`}
          >
            <Flame className="h-3 w-3" />×{player.win_streak}
          </span>
        )}
      </div>
      <div className="mt-1">
        <SkillBadge level={player.skill_level} />
      </div>
    </div>
  );
}

// ── OPTION B ANIMATED — Overdrive ─────────────────────────────
// Layers:
//  1. One-shot ignition flash on mount (scale + brightness, 0.5s)
//  2. filter:drop-shadow glow pulse on wrapper — follows clip-path polygon (2.2s ∞)
//  3. cc-scan-style amber scanline sweep every 5s
//  4. Flame icon heartbeat (scale + rotate, 1.8s ∞)
//  5. Score count scoreboard kick every 4s
//  6. @property --streak-glow interpolates border opacity (normally un-animatable)

function OptionBAnimatedRowDark({ player }: { player: MockPlayer }) {
  const hasStreak = player.win_streak >= 3;

  return (
    <div className={hasStreak ? "streak-glow-wrapper" : undefined}>
      <div
        className={[
          "streak-row w-full clip-cut-tr relative overflow-hidden",
          hasStreak
            ? "streak-hot-border streak-ignite"
            : "bg-cc-bg-3 hover:bg-cc-border transition-colors duration-150",
        ].join(" ")}
        style={hasStreak ? { background: "oklch(0.72 0.22 38 / 0.22)" } : undefined}
      >
        {/* Main row — name + flame counter */}
        <div className="relative z-[1] flex items-center justify-between gap-2 px-3 pt-2 pb-1 overflow-hidden">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="shrink min-w-0 truncate font-command text-[13px] leading-none font-bold text-cc-t1">
              {player.display_name}
            </span>
            {player.vip_tag && <VipTag tag={player.vip_tag} />}
          </div>
          {hasStreak && (
            <span
              className="shrink-0 flex items-center gap-1.5"
              aria-label={`Win streak: ${player.win_streak}`}
            >
              <span className="flame-icon inline-flex items-center">
                <Flame className="h-4 w-4" />
              </span>
              <span
                className="streak-label font-command text-[9px] uppercase"
                style={{ letterSpacing: "0.18em" }}
              >
                Win Streak
              </span>
              <span className="streak-count font-command text-[13px]">×{player.win_streak}</span>
            </span>
          )}
        </div>

        <div className="relative z-[1] px-3 pb-2">
          <SkillBadge level={player.skill_level} />
        </div>
      </div>
    </div>
  );
}

// ── OPTION C — Leading Amber Square Badge ─────────────────────

function OptionCRowDark({ player }: { player: MockPlayer }) {
  const hasStreak = player.win_streak >= 3;
  return (
    <div className="w-full clip-cut-tr bg-cc-bg-3 px-3 py-2 transition-colors hover:bg-cc-border flex items-center gap-2">
      {/* Leading streak badge — fixed width slot so name stays aligned */}
      {hasStreak ? (
        <span
          className="shrink-0 w-6 h-6 flex items-center justify-center
                     bg-cc-amber
                     font-command text-[10px] font-bold clip-cut-sm
                     text-[oklch(0.11_0.016_238)]"
          aria-label={`Win streak: ${player.win_streak}`}
        >
          {player.win_streak}
        </span>
      ) : (
        <span className="shrink-0 w-6" aria-hidden="true" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 overflow-hidden">
          <span className="shrink min-w-0 truncate font-command text-[12px] leading-none font-medium text-cc-t1">
            {player.display_name}
          </span>
          {player.vip_tag && <VipTag tag={player.vip_tag} />}
        </div>
        <div className="mt-1">
          <SkillBadge level={player.skill_level} />
        </div>
      </div>
    </div>
  );
}

// ── OPTION B FIRE BORDER ─────────────────────────────────────
// Burning border variant: border color cycles red → orange → amber via
// @property --fire-hue. Outer glow shifts 4-layer drop-shadow through
// fire color temperatures every 0.85s. Background flickers independently.

function OptionBFireBorderDark({ player }: { player: MockPlayer }) {
  const hasStreak = player.win_streak >= 3;

  return (
    <div className={hasStreak ? "fire-glow-wrapper" : undefined}>
      <div
        className={[
          "streak-row w-full clip-cut-tr relative overflow-hidden",
          hasStreak
            ? "fire-border fire-bg streak-ignite"
            : "bg-cc-bg-3 hover:bg-cc-border transition-colors duration-150",
        ].join(" ")}
      >
        <div className="relative z-[1] flex items-center justify-between gap-2 px-3 pt-2 pb-1 overflow-hidden">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="shrink min-w-0 truncate font-command text-[13px] leading-none font-bold text-cc-t1">
              {player.display_name}
            </span>
            {player.vip_tag && <VipTag tag={player.vip_tag} />}
          </div>
          {hasStreak && (
            <span
              className="shrink-0 flex items-center gap-1.5"
              aria-label={`Win streak: ${player.win_streak}`}
            >
              <span className="flame-icon inline-flex items-center">
                <Flame className="h-4 w-4" />
              </span>
              <span
                className="streak-label font-command text-[9px] uppercase"
                style={{ letterSpacing: "0.18em" }}
              >
                Win Streak
              </span>
              <span className="streak-count font-command text-[13px]">×{player.win_streak}</span>
            </span>
          )}
        </div>
        <div className="relative z-[1] px-3 pb-2">
          <SkillBadge level={player.skill_level} />
        </div>
      </div>
    </div>
  );
}

// ── Roster grid mock ──────────────────────────────────────────

function RosterGrid({
  players,
  RowComponent,
}: {
  players: [MockPlayer, MockPlayer, MockPlayer, MockPlayer];
  RowComponent: React.FC<{ player: MockPlayer }>;
}) {
  const [a0, a1, b0, b1] = players;
  return (
    <div className="grid gap-y-2 px-3 py-3" style={{ gridTemplateColumns: "1fr 40px 1fr" }}>
      {/* Labels */}
      <div style={{ gridColumn: 1, gridRow: 1 }}>
        <span className="font-command text-[9px] uppercase tracking-[0.20em] text-cc-t3">
          Team A
        </span>
      </div>
      <div style={{ gridColumn: 2, gridRow: 1 }} />
      <div style={{ gridColumn: 3, gridRow: 1 }} className="text-right">
        <span className="font-command text-[9px] uppercase tracking-[0.20em] text-cc-t3">
          Team B
        </span>
      </div>
      {/* VS badge */}
      <div
        style={{ gridColumn: 2, gridRow: "2 / span 2" }}
        className="flex items-center justify-center"
      >
        <VsBadge />
      </div>
      {/* Row 2 */}
      <div style={{ gridColumn: 1, gridRow: 2 }}>
        <RowComponent player={a0} />
      </div>
      <div style={{ gridColumn: 3, gridRow: 2 }}>
        <RowComponent player={b0} />
      </div>
      {/* Row 3 */}
      <div style={{ gridColumn: 1, gridRow: 3 }}>
        <RowComponent player={a1} />
      </div>
      <div style={{ gridColumn: 3, gridRow: 3 }}>
        <RowComponent player={b1} />
      </div>
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────

function OptionCard({
  label,
  tag,
  description,
  children,
}: {
  label: string;
  tag: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="clip-cut-badge bg-cc-accent-dim border border-cc-accent/30 font-command text-[9px] uppercase tracking-[0.14em] text-cc-accent px-2.5 py-1">
          {tag}
        </span>
        <h2 className="font-command text-[14px] font-bold uppercase tracking-[0.12em] text-cc-t1">
          {label}
        </h2>
      </div>
      <p className="font-command text-[10px] uppercase tracking-[0.08em] text-cc-t3 max-w-sm">
        {description}
      </p>
      {children}
    </div>
  );
}

function CourtCardMock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="clip-cut overflow-hidden border border-cc-border bg-cc-bg-2">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-cc-accent/25">
        <h3 className="font-command text-[18px] font-bold uppercase tracking-[0.06em] text-cc-t1">
          {title}
        </h3>
        <span className="clip-cut-badge bg-cc-badge-progress-bg border border-cc-amber/40 font-command text-[9px] uppercase tracking-[0.12em] text-cc-amber px-2.5 py-0.5">
          In Progress
        </span>
      </div>
      {children}
    </div>
  );
}

function OnDeckMock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl overflow-hidden border border-cc-border bg-cc-bg-2">
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-cc-border">
        <h3 className="font-command text-[13px] font-bold uppercase tracking-[0.10em] text-cc-t1">
          {title}
        </h3>
        <span className="clip-cut-badge bg-cc-accent-dim border border-cc-accent/30 font-command text-[9px] uppercase tracking-[0.12em] text-cc-accent px-2.5 py-0.5">
          On Deck
        </span>
      </div>
      {children}
    </div>
  );
}

// ── Roster configurations ─────────────────────────────────────
// Simulate realistic match: one hot player, one cold, mix of streakers

const MATCH_PLAYERS: [MockPlayer, MockPlayer, MockPlayer, MockPlayer] = [
  HOT, // A0 — on a 4W streak + VIP
  COLD, // A1 — no streak
  STREAKING_NO_VIP, // B0 — on a 3W streak, no VIP
  { ...COLD, display_name: "Ravi", skill_level: "Beginner" }, // B1 — cold
];

// ── Page ──────────────────────────────────────────────────────

export default function StreakPreviewPage() {
  return (
    <div className="min-h-screen bg-cc-bg p-8 space-y-16">
      {/* ── Overdrive animation keyframes ── */}
      <style>{`
        /* Hot orange — distinct from cc-amber (62°) and cc-red (25°) */
        /* oklch(0.72 0.22 38) = scoreboard fire, not warning, not error  */

        @property --streak-glow {
          syntax: '<number>';
          inherits: false;
          initial-value: 0.5;
        }

        /* One-shot ignition on mount */
        @keyframes streak-ignite {
          0%   { transform: scale(1);     filter: brightness(1); }
          30%  { transform: scale(1.025); filter: brightness(1.4); }
          100% { transform: scale(1);     filter: brightness(1); }
        }

        /* Ambient polygon glow — traces clip-path shape */
        @keyframes streak-outer-glow {
          0%, 100% { filter: drop-shadow(0 0 3px  oklch(0.72 0.22 38 / 0.4))
                             drop-shadow(0 0 6px   oklch(0.72 0.22 38 / 0.15)); }
          50%      { filter: drop-shadow(0 0 14px  oklch(0.72 0.22 38 / 0.85))
                             drop-shadow(0 0 32px  oklch(0.72 0.22 38 / 0.35)); }
        }

        /* @property border opacity — normally un-animatable in CSS */
        @keyframes streak-border-pulse {
          0%, 100% { --streak-glow: 0.5; }
          50%      { --streak-glow: 1.0; }
        }

        /* Flame — controlled energy, not chaos */
        @keyframes flame-beat {
          0%   { transform: scale(1)    rotate(0deg);  filter: brightness(1);   }
          25%  { transform: scale(1.2)  rotate(-4deg); filter: brightness(1.6); }
          50%  { transform: scale(1.1)  rotate(3deg);  filter: brightness(1.3); }
          75%  { transform: scale(1.18) rotate(-3deg); filter: brightness(1.5); }
          100% { transform: scale(1)    rotate(0deg);  filter: brightness(1);   }
        }

        .streak-ignite {
          animation: streak-ignite 0.55s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .streak-hot-border {
          border: 1px solid oklch(0.72 0.22 38 / var(--streak-glow));
          animation: streak-border-pulse 1.8s ease-in-out infinite;
        }
        .streak-glow-wrapper {
          animation: streak-outer-glow 1.8s ease-in-out infinite;
        }
        .flame-icon {
          animation: flame-beat 1.5s ease-in-out infinite;
          display: inline-flex;
          transform-origin: bottom center;
          color: oklch(0.88 0.2 38);
          filter: drop-shadow(0 0 5px oklch(0.72 0.22 38 / 0.95));
        }

        /* Text labels — dark in light mode (contrast on pale orange bg),
           bright in dark mode (contrast on dark navy bg) */
        .streak-label {
          color: oklch(0.18 0.06 38);
          font-weight: 800;
        }
        .dark .streak-label {
          color: oklch(0.92 0.18 38);
          text-shadow: 0 0 8px oklch(0.72 0.22 38 / 0.7);
        }
        .streak-count {
          color: oklch(0.18 0.06 38);
          font-weight: 800;
        }
        .dark .streak-count {
          color: oklch(0.95 0.16 38);
          text-shadow: 0 0 10px oklch(0.72 0.22 38 / 0.8);
        }

        /* Container query — fires on actual column width, not viewport.
           The player row is always in a narrow 1fr column regardless of screen.
           Below 210px column width: drop the label, keep 🔥 ×N only.
           Below 170px: shrink flame too. */
        .streak-row { container-type: inline-size; }

        @container (max-width: 255px) {
          .streak-label { display: none; }
          .streak-count { font-size: 11px; }
        }

        @container (max-width: 180px) {
          .flame-icon { width: 14px; height: 14px; }
          .streak-count { font-size: 10px; }
        }

        @media (prefers-reduced-motion: reduce) {
          .streak-ignite,
          .streak-glow-wrapper,
          .flame-icon { animation: none; }
          .streak-hot-border {
            border: 1px solid oklch(0.72 0.22 38 / 0.65);
            animation: none;
          }
        }

        /* ── FIRE BORDER VARIANT ─────────────────────────────────────
           Border color cycles through fire spectrum: red → orange → amber.
           Outer glow shifts color temperature at a faster cadence than the
           ambient glow variant, creating an organic burning rhythm.       */

        @property --fire-hue {
          syntax: '<number>';
          inherits: false;
          initial-value: 22;
        }

        @keyframes fire-hue-spin {
          0%   { --fire-hue: 18; }
          25%  { --fire-hue: 36; }
          55%  { --fire-hue: 52; }
          80%  { --fire-hue: 28; }
          100% { --fire-hue: 18; }
        }

        /* 4-layer drop-shadow cycling through red/orange/amber temps */
        @keyframes fire-outer-glow {
          0%   { filter:
                   drop-shadow(0 0 2px  oklch(0.68 0.26 18 / 0.95))
                   drop-shadow(0 0 8px  oklch(0.72 0.23 28 / 0.7))
                   drop-shadow(0 0 20px oklch(0.75 0.2  38 / 0.38)); }
          25%  { filter:
                   drop-shadow(0 0 5px  oklch(0.78 0.22 40 / 0.98))
                   drop-shadow(0 0 14px oklch(0.81 0.19 50 / 0.78))
                   drop-shadow(0 0 30px oklch(0.83 0.16 58 / 0.48))
                   drop-shadow(0 0 55px oklch(0.75 0.14 62 / 0.2)); }
          50%  { filter:
                   drop-shadow(0 0 3px  oklch(0.70 0.26 22 / 0.95))
                   drop-shadow(0 0 10px oklch(0.73 0.23 30 / 0.72))
                   drop-shadow(0 0 24px oklch(0.76 0.20 42 / 0.42)); }
          75%  { filter:
                   drop-shadow(0 0 6px  oklch(0.80 0.21 44 / 0.98))
                   drop-shadow(0 0 16px oklch(0.83 0.17 54 / 0.82))
                   drop-shadow(0 0 34px oklch(0.85 0.15 60 / 0.52))
                   drop-shadow(0 0 60px oklch(0.77 0.13 64 / 0.22)); }
          100% { filter:
                   drop-shadow(0 0 2px  oklch(0.68 0.26 18 / 0.95))
                   drop-shadow(0 0 8px  oklch(0.72 0.23 28 / 0.7))
                   drop-shadow(0 0 20px oklch(0.75 0.2  38 / 0.38)); }
        }

        /* Background flickers between red-orange and amber tones */
        @keyframes fire-bg-flicker {
          0%, 100% { background: oklch(0.72 0.22 38 / 0.24); }
          22%      { background: oklch(0.68 0.27 20 / 0.32); }
          48%      { background: oklch(0.75 0.20 50 / 0.20); }
          72%      { background: oklch(0.70 0.25 26 / 0.34); }
        }

        .fire-glow-wrapper {
          animation: fire-outer-glow 0.85s ease-in-out infinite;
        }
        .fire-border {
          border: 2px solid oklch(0.84 0.22 var(--fire-hue));
          animation:
            fire-hue-spin 1.1s ease-in-out infinite,
            streak-ignite 0.55s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .fire-bg {
          animation: fire-bg-flicker 0.85s ease-in-out infinite;
        }

        @media (prefers-reduced-motion: reduce) {
          .fire-glow-wrapper,
          .fire-bg { animation: none; }
          .fire-border {
            border: 2px solid oklch(0.78 0.22 38 / 0.85);
            animation: none;
          }
        }
      `}</style>

      {/* Page header */}
      <div className="space-y-2">
        <p className="font-command text-[10px] uppercase tracking-[0.20em] text-cc-accent">
          Design Preview · Streak Indicator
        </p>
        <h1 className="font-command text-[28px] font-bold uppercase tracking-[0.08em] text-cc-t1">
          Win Streak Badge Options
        </h1>
        <p className="font-command text-[10px] uppercase tracking-[0.08em] text-cc-t3 max-w-md">
          Threshold: 3+ consecutive wins · Shown on active courts + on deck · Players with streaks:
          Miguel (4W) and Jordan (3W)
        </p>
      </div>

      <div className="grid gap-14">
        {/* ── OPTION B ANIMATED (OVERDRIVE) ────────────────── */}
        <OptionCard
          tag="⚡ Overdrive"
          label="Option B Animated — Hot Pill"
          description="Critique-revised: hot orange (not amber — avoids warning conflict), 2 animations only (polygon glow + flame), flame capped at 1.2×/±4°, WIN STREAK inline."
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-2">
              <p className="font-command text-[9px] uppercase tracking-[0.16em] text-cc-t3">
                Active Courts (dark)
              </p>
              <CourtCardMock title="Court 1">
                <RosterGrid players={MATCH_PLAYERS} RowComponent={OptionBAnimatedRowDark} />
              </CourtCardMock>
            </div>
            <div className="space-y-2">
              <p className="font-command text-[9px] uppercase tracking-[0.16em] text-cc-t3">
                On Deck (pending)
              </p>
              <OnDeckMock title="Next Up">
                <RosterGrid players={MATCH_PLAYERS} RowComponent={OptionBAnimatedRowDark} />
              </OnDeckMock>
            </div>
          </div>
        </OptionCard>

        <div className="border-t border-dashed border-cc-border" />

        {/* ── FIRE BORDER VARIANT ───────────────────────────── */}
        <OptionCard
          tag="🔥 Fire Border"
          label="Option B — Burning Border"
          description="Border hue cycles red → orange → amber via @property. 4-layer drop-shadow shifts color temp every 0.85s. Background flickers between fire tones. Distinct from the glow variant above."
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-2">
              <p className="font-command text-[9px] uppercase tracking-[0.16em] text-cc-t3">
                Active Courts (light mode)
              </p>
              <CourtCardMock title="Court 1">
                <RosterGrid players={MATCH_PLAYERS} RowComponent={OptionBFireBorderDark} />
              </CourtCardMock>
            </div>
            <div className="space-y-2">
              <p className="font-command text-[9px] uppercase tracking-[0.16em] text-cc-t3">
                On Deck (light mode)
              </p>
              <OnDeckMock title="Next Up">
                <RosterGrid players={MATCH_PLAYERS} RowComponent={OptionBFireBorderDark} />
              </OnDeckMock>
            </div>
          </div>

          {/* Dark mode preview inline */}
          <div
            className="dark mt-6 rounded-xl overflow-hidden"
            style={{ background: "oklch(0.10 0.015 238)" }}
          >
            <div className="p-5 space-y-4">
              <p className="font-command text-[9px] uppercase tracking-[0.16em] text-cc-t3">
                Dark mode — how it looks on the real dashboard
              </p>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <CourtCardMock title="Court 1">
                  <RosterGrid players={MATCH_PLAYERS} RowComponent={OptionBFireBorderDark} />
                </CourtCardMock>
                <OnDeckMock title="Next Up">
                  <RosterGrid players={MATCH_PLAYERS} RowComponent={OptionBFireBorderDark} />
                </OnDeckMock>
              </div>
            </div>
          </div>
        </OptionCard>

        <div className="border-t border-dashed border-cc-border" />

        {/* ── OPTION A ─────────────────────────────────────── */}
        <OptionCard
          tag="Option A"
          label="Status Chip — Inline Badge"
          description="Clip-cut amber badge injected inline on line 1, between name and VIP tag. Uses existing badge language from Mixed Level / origin tags."
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-2">
              <p className="font-command text-[9px] uppercase tracking-[0.16em] text-cc-t3">
                Active Courts (dark)
              </p>
              <CourtCardMock title="Court 1">
                <RosterGrid players={MATCH_PLAYERS} RowComponent={OptionARowDark} />
              </CourtCardMock>
            </div>
            <div className="space-y-2">
              <p className="font-command text-[9px] uppercase tracking-[0.16em] text-cc-t3">
                On Deck (pending)
              </p>
              <OnDeckMock title="Next Up">
                <RosterGrid players={MATCH_PLAYERS} RowComponent={OptionARowLight} />
              </OnDeckMock>
            </div>
          </div>
        </OptionCard>

        {/* ── DARK MODE PREVIEW ────────────────────────────── */}
        <div
          className="dark rounded-xl overflow-hidden"
          style={{ background: "oklch(0.10 0.015 238)" }}
        >
          <div className="p-6 space-y-4">
            <div className="flex items-center gap-3">
              <span className="clip-cut-badge bg-cc-accent-dim border border-cc-accent/30 font-command text-[9px] uppercase tracking-[0.14em] text-cc-accent px-2.5 py-1">
                Dark Mode
              </span>
              <h2 className="font-command text-[14px] font-bold uppercase tracking-[0.12em] text-cc-t1">
                How it looks on the real dashboard
              </h2>
            </div>
            <p className="font-command text-[10px] uppercase tracking-[0.08em] text-cc-t3">
              The organizer view runs on dark navy — this is the actual surface the indicator will
              live on
            </p>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-2">
                <p className="font-command text-[9px] uppercase tracking-[0.16em] text-cc-t3">
                  Active Courts
                </p>
                <CourtCardMock title="Court 1">
                  <RosterGrid players={MATCH_PLAYERS} RowComponent={OptionBAnimatedRowDark} />
                </CourtCardMock>
              </div>
              <div className="space-y-2">
                <p className="font-command text-[9px] uppercase tracking-[0.16em] text-cc-t3">
                  On Deck
                </p>
                <OnDeckMock title="Next Up">
                  <RosterGrid players={MATCH_PLAYERS} RowComponent={OptionBAnimatedRowDark} />
                </OnDeckMock>
              </div>
            </div>
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-dashed border-cc-border" />

        {/* ── OPTION B ─────────────────────────────────────── */}
        <OptionCard
          tag="Option B"
          label="Hot Pill — Full Card Tint"
          description="The entire player pill shifts to amber-dim background + amber border. Streak count appears right-aligned. Loudest option — the whole slot reads 'hot'."
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-2">
              <p className="font-command text-[9px] uppercase tracking-[0.16em] text-cc-t3">
                Active Courts (dark)
              </p>
              <CourtCardMock title="Court 1">
                <RosterGrid players={MATCH_PLAYERS} RowComponent={OptionBRowDark} />
              </CourtCardMock>
            </div>
            <div className="space-y-2">
              <p className="font-command text-[9px] uppercase tracking-[0.16em] text-cc-t3">
                On Deck (pending)
              </p>
              <OnDeckMock title="Next Up">
                <RosterGrid players={MATCH_PLAYERS} RowComponent={OptionBRowDark} />
              </OnDeckMock>
            </div>
          </div>
        </OptionCard>

        {/* Divider */}
        <div className="border-t border-dashed border-cc-border" />

        {/* ── OPTION C ─────────────────────────────────────── */}
        <OptionCard
          tag="Option C"
          label="Heat Score — Leading Amber Square"
          description="Streak count rendered as a filled amber clip-cut square to the left of the player name. Players without streaks get a spacer to maintain alignment. Most HUD-like."
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-2">
              <p className="font-command text-[9px] uppercase tracking-[0.16em] text-cc-t3">
                Active Courts (dark)
              </p>
              <CourtCardMock title="Court 1">
                <RosterGrid players={MATCH_PLAYERS} RowComponent={OptionCRowDark} />
              </CourtCardMock>
            </div>
            <div className="space-y-2">
              <p className="font-command text-[9px] uppercase tracking-[0.16em] text-cc-t3">
                On Deck (pending)
              </p>
              <OnDeckMock title="Next Up">
                <RosterGrid players={MATCH_PLAYERS} RowComponent={OptionCRowDark} />
              </OnDeckMock>
            </div>
          </div>
        </OptionCard>

        {/* Divider */}
        <div className="border-t border-dashed border-cc-border" />

        {/* ── BONUS: Side-by-side single row comparison ─────── */}
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="clip-cut-badge bg-cc-blue-dim border border-cc-blue/30 font-command text-[9px] uppercase tracking-[0.14em] text-cc-blue px-2.5 py-1">
              Compare
            </span>
            <h2 className="font-command text-[14px] font-bold uppercase tracking-[0.12em] text-cc-t1">
              Same Player, All Three Options
            </h2>
          </div>
          <p className="font-command text-[10px] uppercase tracking-[0.08em] text-cc-t3">
            Miguel · 4W streak · Gold VIP · Intermediate
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
            <div className="space-y-1.5">
              <p className="font-command text-[8px] uppercase tracking-[0.16em] text-cc-t3">
                A — Chip
              </p>
              <OptionARowDark player={HOT} />
            </div>
            <div className="space-y-1.5">
              <p className="font-command text-[8px] uppercase tracking-[0.16em] text-cc-t3">
                B — Hot Pill
              </p>
              <OptionBRowDark player={HOT} />
            </div>
            <div className="space-y-1.5">
              <p className="font-command text-[8px] uppercase tracking-[0.16em] text-cc-t3">
                C — Heat Score
              </p>
              <OptionCRowDark player={HOT} />
            </div>
          </div>
          <p className="font-command text-[10px] uppercase tracking-[0.08em] text-cc-t3 pt-2">
            No streak — Esmé · 0W · Advanced
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
            <div className="space-y-1.5">
              <p className="font-command text-[8px] uppercase tracking-[0.16em] text-cc-t3">
                A — no change
              </p>
              <OptionARowDark player={COLD} />
            </div>
            <div className="space-y-1.5">
              <p className="font-command text-[8px] uppercase tracking-[0.16em] text-cc-t3">
                B — no change
              </p>
              <OptionBRowDark player={COLD} />
            </div>
            <div className="space-y-1.5">
              <p className="font-command text-[8px] uppercase tracking-[0.16em] text-cc-t3">
                C — spacer only
              </p>
              <OptionCRowDark player={COLD} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
