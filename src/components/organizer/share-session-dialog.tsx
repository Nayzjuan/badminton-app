"use client";

// ============================================================
// ShareSessionDialog — QR code + copy link for organizer
// ============================================================
// Generates a /play/join?session=[id] URL for players to scan
// and join the session without needing to navigate manually.
// ============================================================

import { useState, useEffect, useRef, useSyncExternalStore } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Share2, Copy, Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useClubSlug } from "@/hooks/use-club-slug";
import { clubJoin } from "@/lib/club-paths";

// `window.location.origin` cannot be read while rendering on the server, and
// reading it during the hydrating render would desync from the server HTML.
// useSyncExternalStore is React's sanctioned escape hatch for exactly this: it
// serves the server snapshot both on the server AND on the hydrating render, so
// the markup always matches, then swaps in the real origin once hydration ends.
// The origin is immutable for the life of the document, so nothing ever needs
// to notify us — `subscribe` hands back a no-op unsubscribe and never fires.
// (All three live at module scope so their identities stay stable across
// renders; a fresh `subscribe` on every render would force a resubscribe.)
const subscribeToOrigin = () => () => {};
const getOriginSnapshot = () => window.location.origin;
const getServerOriginSnapshot = () => "";

interface ShareSessionDialogProps {
  sessionId: string;
  sessionName: string;
  /** Controlled open state. When provided the built-in trigger is hidden
   *  and the parent controls visibility. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ShareSessionDialog({
  sessionId,
  sessionName,
  open,
  onOpenChange,
}: ShareSessionDialogProps) {
  const isControlled = open !== undefined;
  const clubSlug = useClubSlug();
  const [copied, setCopied] = useState(false);
  // Tracks the "copied" reset timer so we can cancel it if the component
  // unmounts before the 2-second window expires (prevents setState on unmounted component).
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Build the URL client-side so window.location.origin is available. On a club
  // route the QR points at /c/[slug]/join; otherwise the legacy /play/join shim
  // (which forwards to the club join) keeps older surfaces working.
  const origin = useSyncExternalStore(
    subscribeToOrigin,
    getOriginSnapshot,
    getServerOriginSnapshot
  );
  const path = clubSlug ? clubJoin(clubSlug, sessionId) : `/play/join?session=${sessionId}`;
  // Stays "" until the origin is known; every consumer below treats "" as
  // "not generated yet" (skeleton QR, disabled copy button, no-op handleCopy).
  const joinUrl = origin ? `${origin}${path}` : "";

  // Clear the copied reset timer on unmount.
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  function scheduleCopiedReset() {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
  }

  async function handleCopy() {
    if (!joinUrl) return;
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      scheduleCopiedReset();
    } catch {
      // Fallback for browsers without clipboard API.
      const input = document.createElement("input");
      input.value = joinUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setCopied(true);
      scheduleCopiedReset();
    }
  }

  return (
    <Dialog
      open={isControlled ? open : undefined}
      onOpenChange={isControlled ? onOpenChange : undefined}
    >
      {!isControlled && (
        <DialogTrigger asChild>
          <button
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/40
                       bg-white/10 px-3 py-1.5 text-xs font-semibold text-white
                       hover:bg-white/20 hover:border-white/60 transition-colors"
          >
            <Share2 className="h-3.5 w-3.5" />
            Share Session
          </button>
        </DialogTrigger>
      )}

      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Join &ldquo;{sessionName}&rdquo;</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col items-center gap-5 py-2">
          {/* QR Code */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            {joinUrl ? (
              <QRCodeSVG
                value={joinUrl}
                size={200}
                bgColor="#ffffff"
                fgColor="#0f172a"
                level="M"
                includeMargin={false}
              />
            ) : (
              <div className="h-[200px] w-[200px] animate-pulse rounded bg-slate-100" />
            )}
          </div>

          <p className="text-center text-xs text-muted-foreground leading-relaxed px-2">
            Players scan this QR code to jump straight to the registration page for this session.
          </p>

          {/* Copy Link */}
          <div className="w-full space-y-2">
            <div
              className="truncate rounded-lg border border-slate-200 bg-slate-50
                         px-3 py-2 text-xs font-mono text-slate-600"
              title={joinUrl}
            >
              {joinUrl || "Generating…"}
            </div>

            <button
              onClick={handleCopy}
              disabled={!joinUrl}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg
                         border border-slate-200 bg-white px-4 py-2 text-sm font-medium
                         text-slate-700 shadow-sm transition-all
                         hover:bg-slate-50 hover:border-slate-300
                         disabled:opacity-50 disabled:cursor-not-allowed
                         active:scale-[0.98]"
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4 text-green-500" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  Copy Link
                </>
              )}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
