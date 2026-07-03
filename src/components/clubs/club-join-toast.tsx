"use client";

// ============================================================
// ClubJoinToast — one-time "Welcome to <club>" after a QR club-join
// ============================================================
// The /c/[clubSlug]/join route appends ?joined=1 to its redirect ONLY when the
// scan actually created or reactivated the caller's membership (see
// ensureClubMembership -> { joined }). This reads that flag once, fires a
// toast, and strips the param so a reload / back-nav / shared link never
// re-announces it.
// ============================================================

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

export function ClubJoinToast({ clubName }: { clubName: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const firedRef = useRef(false);

  useEffect(() => {
    // Guard against React 18 double-invoke / re-renders firing it twice.
    if (firedRef.current) return;
    if (params.get("joined") !== "1") return;
    firedRef.current = true;

    toast.success(`Welcome to ${clubName}`, {
      description: "You've joined this club — its sessions are now yours to see.",
      classNames: {
        toast:
          "clip-cut border border-cc-border bg-cc-bg-2 text-cc-t1 [&>[data-icon]]:text-cc-accent-text",
        title: "font-display text-base font-bold uppercase italic tracking-tight text-cc-t1",
        description: "mt-0.5 text-xs text-cc-t2",
        closeButton: "clip-cut-sm border-cc-border bg-cc-bg-3 text-cc-t2 hover:text-cc-t1",
      },
    });

    // Strip ?joined=1 (preserve any other params) so it announces exactly once.
    const next = new URLSearchParams(params);
    next.delete("joined");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [params, pathname, router, clubName]);

  return null;
}
