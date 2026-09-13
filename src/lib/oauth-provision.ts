import "server-only";

// ============================================================
// OAuth profile provisioning (server-only)
// ============================================================
// Runs in /auth/callback for a NEW Google sign-in (intent != "link").
// The handle_new_user trigger has already created an UNRESOLVED stub
// (needs_rename=true, collided_name=null). This finalises it:
//   • derive a display_name from Google metadata,
//   • ensure a reconnect PIN exists (so OAuth accounts keep the
//     name+PIN recovery fallback — no lockout),
//   • if the derived name is unique → assign it, claim the unique
//     index (needs_rename=false), and set needs_name_confirm so
//     /rename asks them to keep or change it,
//   • if it collides → record collided_name and leave needs_rename
//     so the existing /rename force-mode forbids reusing it.
//
// Idempotent + no-op for already-resolved profiles (returning Google
// users, or anonymous users who LINKED Google — those keep their name).
// A confirm-pending row (needs_name_confirm=true, needs_rename=false)
// is NOT a stub — zero writes, still requiresRename.
// ============================================================

import { createServiceClient } from "@/utils/supabase/service";
import { deriveDisplayName, type OAuthMeta } from "@/lib/oauth-name";
import { isNameTaken } from "@/lib/dup-name";
import { generatePin } from "@/lib/pin";

export interface OAuthProvisionResult {
  /** true when the profile still needs the /rename gate (confirm or collision). */
  requiresRename: boolean;
  /** the display_name assigned (only when uniquely resolved this call). */
  assignedName?: string;
}

/** Destination after a fresh (non-link) Google callback. */
export function oauthPostLoginPath(next: string, requiresRename: boolean): string {
  return requiresRename ? `/rename?next=${encodeURIComponent(next)}` : next;
}

export async function ensureOAuthProfile(
  userId: string,
  meta: OAuthMeta
): Promise<OAuthProvisionResult> {
  const svc = createServiceClient();

  const { data: profile } = await svc
    .from("profiles")
    .select("needs_rename, collided_name, needs_name_confirm, pin")
    .eq("id", userId)
    .maybeSingle();

  // Trigger always creates the row; if it's missing, nothing safe to do here.
  if (!profile) return { requiresRename: false };

  // Only an UNRESOLVED OAuth stub has (needs_rename=true AND collided_name=null).
  // Confirm-pending rows have needs_rename=false. Duplicate-flags carry a
  // collided_name. Linked / historical Google have both flags false.
  const isUnresolvedStub = profile.needs_rename === true && profile.collided_name === null;
  if (!isUnresolvedStub) {
    return {
      requiresRename: profile.needs_rename === true || profile.needs_name_confirm === true,
    };
  }

  const derived = deriveDisplayName(meta);
  const pin = profile.pin ?? generatePin(); // never overwrite an existing PIN

  if (await isNameTaken(svc, derived, userId)) {
    // Collision — hand off to the /rename force gate. Record the colliding
    // name so the screen prefills the stem and R1 forbids reusing it.
    await svc.from("profiles").update({ collided_name: derived, pin }).eq("id", userId);
    return { requiresRename: true };
  }

  // Unique — claim the name (enter the unique index) and leave the confirm
  // gate up. Do NOT clear into the app: the player must keep or change it.
  const { error: assignError } = await svc
    .from("profiles")
    .update({
      display_name: derived,
      needs_rename: false,
      collided_name: null,
      needs_name_confirm: true,
      pin,
    })
    .eq("id", userId);

  if (assignError) {
    // TOCTOU: another first-time sign-in claimed this name between isNameTaken
    // and this write (the partial unique index raised 23505). Fall back to the
    // collision path so the /rename gate resolves it with a proper prefill + R1.
    await svc.from("profiles").update({ collided_name: derived, pin }).eq("id", userId);
    return { requiresRename: true };
  }

  return { requiresRename: true, assignedName: derived };
}
