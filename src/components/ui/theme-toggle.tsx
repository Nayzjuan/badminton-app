"use client";

// ============================================================
// ThemeToggle — Sun/Moon button for light ↔ dark mode
// ============================================================
// Accepts a className prop so it can be styled differently
// depending on the header context (blue organizer header vs
// white player header).
// Renders a fixed-size placeholder on the server to prevent
// layout shift before the theme is resolved client-side.
// ============================================================

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon } from "lucide-react";

interface ThemeToggleProps {
  /** Tailwind classes for the button — controls icon color and hover bg. */
  className?: string;
}

export function ThemeToggle({ className = "" }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch — only render on the client.
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="h-[30px] w-[30px]" />;

  const isDark = theme === "dark";

  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className={`inline-flex items-center justify-center rounded-lg p-1.5
                  transition-colors ${className}`}
    >
      {isDark ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
    </button>
  );
}
