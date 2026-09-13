// ============================================================
// Join / share URL config — next.config headers + redirects
// ============================================================
// IDs: JSC-*
// The in-app-browser 404 is a routing/header problem. If someone
// "simplifies" next.config and drops the join exceptions, unit
// tests of repairEncodedQueryPath stay green and production 404s
// again. These pin the config itself.
// ============================================================

import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config";

const JOIN_SOURCES = [
  "/c/:clubSlug/join",
  "/c/:clubSlug/join/:sessionId",
  "/play/join",
  "/play/join/:sessionId",
  "/j/:sessionId",
];

describe("join-share next.config", () => {
  it("JSC-1: every public join source omits X-Frame-Options and allows framing", async () => {
    const headers = await nextConfig.headers!();
    const joinEntries = headers.filter((h) => JOIN_SOURCES.includes(h.source));
    expect(
      joinEntries.map((h) => h.source).sort(),
      "a join route lost its header override — in-app iframes will hit DENY again"
    ).toEqual([...JOIN_SOURCES].sort());

    for (const entry of joinEntries) {
      expect(
        entry.headers.find((h) => h.key === "X-Frame-Options"),
        `${entry.source} still sends X-Frame-Options`
      ).toBeUndefined();
      const csp = entry.headers.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
      expect(csp, `${entry.source} CSP`).toContain("frame-ancestors *");
      expect(csp, `${entry.source} CSP`).not.toContain("frame-ancestors 'none'");
    }
  });

  it("JSC-2: every other route still denies framing", async () => {
    const headers = await nextConfig.headers!();
    const locked = headers.find((h) => h.source.includes("?!j/"));
    expect(locked, "the catch-all exclusion for join routes is gone").toBeDefined();
    expect(locked!.headers.find((h) => h.key === "X-Frame-Options")?.value).toBe("DENY");
    expect(locked!.headers.find((h) => h.key === "Content-Security-Policy")?.value ?? "").toContain(
      "frame-ancestors 'none'"
    );
  });

  it("JSC-3: next.config does not 308 ?session= — Next forwards the query", async () => {
    const redirects = await nextConfig.redirects!();
    const play = redirects.find((r) => r.source === "/play/join" && r.has);
    expect(play, "a /play/join?session= config redirect re-prints ? on /j/").toBeUndefined();
    const club = redirects.find((r) => r.source === "/c/:slug/join" && r.has);
    expect(club, "a club ?session= config redirect re-prints ? on the path form").toBeUndefined();
  });
});
