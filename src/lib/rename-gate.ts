import "server-only";

// ============================================================
// Rename gate (L1) — server-only redirect guard
// ============================================================
// Routes a flagged-duplicate OR first-run-Google-confirm profile to
// /rename before it can view an authenticated screen. Pure redirect
// logic — NEVER mutates cookies, so it is safe to call during a
// Server Component render (unlike auth.signOut()).
//
// Fast path: a profile with neither flag returns immediately with ZERO
// extra queries (the caller already fetched the profile). Only the
// rare flagged / confirm-pending profile incurs more work.
//
// Two intentional carve-outs apply ONLY to needs_rename (duplicate
// mid-session). needs_name_confirm always redirects — a first-time
// Google user must keep-or-change their name before the queue/TV
// show it, even if they were somehow already queued.
//
//   • Grandfather — a duplicate currently in a live queue/match is
//     left alone; the gate fires at their next fresh login/lobby.
//   • Active organizer — never gate a duplicate organizer out of
//     their own live dashboard.
// ============================================================

import { redirect } from "next/navigation";
import { createServiceClient } from "@/utils/supabase/service";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { renameNextFromRequest } from "@/lib/request-path";
import type { Profile, QueueStatus } from "@/types/database";

const ACTIVE_QUEUE_STATUSES: QueueStatus[] = ["waiting", "drafted", "on_deck", "playing"];

export type RenameGateProfile = Pick<Profile, "id" | "needs_rename" | "needs_name_confirm">;

/**
 * If `profile` still needs a name decision, redirect to `/rename?next=`.
 * Confirm-pending always redirects. Duplicate flags honour the carve-outs.
 */
export async function enforceRenameGate(
  profile: RenameGateProfile,
  nextPath: string
): Promise<void> {
  if (!profile.needs_rename && !profile.needs_name_confirm) return;

  const dest = `/rename?next=${encodeURIComponent(nextPath)}`;

  // First-run Google confirm is not interruptible. Kept in its own branch
  // so a no-throw redirect mock (unit tests) cannot fall through into the
  // duplicate carve-out queries.
  if (profile.needs_name_confirm) {
    redirect(dest);
  } else {
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

    redirect(dest);
  }
}

/**
 * Layout / join helper: load the two flags for `userId` and gate.
 * Missing profile → no-op (the caller already has a recovery path).
 */
export async function enforceRenameGateForUser(userId: string, nextPath: string): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, needs_rename, needs_name_confirm")
    .eq("id", userId)
    .maybeSingle();
  if (!profile) return;
  await enforceRenameGate(profile, await renameNextFromRequest(nextPath));
}
