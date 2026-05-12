/**
 * Phase 2 — Extraction script.
 *
 * Reads host app source files and emits src/data/manifest.json so the
 * Digital Twin site always reflects the live codebase.
 *
 * Parsed targets:
 *   src/types/database.ts        → tables, views, enums, RPCs   (TypeScript AST)
 *   src/lib/constants.ts         → numeric constants + JSDoc     (regex)
 *   src/app/actions/*.ts         → exported function names       (regex)
 */

import * as ts from "typescript";
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST_ROOT = resolve(__dirname, "../../"); // badminton-app/
const OUT_PATH = resolve(__dirname, "../src/data/manifest.json");

// ── Curated gotchas (sourced from APP_MANIFEST.md §9 + PostgREST notes) ───────
// severity: 'critical' | 'warn' | 'info'
// category: grouping label shown in the badge
// link: optional deep-link into a Digital Twin view

interface GotchaEntry {
  id: string;
  title: string;
  body: string;
  severity: "critical" | "warn" | "info";
  category: string;
  link?: string;
}

const CURATED_GOTCHAS: GotchaEntry[] = [
  {
    id: "type-not-interface",
    title: "`type` not `interface` for DB rows",
    body: "All DB row types in src/types/database.ts must be `type` aliases, never `interface`. Supabase's generic system requires sealed types — interfaces are open and cause silent type widening.",
    severity: "warn",
    category: "TypeScript",
    link: "/database",
  },
  {
    id: "service-client-mutations",
    title: "Service client for all cross-user mutations",
    body: "Any write that touches another user's row must use createServiceClient(). Using the RLS client silently returns 0 rows for the primary organizer — no error, no write.",
    severity: "critical",
    category: "Auth / RLS",
    link: "/actions",
  },
  {
    id: "sign-out-before-anonymous",
    title: "`signOut()` before `signInAnonymously()`",
    body: "reconnectPlayer always calls signOut() first. Skipping this causes a stale session conflict that silently fails the entire identity migration — the player loses their history.",
    severity: "critical",
    category: "Auth / RLS",
    link: "/flows",
  },
  {
    id: "auto-matchmaking-no-postgres-changes",
    title: "`is_auto_matchmaking_on` excluded from postgres_changes",
    body: "sessions RLS SELECT only grants access to the row creator. A co-organizer's postgres_changes subscription for this field is silently dropped. It must sync exclusively via the `auto_matchmaking_toggled` broadcast.",
    severity: "critical",
    category: "Realtime",
    link: "/realtime",
  },
  {
    id: "create-match-null-on-toctou",
    title: "`create_match_with_players` returns NULL on TOCTOU conflict",
    body: "{ data: null, error: null } means a DB guard fired — not a hard error. Always check rpcError and !matchId separately. !matchId with no error = graceful slot-skip (log + continue).",
    severity: "critical",
    category: "Engine",
    link: "/engine",
  },
  {
    id: "engine-running-for-process-local",
    title: "`engineRunningFor` Set is process-local only",
    body: "Prevents double-runs within one Node.js process but is useless on Vercel serverless (each request = new worker). Cross-process serialization is handled exclusively by the DB-level TOCTOU guard in create_match_with_players.",
    severity: "critical",
    category: "Engine",
    link: "/engine",
  },
  {
    id: "session-organizers-append-only",
    title: "`session_organizers` is append-only",
    body: "Never DELETE or UPDATE rows in session_organizers. Presence of a row = permission granted. Deleting a row removes organizer access with no undo.",
    severity: "critical",
    category: "Schema",
    link: "/database",
  },
  {
    id: "auth-users-trigger",
    title: "`auth.users` trigger auto-creates profile",
    body: "Inserting into auth.users auto-creates a profiles row via handle_new_user(). Do not also insert a profile manually — you will hit a PK conflict.",
    severity: "critical",
    category: "Schema",
    link: "/database",
  },
  {
    id: "sessions-trigger",
    title: "`sessions` trigger auto-inserts organizer row",
    body: "Inserting into sessions auto-inserts a session_organizers row for created_by via handle_new_session(). Do not also insert an organizer row manually.",
    severity: "critical",
    category: "Schema",
    link: "/database",
  },
  {
    id: "build-overlap-map-async",
    title: "`buildOverlapMap` is async/DB — not in matchmaking-core",
    body: "buildOverlapMap lives in matchmaking.ts (async DB call) not in matchmaking-core.ts (pure logic). Moving it to core would add a DB dependency to a pure function file.",
    severity: "warn",
    category: "Engine",
    link: "/engine",
  },
  {
    id: "recent-rosters-hoisted",
    title: "`recentRosters` hoisted once; `overlapMap` per-anchor",
    body: "recentRosters is the same for all anchors in one engine run and is fetched once before the loop. overlapMap is anchor-specific and must be recomputed inside the per-anchor tick — not hoisted.",
    severity: "warn",
    category: "Engine",
    link: "/engine",
  },
  {
    id: "cancel-match-auto-promotes",
    title: "`cancelMatchAction` auto-promotes oldest on-deck match",
    body: "Cancelling a match does not leave the court idle. It auto-promotes the oldest published on-deck match and re-runs the engine. Handle the cascade in the UI — don't assume cancellation is a no-op.",
    severity: "warn",
    category: "Match",
    link: "/actions",
  },
  {
    id: "draft-mode-blocks-call-next",
    title: "Draft mode blocks `callNextMatch`",
    body: "If all pending matches are drafts (is_published = false), callNextMatch returns hasDraftsBlocking: true instead of promoting a match. The organizer must publish drafts first.",
    severity: "warn",
    category: "Engine",
    link: "/engine",
  },
  {
    id: "snake-draft-null-guard",
    title: "`snakeDraft` / `rotatedDraft` return `null` on cap block",
    body: "Both draft functions return null when MAX_PARTNERSHIP_REPEATS blocks every valid team split. null = slot failure, not an error. All callers must null-guard — an unguarded null propagates as a phantom match.",
    severity: "warn",
    category: "Engine",
    link: "/engine",
  },
  {
    id: "ghost-requeue-prevention",
    title: "Ghost re-queue prevention on match end/cancel",
    body: "match end/cancel checks queue_entries.status before re-queuing. A player with status 'left' is NOT re-queued even if they appear in match_players. Prevents ghost players re-appearing after checkout.",
    severity: "warn",
    category: "Queue",
    link: "/actions",
  },
  {
    id: "active-match-rejoin-guard",
    title: "Active-match re-join guard in `joinQueueAction`",
    body: "joinQueueAction rejects if the player's current queue status is 'playing'. Guards against double-queue on rapid re-tap (e.g. network retry). Returns a clean error — not a silent no-op.",
    severity: "warn",
    category: "Queue",
    link: "/actions",
  },
  {
    id: "uuid-validation-all-actions",
    title: "UUID validation required before every DB call",
    body: "Every server action must call isValidUUID() on every UUID parameter. Malformed IDs return early with a clean error — they never reach PostgREST. Missing this guard exposes the action to injection via crafted UUIDs.",
    severity: "warn",
    category: "Actions",
    link: "/actions",
  },
  {
    id: "on-deck-actions-in-match-not-matchmaking",
    title: "On-deck actions live in `match.ts`, not `matchmaking.ts`",
    body: "clearOnDeckMatch, reorderOnDeckMatches, publishMatchAction, and publishAllDraftMatchesAction all live in match.ts. Only engine entry points (callNextMatch, runEngineForSession) live in matchmaking.ts.",
    severity: "warn",
    category: "Actions",
    link: "/actions",
  },
  {
    id: "max-auto-drafts-replaces-formula",
    title: "`MAX_AUTO_DRAFTS` replaces the old capacity formula",
    body: "MAX_ON_DECK_MATCHES and ON_DECK_LOOKAHEAD are no longer used by the live engine (kept in constants.ts for simulate-engine.ts only). The live engine uses slotsAvailable = max(0, MAX_AUTO_DRAFTS − totalPending) with a single atomic count — never split into published/draft counts.",
    severity: "warn",
    category: "Engine",
    link: "/engine",
  },
  {
    id: "skill-level-6-values",
    title: "Skill level has exactly 6 values — `upper_beginner` removed",
    body: "The skill_level enum is: beginner, lower_intermediate, intermediate, upper_intermediate, lower_advanced, advanced. upper_beginner was removed. Never reference it in code or migrations.",
    severity: "warn",
    category: "Schema",
    link: "/database",
  },
  {
    id: "sessions-ts-plural",
    title: "`sessions.ts` not `session.ts`",
    body: "The actions file is sessions.ts (plural). Creating a session.ts duplicate will silently shadow the original file and cause all session actions to 404 in production.",
    severity: "warn",
    category: "Actions",
    link: "/actions",
  },
  {
    id: "postgrest-update-empty-array",
    title: "PostgREST `UPDATE` matching 0 rows returns empty array",
    body: "An UPDATE matching 0 rows returns an empty array — not null and not an error. Using .single() on such a response throws. Use array + length check for atomic CAS guards.",
    severity: "warn",
    category: "Database",
    link: "/database",
  },
  {
    id: "dnd-kit-two-attrs",
    title: "dnd-kit: two attributes required on interactive children",
    body: "Both data-no-dnd attribute AND onPointerDown stopPropagation are required on interactive children (buttons, inputs) inside draggable containers. Missing either causes drag events to fire on button clicks.",
    severity: "info",
    category: "UI",
    link: "/components",
  },
  {
    id: "cookie-chunking",
    title: "@supabase/ssr chunks auth tokens",
    body: "@supabase/ssr splits auth tokens at 3180 encoded chars into .0, .1, .2 suffixed cookies. Any custom cookie handling must join these chunks before passing to the Supabase client.",
    severity: "info",
    category: "Auth / RLS",
    link: "/actions",
  },
  {
    id: "nextjs-16-breaking",
    title: "Next.js 16 breaking changes",
    body: "Do NOT assume Next.js 13/14/15 APIs. Key changes in 16: params and searchParams are now async Promises. Always await params in Server Components and use React.use() in Client Components.",
    severity: "info",
    category: "Framework",
  },
  {
    id: "vercel-bypass-header",
    title: "Vercel protection bypass for Playwright",
    body: "_vercel_share tokens do NOT work for Playwright E2E tests. The only working approach is the x-vercel-protection-bypass header in playwright.config.ts extraHTTPHeaders.",
    severity: "info",
    category: "CI / Testing",
  },
  {
    id: "postgrest-insert-single-safe",
    title: "PostgREST INSERT + `.select().single()` is safe",
    body: "Unlike UPDATE (which may match 0 rows), INSERT with .select().single() always returns exactly one row or throws. Safe to use .single() on INSERT — it will never return an empty array.",
    severity: "info",
    category: "Database",
    link: "/database",
  },
];

// ── Manifest schema ────────────────────────────────────────────────────────────

interface ColumnEntry {
  name: string;
  type: string;
  nullable: boolean;
  note: string;
}

interface TableEntry {
  name: string; // snake_case DB name  (e.g. "queue_entries")
  typeName: string; // TypeScript type name (e.g. "QueueEntry")
  desc: string;
  columns: ColumnEntry[];
}

interface ViewEntry {
  name: string;
  typeName: string;
  desc: string;
  columns: ColumnEntry[];
}

interface EnumEntry {
  name: string; // snake_case DB name  (e.g. "queue_status")
  typeName: string; // TypeScript type name (e.g. "QueueStatus")
  values: string[];
}

interface RPCArg {
  name: string;
  type: string;
  optional: boolean;
}

interface RPCEntry {
  name: string;
  returns: string;
  args: RPCArg[];
  note: string;
}

interface ConstEntry {
  name: string;
  value: number;
  desc: string;
}

interface ActionEntry {
  file: string;
  functions: string[];
}

interface Manifest {
  _version: number;
  _lastExtracted: string;
  tables: TableEntry[];
  views: ViewEntry[];
  enums: EnumEntry[];
  rpcs: RPCEntry[];
  constants: ConstEntry[];
  actions: ActionEntry[];
  channels: unknown[];
  broadcasts: unknown[];
  gotchas: unknown[];
  components: unknown[];
  scenarios: unknown[];
}

// ── TypeScript AST helpers ─────────────────────────────────────────────────────

/**
 * Extract JSDoc text (only `/** … *\/`) from leading trivia.
 *
 * Intentionally ignores `//` line comments: in the TypeScript AST a trailing
 * `//` on line N is stored as leading trivia for the token on line N+1, so
 * matching it here would attribute the comment to the WRONG property.
 * Trailing `//` notes are captured separately by `trailingLineComment`.
 */
function leadingComment(node: ts.Node, src: ts.SourceFile): string {
  const full = src.getFullText();
  const trivia = full.slice(node.getFullStart(), node.getStart(src));

  const jsdoc = trivia.match(/\/\*\*([\s\S]*?)\*\//);
  if (!jsdoc) return "";

  return jsdoc[1]
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trim())
    .filter(Boolean)
    .join(" ");
}

/** Extract a trailing `// ...` comment from the same line as a node. */
function trailingLineComment(node: ts.Node, src: ts.SourceFile): string {
  const full = src.getFullText();
  const lineEnd = full.indexOf("\n", node.getEnd());
  const segment = full.slice(node.getEnd(), lineEnd === -1 ? undefined : lineEnd);
  const m = segment.match(/\/\/\s*(.+)$/);
  return m ? m[1].trim() : "";
}

/** Best note for a property: leading JSDoc, then trailing inline comment. */
function propertyNote(member: ts.PropertySignature, src: ts.SourceFile): string {
  return leadingComment(member, src) || trailingLineComment(member, src);
}

/** Find a PropertySignature by name inside a TypeLiteralNode. */
function findMember(literal: ts.TypeLiteralNode, key: string): ts.PropertySignature | undefined {
  return literal.members.filter(ts.isPropertySignature).find((m) => {
    const n = ts.isIdentifier(m.name) ? m.name.text : ts.isStringLiteral(m.name) ? m.name.text : "";
    return n === key;
  });
}

/** Serialise a TypeNode to a compact readable string. */
function typeStr(node: ts.TypeNode | undefined, src: ts.SourceFile): string {
  if (!node) return "unknown";
  return node.getText(src).replace(/\s+/g, " ").trim();
}

/** True if the node has an `export` modifier. */
function isExported(node: ts.Declaration): boolean {
  return !!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export);
}

/** Extract columns from a TypeLiteralNode. */
function columnsFrom(literal: ts.TypeLiteralNode, src: ts.SourceFile): ColumnEntry[] {
  return literal.members.filter(ts.isPropertySignature).map((m) => {
    const name = ts.isIdentifier(m.name)
      ? m.name.text
      : ts.isStringLiteral(m.name)
        ? m.name.text
        : "?";

    let type = typeStr(m.type, src);
    let nullable = !!m.questionToken; // optional property

    // Detect explicit `T | null` union
    if (m.type && ts.isUnionTypeNode(m.type)) {
      const nulled = m.type.types.some(
        (t) => ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword
      );
      if (nulled) {
        nullable = true;
        // Rebuild type string without the `null` arm
        const nonNull = m.type.types.filter(
          (t) => !(ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword)
        );
        type = nonNull.map((t) => typeStr(t, src)).join(" | ");
      }
    }

    return { name, type, nullable, note: propertyNote(m, src) };
  });
}

// ── database.ts extraction ─────────────────────────────────────────────────────

function extractDatabase(path: string): {
  tables: TableEntry[];
  views: ViewEntry[];
  enums: EnumEntry[];
  rpcs: RPCEntry[];
} {
  const content = readFileSync(path, "utf8");
  const src = ts.createSourceFile("database.ts", content, ts.ScriptTarget.Latest, true);

  // Pass 1 — build a map of all exported type aliases
  const typeMap = new Map<string, ts.TypeNode>();
  ts.forEachChild(src, (node) => {
    if (ts.isTypeAliasDeclaration(node) && isExported(node)) {
      typeMap.set(node.name.text, node.type);
    }
  });

  // Pass 2 — collect standalone enum types (union of string literals)
  const enumMap = new Map<string, string[]>(); // typeName → values
  typeMap.forEach((typeNode, typeName) => {
    if (!ts.isUnionTypeNode(typeNode)) return;
    const allStrings = typeNode.types.every(
      (t) => ts.isLiteralTypeNode(t) && ts.isStringLiteral((t as ts.LiteralTypeNode).literal)
    );
    if (!allStrings) return;
    enumMap.set(
      typeName,
      typeNode.types.map((t) => ((t as ts.LiteralTypeNode).literal as ts.StringLiteral).text)
    );
  });

  // Pass 3 — extract everything from the Database type
  const tables: TableEntry[] = [];
  const views: ViewEntry[] = [];
  const rpcs: RPCEntry[] = [];

  // Locate `export type Database = { public: { ... } }`
  let dbNode: ts.TypeAliasDeclaration | undefined;
  ts.forEachChild(src, (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === "Database") {
      dbNode = node;
    }
  });

  if (dbNode && ts.isTypeLiteralNode(dbNode.type)) {
    const pubProp = findMember(dbNode.type, "public");
    if (pubProp?.type && ts.isTypeLiteralNode(pubProp.type)) {
      const pub = pubProp.type;

      // ── Tables ──────────────────────────────────────────────
      const tablesProp = findMember(pub, "Tables");
      if (tablesProp?.type && ts.isTypeLiteralNode(tablesProp.type)) {
        tablesProp.type.members.filter(ts.isPropertySignature).forEach((tableMember) => {
          const dbName = ts.isIdentifier(tableMember.name)
            ? tableMember.name.text
            : ts.isStringLiteral(tableMember.name)
              ? tableMember.name.text
              : "";
          if (!dbName || !tableMember.type || !ts.isTypeLiteralNode(tableMember.type)) return;

          const rowProp = findMember(tableMember.type, "Row");
          if (!rowProp?.type) return;

          // Resolve Row type — either a TypeReference or inline TypeLiteral
          let columns: ColumnEntry[] = [];
          let typeName = dbName; // fallback
          let desc = "";

          if (ts.isTypeReferenceNode(rowProp.type)) {
            // Resolve the named type alias (e.g., Profile, QueueEntry)
            const refName = rowProp.type.typeName.getText(src);
            typeName = refName;
            const resolved = typeMap.get(refName);
            if (resolved && ts.isTypeLiteralNode(resolved)) {
              columns = columnsFrom(resolved, src);
            }
            // Get desc from the leading comment on the standalone type declaration
            ts.forEachChild(src, (n) => {
              if (ts.isTypeAliasDeclaration(n) && n.name.text === refName) {
                desc = leadingComment(n, src);
              }
            });
          } else if (ts.isTypeLiteralNode(rowProp.type)) {
            columns = columnsFrom(rowProp.type, src);
          }

          tables.push({ name: dbName, typeName, desc, columns });
        });
      }

      // ── Views ───────────────────────────────────────────────
      const viewsProp = findMember(pub, "Views");
      if (viewsProp?.type && ts.isTypeLiteralNode(viewsProp.type)) {
        viewsProp.type.members.filter(ts.isPropertySignature).forEach((viewMember) => {
          const dbName = ts.isIdentifier(viewMember.name)
            ? viewMember.name.text
            : ts.isStringLiteral(viewMember.name)
              ? viewMember.name.text
              : "";
          if (!dbName || !viewMember.type || !ts.isTypeLiteralNode(viewMember.type)) return;

          const rowProp = findMember(viewMember.type, "Row");
          if (!rowProp?.type) return;

          let columns: ColumnEntry[] = [];
          let typeName = dbName;
          let desc = "";

          if (ts.isTypeReferenceNode(rowProp.type)) {
            const refName = rowProp.type.typeName.getText(src);
            typeName = refName;
            // Intersection types (e.g. QueueEntry & {...}) — just note them
            const resolved = typeMap.get(refName);
            if (resolved && ts.isTypeLiteralNode(resolved)) {
              columns = columnsFrom(resolved, src);
            } else if (resolved && ts.isIntersectionTypeNode(resolved)) {
              // For intersection types, extract columns from each constituent
              resolved.types.forEach((part) => {
                if (ts.isTypeLiteralNode(part)) {
                  columns.push(...columnsFrom(part, src));
                } else if (ts.isTypeReferenceNode(part)) {
                  const partRef = part.typeName.getText(src);
                  const partType = typeMap.get(partRef);
                  if (partType && ts.isTypeLiteralNode(partType)) {
                    columns.push(...columnsFrom(partType, src));
                  }
                }
              });
            }
            ts.forEachChild(src, (n) => {
              if (ts.isTypeAliasDeclaration(n) && n.name.text === refName) {
                desc = leadingComment(n, src);
              }
            });
          } else if (ts.isTypeLiteralNode(rowProp.type)) {
            columns = columnsFrom(rowProp.type, src);
          }

          views.push({ name: dbName, typeName, desc, columns });
        });
      }

      // ── RPCs (Functions) ────────────────────────────────────
      const funcProp = findMember(pub, "Functions");
      if (funcProp?.type && ts.isTypeLiteralNode(funcProp.type)) {
        funcProp.type.members.filter(ts.isPropertySignature).forEach((rpcMember) => {
          const name = ts.isIdentifier(rpcMember.name)
            ? rpcMember.name.text
            : ts.isStringLiteral(rpcMember.name)
              ? rpcMember.name.text
              : "";
          if (!name || !rpcMember.type || !ts.isTypeLiteralNode(rpcMember.type)) return;

          const rpcLiteral = rpcMember.type;
          const returnsProp = findMember(rpcLiteral, "Returns");
          const argsProp = findMember(rpcLiteral, "Args");
          const note = leadingComment(rpcMember, src);

          const returns = typeStr(returnsProp?.type, src);

          const args: RPCArg[] = [];
          if (argsProp?.type) {
            if (ts.isTypeLiteralNode(argsProp.type)) {
              argsProp.type.members.filter(ts.isPropertySignature).forEach((a) => {
                const argName = ts.isIdentifier(a.name)
                  ? a.name.text
                  : ts.isStringLiteral(a.name)
                    ? a.name.text
                    : "";
                if (argName) {
                  args.push({
                    name: argName,
                    type: typeStr(a.type, src),
                    optional: !!a.questionToken,
                  });
                }
              });
            } else {
              // Args: Record<string, never> etc.
              args.push({ name: "—", type: typeStr(argsProp.type, src), optional: false });
            }
          }

          rpcs.push({ name, returns, args, note });
        });
      }
    }
  }

  // Pass 4 — build enums list, using Database.public.Enums for DB names
  const enums: EnumEntry[] = [];
  if (dbNode && ts.isTypeLiteralNode(dbNode.type)) {
    const pubProp2 = findMember(dbNode.type, "public");
    if (pubProp2?.type && ts.isTypeLiteralNode(pubProp2.type)) {
      const enumsProp = findMember(pubProp2.type, "Enums");
      if (enumsProp?.type && ts.isTypeLiteralNode(enumsProp.type)) {
        enumsProp.type.members.filter(ts.isPropertySignature).forEach((m) => {
          const dbName = ts.isIdentifier(m.name)
            ? m.name.text
            : ts.isStringLiteral(m.name)
              ? m.name.text
              : "";
          if (!dbName || !m.type) return;

          const tsTypeName = ts.isTypeReferenceNode(m.type)
            ? m.type.typeName.getText(src)
            : typeStr(m.type, src);

          const values = enumMap.get(tsTypeName) ?? [];
          enums.push({ name: dbName, typeName: tsTypeName, values });
        });
      }
    }
  }

  return { tables, views, enums, rpcs };
}

// ── constants.ts extraction ────────────────────────────────────────────────────

function extractConstants(path: string): ConstEntry[] {
  const content = readFileSync(path, "utf8");
  const results: ConstEntry[] = [];

  // Match optional JSDoc block followed by: export const NAME = NUMBER;
  const re = /(?:\/\*\*([\s\S]*?)\*\/\s*\n)?export const ([A-Z_]+)\s*=\s*(\d+(?:\.\d+)?);/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(content)) !== null) {
    const [, rawDoc, name, rawVal] = m;
    const desc = rawDoc
      ? rawDoc
          .split("\n")
          .map((l) => l.replace(/^\s*\*\s?/, "").trim())
          .filter(Boolean)
          .join(" ")
      : "";
    results.push({ name, value: Number(rawVal), desc });
  }

  return results;
}

// ── action files extraction ────────────────────────────────────────────────────

function extractActions(actionsDir: string): ActionEntry[] {
  const files = readdirSync(actionsDir)
    .filter((f) => f.endsWith(".ts"))
    .sort();

  return files
    .map((file) => {
      const content = readFileSync(join(actionsDir, file), "utf8");
      const functions: string[] = [];

      // export async function name(  or  export function name(
      const fnRe = /^export\s+(?:async\s+)?function\s+(\w+)\s*[<(]/gm;
      let m: RegExpExecArray | null;
      while ((m = fnRe.exec(content)) !== null) functions.push(m[1]);

      // export const name = async (  or  export const name = (
      const constRe = /^export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm;
      while ((m = constRe.exec(content)) !== null) functions.push(m[1]);

      return { file, functions };
    })
    .filter((e) => e.functions.length > 0);
}

// ── Main ───────────────────────────────────────────────────────────────────────

function run(): void {
  const t0 = Date.now();
  console.log("[extract] starting…");

  const { tables, views, enums, rpcs } = extractDatabase(
    resolve(HOST_ROOT, "src/types/database.ts")
  );
  const constants = extractConstants(resolve(HOST_ROOT, "src/lib/constants.ts"));
  const actions = extractActions(resolve(HOST_ROOT, "src/app/actions"));

  const manifest: Manifest = {
    _version: 2,
    _lastExtracted: new Date().toISOString(),
    tables,
    views,
    enums,
    rpcs,
    constants,
    actions,
    channels: [],
    broadcasts: [],
    gotchas: CURATED_GOTCHAS,
    components: [],
    scenarios: [],
  };

  writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + "\n");

  const ms = Date.now() - t0;
  console.log(`[extract] ✓ done in ${ms}ms`);
  console.log(`  tables:    ${tables.length}`);
  console.log(`  views:     ${views.length}`);
  console.log(`  enums:     ${enums.length}`);
  console.log(`  rpcs:      ${rpcs.length}`);
  console.log(`  constants: ${constants.length}`);
  console.log(`  actions:   ${actions.length} files`);
  console.log(`  → ${OUT_PATH}`);
}

run();
