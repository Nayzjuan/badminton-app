"use server";

// ============================================================
// Upcoming Match Server Action
// ============================================================
// Surfaces a player's OWN reserved spot in a held cross-court
// draft while they are still on court.
//
// Why a server action (not a client query):
//   A held draft is is_published=false until its source match
//   finishes, so the three-layer draft firewall (RLS + realtime
//   + client query filter) hides it from the player entirely.
//   This action uses the service-role client to look up only the
//   caller's own reservation — no roster, no other drafts — so the
//   firewall stays intact for everything else.
// ============================================================

import { createServiceClient } from "@/utils/supabase/service";
import { getAuthenticatedUser } from "@/app/actions/_shared";
import { isValidUUID } from "@/lib/validate";

export type UpcomingHeldDraft = {
  /** The player is the pulled body of a pending held draft. */
  reserved: boolean;
  /**
   * The held draft's source match has freed and it is ready to be
   * promoted to a court next. Drives the "up right after this" wording.
   */
  ready: boolean;
};

export type UpcomingHeldDraftResult =
  | { success: true; upcoming: UpcomingHeldDraft }
  | { success: false; error: string };

/**
 * Returns whether the authenticated caller is reserved as the still-playing
 * "pulled body" of a pending held cross-court draft in this session.
 *
 * Scoped to the caller's own id only — never reveals other players'
 * draft assignments or the held draft's roster. Returns reserved=false
 * (not an error) when there is no held draft for this player.
 */
export async function getUpcomingHeldDraft(sessionId: string): Promise<UpcomingHeldDraftResult> {
  if (!isValidUUID(sessionId)) return { success: false, error: "Invalid session ID." };

  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Not authenticated." };

  const svc = createServiceClient();

  // A held draft this player is reserved in: pending, is_held, and the
  // caller's id sits in pulled_player_ids (the still-playing reserved bodies).
  const { data, error } = await svc
    .from("matches")
    .select("id, held_ready_at")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .eq("is_held", true)
    .contains("pulled_player_ids", [user.id])
    .limit(1);

  if (error) return { success: false, error: "Failed to check upcoming match." };

  const held = data?.[0] ?? null;

  return {
    success: true,
    upcoming: {
      reserved: held !== null,
      ready: held?.held_ready_at != null,
    },
  };
}
