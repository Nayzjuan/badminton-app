"use client";

// ============================================================
// OrganizerSessionHeader — sticky command bar for the organizer board
// ============================================================
// Split out of organizer-dashboard.tsx so the shell stays readable and so the
// header can be rendered on its own (see /sandbox/organizer-header) at real
// viewport widths — its failure mode is a layout one, and layout is only
// falsifiable against a live viewport.
//
// Owns no state: every toggle, dropdown and dialog is driven by
// useOrganizerDashboard and handed down, so the header is a pure function of
// the board's state.
//
// Layout contract — three bands, none of which may overflow:
//   1. utility bar   back link | theme + notices + overflow menu
//   2. command bar   identity (name over live tallies) | organizer controls
//   3. tab rail      horizontally scrollable
// Band 2 is ONE `flex-wrap` row at every width. Wrapping — not a breakpoint —
// is what makes overflow structurally impossible: when the controls no longer
// fit beside the identity block they drop to their own line, and when they no
// longer fit on one line they wrap among themselves. Nothing is `shrink-0` at
// a size that can exceed a phone viewport.
//
// Every control is rendered EXACTLY ONCE. The previous version carried a
// desktop copy and a mobile copy of the stats, the auto toggle, the publish
// toggle and the cap chip; the two copies drifted ("in play" vs "active") and
// the mobile copies sat below the 44px touch minimum. Responsive behaviour
// here is label-level (`hidden xl:inline`), never element-level.

import { useRouter } from "next/navigation";
import {
  ChevronDown,
  ArrowLeft,
  Repeat,
  Power,
  Tv2,
  Share2,
  MoreVertical,
  WifiOff,
} from "lucide-react";

import { DraftCapPopover } from "./draft-cap-popover";
import { DevTools } from "./dev-tools";
import { OrganizerNoticeInbox } from "@/components/organizer/organizer-notice-inbox";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { useClubSlug } from "@/hooks/use-club-slug";
import { clubBase, clubOrganizer, clubTv } from "@/lib/club-paths";
import type { CapPhase } from "@/hooks/use-organizer-session";
import type { OrganizerTab, TabConfig } from "@/hooks/use-organizer-dashboard";
import type { Profile, Session, SessionNotification } from "@/types/database";

// ── Design token constants ───────────────────────────────────
// Command-center surface tokens (theme-aware via cc-* tokens in globals.css).
const HEADER_BG = "bg-cc-header-bg";
const ACTIVE_TAB = "border-b-2 border-cc-accent text-cc-accent font-semibold";

/** Shared chrome for the three chip-shaped toggles (Auto / Publish / links). */
const CHIP =
  "items-center justify-center gap-1.5 clip-cut-sm px-2.5 lg:px-3 " +
  "min-h-[44px] font-command text-[10px] uppercase tracking-[0.10em] " +
  "transition-colors border disabled:opacity-50 disabled:cursor-not-allowed";

/** Chrome for the icon-first link chips (TV / Share / Close). Hidden below
 *  lg, where the utility bar's overflow menu carries the same three actions. */
const LINK_CHIP = `hidden lg:inline-flex min-w-[44px] ${CHIP}`;

/** Live board tallies. Only the counts are read here, never the rows. */
export interface HeaderCounts {
  courts: number;
  queue: number;
  active: number;
  drafts: number;
}

export interface OrganizerSessionHeaderProps {
  /** Measured by the dashboard's ResizeObserver to publish --cc-header-h. */
  headerRef: React.RefObject<HTMLElement | null>;
  session: Session;
  liveSession: Session;
  profile: Profile;
  otherSessions: Session[];
  isClosed: boolean;
  isDashboardLocked: boolean;
  realtimeConnected: boolean;
  counts: HeaderCounts;

  // Notice inbox
  alerts: {
    inbox: SessionNotification[];
    unreadCount: number;
    markRead: (id: string) => void;
  };
  setReviewNotice: (notice: SessionNotification) => void;

  // Auto-matchmaking
  autoMatchmaking: boolean;
  togglingAuto: boolean;
  handleToggleAuto: () => void;

  // Auto-publish
  autoPublish: boolean;
  togglingAutoPublish: boolean;
  handleToggleAutoPublish: (enabled: boolean) => void;
  setAutoPublishConfirmOpen: (open: boolean) => void;

  // Draft cap
  capPhase: CapPhase;
  handleCapChange: (cap: number | null) => Promise<void>;

  // Dropdowns / dialogs (owned by useOrganizerDashboard)
  switcherOpen: boolean;
  setSwitcherOpen: (open: boolean) => void;
  switcherRef: React.RefObject<HTMLDivElement | null>;
  moreMenuOpen: boolean;
  setMoreMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  moreMenuRef: React.RefObject<HTMLDivElement | null>;
  setShareOpen: (open: boolean) => void;
  setCloseOpen: (open: boolean) => void;

  // Tabs
  tabs: TabConfig[];
  activeTab: OrganizerTab;
  setActiveTab: (tab: OrganizerTab) => void;
}

export function OrganizerSessionHeader({
  headerRef,
  session,
  liveSession,
  profile,
  otherSessions,
  isClosed,
  isDashboardLocked,
  realtimeConnected,
  counts,
  alerts,
  setReviewNotice,
  autoMatchmaking,
  togglingAuto,
  handleToggleAuto,
  autoPublish,
  togglingAutoPublish,
  handleToggleAutoPublish,
  setAutoPublishConfirmOpen,
  capPhase,
  handleCapChange,
  switcherOpen,
  setSwitcherOpen,
  switcherRef,
  moreMenuOpen,
  setMoreMenuOpen,
  moreMenuRef,
  setShareOpen,
  setCloseOpen,
  tabs,
  activeTab,
  setActiveTab,
}: OrganizerSessionHeaderProps) {
  const router = useRouter();
  const clubSlug = useClubSlug();

  const tvHref = clubSlug ? clubTv(clubSlug, session.id) : `/tv/${session.id}`;
  const canSwitch = otherSessions.length > 0;

  return (
    <header ref={headerRef} className={`sticky top-0 z-20 ${HEADER_BG} border-b border-cc-border`}>
      <div className="max-w-7xl mx-auto px-3 lg:px-6 py-2 lg:py-3">
        {/* ── Band 1: utility bar ─────────────────────────────
            Icon-only controls live here and nowhere else, so they share one
            baseline. All three are 44px square, which is what makes the bell
            read as aligned rather than orphaned. */}
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => router.push(clubSlug ? clubBase(clubSlug) : "/organizer")}
            /* text-cc-t2, not the inherited t3: on the light canvas t3 measures
               4.17:1 against the header background, under the 4.5:1 floor for
               12px text. t2 is 9:1 in light and 7.1:1 in dark. */
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded px-3 py-2
                       min-h-[44px] -ml-1 text-xs font-medium text-cc-t2
                       hover:text-cc-t1 hover:bg-cc-bg-3 transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5 shrink-0" />
            All Sessions
          </button>

          <div className="flex min-w-0 shrink items-center gap-0.5">
            {/* Whose board this is. It rides the utility bar — the one band
                with slack at every width — rather than sitting beside the
                session name, where the max-w-7xl cap means it is paid for out
                of the title, or on the tally line, where it forces a wrap. */}
            <span className="hidden max-w-[14rem] truncate pr-1.5 text-xs text-cc-t2 lg:inline">
              {profile.display_name}
            </span>

            {/* Sized box so the pre-mount placeholder cannot shift the row. */}
            <span className="inline-flex h-11 w-11 items-center justify-center">
              <ThemeToggle className="h-11 w-11 text-cc-t2 hover:text-cc-t1 hover:bg-cc-bg-3" />
            </span>

            <OrganizerNoticeInbox
              inbox={alerts.inbox}
              unreadCount={alerts.unreadCount}
              isClosed={isClosed}
              onMarkRead={alerts.markRead}
              onReview={setReviewNotice}
            />

            {/* Overflow menu — the only route to TV / Share / Close below lg,
                where those three chips are hidden. */}
            {!isClosed && (
              <div className="relative lg:hidden" ref={moreMenuRef}>
                <button
                  onClick={() => setMoreMenuOpen((v) => !v)}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-lg
                             text-cc-t2 hover:text-cc-t1 hover:bg-cc-bg-3 transition-colors"
                  aria-label="More options"
                  aria-expanded={moreMenuOpen}
                >
                  <MoreVertical className="h-4 w-4" />
                </button>

                {moreMenuOpen && (
                  <div
                    className="absolute right-0 top-full mt-1.5 w-52 rounded-xl
                               border border-cc-border bg-cc-bg-2
                               shadow-xl z-50 overflow-hidden
                               animate-in fade-in slide-in-from-top-1 duration-150"
                  >
                    <a
                      href={tvHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setMoreMenuOpen(false)}
                      className="flex items-center gap-3 w-full px-4 py-3 text-sm
                                 text-cc-t2 hover:bg-cc-bg-3
                                 hover:text-cc-t1 transition-colors"
                    >
                      <Tv2 className="h-4 w-4 text-cc-t3 shrink-0" />
                      TV Scoreboard
                    </a>

                    <button
                      onClick={() => {
                        setMoreMenuOpen(false);
                        setShareOpen(true);
                      }}
                      className="flex items-center gap-3 w-full px-4 py-3 text-sm text-left
                                 text-cc-t2 hover:bg-cc-bg-3
                                 hover:text-cc-t1 transition-colors"
                    >
                      <Share2 className="h-4 w-4 text-cc-t3 shrink-0" />
                      Share Session
                    </button>

                    <div className="border-t border-cc-border" />

                    <button
                      onClick={() => {
                        setMoreMenuOpen(false);
                        setCloseOpen(true);
                      }}
                      className="flex items-center gap-3 w-full px-4 py-3 text-sm text-left
                                 text-cc-red hover:bg-cc-red-dim
                                 hover:text-cc-red transition-colors"
                    >
                      <Power className="h-4 w-4 shrink-0" />
                      Close Session
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Band 2: identity + controls ─────────────────────
            One wrapping row. `basis-[240px]` on the identity block is what
            decides where the controls break to their own line; below that the
            name would truncate before the controls have given up any space. */}
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          {/* Identity: session name over the live tallies. */}
          <div className="flex min-w-0 flex-1 basis-[240px] flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <div className="relative min-w-0 flex-1" ref={switcherRef}>
                <button
                  onClick={() => canSwitch && setSwitcherOpen(!switcherOpen)}
                  aria-expanded={canSwitch ? switcherOpen : undefined}
                  // max-w-full is load-bearing: a <button> resolves width:auto
                  // to fit-content even inside a flex-shrunk parent, so without
                  // a cap the <h1> paints past its box and `truncate` never
                  // engages — that is the overlap this component was split out
                  // to fix.
                  className={`flex max-w-full items-center gap-2 rounded-lg px-2 py-1 -mx-2
                              min-h-[36px] transition-colors
                              ${canSwitch ? "hover:bg-cc-bg-3 cursor-pointer" : "cursor-default"}`}
                >
                  <h1 className="font-command truncate text-base lg:text-xl font-bold text-cc-t1 tracking-wide">
                    {session.name}
                  </h1>
                  {canSwitch && (
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-cc-t3 transition-transform
                                  ${switcherOpen ? "rotate-180" : ""}`}
                    />
                  )}
                </button>

                {/* Session switcher dropdown */}
                {switcherOpen && canSwitch && (
                  <div
                    className="absolute left-0 top-full mt-2 w-[min(18rem,calc(100vw-1.5rem))]
                               rounded-xl border border-cc-border bg-cc-bg-2
                               shadow-xl z-50 overflow-hidden
                               animate-in fade-in slide-in-from-top-1 duration-150"
                  >
                    <div className="px-3 py-2 bg-cc-bg-3 border-b border-cc-border">
                      <p className="font-command text-[9px] font-bold uppercase tracking-[0.22em] text-cc-t3">
                        Switch Session
                      </p>
                    </div>
                    <div className="max-h-60 overflow-y-auto py-1">
                      {otherSessions.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => {
                            setSwitcherOpen(false);
                            router.push(
                              clubSlug ? clubOrganizer(clubSlug, s.id) : `/organizer/${s.id}`
                            );
                          }}
                          className="flex items-center gap-3 w-full px-3 py-2.5 text-left
                                     hover:bg-cc-bg-3 transition-colors"
                        >
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cc-bg-3">
                            <Repeat className="h-3.5 w-3.5 text-cc-t3" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-cc-t1 truncate">{s.name}</p>
                            <p className="text-[10px] text-cc-t3">
                              Created{" "}
                              {new Date(s.created_at).toLocaleDateString("en-US", {
                                weekday: "short",
                                month: "short",
                                day: "numeric",
                              })}
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                    <div className="border-t border-cc-border px-3 py-2">
                      <button
                        onClick={() => {
                          setSwitcherOpen(false);
                          router.push(clubSlug ? clubBase(clubSlug) : "/organizer");
                        }}
                        className="flex items-center gap-2 w-full text-xs font-medium
                                   text-cc-accent hover:text-cc-accent/80 transition-colors py-1"
                      >
                        <ArrowLeft className="h-3 w-3" />
                        View all sessions & create new
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {isClosed && (
                <span
                  className="inline-flex shrink-0 items-center rounded-full bg-cc-bg-3
                             border border-cc-border px-2.5 py-0.5 text-[10px]
                             font-bold uppercase tracking-wider text-cc-t2"
                >
                  Closed
                </span>
              )}
            </div>

            {/* Live tallies — one implementation, read at every width. */}
            {!isClosed && (
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-0.5 text-[11px] text-cc-t2 lg:text-xs">
                <span className="tabular-nums">
                  {counts.courts} court{counts.courts !== 1 ? "s" : ""}
                </span>
                <span aria-hidden="true" className="text-cc-t3">
                  ·
                </span>
                <span className="tabular-nums">{counts.queue} in queue</span>
                <span aria-hidden="true" className="text-cc-t3">
                  ·
                </span>
                <span className="tabular-nums">{counts.active} in play</span>
                {!realtimeConnected && (
                  <>
                    <span aria-hidden="true" className="text-cc-t3">
                      ·
                    </span>
                    <span
                      className="inline-flex items-center gap-1 text-cc-amber"
                      title="Realtime channels disconnected — displayed data may be stale. Reconnecting…"
                    >
                      <WifiOff className="h-3 w-3 shrink-0" aria-hidden="true" />
                      Sync offline
                    </span>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Organizer controls. Shrinkable + wrapping, so a narrow viewport
              reflows them instead of pushing them off-screen. */}
          {!isClosed && (
            <div className="flex min-w-0 flex-wrap items-center justify-start gap-2 lg:justify-end">
              {/* Auto-matchmaking toggle */}
              <button
                data-testid="toggle-auto-matchmaking"
                onClick={handleToggleAuto}
                disabled={togglingAuto}
                aria-pressed={autoMatchmaking}
                className={`inline-flex ${CHIP} ${
                  autoMatchmaking
                    ? "bg-cc-accent-dim border-cc-accent/45 text-cc-accent hover:bg-cc-accent/20"
                    : "bg-cc-bg-3 border-cc-border text-cc-t3 hover:bg-cc-bg-2"
                }`}
                title="Auto matchmaking: when ON, the engine automatically forms the next match when a court opens"
              >
                {/* Dot: spins as arc while saving, pings when ON, static when OFF */}
                {togglingAuto ? (
                  <span className="h-2.5 w-2.5 shrink-0 animate-spin">
                    <svg viewBox="0 0 10 10" fill="none" aria-hidden="true">
                      <circle
                        cx="5"
                        cy="5"
                        r="3.5"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeDasharray="14 8"
                        strokeLinecap="round"
                        opacity=".9"
                      />
                    </svg>
                  </span>
                ) : (
                  <span className="relative flex h-2 w-2 shrink-0">
                    {autoMatchmaking && (
                      <span className="animate-ping motion-reduce:hidden absolute inline-flex h-full w-full rounded-full bg-cc-accent opacity-50" />
                    )}
                    <span
                      className={`relative inline-flex h-2 w-2 rounded-full ${autoMatchmaking ? "bg-cc-accent" : "bg-cc-t3"}`}
                    />
                  </span>
                )}
                {togglingAuto ? "Saving…" : autoMatchmaking ? "Auto On" : "Auto Off"}
              </button>

              {/* Auto-publish toggle. Disabled until Auto-Matchmaking is ON
                  (D11): the engine is paused otherwise. */}
              <button
                data-testid="toggle-auto-publish"
                onClick={() => {
                  const enabling = !autoPublish;
                  if (enabling && counts.drafts > 0) {
                    setAutoPublishConfirmOpen(true);
                  } else {
                    void handleToggleAutoPublish(enabling);
                  }
                }}
                disabled={togglingAutoPublish || !autoMatchmaking || isDashboardLocked}
                aria-pressed={autoPublish}
                className={`inline-flex ${CHIP} ${
                  autoPublish
                    ? "bg-cc-accent-dim border-cc-accent/45 text-cc-accent hover:bg-cc-accent/20"
                    : "bg-cc-bg-3 border-cc-border text-cc-t3 hover:bg-cc-bg-2"
                }`}
                title={
                  !autoMatchmaking
                    ? "Enable Auto-Matchmaking first — auto-publish only works while the engine runs"
                    : "Auto-publish: when ON, generated matches skip review and go straight to On Deck"
                }
              >
                {togglingAutoPublish ? (
                  <span className="h-2.5 w-2.5 shrink-0 animate-spin">
                    <svg viewBox="0 0 10 10" fill="none" aria-hidden="true">
                      <circle
                        cx="5"
                        cy="5"
                        r="3.5"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeDasharray="14 8"
                        strokeLinecap="round"
                        opacity=".9"
                      />
                    </svg>
                  </span>
                ) : (
                  <span
                    className={`relative inline-flex h-2 w-2 shrink-0 rounded-full ${autoPublish ? "bg-cc-accent" : "bg-cc-t3"}`}
                  />
                )}
                {togglingAutoPublish ? "Saving…" : autoPublish ? "Publish On" : "Publish Off"}
              </button>

              <DraftCapPopover
                value={liveSession.max_auto_drafts_override ?? null}
                autoIsOn={autoMatchmaking}
                autoPublishIsOn={autoPublish}
                capPhase={capPhase}
                onChange={handleCapChange}
              />

              {process.env.NODE_ENV === "development" && (
                <span className="hidden lg:inline-flex">
                  <DevTools sessionId={session.id} />
                </span>
              )}

              <span className="hidden h-5 w-px shrink-0 bg-cc-border lg:block" aria-hidden="true" />

              {/* Icon-only until xl, where the labels fit beside the identity
                  block on a single line. */}
              <a
                href={tvHref}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="TV View"
                title="Open TV scoreboard in a new tab"
                className={`${LINK_CHIP} border-cc-border bg-cc-bg-3 text-cc-t2
                            hover:bg-cc-bg-2 hover:text-cc-t1 hover:border-cc-border-hi`}
              >
                <Tv2 className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden xl:inline">TV View</span>
              </a>

              <button
                onClick={() => setShareOpen(true)}
                aria-label="Share Session"
                title="Share Session"
                className={`${LINK_CHIP} border-cc-border bg-cc-bg-3 text-cc-t2
                            hover:bg-cc-bg-2 hover:text-cc-t1 hover:border-cc-border-hi`}
              >
                <Share2 className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden xl:inline">Share Session</span>
              </button>

              <button
                onClick={() => setCloseOpen(true)}
                aria-label="Close Session"
                title="Close Session"
                className={`${LINK_CHIP} border-cc-red/50 bg-cc-red-dim text-cc-red
                            hover:bg-cc-red/20 hover:border-cc-red`}
              >
                <Power className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden xl:inline">Close Session</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Band 3: tab rail — horizontally scrollable on mobile ── */}
      <div className="max-w-7xl mx-auto px-3 lg:px-6">
        <nav
          className="flex overflow-x-auto gap-1 pt-2
                     [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
          role="tablist"
          aria-label="Dashboard sections"
        >
          {tabs.map((tab) => (
            <button
              key={tab.key}
              id={`tab-${tab.key}`}
              role="tab"
              aria-selected={activeTab === tab.key}
              aria-controls={`tabpanel-${tab.key}`}
              onClick={() => setActiveTab(tab.key)}
              className={`relative shrink-0 whitespace-nowrap px-4 lg:px-5 py-2.5
                          font-command text-[10px] uppercase tracking-[0.14em] transition-colors
                          ${
                            activeTab === tab.key
                              ? ACTIVE_TAB
                              : "text-cc-t3 hover:text-cc-t2 hover:bg-cc-bg-3"
                          }`}
            >
              {tab.label}
              {tab.badge !== undefined && (
                <span
                  className={[
                    "absolute -top-1 -right-1 h-5 w-5 rounded-full text-white",
                    "text-xs flex items-center justify-center font-bold",
                    // amber = drafts waiting for approval; red = bottleneck players
                    tab.badgeVariant === "amber"
                      ? "bg-amber-500 animate-pulse"
                      : "bg-red-500 animate-pulse",
                  ].join(" ")}
                >
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>
    </header>
  );
}
