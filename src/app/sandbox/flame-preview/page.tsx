"use client";

// ============================================================
// Flame Animation Preview — /sandbox/flame-preview
// Compare three fire approaches for win-streak cards
// ============================================================

import { Flame } from "lucide-react";

// ─────────────────────────────────────────────────────────────
// Mock card shell that matches CourtMatchCard layout
// ─────────────────────────────────────────────────────────────

function MockPlayerRow({ name, skill, streak }: { name: string; skill: string; streak: number }) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <div>
        <p className="text-sm font-bold text-white">{name}</p>
        <p className="text-[10px] text-white/50 uppercase tracking-wider">{skill}</p>
      </div>
      {streak >= 3 && (
        <span className="flex items-center gap-1 text-orange-400 text-xs font-bold">
          <Flame className="h-3.5 w-3.5" />×{streak}
        </span>
      )}
    </div>
  );
}

function MockCard({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/40">{label}</p>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Option A — Current (reference)
// ─────────────────────────────────────────────────────────────

function OptionA() {
  return (
    <MockCard label="Option A — Current">
      <div
        className="rounded-xl overflow-hidden"
        style={{
          background: "oklch(0.11 0.016 238)",
          boxShadow: "0 0 0 1px oklch(0.72 0.22 38 / 0.35), 0 0 18px oklch(0.72 0.22 38 / 0.20)",
        }}
      >
        <div className="px-3 py-2 border-b border-white/10">
          <span className="text-[11px] font-bold uppercase tracking-wider text-white/60">
            Court 1
          </span>
        </div>
        <div className="divide-y divide-white/5">
          <MockPlayerRow name="Miguel" skill="Intermediate" streak={4} />
          <MockPlayerRow name="Jordan" skill="Beginner" streak={0} />
        </div>
        <div className="h-px mx-3" style={{ background: "oklch(0.72 0.22 38 / 0.25)" }} />
        <div className="divide-y divide-white/5">
          <MockPlayerRow name="Esmé" skill="Advanced" streak={0} />
          <MockPlayerRow name="Alex" skill="Intermediate" streak={0} />
        </div>
      </div>
    </MockCard>
  );
}

// ─────────────────────────────────────────────────────────────
// Option B — CSS Ember Particles
// Floating sparks rise from inside the card
// ─────────────────────────────────────────────────────────────

function EmberParticles() {
  // 18 particles with varied x, size, speed, delay
  const particles = [
    { left: "8%", size: 3, dur: "2.4s", delay: "0s", opacity: 0.9 },
    { left: "18%", size: 2, dur: "3.1s", delay: "0.4s", opacity: 0.7 },
    { left: "28%", size: 4, dur: "2.7s", delay: "0.8s", opacity: 0.85 },
    { left: "38%", size: 2, dur: "3.5s", delay: "0.2s", opacity: 0.6 },
    { left: "48%", size: 3, dur: "2.2s", delay: "1.1s", opacity: 0.95 },
    { left: "58%", size: 2, dur: "3.8s", delay: "0.6s", opacity: 0.7 },
    { left: "68%", size: 4, dur: "2.6s", delay: "0.3s", opacity: 0.8 },
    { left: "78%", size: 2, dur: "3.2s", delay: "0.9s", opacity: 0.65 },
    { left: "88%", size: 3, dur: "2.9s", delay: "0.1s", opacity: 0.9 },
    { left: "13%", size: 2, dur: "3.6s", delay: "1.3s", opacity: 0.55 },
    { left: "23%", size: 3, dur: "2.3s", delay: "0.7s", opacity: 0.75 },
    { left: "33%", size: 2, dur: "4.0s", delay: "1.5s", opacity: 0.5 },
    { left: "43%", size: 4, dur: "2.8s", delay: "0.5s", opacity: 0.88 },
    { left: "53%", size: 2, dur: "3.3s", delay: "1.0s", opacity: 0.65 },
    { left: "63%", size: 3, dur: "2.1s", delay: "0.2s", opacity: 0.92 },
    { left: "73%", size: 2, dur: "3.7s", delay: "1.2s", opacity: 0.6 },
    { left: "83%", size: 3, dur: "2.5s", delay: "0.8s", opacity: 0.8 },
    { left: "93%", size: 2, dur: "3.0s", delay: "0.4s", opacity: 0.7 },
  ];

  return (
    <>
      {particles.map((p, i) => (
        <span
          key={i}
          className="ember-b"
          style={{
            position: "absolute",
            bottom: 0,
            left: p.left,
            width: p.size,
            height: p.size,
            borderRadius: "50%",
            background: `radial-gradient(circle, oklch(0.98 0.15 55) 0%, oklch(0.72 0.22 38) 60%, transparent 100%)`,
            opacity: p.opacity,
            animationDuration: p.dur,
            animationDelay: p.delay,
            pointerEvents: "none",
          }}
        />
      ))}
    </>
  );
}

function OptionB() {
  return (
    <MockCard label="Option B — CSS Ember Particles">
      <div
        className="rounded-xl overflow-hidden relative"
        style={{
          background: "oklch(0.11 0.016 238)",
          boxShadow:
            "0 0 0 1px oklch(0.72 0.22 38 / 0.60), 0 0 24px oklch(0.72 0.22 38 / 0.35), 0 0 48px oklch(0.72 0.22 38 / 0.15)",
        }}
      >
        {/* Ember layer — behind content */}
        <div className="absolute inset-0 overflow-hidden rounded-xl" aria-hidden="true">
          <EmberParticles />
        </div>

        {/* Card content on top */}
        <div className="relative z-10">
          <div className="px-3 py-2 border-b border-white/10">
            <span className="text-[11px] font-bold uppercase tracking-wider text-white/60">
              Court 1
            </span>
          </div>
          <div className="divide-y divide-white/5">
            <MockPlayerRow name="Miguel" skill="Intermediate" streak={4} />
            <MockPlayerRow name="Jordan" skill="Beginner" streak={0} />
          </div>
          <div className="h-px mx-3" style={{ background: "oklch(0.72 0.22 38 / 0.25)" }} />
          <div className="divide-y divide-white/5">
            <MockPlayerRow name="Esmé" skill="Advanced" streak={0} />
            <MockPlayerRow name="Alex" skill="Intermediate" streak={0} />
          </div>
        </div>
      </div>
    </MockCard>
  );
}

// ─────────────────────────────────────────────────────────────
// Option C — Gooey CSS Flame (blur + contrast trick)
// Particles merge at base, separate into flame tongues at top
// External to card — wraps around the outside
// ─────────────────────────────────────────────────────────────

function GooeyFlame({ side }: { side: "left" | "right" | "bottom" }) {
  const blobs =
    side === "bottom"
      ? [
          { left: "15%", width: 28, height: 40, delay: "0s", dur: "1.6s" },
          { left: "28%", width: 22, height: 36, delay: "0.25s", dur: "1.9s" },
          { left: "40%", width: 32, height: 50, delay: "0.1s", dur: "1.4s" },
          { left: "52%", width: 20, height: 34, delay: "0.4s", dur: "2.0s" },
          { left: "64%", width: 28, height: 44, delay: "0.15s", dur: "1.7s" },
          { left: "76%", width: 22, height: 38, delay: "0.35s", dur: "1.5s" },
        ]
      : [
          { top: "20%", width: 26, height: 36, delay: "0s", dur: "1.6s" },
          { top: "35%", width: 20, height: 30, delay: "0.3s", dur: "1.9s" },
          { top: "50%", width: 28, height: 42, delay: "0.1s", dur: "1.4s" },
          { top: "65%", width: 22, height: 32, delay: "0.4s", dur: "2.0s" },
          { top: "78%", width: 18, height: 28, delay: "0.2s", dur: "1.7s" },
        ];

  if (side === "bottom") {
    return (
      <div
        style={{
          position: "absolute",
          bottom: -8,
          left: 0,
          right: 0,
          height: 60,
          filter: "blur(7px) contrast(25) brightness(1.6)",
          zIndex: 0,
          pointerEvents: "none",
        }}
      >
        {(
          blobs as { left: string; width: number; height: number; delay: string; dur: string }[]
        ).map((b, i) => (
          <span
            key={i}
            className="gooey-flame-blob"
            style={{
              position: "absolute",
              bottom: 0,
              left: b.left,
              width: b.width,
              height: b.height,
              borderRadius: "50% 50% 30% 30%",
              background:
                "radial-gradient(ellipse at 50% 80%, oklch(0.98 0.18 55) 0%, oklch(0.72 0.22 38) 50%, oklch(0.55 0.20 35) 100%)",
              animationDuration: b.dur,
              animationDelay: b.delay,
            }}
          />
        ))}
      </div>
    );
  }

  const isLeft = side === "left";
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        [isLeft ? "left" : "right"]: -10,
        width: 60,
        filter: "blur(7px) contrast(25) brightness(1.6)",
        zIndex: 0,
        pointerEvents: "none",
      }}
    >
      {(blobs as { top: string; width: number; height: number; delay: string; dur: string }[]).map(
        (b, i) => (
          <span
            key={i}
            className="gooey-flame-blob-side"
            style={{
              position: "absolute",
              top: b.top,
              [isLeft ? "right" : "left"]: 0,
              width: b.width,
              height: b.height,
              borderRadius: "50% 50% 30% 30%",
              background:
                "radial-gradient(ellipse at 50% 80%, oklch(0.98 0.18 55) 0%, oklch(0.72 0.22 38) 50%, oklch(0.55 0.20 35) 100%)",
              animationDuration: b.dur,
              animationDelay: b.delay,
            }}
          />
        )
      )}
    </div>
  );
}

function OptionC() {
  return (
    <MockCard label="Option C — Gooey CSS Flame (around border)">
      {/* Outer glow layer — separate from gooey layer */}
      <div
        className="relative"
        style={{
          filter:
            "drop-shadow(0 0 20px oklch(0.72 0.22 38 / 0.7)) drop-shadow(0 0 40px oklch(0.72 0.22 38 / 0.4))",
        }}
      >
        {/* Gooey flame container */}
        <div className="relative">
          {/* Bottom flame */}
          <GooeyFlame side="bottom" />
          {/* Left flame */}
          <GooeyFlame side="left" />
          {/* Right flame */}
          <GooeyFlame side="right" />

          {/* Card itself — sits on top of flame layer */}
          <div
            className="relative z-10 rounded-xl overflow-hidden"
            style={{ background: "oklch(0.11 0.016 238)" }}
          >
            <div className="px-3 py-2 border-b border-white/10">
              <span className="text-[11px] font-bold uppercase tracking-wider text-white/60">
                Court 1
              </span>
            </div>
            <div className="divide-y divide-white/5">
              <MockPlayerRow name="Miguel" skill="Intermediate" streak={4} />
              <MockPlayerRow name="Jordan" skill="Beginner" streak={0} />
            </div>
            <div className="h-px mx-3" style={{ background: "oklch(0.72 0.22 38 / 0.25)" }} />
            <div className="divide-y divide-white/5">
              <MockPlayerRow name="Esmé" skill="Advanced" streak={0} />
              <MockPlayerRow name="Alex" skill="Intermediate" streak={0} />
            </div>
          </div>
        </div>
      </div>
    </MockCard>
  );
}

// ─────────────────────────────────────────────────────────────
// Option D — Combined: Gooey Flame + Ember Particles
// ─────────────────────────────────────────────────────────────

function OptionD() {
  return (
    <MockCard label="Option D — Gooey Flame + Embers (recommended)">
      <div
        className="relative"
        style={{
          filter:
            "drop-shadow(0 0 22px oklch(0.72 0.22 38 / 0.75)) drop-shadow(0 0 50px oklch(0.72 0.22 38 / 0.45))",
        }}
      >
        <div className="relative">
          <GooeyFlame side="bottom" />
          <GooeyFlame side="left" />
          <GooeyFlame side="right" />

          <div
            className="relative z-10 rounded-xl overflow-hidden"
            style={{ background: "oklch(0.09 0.018 238)" }}
          >
            {/* Embers inside the card */}
            <div className="absolute inset-0 overflow-hidden rounded-xl z-0" aria-hidden="true">
              <EmberParticles />
            </div>

            <div className="relative z-10">
              <div className="px-3 py-2 border-b border-white/10">
                <span className="text-[11px] font-bold uppercase tracking-wider text-white/60">
                  Court 1
                </span>
              </div>
              <div className="divide-y divide-white/5">
                <MockPlayerRow name="Miguel" skill="Intermediate" streak={4} />
                <MockPlayerRow name="Jordan" skill="Beginner" streak={0} />
              </div>
              <div className="h-px mx-3" style={{ background: "oklch(0.72 0.22 38 / 0.25)" }} />
              <div className="divide-y divide-white/5">
                <MockPlayerRow name="Esmé" skill="Advanced" streak={0} />
                <MockPlayerRow name="Alex" skill="Intermediate" streak={0} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </MockCard>
  );
}

// ─────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────

export default function FlamePreviewPage() {
  return (
    <>
      {/* Keyframe styles */}
      <style>{`
        /* Ember particles — float upward and fade out */
        @keyframes ember-rise {
          0%   { transform: translateY(0)    translateX(0)    scale(1);   opacity: var(--em-op, 0.8); }
          30%  { transform: translateY(-30%) translateX(4px)  scale(0.9); opacity: var(--em-op, 0.8); }
          60%  { transform: translateY(-65%) translateX(-5px) scale(0.7); opacity: calc(var(--em-op, 0.8) * 0.6); }
          100% { transform: translateY(-110%) translateX(3px) scale(0.3); opacity: 0; }
        }
        .ember-b {
          animation: ember-rise linear infinite;
        }

        /* Gooey flame blobs — pulse up from the base */
        @keyframes gooey-rise {
          0%   { transform: scaleY(0.6) scaleX(1.1); }
          40%  { transform: scaleY(1.2) scaleX(0.85); }
          70%  { transform: scaleY(1.05) scaleX(0.95); }
          100% { transform: scaleY(0.6) scaleX(1.1); }
        }
        .gooey-flame-blob {
          animation: gooey-rise ease-in-out infinite;
          transform-origin: bottom center;
        }

        /* Side flame blobs — pulse outward from the edges */
        @keyframes gooey-side-rise {
          0%   { transform: scaleX(0.5) scaleY(1.1); }
          40%  { transform: scaleX(1.3) scaleY(0.85); }
          70%  { transform: scaleX(1.05) scaleY(0.95); }
          100% { transform: scaleX(0.5) scaleY(1.1); }
        }
        .gooey-flame-blob-side {
          animation: gooey-side-rise ease-in-out infinite;
          transform-origin: center;
        }
      `}</style>

      <div className="min-h-screen bg-[oklch(0.07_0.012_238)] px-6 py-10">
        {/* Header */}
        <div className="mb-10">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/30 mb-1">
            Sandbox / Flame Preview
          </p>
          <h1 className="text-2xl font-black text-white">Win Streak Fire Animations</h1>
          <p className="mt-1 text-sm text-white/50">
            Four options — pick the one you want to ship.
          </p>
        </div>

        {/* Grid — 2×2 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 max-w-3xl">
          <OptionA />
          <OptionB />
          <OptionC />
          <OptionD />
        </div>

        {/* Legend */}
        <div className="mt-16 max-w-xl space-y-2 text-xs text-white/40">
          <p>
            <span className="text-white/70 font-semibold">Option A</span> — What you have now.
            Pulsing orange glow border, no flame geometry.
          </p>
          <p>
            <span className="text-white/70 font-semibold">Option B</span> — Floating ember sparks
            inside the card. Pure CSS. Fast. Scales to many players.
          </p>
          <p>
            <span className="text-white/70 font-semibold">Option C</span> — Gooey CSS flames around
            the outside of the card using blur+contrast trick. Organic flame shapes.
          </p>
          <p>
            <span className="text-white/70 font-semibold">Option D</span> — B + C combined. Closest
            to the video. Outer gooey flames + inner floating sparks.
          </p>
        </div>
      </div>
    </>
  );
}
