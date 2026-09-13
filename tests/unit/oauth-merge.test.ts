// ============================================================
// OAuth merge token + post-login path (OM)
// ============================================================
// OM-1  a token minted now reads back the same user id
// OM-2  (negative) a tampered signature is rejected
// OM-3  (negative) an expired token is rejected
// OM-4  (negative) garbage / missing tokens are rejected
// OM-5  oauthPostLoginPath sends confirm-pending to /rename?next=
// OM-6  oauthPostLoginPath leaves a resolved user on next
// OM-7  next is encoded so & cannot split query params
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMergeToken, readMergeToken } from "@/lib/oauth-merge";
import { oauthPostLoginPath } from "@/lib/oauth-provision";

const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const NOW = 1_700_000_000_000;

const PREV_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-merge-secret";
});

afterEach(() => {
  if (PREV_KEY === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = PREV_KEY;
});

describe("OM: merge token", () => {
  it("OM-1: a freshly minted token reads back the same user id", () => {
    const token = createMergeToken(ID, NOW);
    expect(readMergeToken(token, NOW)).toBe(ID);
  });

  it("OM-2 (negative): a tampered signature is rejected", () => {
    const token = createMergeToken(ID, NOW);
    const tampered = token.slice(0, -2) + "ff";
    expect(readMergeToken(tampered, NOW)).toBeNull();
  });

  it("OM-3 (negative): an expired token is rejected", () => {
    const token = createMergeToken(ID, NOW);
    expect(readMergeToken(token, NOW + 11 * 60 * 1000)).toBeNull();
  });

  it("OM-4 (negative): garbage and missing tokens are rejected", () => {
    expect(readMergeToken(undefined, NOW)).toBeNull();
    expect(readMergeToken("", NOW)).toBeNull();
    expect(readMergeToken("not-a-token", NOW)).toBeNull();
    expect(readMergeToken("not-a-uuid.1.abcd", NOW)).toBeNull();
  });
});

describe("OM: oauthPostLoginPath", () => {
  it("OM-5: confirm-pending is sent to /rename with encoded next", () => {
    expect(oauthPostLoginPath("/play", true)).toBe("/rename?next=%2Fplay");
  });

  it("OM-6: a resolved user stays on next", () => {
    expect(oauthPostLoginPath("/c/chillax", false)).toBe("/c/chillax");
  });

  it("OM-7: next is encoded so & cannot split the query", () => {
    expect(oauthPostLoginPath("/c/x/play/abc?tab=queue&x=1", true)).toBe(
      "/rename?next=%2Fc%2Fx%2Fplay%2Fabc%3Ftab%3Dqueue%26x%3D1"
    );
  });
});
