/**
 * Playwright globalTeardown — the last-resort sandbox sweep.
 *
 * Per-spec `afterAll` hooks are the primary cleanup path, but they are skipped
 * whenever a run does not end normally: Ctrl-C, a hard 60 s test timeout that
 * kills the worker, or a crash. Scenario I alone creates 50 bot accounts in the
 * production `profiles` / `auth.users` tables, so a skipped cleanup strands
 * them in a real club until someone happens to run the suite again.
 *
 * This runs once after all specs, whatever the outcome, and delegates to the
 * same guarded `resetSandboxSession()` the specs use — so it inherits both hard
 * guardrails (TEST_SESSION_ID must be set, and the session name must start with
 * "🤖 E2E SANDBOX"). It never throws: a teardown failure must not mask the real
 * test results, so it logs loudly and returns.
 */
import { resetSandboxSession } from "./teardown";

export default async function globalTeardown(): Promise<void> {
  try {
    await resetSandboxSession();
    console.log("[global-teardown] Sandbox session reset.");
  } catch (err) {
    console.error(
      "[global-teardown] FAILED to reset the sandbox. Bot accounts may still " +
        "exist in production. Run `npx tsx tests/helpers/emergency-cleanup.ts --yes`.",
      err
    );
  }
}
