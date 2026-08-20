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
// were all green — the type erases in every one of them. But Next's
// server-action transform collects the export SPECIFIERS of a "use server"
// module and emits them as runtime identifiers:
//
//     (0, o.ensureServerEntryExports)([F, G, H, I, J, K, L, NotificationType])
//
// `NotificationType` has no runtime binding, so that array references a free
// variable. The chunk died at module evaluation with
// `ReferenceError: NotificationType is not defined`, which took down the whole
// server-action entry for /c/[clubSlug]/organizer/[sessionId] — every organizer
// action on the route 500'd, including toggleAutoMatchmaking. It ran four days.
//
// ── Why this file checks a WHITELIST and not a blacklist ────────────────────
//
// The first version of this suite banned exactly the spelling that shipped the
// outage: `export type { X }` / `export { type X }`. That was measured and
// found insufficient. This variant —
//
//     import type { NotificationType } from "@/lib/notifications/push-server";
//     export { NotificationType };
//
// is TSC-clean (`isolatedModules` only raises TS1205 for the `… from "…"`
// form), lint-clean, was passed by that blacklist, built with `exit 0`, and
// emitted the byte-identical defect. It was reproduced against a real
// `npm run build` before this rewrite. `export * from "…"` is likewise
// TSC-clean and cannot be resolved to types-or-values by reading one file.
//
// So the rule here is stated positively: a "use server" module may export an
// async function, or an ERASABLE type/interface DECLARATION. It may not carry
// an export CLAUSE of any spelling, and it may not star-re-export. A clause is
// the only construct that produces an emitted specifier, and you cannot tell by
// reading one file whether the name behind it has a runtime binding.
//
//   US-1  no "use server" file carries an export clause or a star re-export
//   US-2  every export in a "use server" file is an allowed form
//   US-3  the detectors discriminate, so US-1/US-2 cannot pass by scanning
//         nothing — including the two variants that defeated the blacklist
//
// A behavioural test cannot reach any of this: the defect is in emitted bundle
// code, not in anything importable. For the complementary check that reads the
// BUILD OUTPUT — the only one that catches this class regardless of cause — see
// `scripts/check-server-entry-exports.mjs`.
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
 * Blank out comments so a commented-out `export { … }` is not reported. Block
 * comments are replaced with their own newlines to keep line numbers honest.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

/**
 * Export CLAUSES — the only construct that yields an emitted specifier. Covers
 * every spelling, because the hazard is the clause itself, not the `type`
 * keyword: `export { X }`, `export { type X }`, `export type { X }`, each with
 * or without a `from "…"`, on one line or many.
 *
 * A type ALIAS or INTERFACE DECLARATION is deliberately NOT matched — it
 * declares rather than re-exports and the transform drops it. The repo has ~60
 * of those in `"use server"` files and they are all fine; the `{` immediately
 * after `export`/`export type` is what discriminates the clause from the
 * declaration.
 */
const EXPORT_CLAUSE = /^[ \t]*export[ \t]*(?:type[ \t]*)?\{/gm;

/** `export * from "…"` / `export * as ns from "…"` — unresolvable by reading one file. */
const STAR_REEXPORT = /^[ \t]*export[ \t]*\*/gm;

/** Every `export …` line that is NOT one of the allowed forms. */
const ALLOWED_EXPORT =
  /^[ \t]*export[ \t]+(?:async[ \t]+function[ \t]|type[ \t]+[A-Za-z_$][\w$]*[ \t]*[=<]|interface[ \t])/;

function offendingClauses(src: string): string[] {
  const clean = stripComments(src);
  return [
    ...[...clean.matchAll(EXPORT_CLAUSE)].map((m) => m[0].trim()),
    ...[...clean.matchAll(STAR_REEXPORT)].map((m) => m[0].trim()),
  ];
}

function disallowedExportLines(src: string): string[] {
  return stripComments(src)
    .split("\n")
    .filter((line) => /^[ \t]*export[ \t]/.test(line))
    .map((line) => line.trim())
    .filter((line) => !ALLOWED_EXPORT.test(line));
}

const FILES = walk(SRC).map((file) => ({ file, src: fs.readFileSync(file, "utf8") }));
const USE_SERVER_FILES = FILES.filter(({ src }) => hasUseServer(src));
const CASES = USE_SERVER_FILES.map(
  ({ file, src }) => [path.relative(ROOT, file), src] as [string, string]
);

const WHY =
  `Next's server-action transform emits every export specifier of a "use server" ` +
  `module as a runtime identifier inside ensureServerEntryExports([...]). If the name ` +
  `behind the specifier is a type it has no runtime binding, the emitted array references ` +
  `a free variable, and the chunk throws ReferenceError at module evaluation — taking down ` +
  `EVERY server action bundled into that entry. You cannot tell from this file alone whether ` +
  `a re-exported name is a type or a value, so no export clause is permitted here. ` +
  `Declare types in a plain module and import them.`;

describe("US-1 — no export clause or star re-export in a use-server module", () => {
  it("finds the use-server modules to scan", () => {
    // Guards against the walker silently matching nothing after a refactor.
    expect(USE_SERVER_FILES.length).toBeGreaterThan(5);
  });

  it.each(CASES)("%s", (rel, src) => {
    const offenders = offendingClauses(src);
    expect(
      offenders,
      `${rel} carries "use server" and has ${offenders.join(", ")}. ${WHY}`
    ).toEqual([]);
  });
});

describe("US-2 — every export in a use-server module is an allowed form", () => {
  it.each(CASES)("%s", (rel, src) => {
    const offenders = disallowedExportLines(src);
    expect(
      offenders,
      `${rel} carries "use server" and exports something that is neither an async function ` +
        `nor an erasable type/interface declaration: ${offenders.join(" | ")}. ${WHY}`
    ).toEqual([]);
  });
});

describe("US-3 — the detectors discriminate", () => {
  it("recognises the use server directive behind a banner comment", () => {
    expect(hasUseServer('// banner\n\n"use server";\n\nexport async function a() {}')).toBe(true);
    expect(hasUseServer('"use client";\nexport function a() {}')).toBe(false);
    expect(hasUseServer("export async function a() {}")).toBe(false);
  });

  it("flags every spelling of an export clause", () => {
    expect(offendingClauses("export type { Foo };")).toHaveLength(1);
    expect(offendingClauses('export type { Foo } from "./bar";')).toHaveLength(1);
    expect(offendingClauses("export { type Foo };")).toHaveLength(1);
    expect(offendingClauses('export { type Foo, bar } from "./bar";')).toHaveLength(1);
    expect(offendingClauses("export type {\n  Foo,\n};")).toHaveLength(1);
    expect(offendingClauses("  export type { Foo };")).toHaveLength(1);
  });

  it("flags the two variants that defeated the earlier blacklist", () => {
    // Reproduced against a real `npm run build`: TSC-clean, exit 0, and the
    // emitted array still read [F,G,H,I,J,K,L,NotificationType].
    const valueSpelled = [
      '"use server";',
      'import type { NotificationType } from "@/lib/notifications/push-server";',
      "export { NotificationType };",
    ].join("\n");
    expect(offendingClauses(valueSpelled)).toEqual(["export {"]);

    // `isolatedModules` raises TS1205 only for the `… from "…"` form, so this
    // one reaches the bundler untouched by the type checker.
    expect(offendingClauses('export * from "./types";')).toEqual(["export *"]);
    expect(offendingClauses('export * as ns from "./types";')).toEqual(["export *"]);
  });

  it("does not flag a type alias declaration, an interface, or an async action", () => {
    expect(offendingClauses("export type ActionResult = { success: boolean };")).toEqual([]);
    expect(offendingClauses("export type Foo = string | number;")).toEqual([]);
    expect(offendingClauses("export interface TvSession { id: string }")).toEqual([]);
    expect(offendingClauses("export async function doThing() {}")).toEqual([]);

    expect(disallowedExportLines("export type ActionResult = { success: boolean };")).toEqual([]);
    expect(disallowedExportLines("export type Codes =\n  | 'a'\n  | 'b';")).toEqual([]);
    expect(disallowedExportLines("export type Result<T> = { v: T };")).toEqual([]);
    expect(disallowedExportLines("export interface TvSession { id: string }")).toEqual([]);
    expect(disallowedExportLines("export async function doThing() {}")).toEqual([]);
  });

  it("flags a non-async value export, which the transform cannot make a reference to", () => {
    expect(disallowedExportLines("export const CAP = 4;")).toEqual(["export const CAP = 4;"]);
    expect(disallowedExportLines("export function sync() {}")).toEqual([
      "export function sync() {}",
    ]);
  });

  it("ignores an export that only appears inside a comment", () => {
    expect(offendingClauses("// export type { Foo };")).toEqual([]);
    expect(offendingClauses("/*\nexport type { Foo };\n*/")).toEqual([]);
    expect(disallowedExportLines("// export const CAP = 4;")).toEqual([]);
  });

  it("would have caught the notifications.ts regression as shipped", () => {
    const original = [
      '"use server";',
      'import { pushToPlayers, type NotificationType } from "@/lib/notifications/push-server";',
      "",
      "export type { NotificationType };",
      "",
      "export type ActionResult = { success: boolean };",
    ].join("\n");
    expect(hasUseServer(original)).toBe(true);
    expect(offendingClauses(original)).toEqual(["export type {"]);
  });
});
