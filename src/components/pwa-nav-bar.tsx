"use client";

// ============================================================
// PwaNavBar — in-app URL bar for PWA standalone mode
// ============================================================
// In standalone mode (installed PWA) the browser's native URL
// bar is hidden. This component restores the ability to:
//   • See the current full URL at a glance
//   • Edit it directly (like a browser address bar)
//   • Navigate back
//   • Jump home (/play)
//
// The bar is fixed at the bottom so it never conflicts with
// existing sticky headers on the player/organizer dashboards.
// ============================================================

import { useState, useRef, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronLeft, Home, ArrowRight, Globe } from "lucide-react";
import { useClubSlug } from "@/hooks/use-club-slug";
import { clubBase } from "@/lib/club-paths";

export function PwaNavBar() {
  const pathname = usePathname();
  const router = useRouter();
  const clubSlug = useClubSlug();

  // All hooks are declared unconditionally before any early return to
  // satisfy the Rules of Hooks. Conditional rendering (Wrapped suppression)
  // is handled after the hook block — hook call order is stable on every render.
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [origin, setOrigin] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  // Timer refs — tracked so both can be cancelled in the cleanup effect below,
  // preventing stale setState calls on an unmounted component.
  // React 19: useRef requires an explicit initial value; null signals "no timer active".
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Grab origin client-side (window is unavailable on SSR). Empty dep array means
  // this runs once on mount; setOrigin is called once and never triggers re-entry.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOrigin(window.location.origin);
  }, []);

  // Cancel any in-flight focus/blur timers when the component unmounts
  // to prevent calling setState on an unmounted component.
  useEffect(() => {
    return () => {
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    };
  }, []);

  // The Wrapped experience is a full-bleed immersive overlay —
  // suppress the nav bar so it doesn't compete with the animation.
  // `includes` (not `startsWith`) so this also catches the club-namespaced
  // variant at /c/[clubSlug]/wrapped/...
  if (pathname.includes("/wrapped/")) return null;

  // The full URL shown in the bar when not editing.
  const displayUrl = origin ? `${origin}${pathname}` : pathname;

  function openEditor() {
    // Pre-fill with the full URL including any query string.
    const full = typeof window !== "undefined" ? window.location.href : displayUrl;
    setInputValue(full);
    setEditing(true);
    // Select all text after the input mounts so the user can type immediately.
    // Timer is tracked so it can be cancelled on unmount.
    focusTimerRef.current = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 10);
  }

  function handleNavigate() {
    const val = inputValue.trim();
    setEditing(false);
    if (!val) return;

    try {
      const url = new URL(val);
      if (url.origin === window.location.origin) {
        // Same-origin → use the router for a soft navigation.
        router.push(url.pathname + url.search + url.hash);
      } else {
        // Cross-origin → full browser navigation.
        window.location.href = val;
      }
    } catch {
      // Not a valid absolute URL — treat as a pathname.
      if (val.startsWith("/")) {
        router.push(val);
      }
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleNavigate();
    }
    if (e.key === "Escape") {
      setEditing(false);
    }
  }

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-[100]
                 border-t border-border bg-background/95 backdrop-blur-sm
                 flex items-center gap-1.5 px-2
                 h-12
                 [padding-bottom:max(6px,env(safe-area-inset-bottom,0px))]"
    >
      {/* ── Back ────────────────────────────────────────────── */}
      <button
        onClick={() => router.back()}
        aria-label="Go back"
        className="shrink-0 h-10 w-10 flex items-center justify-center
                   rounded-lg text-muted-foreground
                   hover:bg-accent hover:text-foreground transition-colors"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>

      {/* ── URL field ───────────────────────────────────────── */}
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            ref={inputRef}
            type="url"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              // Short delay so the "Go" button click registers before blur
              // collapses the input. Timer is tracked for unmount cleanup.
              blurTimerRef.current = setTimeout(() => setEditing(false), 150);
            }}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            className="w-full h-10 rounded-lg border border-primary/50 bg-background
                       px-2.5 text-xs text-foreground
                       focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        ) : (
          <button
            onClick={openEditor}
            title="Tap to edit URL"
            className="w-full h-10 flex items-center gap-1.5
                       rounded-lg bg-accent/60 hover:bg-accent
                       px-2.5 text-left transition-colors"
          >
            <Globe className="h-3 w-3 shrink-0 text-muted-foreground/50" />
            <span className="truncate text-xs text-muted-foreground">{displayUrl}</span>
          </button>
        )}
      </div>

      {/* ── Go / Home ───────────────────────────────────────── */}
      {editing ? (
        <button
          onClick={handleNavigate}
          aria-label="Navigate to URL"
          className="shrink-0 h-10 px-3 flex items-center gap-1
                     rounded-lg bg-primary text-primary-foreground
                     text-xs font-semibold hover:bg-primary/90 transition-colors"
        >
          <ArrowRight className="h-3.5 w-3.5" />
          Go
        </button>
      ) : (
        <button
          onClick={() => router.push(clubSlug ? clubBase(clubSlug) : "/play")}
          aria-label="Go home"
          className="shrink-0 h-10 w-10 flex items-center justify-center
                     rounded-lg text-muted-foreground
                     hover:bg-accent hover:text-foreground transition-colors"
        >
          <Home className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
