// Extend Vitest's `expect` with @testing-library/jest-dom matchers
// (toBeInTheDocument, toBeVisible, toHaveTextContent, etc.)
// This file is referenced from vitest.config.ts via setupFiles.
import "@testing-library/jest-dom/vitest";

// ── Async-query patience ──────────────────────────────────────
// Testing Library's waitFor/findBy default to a 1000 ms budget, which is
// generous on an idle machine and far too tight on a loaded one. Six unit
// suites run concurrently reproduce EM-3/EM-5/EM-6 and QRP-S2 as red on
// roughly half of runs, every time with a "Timed out"/"Unable to find"
// message rather than a failed assertion.
//
// A test that goes red for reasons unrelated to the behaviour it names is
// worse than a missing test: the next red gets waved through as "just the
// flaky one". Raising the budget weakens nothing — the assertions are
// unchanged, and a genuinely broken component still fails, just later.
//
// Guarded on `document` because vitest.config.ts sets environment: "node"
// globally and only the component suites opt into happy-dom via a
// `@vitest-environment` docblock; importing RTL under node is pointless.
if (typeof document !== "undefined") {
  const { configure } = await import("@testing-library/react");
  configure({ asyncUtilTimeout: 5_000 });
}
