"use client";

// ============================================================
// JoinClubPanel — confirm + redeem a club invite token
// ============================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Ticket } from "lucide-react";
import { acceptClubInvite } from "@/app/actions/clubs";

export function JoinClubPanel({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleJoin() {
    setError(null);
    startTransition(async () => {
      const result = await acceptClubInvite(token);
      if (result.success && result.slug) {
        router.push(`/c/${result.slug}`);
      } else {
        setError(result.message);
      }
    });
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-6 py-8 text-center shadow-sm dark:border-border dark:bg-card">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-cc-accent-dim">
        <Ticket className="h-6 w-6 text-cc-accent-text" />
      </div>
      <h1 className="text-lg font-black tracking-tight text-slate-900 dark:text-foreground">
        Join this club
      </h1>
      <p className="mx-auto mt-1 max-w-xs text-sm text-slate-500 dark:text-muted-foreground">
        You&apos;ve been invited. Accept to add this club to your account.
      </p>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700 dark:bg-red-950/40 dark:text-red-400">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleJoin}
        disabled={isPending}
        className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-cc-accent px-4 py-2.5 text-sm font-bold text-cc-btn-on-accent transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        {isPending ? "Joining…" : "Accept invite"}
      </button>
    </div>
  );
}
