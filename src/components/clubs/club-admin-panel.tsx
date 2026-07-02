"use client";

// ============================================================
// ClubAdminPanel — member roster · invite links · new session
// ============================================================
// Owner/admin surface for a club. Creates club-scoped sessions (createSession
// with clubId), generates one-time invite links, and lists members.
// ============================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Copy, Check, Link2, Users, UserMinus } from "lucide-react";
import {
  createClubInvite,
  removeMember,
  restoreMember,
  changeMemberRole,
} from "@/app/actions/clubs";
import { createSession } from "@/app/actions/sessions";
import { clubOrganizer } from "@/lib/club-paths";
import type { ClubRole, ScoringFormat } from "@/types/database";

type AdminMember = {
  id: string;
  player_id: string;
  role: ClubRole;
  display_name: string;
  joined_at: string;
  is_active: boolean;
};

const ROLE_LABEL: Record<ClubRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** Client-side mirror of the server's permission hierarchy — a UI hint only, the actions re-check authoritatively. */
function canManage(viewerRole: ClubRole, targetRole: ClubRole): boolean {
  if (viewerRole === "owner") return true;
  if (viewerRole === "admin") return targetRole === "member";
  return false;
}

interface ClubAdminPanelProps {
  clubId: string;
  clubSlug: string;
  clubName: string;
  members: AdminMember[];
  viewerRole: ClubRole;
  viewerId: string;
}

export function ClubAdminPanel({
  clubId,
  clubSlug,
  clubName,
  members,
  viewerRole,
  viewerId,
}: ClubAdminPanelProps) {
  const router = useRouter();

  // ── New session ──
  const [sessionName, setSessionName] = useState("");
  const [scoring, setScoring] = useState<ScoringFormat>("single");
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [creatingSession, startSession] = useTransition();

  function handleCreateSession(e: React.FormEvent) {
    e.preventDefault();
    setSessionError(null);
    if (!sessionName.trim()) return;
    startSession(async () => {
      const result = await createSession({ name: sessionName.trim(), scoring, clubId });
      if (result.success && result.sessionId) {
        router.push(clubOrganizer(clubSlug, result.sessionId));
      } else {
        setSessionError(result.message);
      }
    });
  }

  // ── Invite ──
  const [inviteRole, setInviteRole] = useState<ClubRole>("member");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [creatingInvite, startInvite] = useTransition();

  function handleCreateInvite() {
    setInviteError(null);
    setInviteLink(null);
    setCopied(false);
    startInvite(async () => {
      const result = await createClubInvite({ clubId, role: inviteRole });
      if (result.success && result.token) {
        const origin = typeof window !== "undefined" ? window.location.origin : "";
        setInviteLink(`${origin}/clubs/join?invite=${result.token}`);
      } else {
        setInviteError(result.message);
      }
    });
  }

  async function copyInvite() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked — leave the link visible for manual copy
    }
  }

  // ── Members ──
  const [memberList, setMemberList] = useState<AdminMember[]>(members);
  function updateMember(id: string, patch: Partial<AdminMember>) {
    setMemberList((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }
  const activeMembers = memberList.filter((m) => m.is_active);
  const removedMembers = memberList.filter((m) => !m.is_active);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-foreground">
          {clubName} · Admin
        </h1>
        <p className="mt-0.5 font-mono text-[11px] text-slate-400 dark:text-muted-foreground">
          /c/{clubSlug}
        </p>
      </div>

      {/* New session */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-border dark:bg-card">
        <h2 className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground">
          Start a session
        </h2>
        <form onSubmit={handleCreateSession} className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              maxLength={60}
              placeholder="Friday Night Smash"
              className="flex-1 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-cc-accent focus:ring-2 focus:ring-cc-accent/30 dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground"
            />
            <select
              value={scoring}
              onChange={(e) => setScoring(e.target.value as ScoringFormat)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-cc-accent focus:ring-2 focus:ring-cc-accent/30 dark:border-border dark:bg-background dark:text-foreground"
            >
              <option value="single">Single game</option>
              <option value="best_of_3">Best of 3</option>
              <option value="best_of_5">Best of 5</option>
            </select>
          </div>
          {sessionError && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700 dark:bg-red-950/40 dark:text-red-400">
              {sessionError}
            </p>
          )}
          <button
            type="submit"
            disabled={creatingSession || !sessionName.trim()}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-cc-accent px-4 py-2.5 text-sm font-bold text-cc-btn-on-accent transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creatingSession && <Loader2 className="h-4 w-4 animate-spin" />}
            {creatingSession ? "Creating…" : "Create session"}
          </button>
        </form>
      </section>

      {/* Invite */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-border dark:bg-card">
        <h2 className="mb-3 flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground">
          <Link2 className="h-3.5 w-3.5" />
          Invite players
        </h2>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as ClubRole)}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-cc-accent focus:ring-2 focus:ring-cc-accent/30 dark:border-border dark:bg-background dark:text-foreground"
          >
            <option value="member">As member</option>
            <option value="admin">As admin</option>
          </select>
          <button
            type="button"
            onClick={handleCreateInvite}
            disabled={creatingInvite}
            aria-busy={creatingInvite}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-cc-accent/55 bg-cc-accent-dim px-4 py-2.5 text-sm font-bold text-cc-accent-text transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {creatingInvite && <Loader2 className="h-4 w-4 animate-spin" />}
            {creatingInvite ? "Generating…" : "Generate invite link"}
          </button>
        </div>

        {inviteError && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700 dark:bg-red-950/40 dark:text-red-400">
            {inviteError}
          </p>
        )}

        {inviteLink && (
          <div
            role="status"
            aria-live="polite"
            className="mt-3 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 dark:border-border dark:bg-muted/40"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600 dark:text-muted-foreground">
              {inviteLink}
            </span>
            <button
              type="button"
              onClick={copyInvite}
              aria-label="Copy invite link"
              className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-cc-accent-text transition-colors hover:bg-cc-accent/15"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
        <p className="mt-2 text-[11px] text-slate-400 dark:text-muted-foreground">
          One-time link — it stops working after someone joins with it.
        </p>
      </section>

      {/* Members */}
      <section>
        <h2 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground">
          <Users className="h-3.5 w-3.5" />
          Members ({activeMembers.length})
        </h2>
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card">
          {activeMembers.map((m) => (
            <MemberRow
              key={m.id}
              member={m}
              clubId={clubId}
              clubSlug={clubSlug}
              viewerRole={viewerRole}
              viewerId={viewerId}
              onUpdate={updateMember}
            />
          ))}
        </ul>
      </section>

      {/* Removed members — restore-only */}
      {removedMembers.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-widest text-slate-400 dark:text-muted-foreground">
            Removed ({removedMembers.length})
          </h2>
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/60 dark:divide-border dark:border-border dark:bg-muted/20">
            {removedMembers.map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                clubId={clubId}
                clubSlug={clubSlug}
                viewerRole={viewerRole}
                viewerId={viewerId}
                onUpdate={updateMember}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

interface MemberRowProps {
  member: AdminMember;
  clubId: string;
  clubSlug: string;
  viewerRole: ClubRole;
  viewerId: string;
  onUpdate: (id: string, patch: Partial<AdminMember>) => void;
}

function MemberRow({ member, clubId, clubSlug, viewerRole, viewerId, onUpdate }: MemberRowProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const isSelf = member.player_id === viewerId;
  const manageable = !isSelf && canManage(viewerRole, member.role);

  function handleRemove() {
    setError(null);
    startTransition(async () => {
      const result = await removeMember(clubId, member.id, clubSlug);
      if (result.success) {
        onUpdate(member.id, { is_active: false });
        setConfirming(false);
      } else {
        setError(result.message);
      }
    });
  }

  function handleRestore() {
    setError(null);
    startTransition(async () => {
      const result = await restoreMember(clubId, member.id, clubSlug);
      if (result.success) {
        onUpdate(member.id, { is_active: true });
      } else {
        setError(result.message);
      }
    });
  }

  function handleRoleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const newRole = e.target.value as ClubRole;
    setError(null);
    startTransition(async () => {
      const result = await changeMemberRole(clubId, member.id, newRole, clubSlug);
      if (result.success) {
        onUpdate(member.id, { role: newRole });
      } else {
        setError(result.message);
      }
    });
  }

  return (
    <li className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-slate-800 dark:text-foreground">
          {member.display_name}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {viewerRole === "owner" && !isSelf && member.is_active ? (
            <span className="inline-flex items-center gap-1.5">
              <select
                value={member.role}
                disabled={pending}
                onChange={handleRoleChange}
                aria-label={`Change ${member.display_name}'s role`}
                aria-describedby={error ? `member-${member.id}-error` : undefined}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-bold uppercase tracking-wider text-slate-500 outline-none focus:border-cc-accent disabled:opacity-50 dark:border-border dark:bg-background dark:text-muted-foreground"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                <option value="owner">Owner</option>
              </select>
              {pending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" aria-hidden="true" />
              )}
            </span>
          ) : (
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:bg-muted dark:text-muted-foreground">
              {ROLE_LABEL[member.role]}
            </span>
          )}

          {manageable && member.is_active && !confirming && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              aria-label={`Remove ${member.display_name}`}
              className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-muted-foreground dark:hover:bg-red-950/40 dark:hover:text-red-400"
            >
              <UserMinus className="h-3.5 w-3.5" />
            </button>
          )}

          {manageable && member.is_active && confirming && (
            <div className="flex items-center gap-1">
              <span className="text-[11px] font-medium text-slate-500 dark:text-muted-foreground">
                Remove?
              </span>
              <button
                type="button"
                onClick={handleRemove}
                disabled={pending}
                className="rounded-full bg-red-600 px-2 py-1 text-[11px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Yes"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={pending}
                className="rounded-full px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-100 disabled:opacity-50 dark:text-muted-foreground dark:hover:bg-muted"
              >
                No
              </button>
            </div>
          )}

          {manageable && !member.is_active && (
            <button
              type="button"
              onClick={handleRestore}
              disabled={pending}
              className="inline-flex items-center gap-1 rounded-full border border-cc-accent/55 bg-cc-accent-dim px-2.5 py-1 text-[11px] font-bold text-cc-accent-text transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {pending && <Loader2 className="h-3 w-3 animate-spin" />}
              Restore
            </button>
          )}
        </div>
      </div>
      {error && (
        <p
          id={`member-${member.id}-error`}
          role="alert"
          className="text-[11px] text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}
    </li>
  );
}
