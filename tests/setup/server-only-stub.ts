// Empty stub for the `server-only` package under Vitest.
//
// `server-only` is a real Next.js dependency that guards modules from being
// imported into client bundles. It is resolved by the Next build, but not by
// Vitest's module graph — so any test that loads a real module importing it
// (e.g. src/lib/notifications/push-server.ts) would fail with ERR_MODULE_NOT_FOUND.
// vitest.config.ts aliases "server-only" to this no-op module to keep those
// server modules importable in tests. Build behaviour is unaffected.
export {};
