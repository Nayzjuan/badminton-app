"use client";

// ============================================================
// JoinFinalizer — authenticated QR / club join progress
// ============================================================
// ClubJoinScreen renders this instead of mutating during RSC. A client
// ref limits duplicate effects (Strict Mode remounts still re-run; the
// join_queue / membership no-ops are the real idempotency guarantee).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { completeRegistrationJoinAction } from "@/app/actions/registration";
import { trackRegistration } from "@/lib/registration-analytics";
import { Spinner } from "@/components/reconnect-modal";

type Props = {
  clubSlug: string;
  sessionId?: string;
};

export function JoinFinalizer({ clubSlug, sessionId }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const result = await completeRegistrationJoinAction({
          clubSlug,
          sessionId: sessionId ?? null,
        });
        if (cancelled) return;

        if (!result.success && result.requiresRename) {
          trackRegistration({
            step: "identity_ready",
            entry: sessionId ? "qr_session" : "qr_club",
          });
          router.replace(`/rename?next=${encodeURIComponent(result.next)}`);
          return;
        }

        if (!result.success) {
          setError(result.error);
          return;
        }

        const entry = sessionId ? "qr_session" : "qr_club";
        trackRegistration({ step: "identity_ready", entry });
        if (result.membershipAction === "created" || result.membershipAction === "reactivated") {
          trackRegistration({ step: "membership_transition", entry });
        }
        if (result.queueAction === "inserted" || result.queueAction === "reactivated") {
          trackRegistration({ step: "queue_transition", entry });
        }
        const outcome =
          result.queueAction === "inserted" || result.queueAction === "reactivated"
            ? "queue_joined"
            : result.queueAction === "unchanged"
              ? "already_joined"
              : result.membershipAction === "unchanged"
                ? "already_joined"
                : "club_joined";
        trackRegistration({ step: "completed", entry, outcome });

        const joinedQs = result.joined ? "?joined=1" : "";
        router.replace(result.destination + joinedQs);
      } catch {
        if (cancelled) return;
        setError("Something went wrong. Please try again.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clubSlug, sessionId, retryKey, router]);

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
                     bg-amber-500 px-4 py-3 text-base font-semibold text-[#0E1C3A]
                     hover:bg-amber-600"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-3 py-8 text-center">
      <Spinner />
      <p className="text-sm text-muted-foreground">
        {sessionId ? "Joining session…" : "Joining club…"}
      </p>
    </div>
  );
}
