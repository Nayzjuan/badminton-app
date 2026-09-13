// ============================================================
// Rename-screen admission + sync validation (pure)
// ============================================================
// Shared by /rename (server) and RenameScreen (client) so the
// keep-same / bounce / force-vs-confirm rules have one body.
// ============================================================

import { displayNameSchema } from "@/lib/schemas/auth";
import { normalizeName } from "@/lib/normalize-name";

export type RenameScreenMode = "force" | "confirm";

export type RenamePageDecision =
  | { action: "bounce" }
  | { action: "force"; currentName: string }
  | { action: "confirm"; currentName: string };

/**
 * Who /rename admits, and which name the screen prefills.
 * Force wins if both flags are set (R1 must still apply).
 * Confirm never prefills collided_name — that would forbid keeping it.
 */
export function renamePageDecision(profile: {
  needs_rename: boolean;
  needs_name_confirm: boolean;
  collided_name: string | null;
  display_name: string;
}): RenamePageDecision {
  if (profile.needs_rename) {
    return { action: "force", currentName: profile.collided_name ?? profile.display_name };
  }
  if (profile.needs_name_confirm) {
    return { action: "confirm", currentName: profile.display_name };
  }
  return { action: "bounce" };
}

export type RenameSyncCheck = { phase: "invalid" | "reused"; message: string } | "async";

/**
 * Sync rungs of the rename ladder. Confirm mode does not apply R1 against
 * the current (already-claimed) name — keeping it is valid.
 */
export function evaluateRenameSync(
  raw: string,
  opts: { mode: RenameScreenMode; currentName: string }
): RenameSyncCheck {
  const parsed = displayNameSchema.safeParse(raw);
  if (!parsed.success) {
    return { phase: "invalid", message: parsed.error.issues[0].message };
  }
  if (opts.mode === "force" && normalizeName(parsed.data) === normalizeName(opts.currentName)) {
    return {
      phase: "reused",
      message: `That's the name we need to change. Add an initial or number — e.g. "${opts.currentName} L".`,
    };
  }
  return "async";
}
