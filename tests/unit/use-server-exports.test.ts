// @vitest-environment node
// ============================================================
// Unit Tests — "use server" export shape (static analysis)
// ============================================================
// This file exists because of a production outage that nothing in the repo
// could see. `src/app/actions/notifications.ts` carries "use server" and had
// one line of pure type plumbing:
//
//     export type { NotificationType };
//
// `npx tsc --noEmit`, `npm run lint`, `npm run test:unit` and `npm run build`
// were all green — the type erases in every one of those. But Next's
// server-action transform collects the export SPECIFIERS of a "use server"
// module and emits them as runtime identifiers:
//
//     (0, o.ensureServerEntryExports)([F, G, H, I, J, K, L, NotificationType])
//
// `NotificationType` has no runtime binding, so that array references a free
// variable. The chunk died at module evaluation with
// `ReferenceError: NotificationType is not defined`, which took down the whole
// server-action entry for /c/[clubSlug]/organizer/[sessionId] — every organizer
// action on the route 500'd, including toggleAutoMatchmaking. The only symptom
// an organizer saw was the Auto toggle snapping back to "Auto On", and no
// request ever reached Postgres. It ran for four days.
//
// A behavioural test cannot reach this: the defect is in emitted bundle code,
// not in anything importable. Reading the source text is the only place it is
// observable from a unit test.
//
//   US-1  no "use server" file re-exports a type via an export clause
//   US-2  the directive detector and clause matcher used by US-1 actually
//         discriminate, so US-1 cannot pass by scanning nothing
// ============================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");

// ── Tiny source walker ────────────────────────────────────────

/** Every .ts/.tsx under `dir`, skipping node_modules, .next and dot-dirs. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === ".next") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * First line of real code, with leading blank lines, line comments and block
 * comments skipped. Every file in this repo opens with a banner comment, so a
 * naive "line 1" check would classify all of them as neither client nor server.
 */
function firstCodeLine(src: string): string {
  let rest = src.replace(/^﻿/, ""); // strip a byte-order mark, if any
  for (;;) {
    const next = rest
      .replace(/^\s+/, "")
      .replace(/^\/\/[^\n]*\n?/, "")
      .replace(/^\/\*[\s\S]*?\*\//, "");
    if (next === rest) break;
    rest = next;
  }
  return rest.split("\n")[0].trim();
}

function hasUseServer(src: string): boolean {
  return /^["']use server["']\s*;?$/.test(firstCodeLine(src));
}

/**
 * Type-only export CLAUSES — the shape the transform mishandles. Two spellings
 * reach the same emitted identifier:
 *
 *     export type { X };            export type { X } from "…";
 *     export { type X };            export { type X } from "…";
 *
 * A type ALIAS DECLARATION (`export type ActionResult = { … }`) is a different
 * production and is NOT matched: it declares rather than re-exports, and the
 * transform drops it cleanly. `notifications.ts` still carries several, and
 * they are fine. The `{` in the first alternative is what discriminates the
 * clause from the declaration.
 */
const TYPE_EXPORT_CLAUSE =
  /^[ \t]*export[ \t]+type[ \t]*\{|^[ \t]*export[ \t]*\{[^}]*\btype[ \t]+/gm;

function typeExportClauses(src: string): string[] {
  return [...src.matchAll(TYPE_EXPORT_CLAUSE)].map((m) => m[0].trim());
}

const FILES = walk(SRC).map((file) => ({ file, src: fs.readFileSync(file, "utf8") }));
const USE_SERVER_FILES = FILES.filter(({ src }) => hasUseServer(src));

describe('US-1 — no "use server" file re-exports a type via an export clause', () => {
  it("finds the use-server modules to scan", () => {
    // Guards against the walker silently matching nothing after a refactor.
    expect(USE_SERVER_FILES.length).toBeGreaterThan(5);
  });

  it.each(USE_SERVER_FILES.map(({ file, src }) => [path.relative(ROOT, file), src] as const))(
    "%s",
    (rel, src) => {
      const offenders = typeExportClauses(src);
      expect(
        offenders,
        `${rel} carries "use server" and re-exports a type via an export clause ` +
          `(${offenders.join(", ")}). Next's server-action transform emits every export ` +
          `specifier of a "use server" module as a runtime identifier inside ` +
          `ensureServerEntryExports([...]); a type has no runtime binding, so the chunk ` +
          `throws ReferenceError at module evaluation and every server action bundled ` +
          `with it dies. Move the type to a plain module and import it from there.`
      ).toEqual([]);
    }
  );
});

describe("US-2 — the detectors discriminate", () => {
  it("recognises the use server directive behind a banner comment", () => {
    expect(hasUseServer('// banner\n\n"use server";\n\nexport async function a() {}')).toBe(true);
    expect(hasUseServer('"use client";\nexport function a() {}')).toBe(false);
    expect(hasUseServer("export async function a() {}")).toBe(false);
  });

  it("flags both spellings of a type-only export clause", () => {
    expect(typeExportClauses("export type { Foo };")).toHaveLength(1);
    expect(typeExportClauses('export type { Foo } from "./bar";')).toHaveLength(1);
    expect(typeExportClauses("export { type Foo };")).toHaveLength(1);
    expect(typeExportClauses('export { type Foo, bar } from "./bar";')).toHaveLength(1);
  });

  it("does not flag a type alias declaration or a value export", () => {
    expect(typeExportClauses("export type ActionResult = { success: boolean };")).toEqual([]);
    expect(typeExportClauses("export type Foo = string | number;")).toEqual([]);
    expect(typeExportClauses("export async function doThing() {}")).toEqual([]);
    expect(typeExportClauses('export { doThing } from "./thing";')).toEqual([]);
  });

  it("would have caught the notifications.ts regression", () => {
    // The exact line that shipped the outage, in its original context.
    const original = [
      '"use server";',
      'import { pushToPlayers, type NotificationType } from "@/lib/notifications/push-server";',
      "",
      "export type { NotificationType };",
      "",
      "export type ActionResult = { success: boolean };",
    ].join("\n");
    expect(hasUseServer(original)).toBe(true);
    expect(typeExportClauses(original)).toEqual(["export type {"]);
  });
});
