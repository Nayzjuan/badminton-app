// ============================================================
// ClubJoinScreen — unauthenticated form vs authenticated finalizer
// ============================================================
// Authenticated players with a profile render JoinFinalizer and must
// not mutate membership/queue during the Server Component render.
// Unauthenticated / profileless visitors still see LoginForm.
//
//   CJS-1  authenticated + profile → JoinFinalizer, no queue upsert
//   CJS-2  session context is passed through to the finalizer
//   CJS-3  club-only join still renders the finalizer (no sessionId)
//   CJS-4  no user → LoginForm
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

class NavError extends Error {}

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new NavError(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new NavError("NOT_FOUND");
  }),
}));

vi.mock("@/lib/resolve-session-join", () => ({
  lookupActiveJoinSession: vi.fn(),
}));

vi.mock("@/lib/clubs", () => ({
  getClubBySlug: vi.fn(),
  ensureClubMembership: vi.fn(),
}));

vi.mock("@/utils/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
}));

vi.mock("@/components/login-form", () => ({
  LoginForm: (props: { sessionId?: string; clubSlug?: string }) => (
    <div data-testid="login-form" data-session={props.sessionId ?? ""} data-club={props.clubSlug} />
  ),
}));

vi.mock("@/components/join/join-finalizer", () => ({
  JoinFinalizer: (props: { clubSlug: string; sessionId?: string }) => (
    <div
      data-testid="join-finalizer"
      data-club={props.clubSlug}
      data-session={props.sessionId ?? ""}
    />
  ),
}));

import { lookupActiveJoinSession } from "@/lib/resolve-session-join";
import { getClubBySlug, ensureClubMembership } from "@/lib/clubs";
import { createServerSupabaseClient } from "@/utils/supabase/server";
import { ClubJoinScreen } from "@/components/join/club-join-screen";
import { renderToStaticMarkup } from "react-dom/server";

const SID = "00000000-0000-4000-8000-000000000001";
const UID = "00000000-0000-4000-8000-00000000d0e5";

function supabaseMock(opts: { user: boolean; profile: boolean }) {
  const upsert = vi.fn().mockResolvedValue({ data: null, error: null });
  const client = {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: opts.user ? { id: UID } : null },
      }),
    },
    from: vi.fn((table: string) => {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: opts.profile ? { id: UID } : null }),
            }),
          }),
        };
      }
      if (table === "queue_entries") {
        return { upsert };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };
  vi.mocked(createServerSupabaseClient).mockResolvedValue(
    client as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>
  );
  return { upsert };
}

describe("ClubJoinScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getClubBySlug).mockResolvedValue({
      id: "club-1",
      slug: "chillax",
      name: "Chillax",
      is_active: true,
    } as Awaited<ReturnType<typeof getClubBySlug>>);
    vi.mocked(lookupActiveJoinSession).mockResolvedValue({
      ok: true,
      sessionId: SID,
      name: "Thursday",
      clubSlug: "chillax",
    });
  });

  it("CJS-1: authenticated profile renders JoinFinalizer and never upserts", async () => {
    const { upsert } = supabaseMock({ user: true, profile: true });
    const html = renderToStaticMarkup(
      await ClubJoinScreen({ clubSlug: "chillax", sessionId: SID })
    );
    expect(html).toContain("join-finalizer");
    expect(html).toContain(`data-session="${SID}"`);
    expect(html).not.toContain("login-form");
    expect(ensureClubMembership).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("CJS-2: session lookup is bound onto the finalizer", async () => {
    supabaseMock({ user: true, profile: true });
    const html = renderToStaticMarkup(
      await ClubJoinScreen({ clubSlug: "chillax", sessionId: SID })
    );
    expect(html).toContain(`data-club="chillax"`);
    expect(html).toContain(`data-session="${SID}"`);
  });

  it("CJS-3: club-only join renders the finalizer without a session id", async () => {
    const { upsert } = supabaseMock({ user: true, profile: true });
    const html = renderToStaticMarkup(await ClubJoinScreen({ clubSlug: "chillax" }));
    expect(html).toContain("join-finalizer");
    expect(html).toContain('data-session=""');
    expect(upsert).not.toHaveBeenCalled();
  });

  it("CJS-4: anonymous visitor sees LoginForm, not the finalizer", async () => {
    supabaseMock({ user: false, profile: false });
    const html = renderToStaticMarkup(
      await ClubJoinScreen({ clubSlug: "chillax", sessionId: SID })
    );
    expect(html).toContain("login-form");
    expect(html).not.toContain("join-finalizer");
  });

  it("CJS-5: a cross-club session is dropped so LoginForm does not inherit it", async () => {
    supabaseMock({ user: false, profile: false });
    vi.mocked(lookupActiveJoinSession).mockResolvedValue({
      ok: true,
      sessionId: SID,
      name: "Other club night",
      clubSlug: "other-club",
    });
    const html = renderToStaticMarkup(
      await ClubJoinScreen({ clubSlug: "chillax", sessionId: SID })
    );
    expect(html).toContain("login-form");
    expect(html).toContain('data-session=""');
    expect(html).not.toContain("Other club night");
  });
});
