import "server-only";

// ============================================================
// Anon-safe lookup for public join routes
// ============================================================
// Wraps `lookup_active_session` in React `cache` so generateMetadata
// and the page share one RPC. Empty / inactive / club-less → not ok;
// callers redirect to /play rather than 404 (same as the legacy shim).
// ============================================================

import { cache } from "react";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { isValidUUID } from "@/lib/validate";

export type SessionJoinLookup =
  | { ok: true; sessionId: string; name: string; clubSlug: string }
  | { ok: false };

export const lookupActiveJoinSession = cache(
  async (sessionId: string): Promise<SessionJoinLookup> => {
    if (!isValidUUID(sessionId)) return { ok: false };

    const supabase = await createServerSupabaseClient();
    const { data: lookup } = await supabase.rpc("lookup_active_session", {
      p_session_id: sessionId,
    });
    const session = lookup?.[0] ?? null;
    if (!session || !session.is_active || !session.club_slug) {
      return { ok: false };
    }
    return {
      ok: true,
      sessionId: session.id,
      name: session.name,
      clubSlug: session.club_slug,
    };
  }
);
