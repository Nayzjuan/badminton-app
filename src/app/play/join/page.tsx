// ============================================================
// Legacy QR shim — /play/join?session=<id> → /c/[clubSlug]/join?session=<id>
// ============================================================
// Already-printed QR codes point at /play/join. This resolves the session's
// club (via the anon-safe SECURITY DEFINER RPC, which now returns club_slug)
// and forwards to the club-namespaced join page, which owns enrollment +
// routing. Keep this shim permanently so old codes never break.
// ============================================================

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { clubJoin } from "@/lib/club-paths";

interface JoinShimProps {
  searchParams: Promise<{ session?: string }>;
}

export default async function JoinShim({ searchParams }: JoinShimProps) {
  const { session: sessionId } = await searchParams;
  if (!sessionId) redirect("/clubs");

  const supabase = await createServerSupabaseClient();
  const { data: lookup } = await supabase.rpc("lookup_active_session", { p_session_id: sessionId });
  const session = lookup?.[0] ?? null;

  // Bad / inactive / club-less session → the multi-club home.
  if (!session || !session.is_active || !session.club_slug) {
    redirect("/clubs");
  }

  redirect(clubJoin(session.club_slug, sessionId));
}
