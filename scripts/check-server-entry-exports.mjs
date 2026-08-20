#!/usr/bin/env node
// ============================================================
// check-server-entry-exports.mjs
// ============================================================
// Reads the BUILD OUTPUT and fails if a server-action entry array references an
// identifier that has no binding in its own chunk.
//
// Why this exists when tests/unit/use-server-exports.test.ts already checks the
// source: that suite bans the source SHAPES known to produce a free identifier.
// This one asserts the property that actually matters — every name Next emitted
// is defined — so it catches the class regardless of which construct produced
// it, including constructs nobody has thought of yet, and including a defect
// introduced by a bundler or dependency change with no source diff at all.
//
// The outage it is named for: `export type { NotificationType };` in a
// "use server" module made Next emit
//
//     (0, o.ensureServerEntryExports)([F, G, H, I, J, K, L, NotificationType])
//
// where F…L are real chunk-local functions and NotificationType is a type that
// erased. The chunk threw ReferenceError at module evaluation and every server
// action bundled into that entry 500'd for four days. `next build` EMITS these
// chunks but never EVALUATES them, so the build exits 0 — and tsc, eslint and
// vitest all erase the type before they ever see it. Nothing else in this repo
// reads the emitted output.
//
// Usage — needs a completed build, so run it after one:
//
//     npm run build && node scripts/check-server-entry-exports.mjs
//
// Exit 0 = every emitted identifier is bound.
// Exit 1 = a free variable, named, with its chunk.
// Exit 2 = nothing to check (no build output, or no entry arrays found). That
//          is a failure too: silently checking zero chunks is how a guard rots
//          into decoration. If Next renames the helper, update ENTRY_ARRAY —
//          do not let this pass by scanning nothing.
// ============================================================

import fs from "node:fs";
import path from "node:path";

// Scan all of .next/server, not one chunk directory. Turbopack and Webpack put
// SSR chunks in different places and the layout moves between Next versions; a
// hard-coded subdirectory would turn a layout change into a spurious exit 2 on
// a production deploy.
const SERVER_DIR = path.join(process.cwd(), ".next", "server");
const ENTRY_ARRAY = /ensureServerEntryExports\)?\(\[([^\]]*)\]/g;

/** Every .js file under `dir`. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/** Is there a binding for `name` anywhere in this chunk? */
function isBound(source, name) {
  const declared = new RegExp(
    `(?:var|let|const|function|class)\\s+${name}\\b` + // var X / function X / class X
      `|\\b${name}\\s*=` + //                            X = …  (assignment form)
      `|function\\s*\\*?\\s*${name}\\b`, //              generator
    "m"
  );
  return declared.test(source);
}

function main() {
  if (!fs.existsSync(SERVER_DIR)) {
    console.error(`[check-server-entry-exports] no build output at ${SERVER_DIR}`);
    console.error("[check-server-entry-exports] run `npm run build` first.");
    process.exit(2);
  }

  const chunks = walk(SERVER_DIR);
  const failures = [];
  let arraysChecked = 0;
  let namesChecked = 0;

  for (const full of chunks) {
    const source = fs.readFileSync(full, "utf8");
    if (!source.includes("ensureServerEntryExports")) continue;

    for (const match of source.matchAll(ENTRY_ARRAY)) {
      arraysChecked += 1;
      const names = match[1]
        .split(",")
        .map((n) => n.trim())
        .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n)); // identifiers only

      for (const name of names) {
        namesChecked += 1;
        if (!isBound(source, name)) {
          failures.push({
            file: path.relative(process.cwd(), full),
            name,
            array: match[0].slice(0, 120),
          });
        }
      }
    }
  }

  if (arraysChecked === 0) {
    console.error("[check-server-entry-exports] found 0 server-entry arrays under");
    console.error(`  ${SERVER_DIR}  (${chunks.length} .js files scanned)`);
    console.error("Either the build is incomplete or Next renamed the emitted helper.");
    console.error("Update ENTRY_ARRAY in this script — do not let it pass by checking nothing.");
    process.exit(2);
  }

  if (failures.length > 0) {
    console.error("[check-server-entry-exports] FREE VARIABLE in a server-action entry array.\n");
    for (const f of failures) {
      console.error(`  ${f.file}`);
      console.error(`    ${f.name} is referenced but never bound in this chunk`);
      console.error(`    ${f.array}…\n`);
    }
    console.error("That chunk throws ReferenceError at module evaluation, taking down EVERY");
    console.error("server action bundled into the entries that import it. The build exits 0");
    console.error("anyway, because a build emits chunks without evaluating them.\n");
    console.error('Cause is almost always an export clause in a "use server" module: the');
    console.error("transform emits each export specifier as a runtime identifier, and a type");
    console.error("has no runtime binding. See tests/unit/use-server-exports.test.ts and");
    console.error("docs/incidents/2026-08-20-a-type-re-export-took-down-every-organizer-action.md");
    process.exit(1);
  }

  console.log(
    `[check-server-entry-exports] ✓ ${namesChecked} identifiers across ` +
      `${arraysChecked} server-entry arrays in ${chunks.length} chunks are all bound`
  );
}

main();
