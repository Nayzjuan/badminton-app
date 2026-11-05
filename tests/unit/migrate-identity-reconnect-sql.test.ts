// ============================================================
// Suite MI-R — migrate_identity_reconnect_fkeys.sql shape (no DB)
// ============================================================
// The live reconnect RPC is hand-applied. These assertions pin the phrases
// that stop a correct-PIN reconnect from returning
// "Failed to migrate account. Please try again."
//
//   MI-R-1  SECURITY DEFINER (20260913 CREATE OR REPLACE dropped it)
//   MI-R-2  EXECUTE is service_role only
//   MI-R-3  no-CASCADE FKs update before DELETE old, not in a savepoint
//   MI-R-4  active-organizer tombstone does not restore needs_rename=false
//   MI-R-5  INSERT still copies needs_name_confirm
// ============================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = "20261105000000_migrate_identity_reconnect_fkeys.sql";
const SQL = readFileSync(resolve(__dirname, "..", "..", "supabase/migrations", FILE), "utf8");

function fnBody(): string {
  const start = SQL.indexOf("CREATE OR REPLACE FUNCTION public.migrate_player_identity");
  expect(start, "migrate_player_identity not found").toBeGreaterThan(-1);
  const end = SQL.indexOf("$function$;", start);
  expect(end, "function terminator not found").toBeGreaterThan(start);
  return SQL.slice(start, end);
}

describe("MI-R: migrate_player_identity reconnect hardening", () => {
  it("MI-R-1: SECURITY DEFINER is on the CREATE", () => {
    const hdr = SQL.slice(
      SQL.indexOf("CREATE OR REPLACE FUNCTION public.migrate_player_identity"),
      SQL.indexOf("AS $function$")
    );
    expect(hdr).toMatch(/SECURITY DEFINER/);
  });

  it("MI-R-2: EXECUTE granted to service_role, revoked from PUBLIC/anon/authenticated", () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.migrate_player_identity\(uuid, uuid\) FROM PUBLIC, anon, authenticated/
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.migrate_player_identity\(uuid, uuid\) TO service_role/
    );
  });

  it("MI-R-3: clubs/invites/invited_by updates are fatal and precede DELETE old", () => {
    const body = fnBody();
    const clubs = body.lastIndexOf("UPDATE clubs SET created_by");
    const invited = body.lastIndexOf("UPDATE club_members SET invited_by");
    const invitesCreated = body.lastIndexOf("UPDATE club_invites SET created_by");
    const invitesConsumed = body.lastIndexOf("UPDATE club_invites SET consumed_by");
    const del = body.lastIndexOf("DELETE FROM profiles WHERE id = p_old_user_id");
    expect(clubs).toBeGreaterThan(-1);
    expect(invited).toBeGreaterThan(-1);
    expect(invitesCreated).toBeGreaterThan(-1);
    expect(invitesConsumed).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(clubs);
    expect(del).toBeGreaterThan(invited);
    expect(del).toBeGreaterThan(invitesCreated);
    expect(del).toBeGreaterThan(invitesConsumed);
    const between = body.slice(Math.min(clubs, invited, invitesCreated, invitesConsumed), del);
    expect(between).not.toMatch(/EXCEPTION WHEN/);
  });

  it("MI-R-4: organizer tombstone does not restore needs_rename=false", () => {
    const body = fnBody();
    expect(body).not.toMatch(/needs_rename\s*=\s*false\s*WHERE\s+id\s*=\s*p_old_user_id/);
    expect(body).toMatch(/DELETE FROM profiles WHERE id = p_old_user_id/);
  });

  it("MI-R-5: INSERT copies needs_name_confirm", () => {
    const body = fnBody();
    const insertIdx = body.indexOf("INSERT INTO profiles (");
    expect(insertIdx).toBeGreaterThan(-1);
    const close = body.indexOf(")", insertIdx);
    const cols = body.slice(insertIdx, close);
    expect(cols).toMatch(/needs_name_confirm/);
  });
});
