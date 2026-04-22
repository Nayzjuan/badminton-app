"use client";

// ============================================================
// SignOutButton — reusable sign-out trigger
// ============================================================
// Calls the playerLogOut server action (clears auth + redirects
// to "/"). Available in three visual variants so it can slot
// into different header contexts without additional styling work.
//
//   variant="icon"   — bare LogOut icon, no text (compact headers)
//   variant="text"   — underlined text link (dialogs / footers)
//   variant="full"   — icon + label pill (spacious headers)
// ============================================================

import { useState } from "react";
import { LogOut } from "lucide-react";
import { playerLogOut } from "@/app/actions/auth";

interface SignOutButtonProps {
  variant?: "icon" | "text" | "full";
  className?: string;
}

export function SignOutButton({
  variant = "full",
  className = "",
}: SignOutButtonProps) {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    await playerLogOut();
    // playerLogOut redirects — this line is effectively unreachable,
    // but keeps the loading state honest while the redirect fires.
    setLoading(false);
  }

  if (variant === "icon") {
    return (
      <button
        onClick={handleClick}
        disabled={loading}
        aria-label="Sign out"
        title="Sign out"
        className={`flex items-center justify-center h-8 w-8 rounded-lg
                    text-muted-foreground hover:text-destructive hover:bg-destructive/10
                    transition-colors disabled:opacity-50 disabled:cursor-not-allowed
                    ${className}`}
      >
        <LogOut className="h-4 w-4" />
      </button>
    );
  }

  if (variant === "text") {
    return (
      <button
        onClick={handleClick}
        disabled={loading}
        className={`text-[11px] text-muted-foreground hover:text-foreground
                    underline underline-offset-2 transition-colors
                    disabled:opacity-50 disabled:cursor-not-allowed
                    ${className}`}
      >
        {loading ? "Signing out…" : "Sign out of the app entirely"}
      </button>
    );
  }

  // variant === "full"
  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5
                  text-xs font-medium text-muted-foreground
                  hover:text-destructive hover:bg-destructive/10
                  transition-colors disabled:opacity-50 disabled:cursor-not-allowed
                  ${className}`}
    >
      <LogOut className="h-3.5 w-3.5" />
      {loading ? "Signing out…" : "Sign out"}
    </button>
  );
}
