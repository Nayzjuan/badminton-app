"use client";

// ============================================================
// OrganizerHeaderPreview — /sandbox/organizer-header
// ============================================================
// Renders the real OrganizerSessionHeader against fabricated board state so
// the sticky command bar can be checked at phone / tablet / laptop widths
// without a live session. Toggle the knobs to reach the states that change the
// header's width: a long session name, a disconnected socket, a closed
// session, and a two-digit notice badge.

import { useRef, useState } from "react";
import { OrganizerSessionHeader } from "@/components/organizer/session-header";
import type { OrganizerTab } from "@/hooks/use-organizer-dashboard";
import type { Profile, Session, SessionNotification } from "@/types/database";

const SESSION = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "08/22 Saturday Session",
  created_at: "2026-08-22T09:00:00.000Z",
  max_auto_drafts_override: null,
  auto_publish: false,
  is_auto_matchmaking_on: true,
  is_active: true,
} as unknown as Session;

const LONG_SESSION = {
  ...SESSION,
  name: "08/22 Saturday Night Doubles Ladder — Chillax Main Hall",
} as unknown as Session;

const OTHER_SESSIONS = [
  { ...SESSION, id: "00000000-0000-0000-0000-000000000002", name: "08/15 Saturday Session" },
] as unknown as Session[];

const PROFILE = { id: "p1", display_name: "Miggy Ordinario" } as unknown as Profile;

export function OrganizerHeaderPreview() {
  const headerRef = useRef<HTMLElement | null>(null);
  const switcherRef = useRef<HTMLDivElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);

  const [longName, setLongName] = useState(false);
  const [offline, setOffline] = useState(false);
  const [closed, setClosed] = useState(false);
  const [unread, setUnread] = useState(0);

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<OrganizerTab>("courts");
  const [autoMatchmaking, setAutoMatchmaking] = useState(true);
  const [autoPublish, setAutoPublish] = useState(false);

  const session = longName ? LONG_SESSION : SESSION;

  return (
    <div className="min-h-screen bg-cc-bg">
      <OrganizerSessionHeader
        headerRef={headerRef}
        session={session}
        liveSession={session}
        profile={PROFILE}
        otherSessions={OTHER_SESSIONS}
        isClosed={closed}
        isDashboardLocked={false}
        realtimeConnected={!offline}
        counts={{ courts: 4, queue: 12, active: 3, drafts: 2 }}
        alerts={{
          inbox: [] as SessionNotification[],
          unreadCount: unread,
          markRead: () => {},
        }}
        setReviewNotice={() => {}}
        autoMatchmaking={autoMatchmaking}
        togglingAuto={false}
        handleToggleAuto={() => setAutoMatchmaking((v) => !v)}
        autoPublish={autoPublish}
        togglingAutoPublish={false}
        handleToggleAutoPublish={(enabled) => setAutoPublish(enabled)}
        // counts.drafts > 0, so the header routes through the confirm
        // dialog rather than handleToggleAutoPublish. The harness stands
        // in for the organizer accepting it; without this the "Publish On"
        // state is unreachable and cannot be checked at any width.
        setAutoPublishConfirmOpen={(open) => {
          if (open) setAutoPublish(true);
        }}
        capPhase={null}
        handleCapChange={async () => {}}
        switcherOpen={switcherOpen}
        setSwitcherOpen={setSwitcherOpen}
        switcherRef={switcherRef}
        moreMenuOpen={moreMenuOpen}
        setMoreMenuOpen={setMoreMenuOpen}
        moreMenuRef={moreMenuRef}
        setShareOpen={() => {}}
        setCloseOpen={() => {}}
        tabs={[
          { key: "courts", label: "Active Courts", badge: 2, badgeVariant: "amber" },
          { key: "queue", label: "Queue & Match Control" },
          { key: "monitor", label: "Wait Time Monitor" },
          { key: "history", label: "Match History" },
          { key: "leaderboard", label: "Leaderboard" },
        ]}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
      />

      <div className="mx-auto max-w-7xl px-3 py-6 lg:px-6">
        <p className="font-command text-[10px] uppercase tracking-[0.18em] text-cc-t3">
          Preview knobs
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Knob on={longName} onClick={() => setLongName((v) => !v)} label="Long session name" />
          <Knob on={offline} onClick={() => setOffline((v) => !v)} label="Sync offline" />
          <Knob on={closed} onClick={() => setClosed((v) => !v)} label="Session closed" />
          <Knob
            on={unread > 0}
            onClick={() => setUnread((v) => (v === 0 ? 3 : v === 3 ? 12 : 0))}
            label={`Unread notices: ${unread}`}
          />
        </div>
        <div className="mt-8 h-[150vh] rounded-xl border border-dashed border-cc-border" />
      </div>
    </div>
  );
}

function Knob({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`clip-cut-sm border px-3 py-2 font-command text-[10px] uppercase tracking-[0.10em] transition-colors ${
        on
          ? "border-cc-accent/45 bg-cc-accent-dim text-cc-accent"
          : "border-cc-border bg-cc-bg-3 text-cc-t3 hover:bg-cc-bg-2"
      }`}
    >
      {label}
    </button>
  );
}
