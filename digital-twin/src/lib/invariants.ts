/**
 * Build-time assertions for twin pages. Created in Stage 2 before any page
 * imports them. Missing file / unknown action / missing annotation / gotcha
 * mismatch throw here (and in extract --check / CI). Host-path existsSync
 * checks no-op when the host `src/` tree is absent (standalone twin deploy).
 */
import { existsSync } from "fs";
import { resolve } from "path";

export interface ManifestConst {
  name: string;
  value: unknown;
}

export interface ManifestLike {
  constants?: ManifestConst[];
  actionDetails?: { name: string }[];
  gotchas?: { id: string }[];
}

export function constByName(manifest: ManifestLike, name: string): ManifestConst {
  const found = (manifest.constants ?? []).find((c) => c.name === name);
  if (!found) {
    throw new Error(`[twin] missing constant ${name} in manifest.constants`);
  }
  return found;
}

export function hostSrcRoot(): string | null {
  const host = resolve(process.cwd(), "..", "src");
  return existsSync(resolve(host, "app")) ? host : null;
}

export function assertFilesExist(paths: string[], hostRoot = hostSrcRoot()): void {
  if (!hostRoot) return;
  for (const p of paths) {
    const full = p.startsWith("/") ? p : resolve(hostRoot, "..", p);
    if (!existsSync(full)) {
      throw new Error(`[twin] missing host file: ${p}`);
    }
  }
}

export function assertActionsExist(names: string[], manifest: ManifestLike): void {
  const have = new Set((manifest.actionDetails ?? []).map((a) => a.name));
  const missing = names.filter((n) => !have.has(n));
  if (missing.length) {
    throw new Error(`[twin] unknown action(s) in trace/page: ${missing.join(", ")}`);
  }
}

export function assertAnnotationCoverage(
  keys: string[],
  annotations: Record<string, unknown>
): void {
  const missing = keys.filter((k) => annotations[k] === undefined);
  if (missing.length) {
    throw new Error(`[twin] unannotated key(s): ${missing.join(", ")}`);
  }
}

export function assertGotchaParity(manifestIds: string[], expectedIds: string[]): void {
  const a = [...manifestIds].sort();
  const b = [...expectedIds].sort();
  if (a.length !== b.length || a.some((id, i) => id !== b[i])) {
    throw new Error(
      `[twin] gotcha set disagrees with sidecar/§9 (manifest ${a.join(",")} vs expected ${b.join(",")})`
    );
  }
}
