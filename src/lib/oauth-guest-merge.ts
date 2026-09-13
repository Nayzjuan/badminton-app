import "server-only";

import { createServiceClient } from "@/utils/supabase/service";

/**
 * Move a guest anonymous profile's play history onto the Google keeper.
 * Does not overwrite the keeper's display_name. Deletes the guest profile
 * when the RPC succeeds and the guest is not an active organizer.
 */
export async function mergeGuestPlayIntoKeeper(
  guestId: string,
  keeperId: string
): Promise<{ success: boolean }> {
  if (guestId === keeperId) return { success: true };

  const svc = createServiceClient();
  const { data, error } = await svc.rpc("merge_guest_play_into_profile", {
    p_guest_id: guestId,
    p_keeper_id: keeperId,
  });

  if (error) {
    console.error("[mergeGuestPlayIntoKeeper] RPC error:", error.message);
    return { success: false };
  }
  if (!data?.success) {
    console.error("[mergeGuestPlayIntoKeeper] RPC refused:", data?.error);
    return { success: false };
  }

  const { error: delErr } = await svc.auth.admin.deleteUser(guestId);
  if (delErr) {
    console.warn("[mergeGuestPlayIntoKeeper] guest auth row left behind:", delErr.message);
  }

  return { success: true };
}
