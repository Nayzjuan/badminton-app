// ============================================================
// Co-organizer invite token — shape, public columns, column lockdown
// ============================================================
// IDs: CIT-*
// The player share URL already publishes the session UUID. Encoding that
// UUID (or the spoken passcode) as the co-org admit secret would let a
// queue join become an organizer. These pin the token class itself.
// ============================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  generateCoOrganizerInviteToken,
  isCoOrganizerInviteTokenShape,
  CO_ORGANIZER_INVITE_TOKEN_RE,
  decodeInviteTokenParam,
} from "@/lib/co-organizer-invite";
import { PUBLIC_SESSION_COLUMNS } from "@/types/database";
import { sessionShare, sessionCoOrgShare } from "@/lib/club-paths";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

describe("co-organizer invite token", () => {
  it("CIT-1: minted tokens are 32-char base64url and not a session UUID", () => {
    const token = generateCoOrganizerInviteToken();
    expect(token).toHaveLength(32);
    expect(CO_ORGANIZER_INVITE_TOKEN_RE.test(token)).toBe(true);
    expect(isCoOrganizerInviteTokenShape(token)).toBe(true);
    expect(isCoOrganizerInviteTokenShape(SESSION_ID)).toBe(false);
    expect(isCoOrganizerInviteTokenShape("SMASH7")).toBe(false);
    expect(isCoOrganizerInviteTokenShape("")).toBe(false);
  });

  it("CIT-2: /j/[sessionId] cannot be rewritten into a valid /o/ admit token", () => {
    const playerPath = sessionShare(SESSION_ID);
    const id = playerPath.replace(/^\/j\//, "");
    expect(isCoOrganizerInviteTokenShape(id)).toBe(false);
    expect(sessionCoOrgShare(id)).not.toBe(playerPath);
  });

  it("CIT-3: PUBLIC_SESSION_COLUMNS omits both organizer secrets", () => {
    const cols = PUBLIC_SESSION_COLUMNS.split(",").map((c) => c.trim());
    expect(cols).not.toContain("organizer_passcode");
    expect(cols).not.toContain("co_organizer_invite_token");
    expect(cols).toContain("id");
    expect(cols).toContain("is_hidden");
  });

  it("CIT-4: the migration revokes SELECT on the invite token from anon and authenticated", () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), "supabase/migrations/20260918000000_co_organizer_invite_token.sql"),
      "utf8"
    );
    expect(sql).toMatch(/add column if not exists co_organizer_invite_token text/i);
    expect(sql).toMatch(
      /revoke select \(co_organizer_invite_token\) on public\.sessions from authenticated, anon/i
    );
    expect(sql).not.toMatch(/grant select \(co_organizer_invite_token\)/i);
    expect(sql).toMatch(/create or replace function public\.admit_session_organizer/i);
    expect(sql).toMatch(
      /grant execute on function public\.admit_session_organizer\(uuid, uuid\) to service_role/i
    );
    expect(sql).toMatch(
      /revoke execute on function public\.admit_session_organizer\(uuid, uuid\) from public, anon, authenticated/i
    );
  });

  it("CIT-4b: the grant lock asserts browser roles cannot EXECUTE admit_session_organizer", () => {
    const sql = fs.readFileSync(
      path.join(
        process.cwd(),
        "supabase/migrations/20260918000001_lock_admit_session_organizer_grants.sql"
      ),
      "utf8"
    );
    expect(sql).toMatch(
      /grant execute on function public\.admit_session_organizer\(uuid, uuid\) to service_role/i
    );
    expect(sql).toMatch(
      /revoke execute on function public\.admit_session_organizer\(uuid, uuid\) from public, anon, authenticated/i
    );
    expect(sql).toMatch(/has_function_privilege\('anon'/);
    expect(sql).toMatch(/has_function_privilege\('authenticated'/);
    expect(sql).toMatch(/has_function_privilege\('service_role'/);
  });

  it("CIT-5: a lone percent in a path segment does not throw", () => {
    expect(() => decodeInviteTokenParam("%")).not.toThrow();
    expect(isCoOrganizerInviteTokenShape(decodeInviteTokenParam("%"))).toBe(false);
  });
});
