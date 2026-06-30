// ============================================================
// Club root layout — /c/[clubSlug]
// ============================================================
// Minimal: resolves the slug → club and 404s on an unknown slug. No auth,
// no membership gate, no chrome here — those live in the (app) route group
// so PUBLIC club routes (tv, join) can sit OUTSIDE the membership gate while
// still getting a fast shared 404 for bad slugs.
// ============================================================

import { notFound } from "next/navigation";
import { getClubBySlug } from "@/lib/clubs";

export default async function ClubRootLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  const club = await getClubBySlug(clubSlug);
  if (!club) notFound();
  return <>{children}</>;
}
