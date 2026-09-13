// ============================================================
// Public join shims — query → path, /play/join/[id] → /j/[id],
// /j/[id] bounces a dead session to /play
// ============================================================
// IDs: JS-*
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

class NavError extends Error {}

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new NavError(`REDIRECT:${url}`);
  }),
  permanentRedirect: vi.fn((url: string) => {
    throw new NavError(`PERMANENT:${url}`);
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
vi.mock("@/components/join/club-join-screen", () => ({
  ClubJoinScreen: vi.fn(() => null),
}));

import { lookupActiveJoinSession } from "@/lib/resolve-session-join";
import JoinShim from "@/app/play/join/page";
import PlayJoinAlias from "@/app/play/join/[sessionId]/page";
import ShortJoinPage from "@/app/j/[sessionId]/page";
import ClubJoinPage from "@/app/c/[clubSlug]/join/page";

const SID = "00000000-0000-4000-8000-000000000001";

async function dest(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "FELL_THROUGH";
  } catch (e) {
    if (e instanceof NavError) return e.message;
    throw e;
  }
}

describe("join shims", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("JS-1: /play/join?session=<uuid> permanently redirects to /j/<uuid>", async () => {
    expect(await dest(() => JoinShim({ searchParams: Promise.resolve({ session: SID }) }))).toBe(
      `PERMANENT:/j/${SID}`
    );
  });

  it("JS-2: /play/join with no / bad session goes to /play", async () => {
    expect(await dest(() => JoinShim({ searchParams: Promise.resolve({}) }))).toBe(
      "REDIRECT:/play"
    );
    expect(await dest(() => JoinShim({ searchParams: Promise.resolve({ session: "nope" }) }))).toBe(
      "REDIRECT:/play"
    );
  });

  it("JS-3: /play/join/<id> permanently redirects to /j/<id>", async () => {
    expect(await dest(() => PlayJoinAlias({ params: Promise.resolve({ sessionId: SID }) }))).toBe(
      `PERMANENT:/j/${SID}`
    );
  });

  it("JS-4: /j/<id> with a live session renders (does not redirect)", async () => {
    vi.mocked(lookupActiveJoinSession).mockResolvedValue({
      ok: true,
      sessionId: SID,
      name: "Thursday",
      clubSlug: "chillax",
    });
    expect(await dest(() => ShortJoinPage({ params: Promise.resolve({ sessionId: SID }) }))).toBe(
      "FELL_THROUGH"
    );
  });

  it("JS-5: /j/<id> with a dead session redirects to /play", async () => {
    vi.mocked(lookupActiveJoinSession).mockResolvedValue({ ok: false });
    expect(await dest(() => ShortJoinPage({ params: Promise.resolve({ sessionId: SID }) }))).toBe(
      "REDIRECT:/play"
    );
  });

  it("JS-6: /c/<slug>/join?session=<uuid> permanently redirects to the path form", async () => {
    expect(
      await dest(() =>
        ClubJoinPage({
          params: Promise.resolve({ clubSlug: "chillax" }),
          searchParams: Promise.resolve({ session: SID }),
        })
      )
    ).toBe(`PERMANENT:/c/chillax/join/${SID}`);
  });
});
