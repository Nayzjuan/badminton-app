// @vitest-environment happy-dom
// ============================================================
// Registration analytics — schema, canonicalization, dedupe
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@vercel/analytics", () => ({
  track: vi.fn(),
}));

import { track } from "@vercel/analytics";
import {
  canonicalizeAnalyticsPath,
  sanitizeRegistrationProps,
  trackRegistration,
  REGISTRATION_EVENT,
} from "@/lib/registration-analytics";

describe("canonicalizeAnalyticsPath", () => {
  it("strips query, fragment, and templates UUIDs and club slugs", () => {
    expect(
      canonicalizeAnalyticsPath(
        "https://app.example/j/00000000-0000-4000-8000-000000000001?next=/c/chillax/play"
      )
    ).toBe("/j/[id]");
    expect(canonicalizeAnalyticsPath("/c/chillax/play/00000000-0000-4000-8000-000000000001")).toBe(
      "/c/[clubSlug]/play/[id]"
    );
    expect(canonicalizeAnalyticsPath("/rename?next=%2Fj%2Fabc")).toBe("/rename");
    expect(canonicalizeAnalyticsPath("/auth/callback?code=xyz")).toBe("/auth/callback");
  });
});

describe("sanitizeRegistrationProps", () => {
  it("keeps the allowlisted enums and drops everything else", () => {
    expect(
      sanitizeRegistrationProps({
        step: "viewed",
        entry: "qr_session",
        method: "anonymous",
        outcome: "queue_joined",
        field: "name",
        email: "x@y.z",
        sessionId: "00000000-0000-4000-8000-000000000001",
      })
    ).toEqual({
      step: "viewed",
      entry: "qr_session",
      method: "anonymous",
      outcome: "queue_joined",
      field: "name",
    });
  });

  it("rejects unknown steps", () => {
    expect(sanitizeRegistrationProps({ step: "hacked", entry: "direct" })).toBeNull();
  });
});

describe("trackRegistration", () => {
  const prev = process.env.NEXT_PUBLIC_VERCEL_ANALYTICS;

  beforeEach(() => {
    vi.mocked(track).mockClear();
    sessionStorage.clear();
    process.env.NEXT_PUBLIC_VERCEL_ANALYTICS = "true";
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_VERCEL_ANALYTICS = prev;
  });

  it("no-ops when the public flag is off", () => {
    process.env.NEXT_PUBLIC_VERCEL_ANALYTICS = "false";
    trackRegistration({ step: "viewed", entry: "direct" });
    expect(track).not.toHaveBeenCalled();
  });

  it("dedupes viewed / identity_ready / completed in sessionStorage", () => {
    trackRegistration({ step: "viewed", entry: "direct" });
    trackRegistration({ step: "viewed", entry: "direct" });
    trackRegistration({ step: "identity_ready" });
    trackRegistration({ step: "identity_ready" });
    trackRegistration({ step: "completed", outcome: "profile_only" });
    trackRegistration({ step: "completed", outcome: "profile_only" });
    expect(track).toHaveBeenCalledTimes(3);
    expect(vi.mocked(track).mock.calls[0]?.[0]).toBe(REGISTRATION_EVENT);
  });

  it("accepts the profile_only completion outcome", () => {
    trackRegistration({ step: "completed", entry: "direct", outcome: "profile_only" });
    expect(track).toHaveBeenCalledWith(
      REGISTRATION_EVENT,
      expect.objectContaining({ step: "completed", outcome: "profile_only", entry: "direct" })
    );
  });

  it("swallows a throwing transport", () => {
    vi.mocked(track).mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => trackRegistration({ step: "started", entry: "direct" })).not.toThrow();
  });
});
