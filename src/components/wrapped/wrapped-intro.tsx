"use client";

// ============================================================
// WrappedIntro — full-screen animated reveal overlay
// ============================================================
// Five enhancement layers on top of the base reveal sequence:
//
//   Layer 1 — Floating particles (8 dots, amber + white,
//             loop throughout, rise from bottom)
//   Layer 2 — Ambient glow (two-layer radial, stronger depth)
//   Layer 3 — Icon ring burst (amber ring expands + evaporates)
//   Layer 4 — WRAPPED color flash (amber → white on impact)
//   Layer 5 — WRAPPED shimmer sweep (diagonal glint, one pass)
//
// Base sequence timing:
//   0.2 s  — 🏸 slams in (+ ring burst fires simultaneously)
//   0.7 s  — "SESSION" label slides up
//   0.95 s — "WRAPPED" slams in, amber → white
//   1.15 s — shimmer sweeps across WRAPPED
//   1.35 s — player name fades up
//   1.7 s  — stat teaser fades in
//   2.1 s  — CTA button slides up
//   2.65 s — CTA begins soft breathe
//   3.0 s  — tap-anywhere unlocked
//   3.2 s  — "tap anywhere" hint fades in
//
// All animations: transform + opacity (GPU). `color` used only
// for the WRAPPED flash — single element, acceptable cost.
// Keyframes live in globals.css.
// prefers-reduced-motion collapses all to 0.01 ms.
// ============================================================

import { useState, useEffect, useCallback, CSSProperties } from "react";

// ── Easing ───────────────────────────────────────────────────
const E = "cubic-bezier(0.22, 1, 0.36, 1)"; // out-quint

// ── Animation helper ─────────────────────────────────────────
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

// ── Particle definitions ─────────────────────────────────────
// Positioned at different x% across the screen, starting near
// the bottom. Alternate between amber and white, drift r/l.
const PARTICLES: {
  left: string; bottom: string; size: number;
  opacity: number; dur: number; delay: number;
  color: string; kf: string;
}[] = [
  { left: "6%",  bottom: "10%", size: 3, opacity: 0.22, dur: 6200, delay: 900,  color: "#F59E0B", kf: "wi-float-r" },
  { left: "16%", bottom: "18%", size: 2, opacity: 0.14, dur: 7900, delay: 1700, color: "#FFFFFF", kf: "wi-float-l" },
  { left: "28%", bottom: "7%",  size: 2, opacity: 0.20, dur: 5700, delay: 500,  color: "#F59E0B", kf: "wi-float-r" },
  { left: "43%", bottom: "22%", size: 3, opacity: 0.11, dur: 8500, delay: 2200, color: "#FFFFFF", kf: "wi-float-l" },
  { left: "57%", bottom: "13%", size: 2, opacity: 0.19, dur: 6700, delay: 700,  color: "#F59E0B", kf: "wi-float-r" },
  { left: "71%", bottom: "8%",  size: 2, opacity: 0.13, dur: 7300, delay: 2000, color: "#FFFFFF", kf: "wi-float-l" },
  { left: "83%", bottom: "19%", size: 3, opacity: 0.17, dur: 5800, delay: 400,  color: "#F59E0B", kf: "wi-float-r" },
  { left: "94%", bottom: "14%", size: 2, opacity: 0.12, dur: 8200, delay: 1300, color: "#FFFFFF", kf: "wi-float-l" },
];

// ── Props ─────────────────────────────────────────────────────

interface WrappedIntroProps {
  playerName: string;
  statLine: string;
  onDismiss: () => void;
}

// ── Component ─────────────────────────────────────────────────

export function WrappedIntro({ playerName, statLine, onDismiss }: WrappedIntroProps) {
  const [canDismiss,   setCanDismiss]   = useState(false);
  const [isDismissing, setIsDismissing] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setCanDismiss(true), 3000);
    return () => clearTimeout(t);
  }, []);

  const dismiss = useCallback(() => {
    if (isDismissing) return;
    setIsDismissing(true);
    setTimeout(onDismiss, 290);
  }, [isDismissing, onDismiss]);

  function handleBackdropClick() {
    if (canDismiss) dismiss();
  }

  const overlayAnim: CSSProperties = isDismissing
    ? { animation: "wi-fade 280ms ease-in reverse forwards" }
    : { animation: "wi-fade 450ms ease-out forwards" };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Session Wrapped intro"
      onClick={handleBackdropClick}
      className="fixed inset-0 z-[200] flex flex-col items-center justify-center
                 overflow-hidden select-none cursor-default"
      style={{ backgroundColor: "#060D1B", ...overlayAnim }}
    >

      {/* ══ Layer 2 — Ambient glow (two-depth radial) ══════════
          Outer bleed + inner hot-spot. Together they make the
          center feel genuinely lit rather than flat navy.       */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background: [
            "radial-gradient(ellipse 70% 55% at 50% 44%, rgba(245,158,11,0.13) 0%, transparent 68%)",
            "radial-gradient(ellipse 30% 22% at 50% 40%, rgba(253,230,138,0.09) 0%, transparent 60%)",
          ].join(", "),
          ...a("wi-fade", 900, 300, "ease-out"),
        }}
      />

      {/* ══ Layer 1 — Floating particles ═══════════════════════
          Eight tiny dots rising continuously in the background.
          Split between amber and white, alternating drift dir.  */}
      {PARTICLES.map((p, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="pointer-events-none absolute rounded-full"
          style={{
            left: p.left,
            bottom: p.bottom,
            width:  p.size,
            height: p.size,
            backgroundColor: p.color,
            opacity: 0,                         // keyframe controls
            animation: `${p.kf} ${p.dur}ms ease-in-out ${p.delay}ms infinite`,
          }}
        />
      ))}

      {/* ══ Content column ═════════════════════════════════════ */}
      <div className="relative flex flex-col items-center px-6 text-center">

        {/* ── Icon + ring burst ────────────────────────────── */}
        <div className="relative flex items-center justify-center mb-5">

          {/* Layer 3 — Ring burst: amber circle expands out.
              Positioned behind the emoji, centered on it.      */}
          <div
            aria-hidden="true"
            className="absolute rounded-full pointer-events-none"
            style={{
              width:  72,
              height: 72,
              border: "1.5px solid rgba(245,158,11,0.65)",
              ...a("wi-ring", 900, 200, "ease-out"),
            }}
          />

          {/* Shuttlecock emoji */}
          <div style={a("wi-icon", 580, 200)} aria-hidden="true">
            <span className="text-6xl leading-none block">🏸</span>
          </div>
        </div>

        {/* ── SESSION label ───────────────────────────────── */}
        <div style={a("wi-up", 380, 700)}>
          <p
            className="text-[11px] font-black uppercase leading-none mb-3"
            style={{
              letterSpacing: "0.45em",
              color: "rgba(251,191,36,0.78)",
            }}
          >
            Session
          </p>
        </div>

        {/* ── WRAPPED word (Layer 4 + Layer 5) ────────────── */}
        {/* overflow-hidden clips the shimmer sweep to the word */}
        <div
          className="relative overflow-hidden"
          style={a("wi-word", 500, 950)}  /* wi-word now animates color amber→white */
        >
          <p
            className="font-black leading-none"
            style={{
              fontSize: "clamp(3.75rem, 18vw, 6.5rem)",
              letterSpacing: "-0.03em",
              /* No explicit color — wi-word keyframe owns it   */
            }}
          >
            WRAPPED
          </p>

          {/* Layer 5 — Shimmer bar: diagonal glint, one pass.
              Starts 200 ms after WRAPPED has landed (950+200). */}
          <div
            aria-hidden="true"
            className="absolute inset-y-0 pointer-events-none"
            style={{
              width: "38%",
              background:
                "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.55) 40%, rgba(253,230,138,0.35) 60%, transparent 100%)",
              ...a("wi-shimmer", 560, 1150, "ease-in-out"),
            }}
          />
        </div>

        {/* ── Amber rule ──────────────────────────────────── */}
        <div
          aria-hidden="true"
          style={{
            ...a("wi-fade", 350, 1250, "ease-out"),
            width: "2.5rem",
            height: "2px",
            backgroundColor: "rgba(245,158,11,0.55)",
            borderRadius: "999px",
            margin: "1.25rem 0 1rem",
          }}
        />

        {/* ── Player name ─────────────────────────────────── */}
        <div style={a("wi-up", 380, 1380)}>
          <p
            className="text-xl font-semibold leading-tight"
            style={{ color: "rgba(255,255,255,0.78)" }}
          >
            {playerName}&rsquo;s Night
          </p>
        </div>

        {/* ── Stat teaser ─────────────────────────────────── */}
        <div style={a("wi-fade", 380, 1730, "ease-out")} className="mt-1.5">
          <p
            className="text-sm tabular-nums"
            style={{ color: "rgba(255,255,255,0.36)" }}
          >
            {statLine}
          </p>
        </div>

        {/* ── CTA — slides up, then breathes ──────────────── */}
        <div className="mt-10" style={a("wi-up", 400, 2120)}>
          <button
            onClick={(e) => { e.stopPropagation(); dismiss(); }}
            aria-label="See your awards"
            className="relative rounded-2xl px-8 py-3.5
                       text-sm font-black uppercase tracking-widest
                       focus-visible:outline-none
                       focus-visible:ring-2 focus-visible:ring-amber-400"
            style={{
              backgroundColor: "#F59E0B",
              color: "#060D1B",
              animation: `wi-up 400ms ${E} 2120ms both,
                          wi-breathe 2000ms ease-in-out 2680ms infinite`,
            }}
          >
            See Your Awards&nbsp;→
          </button>
        </div>

        {/* ── Tap hint ─────────────────────────────────────── */}
        <div
          aria-hidden="true"
          className="mt-6 h-4"
          style={a("wi-fade", 400, 3200, "ease-out")}
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
