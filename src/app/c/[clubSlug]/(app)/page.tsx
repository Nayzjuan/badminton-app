// ============================================================
// Club lobby — /c/[clubSlug]
// ============================================================
// Lists the club's sessions (active first). Members tap a session to enter.
// Auth + membership are already enforced by the club layout.
// ============================================================

import Link from "next/link";
import { notFound } from "next/navigation";
import { History } from "lucide-react";
import { getClubBySlug, getClubSessions } from "@/lib/clubs";
import { clubPlay } from "@/lib/club-paths";

export default async function ClubLobbyPage({ params }: { params: Promise<{ clubSlug: string }> }) {
  const { clubSlug } = await params;
  const club = await getClubBySlug(clubSlug);
  if (!club) notFound();

  const sessions = await getClubSessions(club.id);
  const active = sessions.filter((s) => s.is_active);
  const past = sessions.filter((s) => !s.is_active);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-bold uppercase italic tracking-tight text-cc-t1">
          {club.name}
        </h1>
        <p className="mt-0.5 text-xs text-cc-t2">
          {active.length} active {active.length === 1 ? "session" : "sessions"}
        </p>
      </div>

      {sessions.length === 0 ? (
        <div className="clip-cut border border-dashed border-cc-border bg-cc-bg-2 px-6 py-12 text-center">
          <div className="clip-cut-sm mx-auto mb-3 flex h-10 w-10 items-center justify-center bg-cc-bg-3">
            <History className="h-5 w-5 text-cc-t3" aria-hidden="true" />
          </div>
          <p className="font-command text-sm font-medium uppercase tracking-wide text-cc-t1">
            No sessions yet
          </p>
          <p className="mt-1 text-xs text-cc-t3">A club admin can start one from the Admin tab.</p>
        </div>
      ) : (
        <div className="space-y-5">
          {active.length > 0 && (
            <section className="space-y-2">
              <h2 className="font-command text-[11px] font-bold uppercase tracking-widest text-cc-t2">
                Active
              </h2>
              <ul className="space-y-2">
                {active.map((s) => (
                  <li key={s.id}>
                    <Link
                      href={clubPlay(club.slug, s.id)}
                      className="clip-cut-sm flex items-center justify-between border border-cc-border bg-cc-bg-2 px-4 py-3 transition-colors hover:bg-cc-bg-3"
                    >
                      <span className="font-display font-bold uppercase italic tracking-tight text-cc-t1">
                        {s.name}
                      </span>
                      <span className="flex h-2 w-2 rounded-full bg-cc-live" aria-label="live" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {past.length > 0 && (
            <section className="space-y-2">
              <h2 className="font-command text-[11px] font-bold uppercase tracking-widest text-cc-t3">
                Past
              </h2>
              <ul className="space-y-2">
                {past.map((s) => (
                  <li
                    key={s.id}
                    className="clip-cut-sm flex items-center justify-between border border-cc-border bg-cc-bg-2/60 px-4 py-3"
                  >
                    <span className="font-display font-medium uppercase italic tracking-tight text-cc-t2">
                      {s.name}
                    </span>
                    <span className="clip-cut-badge bg-cc-bg-3 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cc-t3">
                      Ended
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
