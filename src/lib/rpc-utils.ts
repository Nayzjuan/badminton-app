/**
 * Returns true when a Supabase RPC error carries PGRST202, which
 * indicates the function does not exist in the database yet.
 * Used by every action that wraps a new atomic RPC with a graceful
 * fallback for environments where the migration hasn't been applied.
 */
export function isRpcNotFound(error: { code?: string } | null): boolean {
  return error?.code === "PGRST202";
}
