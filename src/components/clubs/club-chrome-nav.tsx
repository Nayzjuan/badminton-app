"use client";

// ============================================================
// ClubChromeNav — role-aware nav for the club chrome header
// ============================================================
// Client component so it can read the current route via usePathname
// and mark the active nav link. All data (slug, isAdmin) is fetched
// server-side in the club layout and passed down as plain props —
// this component holds no data-fetch logic, only the active-state.
// ============================================================

import Link from "next/link";
import { usePathname } from "next/navigation";
import { clubBase, clubAdmin, clubLeaderboard } from "@/lib/club-paths";

interface ClubChromeNavProps {
  slug: string;
  isAdmin: boolean;
}

export function ClubChromeNav({ slug, isAdmin }: ClubChromeNavProps) {
  const pathname = usePathname();

  const base = clubBase(slug);
  const leaderboard = clubLeaderboard(slug);
  const admin = clubAdmin(slug);

  // Lobby is the club root (/c/[slug]) so it must match EXACTLY — a prefix
  // match would light it up on every sub-route. Sub-routes match by prefix
  // so nested pages (e.g. /leaderboard/[sessionId]) keep the tab active.
  const isActive = (href: string) =>
    href === base ? pathname === base : pathname === href || pathname.startsWith(`${href}/`);

  const linkClass = (href: string) =>
    [
      "clip-cut-sm px-3 py-1.5 font-command uppercase tracking-wide transition-colors",
      isActive(href)
        ? "border-b-2 border-cc-accent bg-cc-accent-dim text-cc-accent-text"
        : "text-cc-t2 hover:bg-cc-bg-3 hover:text-cc-t1",
    ].join(" ");

  return (
    <nav className="flex items-center gap-1 text-xs font-semibold">
      <Link
        href={base}
        aria-current={isActive(base) ? "page" : undefined}
        className={linkClass(base)}
      >
        Lobby
      </Link>
      <Link
        href={leaderboard}
        aria-current={isActive(leaderboard) ? "page" : undefined}
        className={linkClass(leaderboard)}
      >
        Leaderboard
      </Link>
      {isAdmin && (
        <Link
          href={admin}
          aria-current={isActive(admin) ? "page" : undefined}
          className={linkClass(admin)}
        >
          Admin
        </Link>
      )}
    </nav>
  );
}
