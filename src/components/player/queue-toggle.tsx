"use client";

// ============================================================
// Queue Toggle — Join / Leave Queue button
// ============================================================

import { useState } from "react";

interface QueueToggleProps {
  isInQueue: boolean;
  onJoin: () => Promise<{ error?: string }>;
  onLeave: () => Promise<{ error?: string }>;
}

export function QueueToggle({ isInQueue, onJoin, onLeave }: QueueToggleProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle() {
    setLoading(true);
    setError(null);

    const result = isInQueue ? await onLeave() : await onJoin();
    if (result.error) {
      setError(result.error);
    }
    setLoading(false);
  }

  return (
    <div className="space-y-2">
      <button
        onClick={handleToggle}
        disabled={loading}
        className={`w-full rounded-2xl px-6 py-5 text-lg font-bold transition-all
                    active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed
                    ${
                      isInQueue
                        ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        : "bg-emerald-600 text-white hover:bg-emerald-700"
                    }`}
      >
        {loading
          ? "Updating..."
          : isInQueue
          ? "Leave Queue"
          : "Join Queue"}
      </button>

      {error && (
        <p className="text-xs text-destructive text-center">{error}</p>
      )}
    </div>
  );
}
