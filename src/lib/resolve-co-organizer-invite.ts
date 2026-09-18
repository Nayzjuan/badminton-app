import "server-only";

import { createServiceClient } from "@/utils/supabase/service";
import { isCoOrganizerInviteTokenShape } from "@/lib/co-organizer-invite";

export type CoOrganizerInviteLookup =
  | {
      ok: true;
      sessionId: string;
      name: string;
      clubSlug: string;
      clubName: string;
    }
  | { ok: false };

/**
 * Public preview for /o/[token]: session name + club, or a miss.
 * Service role (token column is revoked from anon/authenticated).
 * Closed, close-in-flight, hidden, malformed tokens, and lookup errors
 * all miss — same generic page, no oracle.
 */
export async function lookupCoOrganizerInvite(token: string): Promise<CoOrganizerInviteLookup> {
  if (!isCoOrganizerInviteTokenShape(token)) return { ok: false };

  const db = createServiceClient();
  const { data, error } = await db
    .from("sessions")
    .select("id, name, is_active, ended_at, is_hidden, clubs(slug, name)")
    .eq("co_organizer_invite_token", token)
    .maybeSingle();
  if (error) return { ok: false };
  if (!data) return { ok: false };
  if (!data.is_active || data.ended_at || data.is_hidden) return { ok: false };

  const club = data.clubs as unknown as { slug: string; name: string } | null;
  if (!club?.slug) return { ok: false };

  return {
    ok: true,
    sessionId: data.id,
    name: data.name,
    clubSlug: club.slug,
    clubName: club.name,
  };
}
