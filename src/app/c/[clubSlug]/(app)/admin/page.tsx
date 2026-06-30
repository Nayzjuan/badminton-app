// ============================================================
// Club admin — /c/[clubSlug]/admin
// ============================================================
// Owner/admin only. Member roster, invite-link generation, and
// club-scoped session creation. Non-admins are redirected to the lobby.
// ============================================================

import { notFound, redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { getClubBySlug, getClubRole, getClubMembers } from "@/lib/clubs";
import { ClubAdminPanel } from "@/components/clubs/club-admin-panel";

export default async function ClubAdminPage({ params }: { params: Promise<{ clubSlug: string }> }) {
  const { clubSlug } = await params;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const club = await getClubBySlug(clubSlug);
  if (!club) notFound();

  const role = await getClubRole(user.id, club.id);
  if (role !== "owner" && role !== "admin") redirect(`/c/${club.slug}`);

  const members = await getClubMembers(club.id);

  return (
    <ClubAdminPanel clubId={club.id} clubSlug={club.slug} clubName={club.name} members={members} />
  );
}
