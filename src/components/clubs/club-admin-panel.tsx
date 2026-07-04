"use client";

// ============================================================
// ClubAdminPanel — member roster · invite links · new session
// ============================================================
// Owner/admin surface for a club. Creates club-scoped sessions (createSession
// with clubId), generates one-time invite links, and lists members.
// ============================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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

/** Role → brand color classes for the role badge / select (UI-only styling). */
const ROLE_BADGE_CLASS: Record<ClubRole, string> = {
  owner: "bg-command/12 text-command border border-command/40",
  admin: "bg-cc-blue-dim text-cc-blue border border-cc-blue/40",
  member: "bg-cc-bg-3 text-cc-t2 border border-cc-border",
};

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
        <h1 className="font-display text-xl font-bold uppercase italic tracking-tight text-cc-t1">
          {clubName} · Admin
        </h1>
        <p className="mt-0.5 font-mono text-[11px] text-cc-t3">/c/{clubSlug}</p>
      </div>

      {/* New session */}
      <section className="clip-cut border border-cc-border bg-cc-bg-2 p-5">
        <h2 className="mb-3 font-command text-xs font-bold uppercase tracking-wide text-cc-t2">
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
              className="clip-cut-sm flex-1 border border-cc-border bg-cc-bg-3 px-3.5 py-2.5 text-sm text-cc-t1 outline-none transition-colors placeholder:text-cc-t3 focus:border-cc-accent focus:ring-2 focus:ring-cc-accent/30"
            />
            <select
              value={scoring}
              onChange={(e) => setScoring(e.target.value as ScoringFormat)}
              className="clip-cut-sm border border-cc-border bg-cc-bg-3 px-3 py-2.5 text-sm text-cc-t1 outline-none focus:border-cc-accent focus:ring-2 focus:ring-cc-accent/30"
            >
              <option value="single">Single game</option>
              <option value="best_of_3">Best of 3</option>
              <option value="best_of_5">Best of 5</option>
            </select>
          </div>
          {sessionError && (
            <p className="clip-cut-sm border border-cc-red/30 bg-cc-red-dim px-3 py-2 text-xs font-medium text-cc-red">
              {sessionError}
            </p>
          )}
          <button
            type="submit"
            disabled={creatingSession || !sessionName.trim()}
            className="clip-cut-sm inline-flex items-center justify-center gap-2 bg-cc-accent px-4 py-2.5 text-sm font-bold uppercase tracking-wide text-cc-btn-on-accent transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creatingSession && <Loader2 className="h-4 w-4 animate-spin" />}
            {creatingSession ? "Creating…" : "Create session"}
          </button>
        </form>
      </section>

      {/* Invite */}
      <section className="clip-cut border border-cc-border bg-cc-bg-2 p-5">
        <h2 className="mb-3 flex items-center gap-1.5 font-command text-xs font-bold uppercase tracking-wide text-cc-t2">
          <Link2 className="h-3.5 w-3.5" />
          Invite players
        </h2>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as ClubRole)}
            className="clip-cut-sm border border-cc-border bg-cc-bg-3 px-3 py-2.5 text-sm text-cc-t1 outline-none focus:border-cc-accent focus:ring-2 focus:ring-cc-accent/30"
          >
            <option value="member">As member</option>
            <option value="admin">As admin</option>
          </select>
          <button
            type="button"
            onClick={handleCreateInvite}
            disabled={creatingInvite}
            aria-busy={creatingInvite}
            className="clip-cut-sm inline-flex items-center justify-center gap-2 border border-cc-accent/55 bg-cc-accent-dim px-4 py-2.5 text-sm font-bold uppercase tracking-wide text-cc-accent-text transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {creatingInvite && <Loader2 className="h-4 w-4 animate-spin" />}
            {creatingInvite ? "Generating…" : "Generate invite link"}
          </button>
        </div>

        {inviteError && (
          <p className="clip-cut-sm mt-3 border border-cc-red/30 bg-cc-red-dim px-3 py-2 text-xs font-medium text-cc-red">
            {inviteError}
          </p>
        )}

        {inviteLink && (
          <div
            role="status"
            aria-live="polite"
            className="clip-cut-sm mt-3 flex items-center gap-2 border border-cc-border bg-cc-bg-3 px-3 py-2"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-cc-t2">
              {inviteLink}
            </span>
            <button
              type="button"
              onClick={copyInvite}
              aria-label="Copy invite link"
              className="clip-cut-sm inline-flex shrink-0 items-center gap-1 px-2 py-1 text-xs font-semibold text-cc-accent-text transition-colors hover:bg-cc-accent/15"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
        <p className="mt-2 text-[11px] text-cc-t3">
          One-time link — it stops working after someone joins with it.
        </p>
      </section>

      {/* Members */}
      <section>
        <h2 className="mb-2 flex items-center gap-1.5 font-command text-xs font-bold uppercase tracking-wide text-cc-t2">
          <Users className="h-3.5 w-3.5" />
          Members ({activeMembers.length})
        </h2>
        <ul className="clip-cut divide-y divide-cc-border overflow-hidden border border-cc-border bg-cc-bg-2">
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
          <h2 className="mb-2 font-command text-xs font-bold uppercase tracking-wide text-cc-t3">
            Removed ({removedMembers.length})
          </h2>
          <ul className="clip-cut divide-y divide-cc-border overflow-hidden border border-cc-border bg-cc-bg-3">
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
  // Staged (not-yet-committed) role change — a role change, especially → Owner,
  // is high-stakes and irreversible, so it gets the same explicit confirm guard
  // as Remove instead of firing on a single native-select flick (P0 safety).
  const [pendingRole, setPendingRole] = useState<ClubRole | null>(null);

  const isSelf = member.player_id === viewerId;
  const manageable = !isSelf && canManage(viewerRole, member.role);

  function handleRemove() {
    setError(null);
    startTransition(async () => {
      const result = await removeMember(clubId, member.id, clubSlug);
      if (result.success) {
        onUpdate(member.id, { is_active: false });
        setConfirming(false);
        toast.success(`Removed ${member.display_name}`);
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
        toast.success(`Restored ${member.display_name}`);
      } else {
        setError(result.message);
      }
    });
  }

  // Stage the selection only — never mutate on `change`.
  function handleRoleSelect(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as ClubRole;
    setError(null);
    setPendingRole(next === member.role ? null : next);
  }

  // Commit the staged role change after explicit confirmation.
  function handleConfirmRole() {
    if (!pendingRole || pendingRole === member.role) {
      setPendingRole(null);
      return;
    }
    const newRole = pendingRole;
    setError(null);
    startTransition(async () => {
      const result = await changeMemberRole(clubId, member.id, newRole, clubSlug);
      if (result.success) {
        onUpdate(member.id, { role: newRole });
        setPendingRole(null);
        toast.success(`${member.display_name} is now ${ROLE_LABEL[newRole]}`);
      } else {
        setError(result.message);
      }
    });
  }

  return (
    <li className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-cc-t1">{member.display_name}</span>
        <div className="flex shrink-0 items-center gap-2">
          {viewerRole === "owner" && !isSelf && member.is_active ? (
            <span className="inline-flex items-center gap-1.5">
              <select
                value={pendingRole ?? member.role}
                disabled={pending}
                onChange={handleRoleSelect}
                aria-label={`Change ${member.display_name}'s role`}
                aria-describedby={error ? `member-${member.id}-error` : undefined}
                className={`clip-cut-sm px-2 py-1 text-[11px] font-bold uppercase tracking-wider outline-none focus:border-cc-accent disabled:opacity-50 ${ROLE_BADGE_CLASS[pendingRole ?? member.role]}`}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                <option value="owner">Owner</option>
              </select>
              {pendingRole && pendingRole !== member.role ? (
                <span className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    onClick={handleConfirmRole}
                    disabled={pending}
                    aria-label={`Confirm: make ${member.display_name} ${ROLE_LABEL[pendingRole]}`}
                    className="clip-cut-badge inline-flex items-center gap-1 bg-cc-accent px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-cc-btn-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {pending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      `Make ${ROLE_LABEL[pendingRole]}?`
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingRole(null)}
                    disabled={pending}
                    aria-label="Cancel role change"
                    className="clip-cut-badge px-2 py-1 text-[11px] font-medium text-cc-t2 transition-colors hover:bg-cc-bg-3 disabled:opacity-50"
                  >
                    No
                  </button>
                </span>
              ) : (
                pending && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-cc-t3" aria-hidden="true" />
                )
              )}
            </span>
          ) : (
            <span
              className={`clip-cut-badge px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${ROLE_BADGE_CLASS[member.role]}`}
            >
              {ROLE_LABEL[member.role]}
            </span>
          )}

          {manageable && member.is_active && !confirming && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              aria-label={`Remove ${member.display_name}`}
              className="clip-cut-sm flex h-8 w-8 items-center justify-center text-cc-t3 transition-colors hover:bg-cc-red-dim hover:text-cc-red"
            >
              <UserMinus className="h-3.5 w-3.5" />
            </button>
          )}

          {manageable && member.is_active && confirming && (
            <div className="flex items-center gap-1">
              <span className="text-[11px] font-medium text-cc-t2">Remove?</span>
              <button
                type="button"
                onClick={handleRemove}
                disabled={pending}
                className="clip-cut-badge bg-cc-red px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Yes"}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={pending}
                className="clip-cut-badge px-2 py-1 text-[11px] font-medium text-cc-t2 hover:bg-cc-bg-3 disabled:opacity-50"
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
              className="clip-cut-badge inline-flex items-center gap-1 border border-cc-accent/55 bg-cc-accent-dim px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-cc-accent-text transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {pending && <Loader2 className="h-3 w-3 animate-spin" />}
              Restore
            </button>
          )}
        </div>
      </div>
      {error && (
        <p id={`member-${member.id}-error`} role="alert" className="text-[11px] text-cc-red">
          {error}
        </p>
      )}
    </li>
  );
}
