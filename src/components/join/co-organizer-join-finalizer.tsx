"use client";

// ============================================================
// CoOrganizerJoinFinalizer — authenticated /o/[token] redeem
// ============================================================
// Must not call completeRegistrationJoinAction — that path enqueues.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { redeemCoOrganizerInvite } from "@/app/actions/sessions";
import { Spinner } from "@/components/reconnect-modal";

export function CoOrganizerJoinFinalizer({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const result = await redeemCoOrganizerInvite(token);
        if (cancelled) return;

        if (!result.success && result.requiresRename && result.next) {
          router.replace(`/rename?next=${encodeURIComponent(result.next)}`);
          return;
        }

        if (!result.success) {
          setError(result.message);
          return;
        }

        router.replace(result.destination ?? "/play");
      } catch {
        if (cancelled) return;
        setError("Something went wrong. Please try again.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, retryKey, router]);

  if (error) {
    return (
      <div className="w-full max-w-sm space-y-4 text-center">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setRetryKey((k) => k + 1);
          }}
          className="flex min-h-11 w-full cursor-pointer items-center justify-center rounded-lg
                     bg-cc-amber px-4 py-3 text-base font-semibold text-cc-btn-on-accent
                     hover:bg-cc-amber/90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-3 py-8 text-center">
      <Spinner />
      <p className="text-sm text-cc-t2">Joining as co-organizer…</p>
    </div>
  );
}
