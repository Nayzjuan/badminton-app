import "server-only";

// ============================================================
// Rename gate (L1) — server-only redirect guard
// ============================================================
// Routes a flagged-duplicate profile to /rename before it can view
// an authenticated screen under the duplicated name. Pure redirect
// logic — NEVER mutates cookies, so it is safe to call during a
// Server Component render (unlike auth.signOut()).
//
// Fast path: a non-flagged profile returns immediately with ZERO
// extra queries (the caller already fetched the profile). Only the
// rare flagged profile incurs the grandfather / organizer lookups.
//
// Two intentional carve-outs (the gate DEFERS, it never interrupts):
//   • Grandfather — a player currently in a live queue/match is left
//     alone; the gate fires at their next fresh login/lobby instead.
//   • Active organizer — never gate an organizer out of their own
//     live dashboard (belt-and-suspenders; no current organizer is
//     a flagged duplicate, but this makes it structurally impossible).
// ============================================================

import { redirect } from "next/navigation";
import { createServiceClient } from "@/utils/supabase/service";
import type { Profile, QueueStatus } from "@/types/database";

const ACTIVE_QUEUE_STATUSES: QueueStatus[] = ["waiting", "drafted", "on_deck", "playing"];

/**
 * If `profile` is a flagged duplicate (and not grandfathered / an active
 * organizer), redirect to `/rename?next=<nextPath>`. Otherwise return.
 */
export async function enforceRenameGate(profile: Profile, nextPath: string): Promise<void> {
  if (!profile.needs_rename) return; // fast path — no DB round-trips for clean profiles

  const svc = createServiceClient();

  // Grandfather: don't yank a player who is currently in a live session.
  const { data: activeEntry } = await svc
    .from("queue_entries")
    .select("id")
    .eq("player_id", profile.id)
    .in("status", ACTIVE_QUEUE_STATUSES)
    .limit(1)
    .maybeSingle();
  if (activeEntry) return;

  // Never gate an active organizer out of their own dashboard.
  const { data: orgSession } = await svc
    .from("sessions")
    .select("id")
    .eq("created_by", profile.id)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (orgSession) return;

  redirect(`/rename?next=${encodeURIComponent(nextPath)}`);
}
