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
//   • if the derived name is unique → assign it + clear the flag,
//   • if it collides → record collided_name and leave the flag so the
//     existing /rename gate forces a unique pick.
//
// Idempotent + no-op for already-resolved profiles (returning Google
// users, or anonymous users who LINKED Google — those keep their name).
// ============================================================

import { createServiceClient } from "@/utils/supabase/service";
import { deriveDisplayName, type OAuthMeta } from "@/lib/oauth-name";
import { isNameTaken } from "@/lib/dup-name";
import { generatePin } from "@/lib/pin";

export interface OAuthProvisionResult {
  /** true when the profile still needs the /rename gate (name collided). */
  requiresRename: boolean;
  /** the display_name assigned (only when uniquely resolved). */
  assignedName?: string;
}

export async function ensureOAuthProfile(
  userId: string,
  meta: OAuthMeta
): Promise<OAuthProvisionResult> {
  const svc = createServiceClient();

  const { data: profile } = await svc
    .from("profiles")
    .select("needs_rename, collided_name, pin")
    .eq("id", userId)
    .maybeSingle();

  // Trigger always creates the row; if it's missing, nothing safe to do here.
  if (!profile) return { requiresRename: false };

  // Only an UNRESOLVED OAuth stub has (needs_rename=true AND collided_name=null).
  // Anonymous duplicate-flags always carry a collided_name; resolved/linked
  // profiles have needs_rename=false. Either way → leave their name untouched.
  const isUnresolvedStub = profile.needs_rename === true && profile.collided_name === null;
  if (!isUnresolvedStub) {
    return { requiresRename: profile.needs_rename === true };
  }

  const derived = deriveDisplayName(meta);
  const pin = profile.pin ?? generatePin(); // never overwrite an existing PIN

  if (await isNameTaken(svc, derived, userId)) {
    // Collision — hand off to the /rename gate. Record the colliding name so the
    // screen prefills the stem and R1 forbids reusing it; ensure a PIN exists.
    await svc.from("profiles").update({ collided_name: derived, pin }).eq("id", userId);
    return { requiresRename: true };
  }

  // Unique — assign silently, clear the flag, ensure a PIN.
  const { error: assignError } = await svc
    .from("profiles")
    .update({ display_name: derived, needs_rename: false, collided_name: null, pin })
    .eq("id", userId);

  if (assignError) {
    // TOCTOU: another first-time sign-in claimed this name between isNameTaken
    // and this write (the partial unique index raised 23505). Fall back to the
    // collision path so the /rename gate resolves it with a proper prefill + R1.
    await svc.from("profiles").update({ collided_name: derived, pin }).eq("id", userId);
    return { requiresRename: true };
  }

  return { requiresRename: false, assignedName: derived };
}
