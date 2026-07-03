// ============================================================
// ClubSwitcher — active club + dropdown to hop tenants
// ============================================================
// Server component (native <details> disclosure, no client JS). The
// clubSlug in the URL is the active tenant; this lets the user switch
// to any other club they belong to. (MULTI_TENANT_PLAN.md §3.4)
// ============================================================

import Link from "next/link";
import { ChevronDown, Check, Plus, LayoutGrid } from "lucide-react";
import type { ClubRole } from "@/types/database";

interface ClubSwitcherProps {
  activeSlug: string;
  clubs: Array<{ slug: string; name: string; role: ClubRole }>;
}

export function ClubSwitcher({ activeSlug, clubs }: ClubSwitcherProps) {
  const active = clubs.find((c) => c.slug === activeSlug);

  return (
    <details className="group relative">
      <summary className="clip-cut-sm flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 font-display font-bold uppercase italic tracking-tight text-cc-t1 transition-colors hover:bg-cc-bg-3 [&::-webkit-details-marker]:hidden">
        <span className="max-w-[44vw] truncate sm:max-w-xs">{active?.name ?? "Club"}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-cc-t3 transition-transform group-open:rotate-180" />
      </summary>

      <div className="clip-cut absolute left-0 top-full z-30 mt-1 w-64 overflow-hidden border border-cc-border bg-cc-bg-2 py-1">
        <ul className="max-h-72 overflow-y-auto">
          {clubs.map((c) => {
            const isActive = c.slug === activeSlug;
            return (
              <li key={c.slug}>
                <Link
                  href={`/c/${c.slug}`}
                  className="flex items-center justify-between gap-2 px-3 py-2 text-sm transition-colors hover:bg-cc-bg-3"
                >
                  <span className="min-w-0 truncate font-medium text-cc-t1">{c.name}</span>
                  {isActive && <Check className="h-4 w-4 shrink-0 text-cc-accent-text" />}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="mt-1 border-t border-cc-border pt-1">
          <Link
            href="/clubs"
            className="flex items-center gap-2 px-3 py-2 font-command text-sm uppercase tracking-wide text-cc-t2 transition-colors hover:bg-cc-bg-3"
          >
            <LayoutGrid className="h-4 w-4" aria-hidden="true" />
            All clubs
          </Link>
          <Link
            href="/clubs/new"
            className="flex items-center gap-2 px-3 py-2 font-command text-sm uppercase tracking-wide text-cc-t2 transition-colors hover:bg-cc-bg-3"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New club
          </Link>
        </div>
      </div>
    </details>
  );
}
