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
      <defs>
        {/* Clip string lines to the oval head */}
        <clipPath id="racket-head-clip">
          <ellipse cx="12" cy="5.5" rx="4" ry="4.5" />
        </clipPath>
      </defs>

      {/* ── Head ─────────────────────────────────────── */}
      <ellipse cx="12" cy="5.5" rx="4" ry="4.5" />

      {/* ── String grid (thinner strokes, clipped) ───── */}
      <g clipPath="url(#racket-head-clip)" strokeWidth="0.75">
        {/* 3 vertical strings */}
        <line x1="10"  y1="0" x2="10"  y2="11" />
        <line x1="12"  y1="0" x2="12"  y2="11" />
        <line x1="14"  y1="0" x2="14"  y2="11" />
        {/* 3 horizontal strings */}
        <line x1="6" y1="4"   x2="18" y2="4"   />
        <line x1="6" y1="6"   x2="18" y2="6"   />
        <line x1="6" y1="8"   x2="18" y2="8"   />
      </g>

      {/* ── Throat — tapers inward from head to shaft ─ */}
      <line x1="10"    y1="10"   x2="11.25" y2="14" />
      <line x1="14"    y1="10"   x2="12.75" y2="14" />

      {/* ── Handle — long and narrow ─────────────────── */}
      <line x1="11.25" y1="14"   x2="10.75" y2="21.5" />
      <line x1="12.75" y1="14"   x2="13.25" y2="21.5" />

      {/* ── Butt cap ──────────────────────────────────── */}
      <path d="M10.75 21.5 Q12 23 13.25 21.5" />
    </svg>
  );
}
