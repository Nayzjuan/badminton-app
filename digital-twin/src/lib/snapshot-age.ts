/**
 * Snapshot freshness for /rls and /schema-drift.
 * Computed at Astro build time (D10): a stale snapshot is a page warning,
 * never an extract --check / Vercel-build throw.
 */

export function describeSnapshotAge(
  capturedAt: string,
  migrationDates: string[]
): { ageDays: number | null; newestMigrationDate: string; stale: boolean } {
  const newestMigrationDate = migrationDates.reduce((a, d) => (d > a ? d : a), "");
  const iso = capturedAt.length === 10 ? `${capturedAt}T00:00:00Z` : capturedAt;
  const capturedMs = Date.parse(iso);
  const ageDays = Number.isFinite(capturedMs)
    ? Math.max(0, Math.floor((Date.now() - capturedMs) / 86_400_000))
    : null;
  const capturedDay = capturedAt.slice(0, 10);
  const stale = Boolean(capturedDay && newestMigrationDate && capturedDay < newestMigrationDate);
  return { ageDays, newestMigrationDate, stale };
}
