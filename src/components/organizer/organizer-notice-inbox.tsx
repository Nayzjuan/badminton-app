"use client";

// ============================================================
// OrganizerNoticeInbox — header bell + session notice list
// ============================================================
// Informational rows drop the badge on dismiss / mark-read.
// Score corrections stay pending until someone saves Edit Match.

import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import type { SessionNotification } from "@/types/database";
import { isActionable, kindLabel, noticeBody, noticeTitle } from "@/lib/session-notifications";

interface OrganizerNoticeInboxProps {
  inbox: SessionNotification[];
  unreadCount: number;
  isClosed: boolean;
  onMarkRead: (id: string) => void;
  onReview: (row: SessionNotification) => void;
}

export function OrganizerNoticeInbox({
  inbox,
  unreadCount,
  isClosed,
  onMarkRead,
  onReview,
}: OrganizerNoticeInboxProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        data-testid="organizer-notice-bell"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={unreadCount > 0 ? `Session notices, ${unreadCount} unread` : "Session notices"}
        className="relative inline-flex h-11 w-11 items-center justify-center rounded-lg
                   text-cc-t2 hover:text-cc-t1 hover:bg-cc-bg-3 transition-colors"
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span
            data-testid="organizer-notice-badge"
            className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center
                       rounded-full bg-cc-accent px-1 font-command text-[9px] font-bold
                       text-cc-bg leading-none"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          data-testid="organizer-notice-inbox"
          className="absolute right-0 top-full z-50 mt-1.5 w-[min(22rem,calc(100vw-1.5rem))]
                     overflow-hidden rounded-xl border border-cc-border bg-cc-bg-2 shadow-xl
                     animate-in fade-in slide-in-from-top-1 duration-150"
        >
          <div className="border-b border-cc-border bg-cc-bg-3 px-3 py-2">
            <p className="font-command text-[9px] font-bold uppercase tracking-[0.22em] text-cc-t3">
              Session notices
            </p>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {inbox.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-cc-t3">No notices yet.</p>
            ) : (
              inbox.map((row) => {
                const pending = isActionable(row);
                const unread = row.status === "unread" || pending;
                return (
                  <div
                    key={row.id}
                    className={`border-b border-cc-border last:border-b-0 px-3 py-3 ${
                      unread ? "bg-cc-accent-dim/40" : ""
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-command text-[9px] font-bold uppercase tracking-[0.14em] text-cc-t3">
                          {kindLabel(row.kind)}
                          {row.status === "resolved"
                            ? " · handled"
                            : row.status === "superseded"
                              ? " · superseded"
                              : unread
                                ? " · new"
                                : ""}
                        </p>
                        <p className="mt-0.5 text-sm font-semibold text-cc-t1">
                          {noticeTitle(row)}
                        </p>
                        <p className="mt-0.5 text-xs leading-relaxed text-cc-t2">
                          {noticeBody(row)}
                        </p>
                      </div>
                      <time className="shrink-0 text-[10px] tabular-nums text-cc-t3">
                        {formatNoticeTime(row.created_at)}
                      </time>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      {pending && row.match_id && (
                        <button
                          type="button"
                          disabled={isClosed}
                          onClick={() => {
                            setOpen(false);
                            onReview(row);
                          }}
                          className="min-h-[44px] rounded-lg bg-cc-accent px-3 py-2 text-xs font-bold
                                     text-cc-bg hover:brightness-110 disabled:cursor-not-allowed
                                     disabled:opacity-50"
                        >
                          Review
                        </button>
                      )}
                      {row.kind !== "score_correction" && row.status === "unread" && (
                        <button
                          type="button"
                          onClick={() => onMarkRead(row.id)}
                          className="min-h-[44px] rounded-lg px-3 py-2 text-xs font-semibold
                                     text-cc-t2 hover:bg-cc-bg-3 hover:text-cc-t1"
                        >
                          Mark read
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatNoticeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
