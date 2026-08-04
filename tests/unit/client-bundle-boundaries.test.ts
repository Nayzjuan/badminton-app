// @vitest-environment node
// ============================================================
// Unit Tests — client/server bundle boundaries (static analysis)
// ============================================================
// This file exists because of a bug that ran for months without a single
// error anywhere: `src/hooks/use-organizer-dashboard.ts` ("use client")
// imported `broadcastDraftCapPhase` from `@/lib/broadcast` and called it in
// the browser. Next.js does NOT inline `SUPABASE_SERVICE_ROLE_KEY` into a
// client bundle — it compiles to a runtime `process.env` read that is
// `undefined` — so every emit fell straight through the missing-key guard in
// postBroadcast and returned normally. The action reported success, no
// exception was thrown, no request was made, and the co-organizer draft-cap
// lockout overlay simply never appeared for anyone.
//
// A behavioural test can only ever pin the one call site that was fixed. This
// suite pins the CLASS: it reads the source tree off disk and asserts on the
// text, so the next hook that reaches for a service-role module fails here
// instead of silently no-op'ing in production.
//
// These are deliberately NOT runtime imports. Importing a "use client" module
// under Vitest resolves `server-only` to a stub (see vitest.config.ts) and
// runs in Node, where the service-role key IS present — i.e. the runtime
// environment cannot reproduce the browser's failure mode at all. Reading the
// text is the only place the boundary is observable from a unit test.
//
//   CB-1  no "use client" file value-imports @/lib/broadcast or
//         @/utils/supabase/service (type-only imports are fine — they erase)
//   CB-1b the directive detector and import classifier used by CB-1 actually
//         discriminate, so CB-1 cannot pass by scanning nothing
//   CB-2  src/lib/broadcast.ts still begins with `import "server-only"`
//   CB-3  src/lib/broadcast.ts carries no "use server" directive
// ============================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const BROADCAST = path.join(SRC, "lib", "broadcast.ts");

/**
 * Modules that must never reach a browser bundle. Matched on the tail of the
 * specifier so both the `@/…` alias and any relative spelling of the same file
 * are caught — an offender should not be able to hide behind `../lib/broadcast`.
 */
const SERVER_ONLY_MODULES = [
  { label: "@/lib/broadcast", tail: /(^|\/)lib\/broadcast(\.tsx?)?$/ },
  { label: "@/utils/supabase/service", tail: /(^|\/)utils\/supabase\/service(\.tsx?)?$/ },
];

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
 * First line of real code, with any leading blank lines, line comments and
 * block comments skipped. Every file in this repo opens with a banner comment,
 * so a naive "line 1" check would classify every single one of them as neither
 * client nor server.
 */
function firstCodeLine(src: string): string {
  let rest = src.replace(/^\uFEFF/, ""); // strip a byte-order mark, if any
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

function hasUseClient(src: string): boolean {
  return /^["']use client["']\s*;?$/.test(firstCodeLine(src));
}

/**
 * Every `import … from "x"` / `export … from "x"` / bare `import "x"`, as
 * {clause, module}. The clause character class excludes `;`, `=` and `(` so a
 * lazy match cannot start at an unrelated `export const …` earlier in the file
 * and swallow its way down to a later import's specifier.
 */
function importStatements(src: string): Array<{ clause: string; module: string }> {
  const out: Array<{ clause: string; module: string }> = [];
  // Side-effect import: no bindings, but it still executes the module, so it
  // is a value import for our purposes.
  for (const m of src.matchAll(/^[ \t]*import[ \t]*["']([^"']+)["']/gm)) {
    out.push({ clause: "", module: m[1] });
  }
  for (const m of src.matchAll(
    /^[ \t]*(?:import|export)[ \t]+([\w$*,{}\s]*?)[ \t\n\r]+from[ \t]*["']([^"']+)["']/gm
  )) {
    out.push({ clause: m[1], module: m[2] });
  }
  return out;
}

/**
 * True when the clause is erased at compile time — `import type { X }` or an
 * all-inline-`type` brace list. Anything else (default binding, namespace
 * import, a single value specifier alongside types) emits a real require and
 * drags the module into the bundle.
 */
function isTypeOnly(clause: string): boolean {
  const c = clause.trim();
  if (c === "") return false;
  if (/^type\b/.test(c)) return true;
  const braced = c.match(/^\{([\s\S]*)\}$/);
  if (!braced) return false;
  return braced[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .every((s) => /^type\s/.test(s));
}

const ALL_FILES = walk(SRC);

describe("client/server bundle boundaries", () => {
  it('CB-1 no "use client" file value-imports a server-only module', () => {
    const clientFiles = ALL_FILES.filter((f) => hasUseClient(fs.readFileSync(f, "utf8")));

    // Vacuity guards. A walker that silently returns nothing (wrong cwd, a
    // rename of src/, a directive regex that stops matching after a formatting
    // change) would make the real assertion below trivially true forever —
    // the guard would look green while guarding nothing.
    expect(ALL_FILES.length).toBeGreaterThan(0);
    expect(clientFiles.length).toBeGreaterThan(0);
    expect(ALL_FILES).toContain(BROADCAST);

    const offenders: string[] = [];
    for (const file of clientFiles) {
      const src = fs.readFileSync(file, "utf8");
      for (const { clause, module } of importStatements(src)) {
        const hit = SERVER_ONLY_MODULES.find((m) => m.tail.test(module));
        if (hit && !isTypeOnly(clause)) {
          offenders.push(
            `  ${path.relative(ROOT, file)} → value-imports "${module}" (${hit.label})`
          );
        }
      }
    }

    expect(
      offenders,
      [
        'A "use client" module value-imports a server-only module:',
        offenders.join("\n"),
        "",
        "Consequence: SUPABASE_SERVICE_ROLE_KEY is never inlined into a client",
        "bundle, so the imported code hits its missing-key guard and SILENTLY",
        "no-ops in the browser — success returned, nothing sent, no error. That",
        "is exactly how draft_cap_phase stayed dead and the co-organizer lockout",
        "overlay never engaged. And if the key ever WERE inlined, every visitor",
        "would be shipped a full RLS bypass in plain JavaScript.",
        "",
        "Fix: use `import type` for payload types (erased at compile time), or",
        "move the call into a server action that owns the emit.",
      ].join("\n")
    ).toEqual([]);
  });

  it("CB-1b the directive detector and import classifier discriminate", () => {
    // CB-1 is only as good as these two helpers. If either degrades to "always
    // false", CB-1 keeps passing on an empty or misclassified set — the failure
    // mode this whole file was written to prevent, reintroduced one level up.
    expect(hasUseClient('// banner\n\n/* block */\n"use client";\n')).toBe(true);
    expect(hasUseClient("'use client'\nimport x from 'y';\n")).toBe(true);
    expect(hasUseClient('"use server";\n')).toBe(false);
    expect(hasUseClient('import "server-only";\n"use client";\n')).toBe(false);

    expect(isTypeOnly("type { A }")).toBe(true);
    expect(isTypeOnly("{ type A, type B }")).toBe(true);
    expect(isTypeOnly("{ type A, doThing }")).toBe(false); // one value is enough
    expect(isTypeOnly("{ broadcastDraftCapPhase }")).toBe(false);
    expect(isTypeOnly("* as broadcast")).toBe(false);
    expect(isTypeOnly("")).toBe(false); // bare side-effect import

    // The bug as it was actually written, plus the shapes that must stay legal.
    const bad = 'import { broadcastDraftCapPhase } from "@/lib/broadcast";';
    const relative = 'import { createServiceClient } from "../../utils/supabase/service";';
    const good = 'import type { CapSaturationPayload } from "@/lib/broadcast";';
    const flagged = (src: string) =>
      importStatements(src).some(
        ({ clause, module }) =>
          SERVER_ONLY_MODULES.some((m) => m.tail.test(module)) && !isTypeOnly(clause)
      );
    expect(flagged(bad)).toBe(true);
    expect(flagged(relative)).toBe(true);
    expect(flagged(good)).toBe(false);
  });

  it('CB-2 src/lib/broadcast.ts begins with import "server-only"', () => {
    // The import is what upgrades a future mistake from a silent runtime no-op
    // into a BUILD failure: Next resolves `server-only` to a throwing module
    // under the client condition, so re-importing broadcast.ts from a "use
    // client" file breaks the build instead of shipping dead code. CB-1 catches
    // the direct case; this catches every transitive one CB-1 cannot see (a
    // server-looking module with no directive, pulled in by a client hook).
    const src = fs.readFileSync(BROADCAST, "utf8");
    expect(firstCodeLine(src)).toMatch(/^import\s+["']server-only["']\s*;?$/);
  });

  it('CB-3 src/lib/broadcast.ts carries no "use server" directive', () => {
    // Slapping "use server" on this module would compile and would appear to
    // fix the original bug by turning the client import into an RPC. It would
    // also publish all six broadcasters as ungated, POST-able Server Action
    // endpoints with no auth check — anyone holding an action id could forge
    // session_closed on any session UUID (kicking every player to Wrapped),
    // organizer_intervention, cap_saturation, and unbounded draft_cap_phase
    // locks. That forgery capability is precisely what migration
    // 20260723100000 closed by shipping NO INSERT policy on realtime.messages.
    //
    // Matched line-anchored on the raw source so the module's own prose warning
    // ("NEVER add \"use server\"…") does not trip it, while a real directive —
    // top-level or indented inside a function body — still does.
    const src = fs.readFileSync(BROADCAST, "utf8");
    expect(src).not.toMatch(/^[ \t]*["']use server["'][ \t]*;?[ \t]*$/m);

    // Sanity: the same matcher must actually fire on a real directive,
    // otherwise the assertion above is a no-op that can never fail.
    expect('"use server";\n').toMatch(/^[ \t]*["']use server["'][ \t]*;?[ \t]*$/m);
  });
});
