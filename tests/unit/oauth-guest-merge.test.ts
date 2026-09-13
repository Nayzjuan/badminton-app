// ============================================================
// Suite GM — mergeGuestPlayIntoKeeper (identity_already_exists)
// ============================================================
//   GM-1  same id is a no-op — no RPC, no deleteUser
//   GM-2  success calls merge_guest_play_into_profile then deleteUser
//   GM-3  (negative) never calls migrate_player_identity
//   GM-4  (negative) RPC refusal does not delete the guest auth row
//   GM-5  (negative) transport error does not delete the guest auth row
// ============================================================

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/utils/supabase/service", () => ({ createServiceClient: vi.fn() }));

import { createServiceClient } from "@/utils/supabase/service";
import { mergeGuestPlayIntoKeeper } from "@/lib/oauth-guest-merge";

const GUEST = "11111111-1111-4111-8111-111111111111";
const KEEPER = "22222222-2222-4222-8222-222222222222";

type RpcCall = { fn: string; args: Record<string, unknown> };

function useService(opts: {
  rpc?: { data?: unknown; error?: { message: string } | null };
  deleteError?: { message: string } | null;
}) {
  const rpcCalls: RpcCall[] = [];
  const deleteUser = vi.fn().mockResolvedValue({ error: opts.deleteError ?? null });
  const rpc = vi.fn((fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    return Promise.resolve(opts.rpc ?? { data: { success: true }, error: null });
  });
  vi.mocked(createServiceClient).mockReturnValue({
    rpc,
    auth: { admin: { deleteUser } },
  } as unknown as ReturnType<typeof createServiceClient>);
  return { rpcCalls, deleteUser };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("GM: mergeGuestPlayIntoKeeper", () => {
  it("GM-1: same id is a no-op", async () => {
    const svc = useService({});
    expect(await mergeGuestPlayIntoKeeper(KEEPER, KEEPER)).toEqual({ success: true });
    expect(svc.rpcCalls).toEqual([]);
    expect(svc.deleteUser).not.toHaveBeenCalled();
  });

  it("GM-2: success calls merge_guest_play_into_profile then deleteUser(guest)", async () => {
    const svc = useService({ rpc: { data: { success: true }, error: null } });

    expect(await mergeGuestPlayIntoKeeper(GUEST, KEEPER)).toEqual({ success: true });
    expect(svc.rpcCalls).toEqual([
      { fn: "merge_guest_play_into_profile", args: { p_guest_id: GUEST, p_keeper_id: KEEPER } },
    ]);
    expect(svc.deleteUser).toHaveBeenCalledTimes(1);
    expect(svc.deleteUser).toHaveBeenCalledWith(GUEST);
  });

  it("GM-3 (negative): never calls migrate_player_identity", async () => {
    const svc = useService({ rpc: { data: { success: true }, error: null } });
    await mergeGuestPlayIntoKeeper(GUEST, KEEPER);
    expect(svc.rpcCalls.map((c) => c.fn)).not.toContain("migrate_player_identity");
  });

  it("GM-4 (negative): RPC refusal does not delete the guest auth row", async () => {
    const svc = useService({
      rpc: { data: { success: false, error: "guest_is_organizer" }, error: null },
    });
    expect(await mergeGuestPlayIntoKeeper(GUEST, KEEPER)).toEqual({ success: false });
    expect(svc.deleteUser).not.toHaveBeenCalled();
  });

  it("GM-5 (negative): a transport error does not delete the guest auth row", async () => {
    const svc = useService({ rpc: { data: null, error: { message: "boom" } } });
    expect(await mergeGuestPlayIntoKeeper(GUEST, KEEPER)).toEqual({ success: false });
    expect(svc.deleteUser).not.toHaveBeenCalled();
  });
});
