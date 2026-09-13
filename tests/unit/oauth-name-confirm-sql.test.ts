// ============================================================
// Suite OC — oauth_name_confirm.sql shape (no DB)
// ============================================================
// The migration is hand-applied. These assertions pin the load-bearing
// phrases so a rewrite cannot drop GRANT, backfill the wrong cohort, or
// turn merge_guest_play_into_profile into migrate_player_identity.
//
//   OC-1  authenticated/anon can SELECT needs_name_confirm
//   OC-2  historical backfill is Google-native only (no anonymous identity)
//   OC-3  merge does not INSERT INTO profiles (would overwrite the keeper)
//   OC-4  merge repoints sessions.created_by (no ON DELETE — DELETE fails)
//   OC-5  rename_player_identity clears BOTH flags
//   OC-6  rename infers oauth_confirm only on the confirm-only path
// ============================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SQL = readFileSync(
  resolve(__dirname, "..", "..", "supabase/migrations/20260913000000_oauth_name_confirm.sql"),
  "utf8"
);

function fnBody(name: string): string {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const nextCreate = SQL.indexOf("CREATE OR REPLACE FUNCTION public.", start + 1);
  return nextCreate === -1 ? SQL.slice(start) : SQL.slice(start, nextCreate);
}

describe("OC: oauth_name_confirm.sql", () => {
  it("OC-1: GRANT SELECT (needs_name_confirm) to authenticated, anon", () => {
    expect(SQL).toMatch(
      /GRANT SELECT \(needs_name_confirm\) ON public\.profiles TO authenticated, anon/
    );
  });

  it("OC-2: backfill requires google and excludes anonymous identities", () => {
    const start = SQL.indexOf("UPDATE public.profiles p");
    expect(start).toBeGreaterThan(-1);
    const end = SQL.indexOf("-- ── Audit reason CHECK", start);
    const backfill = SQL.slice(start, end === -1 ? undefined : end);
    expect(backfill).toMatch(/i\.provider = 'google'/);
    expect(backfill).toMatch(/NOT EXISTS/);
    expect(backfill).toMatch(/i\.provider = 'anonymous'/);
  });

  it("OC-3: merge_guest_play_into_profile does not INSERT INTO profiles", () => {
    const body = fnBody("merge_guest_play_into_profile");
    expect(body).not.toMatch(/INSERT INTO profiles/i);
    expect(body).not.toMatch(/INSERT INTO public\.profiles/i);
  });

  it("OC-4: merge repoints sessions.created_by before deleting the guest", () => {
    const body = fnBody("merge_guest_play_into_profile");
    const createdBy = body.indexOf("UPDATE sessions SET created_by = p_keeper_id");
    const del = body.indexOf("DELETE FROM profiles WHERE id = p_guest_id");
    expect(
      createdBy,
      "sessions.created_by is not moved — DELETE profiles will FK-fail"
    ).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(createdBy);
  });

  it("OC-5: rename_player_identity clears needs_rename AND needs_name_confirm", () => {
    const body = fnBody("rename_player_identity");
    expect(body).toMatch(/needs_rename\s+=\s+false/);
    expect(body).toMatch(/needs_name_confirm\s+=\s+false/);
  });

  it("OC-6: oauth_confirm is inferred only when confirm is set and rename is not", () => {
    const body = fnBody("rename_player_identity");
    expect(body).toMatch(/IF v_needs_confirm AND NOT v_needs_rename THEN/);
    expect(body).toMatch(/v_reason := 'oauth_confirm'/);
    expect(body).toMatch(/v_reason := 'duplicate_flag'/);
    expect(body).toMatch(/v_reason := 'self_chosen'/);
  });
});
