"use client";

// ============================================================
// CoOrganizerShareDialog — QR + copy link for co-organizer admit
// ============================================================
// Distinct from ShareSessionDialog (player /j/). Encodes /o/[token].
// Token is minted lazily via getOrCreateCoOrganizerInvite.
// ============================================================

import { useState, useEffect, useRef, useSyncExternalStore } from "react";
import { QRCodeSVG } from "qrcode.react";
import { KeyRound, Copy, Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { getOrCreateCoOrganizerInvite } from "@/app/actions/sessions";

const subscribeToOrigin = () => () => {};
const getOriginSnapshot = () => window.location.origin;
const getServerOriginSnapshot = () => "";

interface CoOrganizerShareDialogProps {
  sessionId: string;
  sessionName: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Hide the built-in trigger even when uncontrolled is not used — the
   *  parent supplies its own button that calls onOpenChange. */
  hideTrigger?: boolean;
}

export function CoOrganizerShareDialog({
  sessionId,
  sessionName,
  open,
  onOpenChange,
  hideTrigger,
}: CoOrganizerShareDialogProps) {
  const isControlled = open !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchSeq = useRef(0);
  const dialogOpen = isControlled ? open : uncontrolledOpen;

  const origin = useSyncExternalStore(
    subscribeToOrigin,
    getOriginSnapshot,
    getServerOriginSnapshot
  );
  const joinUrl = origin && path ? `${origin}${path}` : "";

  // Mint only when the dialog is actually open — hub cards must not stamp a
  // token on every organizer landing.
  const shouldLoad = dialogOpen === true;

  function handleOpenChange(next: boolean) {
    if (!next) {
      setPath("");
      setError(null);
    }
    if (isControlled) onOpenChange?.(next);
    else setUncontrolledOpen(next);
  }

  useEffect(() => {
    if (!shouldLoad) return;
    const seq = ++fetchSeq.current;
    void (async () => {
      try {
        const result = await getOrCreateCoOrganizerInvite(sessionId);
        if (seq !== fetchSeq.current) return;
        if (!result.success || !result.path) {
          setError(result.message);
          setPath("");
          return;
        }
        setError(null);
        setPath(result.path);
      } catch {
        if (seq !== fetchSeq.current) return;
        setError("Something went wrong. Please try again.");
        setPath("");
      }
    })();
  }, [shouldLoad, sessionId]);

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
    <Dialog open={dialogOpen} onOpenChange={handleOpenChange}>
      {!isControlled && !hideTrigger && (
        <DialogTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200
                       bg-violet-50 px-2.5 py-1.5 text-[11px] font-semibold text-violet-700
                       hover:bg-violet-100 transition-colors"
          >
            <KeyRound className="h-3.5 w-3.5" />
            Co-organizer QR
          </button>
        </DialogTrigger>
      )}

      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Co-organize &ldquo;{sessionName}&rdquo;</DialogTitle>
          <DialogDescription className="text-center text-xs text-muted-foreground leading-relaxed">
            Co-organizers scan this to run the board with you. This is not the player join QR.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-5 py-2">
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

          {error && (
            <p role="alert" className="text-center text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="w-full space-y-2">
            <div
              className="truncate rounded-lg border border-slate-200 bg-slate-50
                         px-3 py-2 text-xs font-mono text-slate-600"
              title={joinUrl}
            >
              {joinUrl || (error ? "Unavailable" : "Generating…")}
            </div>

            <button
              type="button"
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
