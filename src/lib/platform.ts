import "server-only";

// ============================================================
// Platform-owner gate
// ============================================================
// The "platform owner" is the account allowed to create + manage *clubs* (the
// multi-club layer): reaching /clubs, /clubs/new, and calling createClub.
// Everyone else is scoped to the club(s) they belong to and never sees the
// cross-club hub.
//
// Sourced from the PLATFORM_OWNER_IDS env var (comma-separated auth user-ids),
// server-only (never NEXT_PUBLIC). A baked-in fallback keeps the gate enforced
// even in an environment where the env var hasn't been set yet — so this can
// never silently fail *open*. Add/replace owners by setting PLATFORM_OWNER_IDS
// (a 1-line config change + redeploy).
// ============================================================

// miggy.0107@gmail.com — the founding platform owner.
const FALLBACK_PLATFORM_OWNER_IDS = ["86222a8f-3193-435c-bc04-2ad7aa867854"];

function platformOwnerIds(): string[] {
  const raw = process.env.PLATFORM_OWNER_IDS?.trim();
  if (!raw) return FALLBACK_PLATFORM_OWNER_IDS;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : FALLBACK_PLATFORM_OWNER_IDS;
}

/** True only for the platform owner(s) — the accounts that may create/manage clubs. */
export function isPlatformOwner(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return platformOwnerIds().includes(userId);
}
