// ============================================================
// completeRegistrationJoinAction — auth-first join finalizer
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/utils/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/clubs", () => ({
  getClubBySlug: vi.fn(),
  ensureClubMembership: vi.fn(),
}));
vi.mock("@/lib/resolve-session-join", () => ({ lookupActiveJoinSession: vi.fn() }));
vi.mock("@/app/actions/queue", () => ({ joinQueueAction: vi.fn() }));

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { getClubBySlug, ensureClubMembership } from "@/lib/clubs";
import { lookupActiveJoinSession } from "@/lib/resolve-session-join";
import { joinQueueAction } from "@/app/actions/queue";
import { completeRegistrationJoinAction } from "@/app/actions/registration";

const SID = "00000000-0000-4000-8000-000000000010";
const UID = "00000000-0000-4000-8000-00000000d0e5";
const CLUB = {
  id: "club-1",
  slug: "chillax",
  name: "Chillax",
  is_active: true,
  created_by: UID,
  created_at: "2026-01-01T00:00:00Z",
};

function authClient(opts: {
  user?: boolean;
  profile?: { needs_rename?: boolean; needs_name_confirm?: boolean } | null;
  profileError?: boolean;
}) {
  const from = vi.fn(() => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () =>
          opts.profileError
            ? { data: null, error: { message: "db" } }
            : { data: opts.profile ? { id: UID, ...opts.profile } : null, error: null },
      }),
    }),
  }));
  vi.mocked(createServerSupabaseClient).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: opts.user === false ? null : { id: UID } },
      }),
    },
    from,
  } as never);
  return { from };
}

describe("completeRegistrationJoinAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getClubBySlug).mockResolvedValue(CLUB);
    vi.mocked(lookupActiveJoinSession).mockResolvedValue({
      ok: true,
      sessionId: SID,
      name: "Thursday",
      clubSlug: "chillax",
    });
    vi.mocked(ensureClubMembership).mockResolvedValue({
      ok: true,
      joined: true,
      action: "created",
    });
    vi.mocked(joinQueueAction).mockResolvedValue({ success: true, action: "inserted" });
  });

  it("RJ-1 (negative): unauthenticated returns before any lookup", async () => {
    authClient({ user: false });
    const result = await completeRegistrationJoinAction({ clubSlug: "chillax", sessionId: SID });
    expect(result).toMatchObject({ success: false, code: "unauthenticated" });
    expect(getClubBySlug).not.toHaveBeenCalled();
    expect(joinQueueAction).not.toHaveBeenCalled();
  });

  it("RJ-2 (negative): invalid slug never looks up", async () => {
    authClient({ user: true, profile: { needs_rename: false } });
    const result = await completeRegistrationJoinAction({ clubSlug: "Not A Slug", sessionId: SID });
    expect(result).toMatchObject({ success: false, code: "invalid_input" });
    expect(getClubBySlug).not.toHaveBeenCalled();
  });

  it("RJ-3 (negative): inactive club refuses", async () => {
    authClient({ user: true, profile: { needs_rename: false } });
    vi.mocked(getClubBySlug).mockResolvedValue({ ...CLUB, is_active: false });
    const result = await completeRegistrationJoinAction({ clubSlug: "chillax" });
    expect(result).toMatchObject({ success: false, code: "club_inactive" });
    expect(ensureClubMembership).not.toHaveBeenCalled();
  });

  it("RJ-4 (negative): session/club mismatch never queues", async () => {
    authClient({ user: true, profile: { needs_rename: false } });
    vi.mocked(lookupActiveJoinSession).mockResolvedValue({
      ok: true,
      sessionId: SID,
      name: "Other",
      clubSlug: "other-club",
    });
    const result = await completeRegistrationJoinAction({ clubSlug: "chillax", sessionId: SID });
    expect(result).toMatchObject({ success: false, code: "session_club_mismatch" });
    expect(joinQueueAction).not.toHaveBeenCalled();
  });

  it("RJ-5 (negative): rename gate fires before membership/queue writes", async () => {
    authClient({ user: true, profile: { needs_rename: true } });
    const result = await completeRegistrationJoinAction({ clubSlug: "chillax", sessionId: SID });
    expect(result).toMatchObject({ success: false, requiresRename: true });
    if (!result.success && result.requiresRename) {
      expect(result.next).toBe(`/j/${SID}`);
    }
    expect(ensureClubMembership).not.toHaveBeenCalled();
    expect(joinQueueAction).not.toHaveBeenCalled();
  });

  it("RJ-6 (negative): missing profile fails closed", async () => {
    authClient({ user: true, profile: null });
    const result = await completeRegistrationJoinAction({ clubSlug: "chillax", sessionId: SID });
    expect(result).toMatchObject({ success: false, code: "profile_unavailable" });
    expect(ensureClubMembership).not.toHaveBeenCalled();
  });

  it("RJ-7: happy path returns destination and transition actions", async () => {
    authClient({ user: true, profile: { needs_rename: false, needs_name_confirm: false } });
    const result = await completeRegistrationJoinAction({ clubSlug: "chillax", sessionId: SID });
    expect(result).toEqual({
      success: true,
      destination: `/c/chillax/play/${SID}`,
      membershipAction: "created",
      queueAction: "inserted",
      joined: true,
    });
  });

  it("RJ-8: no-op membership + queue reports already-joined shape", async () => {
    authClient({ user: true, profile: { needs_rename: false, needs_name_confirm: false } });
    vi.mocked(ensureClubMembership).mockResolvedValue({
      ok: true,
      joined: false,
      action: "unchanged",
    });
    vi.mocked(joinQueueAction).mockResolvedValue({ success: true, action: "unchanged" });
    const result = await completeRegistrationJoinAction({ clubSlug: "chillax", sessionId: SID });
    expect(result).toMatchObject({
      success: true,
      membershipAction: "unchanged",
      queueAction: "unchanged",
      joined: false,
    });
  });
});
