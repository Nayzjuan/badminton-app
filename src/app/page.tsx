// ============================================================
// Home Page — Player Login / Profile Setup
// ============================================================
// If already authenticated and in an active session, redirects
// straight to that session dashboard. Otherwise shows the
// name + skill level + PIN entry form.
// ============================================================

import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { LoginForm } from "@/components/login-form";

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    // Check if the player is actively in a session (queued or playing).
    const { data: activeEntry } = await supabase
      .from("queue_entries")
      .select("session_id, sessions!inner(is_active)")
      .eq("player_id", user.id)
      .in("status", ["waiting", "on_deck", "playing"])
      .limit(1)
      .single();

    if (activeEntry) {
      redirect(`/play/${activeEntry.session_id}`);
    }

    // Has auth but no active session — go to session picker.
    redirect("/play");
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#FAFAF7] dark:bg-background px-6 py-12">
      <div className="w-full max-w-sm sm:max-w-md space-y-8 text-center">
        {/* Branding */}
        <div className="space-y-2">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl
                          bg-amber-500 text-[#0E1C3A] ring-4 ring-amber-500/20 dark:ring-amber-400/20">
            <BadmintonRacketIcon className="h-7 w-7" />
          </div>
          <h1 className="text-3xl font-black tracking-tight text-foreground">
            Badminton Queue
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Enter your name and skill level to get started.
          </p>
        </div>

        {/* Login Form */}
        <LoginForm />
      </div>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────
// Badminton Racket Icon
// ─────────────────────────────────────────────────────────────
// Custom SVG — no Lucide equivalent exists.
// Key proportions that read as "racket, not paddle":
//   • Oval head ≈ 40 % of total height
//   • V-shaped throat section ≈ 18 %
//   • Long narrow handle ≈ 42 %
// A clipPath constrains the string grid to the oval so lines
// don't bleed outside the head outline.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Badminton Racket Icon — 45° line-art, 3×3 string grid
// ─────────────────────────────────────────────────────────────
// The entire racket sits inside a <g transform="rotate(45,12,12)">
// so head points upper-right, handle lower-left — classic
// "action pose" you'd see on a sports badge.
//
// String endpoints are pre-calculated to land inside the ellipse
// (cx=12, cy=5.5, rx=3.5, ry=4.5) — no clipPath required.
// Formula: for vertical strings at x, y_edge = cy ± ry·√(1-((x-cx)/rx)²)
//          for horizontal strings at y, x_edge = cx ± rx·√(1-((y-cy)/ry)²)
// ─────────────────────────────────────────────────────────────

function BadmintonRacketIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* Whole racket rotated 45° CW: head upper-right, handle lower-left */}
      <g transform="rotate(45, 12, 12)">

        {/* ── Head ──────────────────────────────────────── */}
        <ellipse cx="12" cy="5.5" rx="3.5" ry="4.5" />

        {/* ── String grid (3 vertical × 3 horizontal) ──── */}
        {/* Endpoints clipped to ellipse boundary via math, no clipPath */}
        <g strokeWidth="0.75">
          {/* Vertical strings (x = 10, 12, 14) */}
          {/* x=10: offset=(10-12)/3.5=-0.571, y±=5.5±4.5·√(1-0.326)=5.5±3.7 */}
          <line x1="10" y1="1.8" x2="10" y2="9.2" />
          {/* x=12: centre string, full height */}
          <line x1="12" y1="1.0" x2="12" y2="10.0" />
          {/* x=14: mirror of x=10 */}
          <line x1="14" y1="1.8" x2="14" y2="9.2" />

          {/* Horizontal strings (y = 4, 6, 8) */}
          {/* y=4: offset=(4-5.5)/4.5=-0.333, x±=12±3.5·√(1-0.111)=12±3.3 */}
          <line x1="8.7" y1="4" x2="15.3" y2="4" />
          {/* y=6: offset=(6-5.5)/4.5=0.111, x±=12±3.5·√(1-0.012)=12±3.48 */}
          <line x1="8.5" y1="6" x2="15.5" y2="6" />
          {/* y=8: offset=(8-5.5)/4.5=0.556, x±=12±3.5·√(1-0.309)=12±2.9 */}
          <line x1="9.1" y1="8" x2="14.9" y2="8" />
        </g>

        {/* ── Throat — V tapers from head bottom to shaft ── */}
        <line x1="10.2" y1="9.8"  x2="11.2" y2="13.5" />
        <line x1="13.8" y1="9.8"  x2="12.8" y2="13.5" />

        {/* ── Handle — two parallel lines ──────────────── */}
        <line x1="11.2" y1="13.5" x2="10.6" y2="22" />
        <line x1="12.8" y1="13.5" x2="13.4" y2="22" />

        {/* ── Butt cap — curved end of grip ────────────── */}
        <path d="M10.6 22 Q12 23.5 13.4 22" />

      </g>
    </svg>
  );
}
