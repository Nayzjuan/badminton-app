// ============================================================
// Club full-screen layout — /c/[clubSlug]/(full)/*
// ============================================================
// Member-gated, but renders NO club chrome — the player & organizer
// dashboards are full-screen apps with their own headers. We only enforce
// auth + club + membership here, then hand the whole viewport to the child.
// ============================================================

import { requireClubMembership } from "@/lib/clubs";

export default async function ClubFullLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  await requireClubMembership(clubSlug); // auth + 404 + member gate
  return <>{children}</>;
}
