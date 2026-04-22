"use client";

// ============================================================
// WrappedIntro — full-screen animated reveal overlay
// ============================================================
// Appears immediately when a session closes, before the player
// sees their award cards. Sequences through:
//
//   0.2 s  — 🏸 icon slams in
//   0.7 s  — "SESSION" label slides up
//   0.95 s — "WRAPPED" word slams in (big, bold)
//   1.35 s — player name fades up
//   1.7 s  — stat teaser fades in
//   2.1 s  — CTA button slides up
//   2.6 s  — CTA begins soft breathe animation
//   3.0 s  — overlay becomes tap-anywhere dismissable
//   3.2 s  — "tap anywhere" hint fades in
//
// Dismissal: CTA button (immediate) or tap anywhere (after 3 s).
// Exit: 280 ms opacity fade on the whole overlay.
//
// Animations are GPU-only (transform + opacity). Keyframes live
// in globals.css. prefers-reduced-motion collapses everything to
// 0.01 ms — the final state is shown immediately.
// ============================================================

import { useState, useEffect, useCallback, CSSProperties } from "react";

// ── Easing ───────────────────────────────────────────────────
// Out-quint: decisive deceleration, feels confident not floaty.
const E = "cubic-bezier(0.22, 1, 0.36, 1)";

// ── Inline animation helper ───────────────────────────────────
// Returns a CSSProperties object so each element can have its
// own delay without needing a dedicated Tailwind utility class.
function a(
  name: string,
  durationMs: number,
  delayMs: number,
  easing = E,
  iterCount: number | "infinite" = 1,
): CSSProperties {
  return {
    animation: `${name} ${durationMs}ms ${easing} ${delayMs}ms ${
      iterCount === "infinite" ? "infinite" : "both"
    }`,
  };
}

// ── Props ─────────────────────────────────────────────────────

interface WrappedIntroProps {
  /** Player's display name, e.g. "Miggy" */
  playerName: string;
  /** One-line stat teaser, e.g. "9 matches · 8 wins" */
  statLine: string;
  /** Called once the exit animation finishes */
  onDismiss: () => void;
}

// ── Component ─────────────────────────────────────────────────

export function WrappedIntro({ playerName, statLine, onDismiss }: WrappedIntroProps) {
  // True once we allow tap-anywhere dismissal (3 s in).
  const [canDismiss, setCanDismiss]     = useState(false);
  // True once the player initiates dismissal.
  const [isDismissing, setIsDismissing] = useState(false);

  // Unlock tap-anywhere after 3 s so the animation plays first.
  useEffect(() => {
    const t = setTimeout(() => setCanDismiss(true), 3000);
    return () => clearTimeout(t);
  }, []);

  const dismiss = useCallback(() => {
    if (isDismissing) return;
    setIsDismissing(true);
    // Wait for fade-out keyframe before unmounting.
    setTimeout(onDismiss, 290);
  }, [isDismissing, onDismiss]);

  // Only intercept taps once we're past the 3-second gate.
  function handleBackdropClick() {
    if (canDismiss) dismiss();
  }

  // ── Overlay fade-in / fade-out switch ──────────────────────
  const overlayStyle: CSSProperties = isDismissing
    ? { animation: `wi-fade 280ms ease-in reverse forwards` }
    : { animation: `wi-fade 450ms ease-out forwards` };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Session Wrapped intro"
      onClick={handleBackdropClick}
      className="fixed inset-0 z-[200] flex flex-col items-center justify-center
                 overflow-hidden select-none cursor-default"
      style={{
        backgroundColor: "#060D1B",
        ...overlayStyle,
      }}
    >
      {/* ── Ambient glow behind icon ─────────────────────────
          A radial amber bleed — subtle, not sci-fi.             */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 55% 40% at 50% 42%, rgba(245,158,11,0.08) 0%, transparent 70%)",
          ...a("wi-fade", 800, 400, "ease-out"),
        }}
        aria-hidden="true"
      />

      {/* ── Content column ───────────────────────────────────── */}
      <div className="relative flex flex-col items-center gap-0 px-6 text-center">

        {/* 🏸 Icon */}
        <div
          style={a("wi-icon", 600, 200)}
          className="mb-5"
          aria-hidden="true"
        >
          <span className="text-6xl leading-none block">🏸</span>
        </div>

        {/* SESSION label */}
        <div style={a("wi-up", 380, 700)}>
          <p
            className="text-[11px] font-black uppercase tracking-[0.45em]
                       leading-none mb-3"
            style={{ color: "rgba(251,191,36,0.75)" }} /* amber-300/75 */
          >
            Session
          </p>
        </div>

        {/* WRAPPED — the hero word */}
        <div style={a("wi-word", 480, 950)}>
          <p
            className="font-black leading-none tracking-tight"
            style={{
              fontSize: "clamp(3.75rem, 18vw, 6.5rem)",
              color: "#FFFFFF",
              letterSpacing: "-0.03em",
            }}
          >
            WRAPPED
          </p>
        </div>

        {/* Amber rule — gives the word room to breathe */}
        <div
          style={{
            ...a("wi-fade", 350, 1200, "ease-out"),
            width: "2.5rem",
            height: "2px",
            backgroundColor: "rgba(245,158,11,0.5)",
            borderRadius: "999px",
            margin: "1.25rem 0 1rem",
          }}
          aria-hidden="true"
        />

        {/* Player name */}
        <div style={a("wi-up", 380, 1350)}>
          <p
            className="text-xl font-semibold leading-tight"
            style={{ color: "rgba(255,255,255,0.75)" }}
          >
            {playerName}&rsquo;s Night
          </p>
        </div>

        {/* Stat teaser */}
        <div style={a("wi-fade", 380, 1700, "ease-out")} className="mt-1.5">
          <p
            className="text-sm tabular-nums"
            style={{ color: "rgba(255,255,255,0.35)" }}
          >
            {statLine}
          </p>
        </div>

        {/* CTA button */}
        <div style={a("wi-up", 400, 2100)} className="mt-10">
          <button
            onClick={(e) => {
              e.stopPropagation(); // prevent backdrop handler re-firing
              dismiss();
            }}
            aria-label="See your awards"
            className="relative rounded-2xl px-8 py-3.5
                       text-sm font-black uppercase tracking-widest
                       transition-colors focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-amber-400"
            style={{
              backgroundColor: "#F59E0B",   /* amber-400 — no gradient */
              color: "#060D1B",
              /* Breathe animation starts after slide-up lands */
              animation: `wi-up 400ms ${E} 2100ms both,
                          wi-breathe 2000ms ease-in-out 2650ms infinite`,
            }}
          >
            See Your Awards&nbsp;→
          </button>
        </div>

        {/* Tap-anywhere hint — only shown once dismissal is unlocked */}
        <div
          style={a("wi-fade", 400, 3200, "ease-out")}
          className="mt-6 h-4"
          aria-hidden="true"
        >
          {canDismiss && (
            <p
              className="text-[11px] uppercase tracking-widest"
              style={{ color: "rgba(255,255,255,0.18)" }}
            >
              tap anywhere to continue
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
