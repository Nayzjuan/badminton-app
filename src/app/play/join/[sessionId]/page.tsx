// ============================================================
// Legacy path alias — /play/join/[sessionId] → /j/[sessionId]
// ============================================================
// Some in-app browsers rewrite `?session=` into a path under the original
// /play/join prefix. Keep that resolving.
// ============================================================

import { permanentRedirect } from "next/navigation";
import { sessionShare } from "@/lib/club-paths";

export default async function PlayJoinAlias({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  permanentRedirect(sessionShare(sessionId));
}
