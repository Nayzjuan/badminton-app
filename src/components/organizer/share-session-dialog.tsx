"use client";

// ============================================================
// ShareSessionDialog — QR code + copy link for organizer
// ============================================================
// Generates a /play/join?session=[id] URL for players to scan
// and join the session without needing to navigate manually.
// ============================================================

import { useState, useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Share2, Copy, Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface ShareSessionDialogProps {
  sessionId: string;
  sessionName: string;
}

export function ShareSessionDialog({ sessionId, sessionName }: ShareSessionDialogProps) {
  const [joinUrl, setJoinUrl] = useState("");
  const [copied, setCopied] = useState(false);

  // Build URL client-side so window.location.origin is available.
  useEffect(() => {
    setJoinUrl(`${window.location.origin}/play/join?session=${sessionId}`);
  }, [sessionId]);

  async function handleCopy() {
    if (!joinUrl) return;
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for browsers without clipboard API.
      const input = document.createElement("input");
      input.value = joinUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200
                     bg-white px-3 py-1.5 text-xs font-semibold text-blue-600
                     hover:bg-blue-50 hover:border-blue-300 transition-colors"
        >
          <Share2 className="h-3.5 w-3.5" />
          Share Session
        </button>
      </DialogTrigger>

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
            Players scan this QR code to jump straight to the registration page
            for this session.
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
