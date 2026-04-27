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
// Badminton Racket Icon — 45° Lucide-style line-art
// ─────────────────────────────────────────────────────────────
// Design principles (from .impeccable.md — grounded, confident, gym-smart):
//   • Icons SUGGEST the object — they don't replicate it at small scale
//   • At 28px rendered, a 3×3 string grid = visual noise; a single cross
//     inside the oval reads instantly as "string bed"
//   • Badminton-specific proportions: tall narrow oval (not round like tennis),
//     clear V-throat, long handle with curved butt cap
//   • Entire group rotated 45° CW → head upper-right, handle lower-left
//     = "action pose" read immediately as sports equipment, not household object
//   • strokeWidth 1.5 outer / 1.0 strings — same language as Lucide icons
//   • No clipPath — no ID collision risk when rendered multiple times
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
      {/* Rotate CW 45°: head → upper-right, handle → lower-left */}
      <g transform="rotate(45, 12, 12)">

        {/* ── Head: tall narrow oval, distinctly badminton not tennis ── */}
        <ellipse cx="12" cy="5.5" rx="3.5" ry="4.5" />

        {/* ── Strings: single cross reads as string bed at icon size ── */}
        {/* At 28px, 9 lines inside an 8px oval = noise; cross = clarity  */}
        <g strokeWidth="1">
          {/* Centre vertical — along racket axis */}
          <line x1="12" y1="1.2" x2="12" y2="9.8" />
          {/* Centre horizontal — across widest point */}
          <line x1="8.7" y1="5.5" x2="15.3" y2="5.5" />
        </g>

        {/* ── Throat: V narrows from head edge to shaft ── */}
        <line x1="9.8"  y1="9.8"  x2="11.2" y2="13.5" />
        <line x1="14.2" y1="9.8"  x2="12.8" y2="13.5" />

        {/* ── Handle: parallel rails, slight outward flare ── */}
        <line x1="11.2" y1="13.5" x2="10.7" y2="21.5" />
        <line x1="12.8" y1="13.5" x2="13.3" y2="21.5" />

        {/* ── Butt cap: curved grip end ── */}
        <path d="M10.7 21.5 Q12 23 13.3 21.5" />

      </g>
    </svg>
  );
}
