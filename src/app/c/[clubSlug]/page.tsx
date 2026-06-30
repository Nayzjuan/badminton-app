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
        <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-foreground">
          {club.name}
        </h1>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-muted-foreground">
          {active.length} active {active.length === 1 ? "session" : "sessions"}
        </p>
      </div>

      {sessions.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center dark:border-border dark:bg-card">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 dark:bg-muted">
            <History className="h-5 w-5 text-slate-400 dark:text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-slate-600 dark:text-foreground">No sessions yet</p>
          <p className="mt-1 text-xs text-slate-400 dark:text-muted-foreground">
            A club admin can start one from the Admin tab.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {active.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-[11px] font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground">
                Active
              </h2>
              <ul className="space-y-2">
                {active.map((s) => (
                  <li key={s.id}>
                    <Link
                      href={`/play/${s.id}`}
                      className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm transition-colors hover:bg-slate-50 dark:border-border dark:bg-card dark:hover:bg-muted/40"
                    >
                      <span className="font-semibold text-slate-800 dark:text-foreground">
                        {s.name}
                      </span>
                      <span
                        className="flex h-2 w-2 rounded-full bg-emerald-500"
                        aria-label="live"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {past.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-[11px] font-bold uppercase tracking-widest text-slate-400 dark:text-muted-foreground">
                Past
              </h2>
              <ul className="space-y-2">
                {past.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between rounded-xl border border-slate-200 bg-white/60 px-4 py-3 dark:border-border dark:bg-card/60"
                  >
                    <span className="font-medium text-slate-500 dark:text-muted-foreground">
                      {s.name}
                    </span>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-muted-foreground">
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
