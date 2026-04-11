"use client";

// ============================================================
// Organizer Entry — Create session or join via passcode
// ============================================================

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import type { Profile, Session, ScoringFormat } from "@/types/database";

interface OrganizerEntryProps {
  profile: Profile;
  organizedSessions: Session[];
}

export function OrganizerEntry({ profile, organizedSessions }: OrganizerEntryProps) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  // Create session state
  const [sessionName, setSessionName] = useState("");
  const [scoring, setScoring] = useState<ScoringFormat>("single");
  const [passcode, setPasscode] = useState("");
  const [creating, setCreating] = useState(false);

  // Join via passcode state
  const [joinSessionId, setJoinSessionId] = useState("");
  const [joinPasscode, setJoinPasscode] = useState("");
  const [joining, setJoining] = useState(false);

  const [error, setError] = useState<string | null>(null);

  async function handleCreateSession() {
    if (!sessionName.trim()) return;
    setCreating(true);
    setError(null);

    const { data: session, error: err } = await supabase
      .from("sessions")
      .insert({
        name: sessionName.trim(),
        created_by: profile.id,
        scoring,
        organizer_passcode: passcode || null,
      })
      .select()
      .single();

    if (err) {
      setError(err.message);
      setCreating(false);
      return;
    }

    // The trigger auto-adds creator to session_organizers.
    router.push(`/organizer/${session.id}`);
  }

  async function handleJoinAsOrganizer() {
    if (!joinSessionId.trim() || !joinPasscode.trim()) return;
    setJoining(true);
    setError(null);

    const { data: result, error: err } = await supabase.rpc("elevate_to_organizer", {
      p_session_id: joinSessionId.trim(),
      p_passcode: joinPasscode.trim(),
    });

    if (err) {
      setError(err.message);
      setJoining(false);
      return;
    }

    if (!result) {
      setError("Invalid passcode. Please check and try again.");
      setJoining(false);
      return;
    }

    router.push(`/organizer/${joinSessionId.trim()}`);
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-6 py-12 space-y-10">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold">Organizer Panel</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Welcome, {profile.display_name}
          </p>
        </div>

        {/* Existing Sessions */}
        {organizedSessions.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Your Active Sessions
            </h2>
            {organizedSessions.map((s) => (
              <button
                key={s.id}
                onClick={() => router.push(`/organizer/${s.id}`)}
                className="w-full rounded-xl border border-border bg-card p-4 text-left
                           hover:bg-accent transition-colors"
              >
                <p className="font-semibold">{s.name}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Scoring: {s.scoring === "single" ? "Single game" : s.scoring.replace(/_/g, " ")}
                </p>
              </button>
            ))}
          </section>
        )}

        {/* Create New Session */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Create New Session
          </h2>
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Session Name</label>
              <input
                type="text"
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                placeholder="e.g. Saturday Open Play"
                className="w-full rounded-lg border border-input bg-background px-4 py-2.5 text-sm
                           placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Scoring Format</label>
                <select
                  value={scoring}
                  onChange={(e) => setScoring(e.target.value as ScoringFormat)}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm
                             focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="single">Single Game</option>
                  <option value="best_of_3">Best of 3</option>
                  <option value="best_of_5">Best of 5</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Organizer Passcode</label>
                <input
                  type="text"
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  placeholder="Optional"
                  className="w-full rounded-lg border border-input bg-background px-4 py-2.5 text-sm
                             placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>

            <button
              onClick={handleCreateSession}
              disabled={creating || !sessionName.trim()}
              className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium
                         text-primary-foreground hover:bg-primary/90 disabled:opacity-50
                         disabled:cursor-not-allowed transition-colors"
            >
              {creating ? "Creating..." : "Create Session"}
            </button>
          </div>
        </section>

        {/* Join Existing Session via Passcode */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Join as Co-Organizer
          </h2>
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Session ID</label>
              <input
                type="text"
                value={joinSessionId}
                onChange={(e) => setJoinSessionId(e.target.value)}
                placeholder="Paste the session ID"
                className="w-full rounded-lg border border-input bg-background px-4 py-2.5 text-sm
                           placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Passcode</label>
              <input
                type="text"
                value={joinPasscode}
                onChange={(e) => setJoinPasscode(e.target.value)}
                placeholder="Enter the organizer passcode"
                className="w-full rounded-lg border border-input bg-background px-4 py-2.5 text-sm
                           placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <button
              onClick={handleJoinAsOrganizer}
              disabled={joining || !joinSessionId.trim() || !joinPasscode.trim()}
              className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium
                         text-primary-foreground hover:bg-primary/90 disabled:opacity-50
                         disabled:cursor-not-allowed transition-colors"
            >
              {joining ? "Joining..." : "Join as Organizer"}
            </button>
          </div>
        </section>

        {/* Errors */}
        {error && (
          <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-4 py-3">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
