// @vitest-environment happy-dom
// ============================================================
// OrganizerEntry hub — always-visible join, per-card org vs join
// ============================================================
// IDs: OE-*
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Profile } from "@/types/database";
import type { SessionWithStats } from "@/components/organizer/organizer-entry";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("@/app/actions/sessions", () => ({
  createSession: vi.fn(),
  joinAsCoOrganizer: vi.fn(),
}));

vi.mock("@/hooks/use-club-slug", () => ({
  useClubSlug: () => "chillax",
}));

vi.mock("@/components/sign-out-button", () => ({
  SignOutButton: () => <button type="button">Sign out</button>,
}));

vi.mock("@/components/organizer/co-organizer-share-dialog", () => ({
  CoOrganizerShareDialog: ({ sessionName }: { sessionName: string }) => (
    <button type="button">Co-organizer QR {sessionName}</button>
  ),
}));

import { OrganizerEntry } from "@/components/organizer/organizer-entry";
import { joinAsCoOrganizer } from "@/app/actions/sessions";
import { clubOrganizer } from "@/lib/club-paths";

const PROFILE: Profile = {
  id: "user-1",
  display_name: "Miggy",
  skill_level: "intermediate",
  pin: null,
  vip_tag: null,
  vip_theme: null,
  needs_rename: false,
  collided_name: null,
  flagged_at: null,
  needs_name_confirm: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const INVITE_TOKEN = "abcdefghijklmnopqrstuvwxyz012345";

function makeSession(overrides: Partial<SessionWithStats> = {}): SessionWithStats {
  return {
    id: "sess-owned",
    name: "Friday Night",
    created_by: "org-1",
    club_id: "club-1",
    organizer_passcode: "SMASH7",
    co_organizer_invite_token: INVITE_TOKEN,
    scoring: "single",
    is_active: true,
    is_auto_matchmaking_on: false,
    court_time_limit_minutes: null,
    max_auto_drafts_override: null,
    auto_publish: false,
    is_hidden: false,
    created_at: "2026-01-01T18:00:00Z",
    ended_at: null,
    playerCount: 8,
    courtCount: 2,
    matchCount: 3,
    ...overrides,
  };
}

describe("OrganizerEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("OE-1: Join as Co-Organizer stays visible when a night is already live", () => {
    render(
      <OrganizerEntry
        profile={PROFILE}
        activeSessions={[makeSession()]}
        pastSessions={[]}
        soloClubId="club-1"
        organizedSessionIds={["sess-owned"]}
      />
    );
    expect(screen.getByRole("heading", { name: /join as co-organizer/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^join session$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create session/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create a new session/i })).toBeInTheDocument();
  });

  it("OE-2: an organized card shows the spoken passcode and co-org QR, not a join field", () => {
    render(
      <OrganizerEntry
        profile={PROFILE}
        activeSessions={[makeSession()]}
        pastSessions={[]}
        soloClubId="club-1"
        organizedSessionIds={["sess-owned"]}
      />
    );
    expect(screen.getByText("SMASH7")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /co-organizer qr friday night/i })
    ).toBeInTheDocument();
    expect(screen.queryByText(INVITE_TOKEN)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /join as co-organizer/i })).not.toBeInTheDocument();
  });

  it("OE-3: a non-organizer card hides the passcode and offers typed join", () => {
    render(
      <OrganizerEntry
        profile={PROFILE}
        activeSessions={[makeSession({ id: "sess-other", name: "Other Night" })]}
        pastSessions={[]}
        soloClubId="club-1"
        organizedSessionIds={[]}
      />
    );
    expect(screen.queryByText("SMASH7")).not.toBeInTheDocument();
    expect(screen.queryByText(INVITE_TOKEN)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /co-organizer qr/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /join as co-organizer/i })).toBeInTheDocument();
    expect(screen.getAllByLabelText(/session passcode/i).length).toBeGreaterThanOrEqual(2);
  });

  it("OE-4: a successful passcode join navigates with the session club, not the hub slug", async () => {
    vi.mocked(joinAsCoOrganizer).mockResolvedValue({
      success: true,
      message: "Joined as co-organizer.",
      sessionId: "sess-other",
      clubSlug: "smash-city",
    });
    const user = userEvent.setup();
    render(
      <OrganizerEntry
        profile={PROFILE}
        activeSessions={[]}
        pastSessions={[]}
        soloClubId="club-1"
        organizedSessionIds={[]}
      />
    );
    await user.type(screen.getByLabelText(/session passcode/i), "BIRDIE3");
    await user.click(screen.getByRole("button", { name: /^join session$/i }));
    await vi.waitFor(() => {
      expect(joinAsCoOrganizer).toHaveBeenCalledWith("BIRDIE3");
      expect(push).toHaveBeenCalledWith(clubOrganizer("smash-city", "sess-other"));
    });
    expect(push).not.toHaveBeenCalledWith(expect.stringContaining("/c/chillax/"));
  });
});
