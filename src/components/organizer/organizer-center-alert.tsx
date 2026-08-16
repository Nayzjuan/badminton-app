"use client";

// ============================================================
// OrganizerCenterAlert — large dismissible card at viewport center
// ============================================================
// Not a corner toast. One card at a time; the parent queues the rest.
// Dismiss via the button, the X, Escape, or the backdrop. Does not
// lock the board the way the draft-cap overlay does.

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { OrganizerAlert } from "@/lib/organizer-alerts";

interface OrganizerCenterAlertProps {
  alert: OrganizerAlert | null;
  remaining: number;
  onDismiss: () => void;
  onReview?: () => void;
}

export function OrganizerCenterAlert({
  alert,
  remaining,
  onDismiss,
  onReview,
}: OrganizerCenterAlertProps) {
  return (
    <Dialog
      open={alert !== null}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <DialogContent className="max-w-lg" data-testid="organizer-center-alert">
        {alert && (
          <>
            <DialogHeader>
              <DialogTitle className="text-2xl font-extrabold leading-tight tracking-tight">
                {alert.title}
              </DialogTitle>
              <DialogDescription className="text-base leading-relaxed">
                {alert.body}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="justify-between sm:justify-between">
              {remaining > 1 ? (
                <p className="text-xs text-muted-foreground">
                  {remaining - 1} more notice{remaining - 1 === 1 ? "" : "s"}
                </p>
              ) : (
                <span />
              )}
              <div className="flex flex-wrap justify-end gap-2">
                {alert.kind === "score_correction" && onReview && (
                  <button
                    type="button"
                    onClick={onReview}
                    className="rounded-xl bg-primary px-6 py-2.5 text-sm font-bold text-primary-foreground
                               transition-colors hover:brightness-110 focus-visible:outline-none
                               focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Review
                  </button>
                )}
                <button
                  type="button"
                  onClick={onDismiss}
                  className={
                    alert.kind === "score_correction" && onReview
                      ? "rounded-xl border border-border px-6 py-2.5 text-sm font-bold text-foreground hover:bg-muted"
                      : "rounded-xl bg-primary px-6 py-2.5 text-sm font-bold text-primary-foreground transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  }
                >
                  Dismiss
                </button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
