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
    <div className="clip-cut border border-cc-border bg-cc-bg-2 px-6 py-8 text-center">
      <div className="clip-cut-sm mx-auto mb-4 flex h-12 w-12 items-center justify-center bg-cc-accent-dim">
        <Ticket className="h-6 w-6 text-cc-accent-text" aria-hidden="true" />
      </div>
      <h1 className="font-display text-2xl font-bold uppercase italic tracking-tight text-cc-t1">
        Join this club
      </h1>
      <p className="mx-auto mt-1.5 max-w-xs text-sm text-cc-t2">
        You&apos;ve been invited. Accept to add this club to your account.
      </p>

      {error && (
        <p
          role="alert"
          className="clip-cut-sm mt-4 border border-cc-red/30 bg-cc-red-dim px-3 py-2 text-xs font-medium text-cc-red"
        >
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleJoin}
        disabled={isPending}
        className="clip-cut-sm mt-5 inline-flex w-full items-center justify-center gap-2 bg-cc-accent px-4 py-2.5 text-sm font-bold uppercase tracking-wide text-cc-btn-on-accent transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        {isPending ? "Joining…" : "Accept invite"}
      </button>
    </div>
  );
}
