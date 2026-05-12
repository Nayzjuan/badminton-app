// ─────────────────────────────────────────────────────────────────────────────
// PlayerPhone — CSS phone mockup containing the full player dashboard.
//
// Shared sandbox state drives all four tabs:
//   My Status   — queue position + live MatchAlert overlay (hero)
//   Live Courts — read-only in_progress match list
//   Waitlist    — full queue, Alex highlighted
//   History     — static 3-match seed (no real history in sandbox)
//
// Alert animation: MatchAlert slides up from the bottom of the screen
// whenever Alex's status transitions to on_deck or in_progress.
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useMemo, useEffect, useRef } from "react";
import type { SandboxState, Player, SkillLevel } from "../state/types";
import { YOU_ID } from "./useAutoPlay";
import { playWarningBeep, playCourtCall } from "./audio";

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = "status" | "courts" | "waitlist" | "history";

interface Props {
  state: SandboxState;
  soundEnabled: boolean;
}

// ── Static mock history (3 completed matches for Alex) ────────────────────────

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

// ── Skill color map ───────────────────────────────────────────────────────────

function skillColor(skill: SkillLevel): string {
  switch (skill) {
    case "beginner":
      return "oklch(65% 0.2 22)"; // err-red
    case "intermediate":
      return "oklch(78% 0.16 70)"; // warn-amber
    case "advanced":
      return "oklch(76% 0.17 155)"; // accent-emerald
  }
}

function skillLabel(skill: SkillLevel): string {
  switch (skill) {
    case "beginner":
      return "BGN";
    case "intermediate":
      return "INT";
    case "advanced":
      return "ADV";
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SkillDot({ skill }: { skill: SkillLevel }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: skillColor(skill),
        flexShrink: 0,
      }}
    />
  );
}

function SkillChip({ skill }: { skill: SkillLevel }) {
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: "0.06em",
        color: skillColor(skill),
        padding: "1px 5px",
        borderRadius: 4,
        border: `1px solid ${skillColor(skill)}44`,
        background: `${skillColor(skill)}18`,
      }}
    >
      {skillLabel(skill)}
    </span>
  );
}

// ── Status bar ────────────────────────────────────────────────────────────────

function StatusBar() {
  return (
    <div
      style={{
        height: 44,
        paddingTop: 14,
        paddingLeft: 28,
        paddingRight: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        position: "relative",
        zIndex: 30,
        background: "oklch(7% 0.012 245)",
        flexShrink: 0,
      }}
    >
      {/* Time */}
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "oklch(96% 0.005 245)",
          letterSpacing: "-0.01em",
        }}
      >
        9:41
      </span>

      {/* Status icons */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {/* Signal bars */}
        <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
          <rect x="0" y="8" width="3" height="4" rx="0.5" fill="oklch(96% 0.005 245)" />
          <rect x="4.5" y="5.5" width="3" height="6.5" rx="0.5" fill="oklch(96% 0.005 245)" />
          <rect x="9" y="3" width="3" height="9" rx="0.5" fill="oklch(96% 0.005 245)" />
          <rect x="13.5" y="0" width="2.5" height="12" rx="0.5" fill="oklch(96% 0.005 245)" />
        </svg>
        {/* WiFi */}
        <svg width="15" height="11" viewBox="0 0 15 11" fill="none">
          <path
            d="M7.5 8.5L7.5 8.5"
            stroke="oklch(96% 0.005 245)"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M5 6.5C5.8 5.5 6.6 5 7.5 5C8.4 5 9.2 5.5 10 6.5"
            stroke="oklch(96% 0.005 245)"
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M2.5 4C4 2.5 5.7 1.5 7.5 1.5C9.3 1.5 11 2.5 12.5 4"
            stroke="oklch(96% 0.005 245)"
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
        {/* Battery */}
        <svg width="22" height="12" viewBox="0 0 22 12" fill="none">
          <rect
            x="0.5"
            y="0.5"
            width="18"
            height="11"
            rx="2.5"
            stroke="oklch(96% 0.005 245)"
            strokeOpacity="0.5"
          />
          <rect x="2" y="2" width="14" height="8" rx="1.5" fill="oklch(96% 0.005 245)" />
          <path
            d="M19.5 4V8C20.5 7.5 20.5 4.5 19.5 4Z"
            fill="oklch(96% 0.005 245)"
            fillOpacity="0.4"
          />
        </svg>
      </div>
    </div>
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

const TAB_DEFS: { id: Tab; label: string; icon: (active: boolean) => React.ReactNode }[] = [
  {
    id: "status",
    label: "Status",
    icon: (active) => (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <circle
          cx="10"
          cy="8"
          r="3"
          stroke={active ? "oklch(76% 0.17 155)" : "oklch(48% 0.01 245)"}
          strokeWidth="1.5"
          fill={active ? "oklch(76% 0.17 155 / 0.2)" : "none"}
        />
        <path
          d="M4 16c0-3.3 2.7-6 6-6s6 2.7 6 6"
          stroke={active ? "oklch(76% 0.17 155)" : "oklch(48% 0.01 245)"}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: "courts",
    label: "Courts",
    icon: (active) => (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <rect
          x="3"
          y="3"
          width="6"
          height="6"
          rx="1.5"
          stroke={active ? "oklch(76% 0.17 155)" : "oklch(48% 0.01 245)"}
          strokeWidth="1.5"
          fill={active ? "oklch(76% 0.17 155 / 0.2)" : "none"}
        />
        <rect
          x="11"
          y="3"
          width="6"
          height="6"
          rx="1.5"
          stroke={active ? "oklch(76% 0.17 155)" : "oklch(48% 0.01 245)"}
          strokeWidth="1.5"
          fill={active ? "oklch(76% 0.17 155 / 0.2)" : "none"}
        />
        <rect
          x="3"
          y="11"
          width="6"
          height="6"
          rx="1.5"
          stroke={active ? "oklch(76% 0.17 155)" : "oklch(48% 0.01 245)"}
          strokeWidth="1.5"
          fill={active ? "oklch(76% 0.17 155 / 0.2)" : "none"}
        />
        <rect
          x="11"
          y="11"
          width="6"
          height="6"
          rx="1.5"
          stroke={active ? "oklch(76% 0.17 155)" : "oklch(48% 0.01 245)"}
          strokeWidth="1.5"
          fill={active ? "oklch(76% 0.17 155 / 0.2)" : "none"}
        />
      </svg>
    ),
  },
  {
    id: "waitlist",
    label: "Waitlist",
    icon: (active) => (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <line
          x1="4"
          y1="6"
          x2="16"
          y2="6"
          stroke={active ? "oklch(76% 0.17 155)" : "oklch(48% 0.01 245)"}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <line
          x1="4"
          y1="10"
          x2="16"
          y2="10"
          stroke={active ? "oklch(76% 0.17 155)" : "oklch(48% 0.01 245)"}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <line
          x1="4"
          y1="14"
          x2="12"
          y2="14"
          stroke={active ? "oklch(76% 0.17 155)" : "oklch(48% 0.01 245)"}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: "history",
    label: "History",
    icon: (active) => (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <circle
          cx="10"
          cy="10"
          r="7"
          stroke={active ? "oklch(76% 0.17 155)" : "oklch(48% 0.01 245)"}
          strokeWidth="1.5"
        />
        <path
          d="M10 6.5v3.5l2.5 2"
          stroke={active ? "oklch(76% 0.17 155)" : "oklch(48% 0.01 245)"}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
];

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  return (
    <div
      style={{
        height: 72,
        background: "oklch(9% 0.014 245)",
        borderTop: "1px solid oklch(18% 0.018 245)",
        display: "flex",
        alignItems: "flex-start",
        paddingTop: 8,
        flexShrink: 0,
      }}
    >
      {TAB_DEFS.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 3,
              padding: "6px 0",
              border: "none",
              background: "none",
              cursor: "pointer",
              transition: "opacity 100ms ease",
            }}
          >
            {tab.icon(isActive)}
            <span
              style={{
                fontSize: 10,
                fontWeight: isActive ? 600 : 400,
                color: isActive ? "oklch(76% 0.17 155)" : "oklch(48% 0.01 245)",
                letterSpacing: "0.01em",
              }}
            >
              {tab.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── My Status tab ─────────────────────────────────────────────────────────────

function WaitingView({
  alex,
  position,
  totalWaiting,
}: {
  alex: Player;
  position: number | null;
  totalWaiting: number;
}) {
  const waitMins = useMemo(() => {
    const waited = Math.round((Date.now() - alex.joinedAt) / 60000);
    return waited;
  }, [alex.joinedAt]);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 20px",
        gap: 0,
      }}
    >
      {/* Position number — primary signal */}
      <div
        style={{
          fontSize: 88,
          fontWeight: 700,
          fontFamily: "var(--font-heading)",
          color: "oklch(96% 0.005 245)",
          lineHeight: 1,
          letterSpacing: "-0.04em",
          marginBottom: 8,
        }}
      >
        {position !== null ? `#${position}` : "—"}
      </div>

      {/* Context label */}
      <p
        style={{
          fontSize: 14,
          color: "oklch(72% 0.008 245)",
          margin: 0,
          textAlign: "center",
          lineHeight: 1.5,
        }}
      >
        {position !== null ? <>in line · {totalWaiting} waiting</> : "Not in queue"}
      </p>

      {/* Divider */}
      <div
        style={{
          width: 32,
          height: 1,
          background: "oklch(25% 0.025 245)",
          margin: "24px 0",
        }}
      />

      {/* Stats row */}
      <div style={{ display: "flex", gap: 32, alignItems: "flex-end" }}>
        <StatPill label="waited" value={`${waitMins}m`} />
        <StatPill label="games today" value={String(alex.gamesPlayed)} />
        <StatPill label="skill" value={skillLabel(alex.skill)} color={skillColor(alex.skill)} />
      </div>
    </div>
  );
}

function StatPill({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <span
        style={{
          fontSize: 20,
          fontWeight: 600,
          fontFamily: "var(--font-heading)",
          color: color ?? "oklch(96% 0.005 245)",
          letterSpacing: "-0.02em",
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontSize: 10,
          color: "oklch(48% 0.01 245)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          fontWeight: 500,
        }}
      >
        {label}
      </span>
    </div>
  );
}

// ── Match Alert (on_deck + in_progress) ──────────────────────────────────────

function PlayerRow({ player, isYou }: { player: Player; isYou: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 0",
      }}
    >
      <SkillDot skill={player.skill} />
      <span
        style={{
          fontSize: 13,
          fontWeight: isYou ? 700 : 500,
          color: isYou ? "oklch(96% 0.005 245)" : "oklch(72% 0.008 245)",
          flex: 1,
        }}
      >
        {player.name}
        {isYou && (
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: "0.1em",
              color: "oklch(76% 0.17 155)",
              marginLeft: 6,
              textTransform: "uppercase",
            }}
          >
            YOU
          </span>
        )}
      </span>
    </div>
  );
}

function MatchAlert({
  visible,
  alex,
  alexMatch,
  players,
}: {
  visible: boolean;
  alex: Player;
  alexMatch: { teamA: readonly string[]; teamB: readonly string[]; status: string } | null;
  players: Record<string, Player>;
}) {
  const isOnDeck = alex.status === "on_deck";
  const isPlaying = alex.status === "in_progress";

  // Find which team Alex is on
  const alexTeam = alexMatch
    ? ([...alexMatch.teamA] as string[]).includes(YOU_ID)
      ? "a"
      : "b"
    : null;
  const myTeamIds = alexMatch
    ? alexTeam === "a"
      ? ([...alexMatch.teamA] as string[])
      : ([...alexMatch.teamB] as string[])
    : [];
  const oppTeamIds = alexMatch
    ? alexTeam === "a"
      ? ([...alexMatch.teamB] as string[])
      : ([...alexMatch.teamA] as string[])
    : [];

  // On Deck: warm amber background
  // Playing: deep navy with emerald court text
  const bg = isOnDeck
    ? "oklch(78% 0.16 70)" // warm amber
    : "oklch(7% 0.012 245)"; // deep navy

  const textPrimary = isOnDeck ? "oklch(18% 0.04 70)" : "oklch(96% 0.005 245)";
  const textSecondary = isOnDeck ? "oklch(32% 0.06 70)" : "oklch(72% 0.008 245)";
  const dividerColor = isOnDeck ? "oklch(50% 0.1 70 / 0.3)" : "oklch(25% 0.025 245)";

  return (
    <div
      className={visible ? "pp-alert-visible" : "pp-alert-hidden"}
      style={{
        position: "absolute",
        inset: 0,
        background: bg,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        // animation class is applied via CSS keyframes in global.css
      }}
    >
      {/* Fake status bar — tinted for context */}
      <div
        style={{
          height: 44,
          paddingTop: 14,
          paddingLeft: 28,
          paddingRight: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: textPrimary }}>9:41</span>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: isOnDeck ? "oklch(32% 0.06 70)" : "oklch(76% 0.17 155)",
            animation: "dt-pulse 1.4s ease-in-out infinite",
          }}
        />
      </div>

      {/* Header badge */}
      <div
        style={{
          padding: "12px 24px 0",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            borderRadius: 20,
            background: isOnDeck ? "oklch(32% 0.06 70 / 0.15)" : "oklch(76% 0.17 155 / 0.15)",
            border: `1px solid ${isOnDeck ? "oklch(32% 0.06 70 / 0.3)" : "oklch(76% 0.17 155 / 0.3)"}`,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: isOnDeck ? "oklch(32% 0.06 70)" : "oklch(76% 0.17 155)",
              animation: "dt-pulse 1.4s ease-in-out infinite",
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: isOnDeck ? "oklch(22% 0.05 70)" : "oklch(76% 0.17 155)",
            }}
          >
            {isOnDeck ? "You're On Deck" : "Match in Progress"}
          </span>
        </div>
      </div>

      {/* Hero text */}
      <div style={{ padding: "16px 24px 0", flexShrink: 0 }}>
        {isPlaying ? (
          <div>
            <p
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "oklch(48% 0.01 245)",
                margin: "0 0 4px",
              }}
            >
              Active Court
            </p>
            <p
              style={{
                fontSize: 52,
                fontWeight: 700,
                fontFamily: "var(--font-heading)",
                letterSpacing: "-0.03em",
                color: "oklch(76% 0.17 155)",
                margin: 0,
                lineHeight: 1,
              }}
            >
              COURT 1
            </p>
          </div>
        ) : (
          <div>
            <p
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: textSecondary,
                margin: "0 0 4px",
              }}
            >
              Next Available Court
            </p>
            <p
              style={{
                fontSize: 28,
                fontWeight: 700,
                fontFamily: "var(--font-heading)",
                letterSpacing: "-0.02em",
                color: textPrimary,
                margin: 0,
                lineHeight: 1.15,
              }}
            >
              Head to the
              <br />
              court area
            </p>
          </div>
        )}
      </div>

      {/* Divider */}
      <div
        style={{
          height: 1,
          background: dividerColor,
          margin: "20px 24px",
          flexShrink: 0,
        }}
      />

      {/* Teams */}
      <div
        style={{
          padding: "0 24px",
          flex: 1,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto 1fr",
            gap: 12,
            alignItems: "start",
          }}
        >
          {/* Your team */}
          <div>
            <p
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: textSecondary,
                marginBottom: 8,
                margin: "0 0 8px",
              }}
            >
              Your Team
            </p>
            {myTeamIds.map((id) => {
              const p = players[id];
              if (!p) return null;
              return <PlayerRow key={id} player={p} isYou={id === YOU_ID} />;
            })}
          </div>

          {/* VS */}
          <div
            style={{
              paddingTop: 28,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.1em",
              color: textSecondary,
            }}
          >
            VS
          </div>

          {/* Opponents */}
          <div>
            <p
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: textSecondary,
                margin: "0 0 8px",
              }}
            >
              Opponents
            </p>
            {oppTeamIds.map((id) => {
              const p = players[id];
              if (!p) return null;
              return <PlayerRow key={id} player={p} isYou={false} />;
            })}
          </div>
        </div>
      </div>

      {/* Score display for in_progress */}
      {isPlaying && (
        <div
          style={{
            padding: "16px 24px 24px",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              background: "oklch(11% 0.016 245)",
              borderRadius: 16,
              padding: "16px 20px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 20,
            }}
          >
            <span
              style={{
                fontSize: 40,
                fontWeight: 700,
                fontFamily: "var(--font-heading)",
                color: "oklch(96% 0.005 245)",
                letterSpacing: "-0.03em",
              }}
            >
              0
            </span>
            <span
              style={{
                fontSize: 20,
                color: "oklch(48% 0.01 245)",
                fontWeight: 300,
              }}
            >
              —
            </span>
            <span
              style={{
                fontSize: 40,
                fontWeight: 700,
                fontFamily: "var(--font-heading)",
                color: "oklch(96% 0.005 245)",
                letterSpacing: "-0.03em",
              }}
            >
              0
            </span>
          </div>
          <p
            style={{
              textAlign: "center",
              fontSize: 11,
              color: "oklch(48% 0.01 245)",
              marginTop: 8,
              marginBottom: 0,
            }}
          >
            Score submitted by organizer when match ends
          </p>
        </div>
      )}
    </div>
  );
}

function MyStatusTab({ state }: { state: SandboxState }) {
  const alex = state.players[YOU_ID];

  // Gate: only mount the MatchAlert after it has been needed at least once.
  // Without this, the element mounts with class `pp-alert-hidden` which
  // immediately plays the slide-down keyframe from translateY(0) — causing
  // a visible flash on page load. Once the ref flips true it stays true for
  // the lifetime of the component.
  const hasAlertEverFiredRef = useRef(false);

  if (!alex) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "oklch(48% 0.01 245)", fontSize: 13 }}>Player not found</p>
      </div>
    );
  }

  // Queue position (1-based, among "waiting" players only)
  const waitingIds = state.queueOrder.filter((id) => state.players[id]?.status === "waiting");
  const alexPosition = waitingIds.indexOf(YOU_ID);
  const position = alexPosition >= 0 ? alexPosition + 1 : null;

  // Alex's active match
  const alexMatch =
    state.matches.find(
      (m) =>
        (m.status === "pending" || m.status === "in_progress" || m.status === "draft") &&
        ([...m.teamA, ...m.teamB] as string[]).includes(YOU_ID)
    ) ?? null;

  const alertVisible = alex.status === "on_deck" || alex.status === "in_progress";
  if (alertVisible) hasAlertEverFiredRef.current = true;

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Base content — queue position */}
      <WaitingView alex={alex} position={position} totalWaiting={waitingIds.length} />

      {/* Match alert overlay — only mounted after the first real trigger so the
          slide-down keyframe never fires on initial page load. */}
      {hasAlertEverFiredRef.current && (
        <MatchAlert
          visible={alertVisible}
          alex={alex}
          alexMatch={alexMatch}
          players={state.players}
        />
      )}
    </div>
  );
}

// ── Live Courts tab ───────────────────────────────────────────────────────────

function LiveCourtsTab({ state }: { state: SandboxState }) {
  const activeMatches = state.matches.filter((m) => m.status === "in_progress");

  if (activeMatches.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          gap: 8,
        }}
      >
        <span style={{ fontSize: 32 }}>🏸</span>
        <p
          style={{
            color: "oklch(48% 0.01 245)",
            fontSize: 13,
            textAlign: "center",
            margin: 0,
            lineHeight: 1.5,
          }}
        >
          No active matches yet.
          <br />
          Start a match in the organizer panel.
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {activeMatches.map((match, i) => {
        const allIds = [...match.teamA, ...match.teamB];
        const teamAPlayers = [...match.teamA]
          .map((id) => state.players[id])
          .filter(Boolean) as Player[];
        const teamBPlayers = [...match.teamB]
          .map((id) => state.players[id])
          .filter(Boolean) as Player[];

        return (
          <div
            key={match.id}
            style={{
              background: "oklch(11% 0.016 245)",
              borderRadius: 14,
              overflow: "hidden",
              border: allIds.includes(YOU_ID)
                ? "1px solid oklch(76% 0.17 155 / 0.4)"
                : "1px solid oklch(18% 0.018 245)",
            }}
          >
            {/* Court header */}
            <div
              style={{
                padding: "10px 14px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background: "oklch(13% 0.018 245)",
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: allIds.includes(YOU_ID) ? "oklch(76% 0.17 155)" : "oklch(48% 0.01 245)",
                }}
              >
                Court {i + 1}
              </span>
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "oklch(76% 0.17 155)",
                  padding: "2px 7px",
                  background: "oklch(76% 0.17 155 / 0.12)",
                  borderRadius: 10,
                }}
              >
                Live
              </span>
            </div>

            {/* Teams */}
            <div
              style={{
                padding: "10px 14px",
                display: "grid",
                gridTemplateColumns: "1fr auto 1fr",
                gap: 8,
                alignItems: "center",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {teamAPlayers.map((p) => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <SkillDot skill={p.skill} />
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: p.id === YOU_ID ? 700 : 400,
                        color: p.id === YOU_ID ? "oklch(96% 0.005 245)" : "oklch(72% 0.008 245)",
                      }}
                    >
                      {p.name}
                    </span>
                  </div>
                ))}
              </div>

              <span style={{ fontSize: 11, color: "oklch(32% 0.012 245)", padding: "0 4px" }}>
                vs
              </span>

              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {teamBPlayers.map((p) => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <SkillDot skill={p.skill} />
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: p.id === YOU_ID ? 700 : 400,
                        color: p.id === YOU_ID ? "oklch(96% 0.005 245)" : "oklch(72% 0.008 245)",
                      }}
                    >
                      {p.name}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Waitlist tab ──────────────────────────────────────────────────────────────

function WaitlistTab({ state }: { state: SandboxState }) {
  const waitingIds = state.queueOrder.filter((id) => state.players[id]?.status === "waiting");

  const allQueuedIds = state.queueOrder.filter((id) => {
    const p = state.players[id];
    return p && p.status !== "left";
  });

  if (allQueuedIds.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <p style={{ color: "oklch(48% 0.01 245)", fontSize: 13, textAlign: "center", margin: 0 }}>
          Queue is empty
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "8px 0",
      }}
    >
      {allQueuedIds.map((id, i) => {
        const p = state.players[id];
        if (!p) return null;
        const isAlex = id === YOU_ID;
        const isWaiting = p.status === "waiting";
        const waitPos = isWaiting ? waitingIds.indexOf(id) + 1 : null;

        return (
          <div
            key={id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 16px",
              background: isAlex ? "oklch(76% 0.17 155 / 0.06)" : "transparent",
              borderBottom: "1px solid oklch(18% 0.018 245)",
            }}
          >
            {/* Position badge */}
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: isAlex
                  ? "oklch(76% 0.17 155)"
                  : waitPos && waitPos <= 4
                    ? "oklch(20% 0.022 245)"
                    : "oklch(15% 0.019 245)",
                flexShrink: 0,
              }}
            >
              {isWaiting && waitPos ? (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: isAlex ? "oklch(7% 0.012 245)" : "oklch(72% 0.008 245)",
                  }}
                >
                  {waitPos}
                </span>
              ) : (
                <span style={{ fontSize: 10, color: "oklch(48% 0.01 245)" }}>—</span>
              )}
            </div>

            {/* Name + skill */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: isAlex ? 700 : 500,
                    color: isAlex ? "oklch(96% 0.005 245)" : "oklch(72% 0.008 245)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {p.name}
                </span>
                {isAlex && (
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: "0.1em",
                      color: "oklch(76% 0.17 155)",
                      textTransform: "uppercase",
                    }}
                  >
                    YOU
                  </span>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
                <SkillChip skill={p.skill} />
                <StatusPill status={p.status} />
              </div>
            </div>

            {/* Games played */}
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <span
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  fontFamily: "var(--font-heading)",
                  color: "oklch(96% 0.005 245)",
                }}
              >
                {p.gamesPlayed}
              </span>
              <span style={{ fontSize: 9, color: "oklch(48% 0.01 245)", display: "block" }}>
                games
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string }> = {
    waiting: { label: "waiting", color: "oklch(48% 0.01 245)" },
    drafted: { label: "drafted", color: "oklch(70% 0.15 245)" },
    on_deck: { label: "on deck", color: "oklch(78% 0.16 70)" },
    in_progress: { label: "playing", color: "oklch(76% 0.17 155)" },
    paused: { label: "paused", color: "oklch(48% 0.01 245)" },
    left: { label: "left", color: "oklch(48% 0.01 245)" },
  };
  const info = map[status] ?? { label: status, color: "oklch(48% 0.01 245)" };
  return <span style={{ fontSize: 9, color: info.color, fontWeight: 500 }}>{info.label}</span>;
}

// ── Match History tab ─────────────────────────────────────────────────────────

function MatchHistoryTab() {
  const wins = MOCK_HISTORY.filter((m) => m.result === "win").length;
  const losses = MOCK_HISTORY.filter((m) => m.result === "loss").length;

  return (
    <div style={{ flex: 1, overflowY: "auto" }}>
      {/* Stats summary */}
      <div
        style={{
          padding: "16px 16px 12px",
          display: "flex",
          gap: 0,
        }}
      >
        <div
          style={{
            flex: 1,
            textAlign: "center",
            paddingRight: 12,
          }}
        >
          <div
            style={{
              fontSize: 28,
              fontWeight: 700,
              fontFamily: "var(--font-heading)",
              color: "oklch(76% 0.17 155)",
              letterSpacing: "-0.02em",
            }}
          >
            {wins}
          </div>
          <div
            style={{
              fontSize: 10,
              color: "oklch(48% 0.01 245)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Wins
          </div>
        </div>
        <div
          style={{
            width: 1,
            background: "oklch(25% 0.025 245)",
            margin: "4px 0",
          }}
        />
        <div style={{ flex: 1, textAlign: "center", paddingLeft: 12 }}>
          <div
            style={{
              fontSize: 28,
              fontWeight: 700,
              fontFamily: "var(--font-heading)",
              color: "oklch(65% 0.2 22)",
              letterSpacing: "-0.02em",
            }}
          >
            {losses}
          </div>
          <div
            style={{
              fontSize: 10,
              color: "oklch(48% 0.01 245)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Losses
          </div>
        </div>
        <div style={{ width: 1, background: "oklch(25% 0.025 245)", margin: "4px 0" }} />
        <div style={{ flex: 1, textAlign: "center", paddingLeft: 12 }}>
          <div
            style={{
              fontSize: 28,
              fontWeight: 700,
              fontFamily: "var(--font-heading)",
              color: "oklch(96% 0.005 245)",
              letterSpacing: "-0.02em",
            }}
          >
            {Math.round((wins / (wins + losses)) * 100)}%
          </div>
          <div
            style={{
              fontSize: 10,
              color: "oklch(48% 0.01 245)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Win%
          </div>
        </div>
      </div>

      <div style={{ height: 1, background: "oklch(18% 0.018 245)", margin: "0 16px 4px" }} />

      {/* Match list */}
      {MOCK_HISTORY.map((match) => (
        <div
          key={match.id}
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid oklch(15% 0.019 245)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            {/* Result badge */}
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "3px 8px",
                borderRadius: 6,
                background:
                  match.result === "win"
                    ? "oklch(76% 0.17 155 / 0.15)"
                    : "oklch(65% 0.2 22 / 0.15)",
                border: `1px solid ${match.result === "win" ? "oklch(76% 0.17 155 / 0.3)" : "oklch(65% 0.2 22 / 0.3)"}`,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: match.result === "win" ? "oklch(76% 0.17 155)" : "oklch(65% 0.2 22)",
                }}
              >
                {match.result === "win" ? "Win" : "Loss"}
              </span>
            </div>

            {/* Score */}
            <div
              style={{
                fontSize: 16,
                fontWeight: 700,
                fontFamily: "var(--font-heading)",
                color: "oklch(96% 0.005 245)",
                letterSpacing: "-0.02em",
              }}
            >
              {match.scoreA} — {match.scoreB}
            </div>
          </div>

          {/* Players */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 11, color: "oklch(96% 0.005 245)", fontWeight: 600 }}>
                Alex
              </span>
              {match.teammates.map((t) => (
                <span key={t} style={{ fontSize: 11, color: "oklch(72% 0.008 245)" }}>
                  + {t}
                </span>
              ))}
            </div>
            <span style={{ fontSize: 10, color: "oklch(32% 0.012 245)" }}>vs</span>
            <div style={{ display: "flex", gap: 4 }}>
              {match.opponents.map((o, i) => (
                <span key={o} style={{ fontSize: 11, color: "oklch(72% 0.008 245)" }}>
                  {o}
                  {i < match.opponents.length - 1 ? " +" : ""}
                </span>
              ))}
            </div>
          </div>

          {/* Time */}
          <p
            style={{
              fontSize: 10,
              color: "oklch(32% 0.012 245)",
              margin: "4px 0 0",
            }}
          >
            {match.label}
          </p>
        </div>
      ))}
    </div>
  );
}

// ── Main PlayerPhone component ────────────────────────────────────────────────

export default function PlayerPhone({ state, soundEnabled }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("status");

  const alex = state.players[YOU_ID];
  const alexStatus = alex?.status;

  // Auto-switch to My Status when Alex gets an alert so the showcase
  // always shows the "wow moment".
  useEffect(() => {
    if (alexStatus === "on_deck" || alexStatus === "in_progress") {
      setActiveTab("status");
    }
  }, [alexStatus]);

  // Fire alert sounds on status transitions — mirrors useMatchAlerts in the
  // real app. Only fires when soundEnabled; the previous-status ref detects
  // genuine transitions (not just re-renders with the same status).
  const prevStatusRef = useRef(alexStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = alexStatus;

    if (!soundEnabled) return;

    if (prev !== "on_deck" && alexStatus === "on_deck") {
      playWarningBeep().catch(() => {});
    } else if (prev !== "in_progress" && alexStatus === "in_progress") {
      playCourtCall().catch(() => {});
    }
  }, [alexStatus, soundEnabled]);

  return (
    /* Phone shell */
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
          inset 0 1px 0 oklch(38% 0.028 245 / 0.4),
          inset 0 -1px 0 oklch(5% 0.01 245 / 0.8)
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

      {/* Screen */}
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "oklch(7% 0.012 245)",
          borderRadius: 44,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <StatusBar />

        {/* Page content */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {activeTab === "status" && <MyStatusTab state={state} />}
          {activeTab === "courts" && <LiveCourtsTab state={state} />}
          {activeTab === "waitlist" && <WaitlistTab state={state} />}
          {activeTab === "history" && <MatchHistoryTab />}
        </div>

        <TabBar active={activeTab} onChange={setActiveTab} />
      </div>
    </div>
  );
}
