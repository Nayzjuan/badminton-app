// ============================================================
// Legacy QR shim — /play/join?session=<id> → /j/<id>
// ============================================================
// Already-printed QR codes point at /play/join. next.config 308s a well-formed
// ?session= UUID to /j/<id>. This page keeps the no-query / bad-id cases
// working and is the fallback if the config redirect is skipped.
// ============================================================

import { redirect, permanentRedirect } from "next/navigation";
import { sessionShare } from "@/lib/club-paths";
import { isValidUUID } from "@/lib/validate";

interface JoinShimProps {
  searchParams: Promise<{ session?: string }>;
}

export default async function JoinShim({ searchParams }: JoinShimProps) {
  const { session: sessionId } = await searchParams;
  if (sessionId && isValidUUID(sessionId)) {
    permanentRedirect(sessionShare(sessionId));
  }
  redirect("/play");
}
