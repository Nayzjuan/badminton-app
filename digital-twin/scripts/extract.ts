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

// ── Design-token types ────────────────────────────────────────────────────────

interface FontEntry {
  /** CSS variable exposed by next/font (e.g. "--font-inter") */
  cssVar: string;
  /** Tailwind semantic class (e.g. "font-sans") */
  tailwindClass: string;
  /** Google Font family name (e.g. "Inter") */
  face: string;
  /** Human role description */
  role: string;
  /** Route scope */
  scope: string;
}

interface DesignTokens {
  /** Fonts in declaration order from layout.tsx */
  fonts: FontEntry[];
  /** All CSS custom properties from :root {} */
  lightTokens: Record<string, string>;
  /** All CSS custom properties from .dark {} */
  darkTokens: Record<string, string>;
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
  broadcasts: BroadcastEntry[];
  gotchas: unknown[];
  components: unknown[];
  scenarios: unknown[];
  /** Extracted from globals.css + layout.tsx — consumed by sync-design-tokens.ts */
  designTokens: DesignTokens;
  // ── Feature pages (added 2026-06) ──
  migrations: MigrationEntry[];
  rlsPolicies: SnapshotPolicy[];
  rlsCapturedAt: string;
  coverage: CoverageData | null;
  schemaDrift: SchemaDrift | null;
  actionDetails: ActionDetail[];
  stateMachines: StateMachine[];
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

// ── Design token extraction ────────────────────────────────────────────────────

/**
 * Extract all CSS custom properties from a named selector block.
 * Handles selectors nested inside @layer or similar at-rules.
 *
 * Returns a flat Record<varName, value> with inline comments stripped.
 */
function extractCssVars(css: string, selector: string): Record<string, string> {
  // Find the selector (allow leading whitespace)
  const idx = css.search(
    new RegExp(`(?:^|\\s)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "m")
  );
  if (idx === -1) return {};

  const blockStart = css.indexOf("{", idx) + 1;
  let depth = 1;
  let pos = blockStart;
  while (pos < css.length && depth > 0) {
    if (css[pos] === "{") depth++;
    else if (css[pos] === "}") depth--;
    pos++;
  }
  const block = css.slice(blockStart, pos - 1);

  const vars: Record<string, string> = {};
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const [, name, rawVal] = m;
    // Strip trailing inline comment
    const value = rawVal.replace(/\/\*.*?\*\//g, "").trim(); // non-greedy, handles * in comment body
    vars[name.trim()] = value;
  }
  return vars;
}

/**
 * Extract the font stack from layout.tsx.
 *
 * Looks for `const <ident> = <FontName>({` blocks and collects
 * `variable` field values, then cross-references with the @theme
 * block in globals.css to build the semantic → face mapping.
 */
function extractFonts(layoutPath: string, globalsPath: string): FontEntry[] {
  // Combine all layout files — root + any sub-layouts that declare fonts.
  // Chakra Petch is scoped to src/app/organizer/layout.tsx, not the root.
  const extraLayouts = [resolve(HOST_ROOT, "src/app/organizer/layout.tsx")];
  const allLayoutSrc = [layoutPath, ...extraLayouts]
    .filter((p) => {
      try {
        readFileSync(p);
        return true;
      } catch {
        return false;
      }
    })
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
  const layout = allLayoutSrc;
  const css = readFileSync(globalsPath, "utf8");

  // Find the @theme block to get semantic → CSS-var mapping
  const themeIdx = css.indexOf("@theme");
  const themeBlockStart = css.indexOf("{", themeIdx) + 1;
  let depth = 1;
  let pos = themeBlockStart;
  while (pos < css.length && depth > 0) {
    if (css[pos] === "{") depth++;
    else if (css[pos] === "}") depth--;
    pos++;
  }
  const themeBlock = css.slice(themeBlockStart, pos - 1);

  // Build map: --font-sans → "var(--font-inter), ..."
  const themeVars: Record<string, string> = {};
  const themeRe = /(--font-[\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = themeRe.exec(themeBlock)) !== null) {
    themeVars[m[1].trim()] = m[2].replace(/\/\*[^*]*\*\//, "").trim();
  }

  // Parse next/font declarations from layout.tsx:
  // const <alias> = <FontName>({ ..., variable: "--font-xxx", ... })
  const fontDeclRe =
    /const\s+(\w+)\s*=\s*(\w+)\s*\(\{[\s\S]*?variable:\s*"(--font-[\w-]+)"[\s\S]*?\}\)/g;
  const injectedVars: Record<string, string> = {}; // "--font-inter" → "Inter"
  while ((m = fontDeclRe.exec(layout)) !== null) {
    const [, , fontFn, cssVar] = m;
    // Convert function name to font face: "Barlow_Condensed" → "Barlow Condensed"
    injectedVars[cssVar] = fontFn.replace(/_/g, " ");
  }

  // Metadata hardcoded here — these are role/scope descriptions, not parseable from code.
  // Update this table when new fonts are added.
  const FONT_META: Record<string, { tailwindClass: string; role: string; scope: string }> = {
    "--font-sans": {
      tailwindClass: "font-sans",
      role: "Body text, UI labels, Sonner toasts",
      scope: "All routes",
    },
    "--font-display": {
      tailwindClass: "font-display",
      role: "Hero numerals, rank numbers, leaderboard",
      scope: "All routes",
    },
    "--font-mono": {
      tailwindClass: "font-mono",
      role: "Stats, metadata pills, monospace labels",
      scope: "All routes",
    },
    "--font-command": {
      tailwindClass: "font-command",
      role: "Organizer tab nav, card labels, command badges",
      scope: "/organizer/* only",
    },
  };

  // Build ordered output — match @theme declaration order
  const result: FontEntry[] = [];
  for (const [semanticVar, meta] of Object.entries(FONT_META)) {
    const themeVal = themeVars[semanticVar] ?? "";
    // Extract the first var(--font-xxx) reference to find the injected face
    const injectedVarMatch = themeVal.match(/var\((--font-[\w-]+)\)/);
    const face = injectedVarMatch
      ? (injectedVars[injectedVarMatch[1]] ?? injectedVarMatch[1])
      : "?";
    result.push({
      cssVar: semanticVar,
      tailwindClass: meta.tailwindClass,
      face,
      role: meta.role,
      scope: meta.scope,
    });
  }
  return result;
}

function extractDesignTokens(globalsPath: string, layoutPath: string): DesignTokens {
  const css = readFileSync(globalsPath, "utf8");
  return {
    fonts: extractFonts(layoutPath, globalsPath),
    lightTokens: extractCssVars(css, ":root"),
    darkTokens: extractCssVars(css, ".dark"),
  };
}

// ── Migrations (Migration Timeline) ─────────────────────────────────────────────

interface MigrationEntry {
  file: string;
  date: string; // YYYY-MM-DD from the leading digits
  ts: string; // full numeric prefix
  title: string; // first meaningful comment line
  kinds: string[]; // table | rpc | policy | trigger | column | index | view | type | rls
  tables: string[];
  functions: string[];
  policies: string[];
  lines: number;
}

function extractMigrations(dir: string): MigrationEntry[] {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    return [];
  }

  return files.map((file) => {
    const sql = readFileSync(join(dir, file), "utf8");
    const pm = file.match(/^(\d{8})(\d*)_?(.*)\.sql$/);
    const datePart = pm?.[1] ?? "";
    const date = datePart
      ? `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`
      : "";

    // Title = first comment line with letters that isn't a `====` banner.
    let title = (pm?.[3] ?? file).replace(/_/g, " ").trim();
    for (const line of sql.split("\n").slice(0, 14)) {
      const c = line.replace(/^--\s?/, "").trim();
      if (c && !/^[=\-]+$/.test(c) && /[a-zA-Z]/.test(c)) {
        title = c;
        break;
      }
    }

    const kinds = new Set<string>();
    const tables = new Set<string>();
    const functions = new Set<string>();
    const policies = new Set<string>();
    let m: RegExpExecArray | null;

    const reTable = /create table (?:if not exists )?(?:public\.)?["']?(\w+)/gi;
    while ((m = reTable.exec(sql))) {
      kinds.add("table");
      tables.add(m[1]);
    }
    const reFn = /create (?:or replace )?function (?:public\.)?["']?(\w+)/gi;
    while ((m = reFn.exec(sql))) {
      kinds.add("rpc");
      functions.add(m[1]);
    }
    const rePol = /create policy ["']?(.+?)["']?\s+on (?:public\.)?["']?(\w+)/gi;
    while ((m = rePol.exec(sql))) {
      kinds.add("policy");
      policies.add(m[1].trim());
      tables.add(m[2]);
    }
    const reAlter = /alter table (?:if exists )?(?:only )?(?:public\.)?["']?(\w+)/gi;
    while ((m = reAlter.exec(sql))) tables.add(m[1]);

    if (/create (?:or replace )?trigger/i.test(sql)) kinds.add("trigger");
    if (/\badd column\b/i.test(sql)) kinds.add("column");
    if (/create (?:unique )?index/i.test(sql)) kinds.add("index");
    if (/create (?:or replace )?(?:materialized )?view/i.test(sql)) kinds.add("view");
    if (/create type/i.test(sql)) kinds.add("type");
    if (/enable row level security|create policy/i.test(sql)) kinds.add("rls");

    return {
      file,
      date,
      ts: `${datePart}${pm?.[2] ?? ""}`,
      title,
      kinds: [...kinds].sort(),
      tables: [...tables].sort(),
      functions: [...functions].sort(),
      policies: [...policies],
      lines: sql.split("\n").length,
    };
  });
}

// ── Live-schema snapshot, RLS policies, drift ───────────────────────────────────

interface SnapshotPolicy {
  table: string;
  name: string;
  cmd: string;
  roles: string;
  using: string | null;
  withCheck: string | null;
}
interface LiveSnapshot {
  capturedAt: string;
  tables: Record<string, [string, string, boolean][]>; // [col, type, nullable]
  views: string[];
  functions: string[];
  policies: SnapshotPolicy[];
}

function readSnapshot(path: string): LiveSnapshot | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LiveSnapshot;
  } catch {
    return null;
  }
}

interface SchemaDrift {
  capturedAt: string;
  ok: boolean;
  tableColumnDrift: { table: string; dbOnly: string[]; codeOnly: string[] }[];
  /** dbOnly = real drift; dbOnlyExpected = triggers / SECURITY DEFINER helpers
   *  that are intentionally NOT exposed as PostgREST RPCs. */
  functions: { dbOnly: string[]; dbOnlyExpected: string[]; codeOnly: string[] };
  views: { dbOnly: string[]; codeOnly: string[] };
  tables: { dbOnly: string[]; codeOnly: string[] };
}

/** DB functions intentionally absent from the TS RPC type: trigger functions,
 *  SECURITY DEFINER RLS helpers, and `_`-prefixed internal helpers. Not drift. */
const EXPECTED_DB_ONLY_FNS = new Set([
  "handle_new_session",
  "handle_new_user",
  "set_updated_at",
  "touch_push_subscription_updated_at",
  "is_session_organizer",
  "is_any_session_organizer",
]);

/** Strip Supabase RPC arg conventions so we compare on the bare function name. */
function computeDrift(
  snap: LiveSnapshot,
  tables: TableEntry[],
  views: ViewEntry[],
  rpcs: RPCEntry[]
): SchemaDrift {
  const codeTableMap = new Map(tables.map((t) => [t.name, t.columns.map((c) => c.name)]));
  const tableColumnDrift: SchemaDrift["tableColumnDrift"] = [];
  for (const [tbl, cols] of Object.entries(snap.tables)) {
    const codeCols = codeTableMap.get(tbl);
    if (!codeCols) continue; // table-level drift handled below
    const dbNames = cols.map((c) => c[0]);
    const dbOnly = dbNames.filter((c) => !codeCols.includes(c));
    const codeOnly = codeCols.filter((c) => !dbNames.includes(c));
    if (dbOnly.length || codeOnly.length) tableColumnDrift.push({ table: tbl, dbOnly, codeOnly });
  }

  const dbFns = new Set(snap.functions);
  const codeFns = new Set(rpcs.map((r) => r.name));
  const fnDbOnlyAll = [...dbFns].filter((f) => !codeFns.has(f));
  // Triggers / internal helpers (`_`-prefixed) / known SECURITY DEFINER helpers
  // are expected to be DB-only — not real drift.
  const fnDbOnlyExpected = fnDbOnlyAll
    .filter((f) => f.startsWith("_") || EXPECTED_DB_ONLY_FNS.has(f))
    .sort();
  const fnDbOnly = fnDbOnlyAll
    .filter((f) => !(f.startsWith("_") || EXPECTED_DB_ONLY_FNS.has(f)))
    .sort();
  const fnCodeOnly = [...codeFns].filter((f) => !dbFns.has(f)).sort();

  const dbViews = new Set(snap.views);
  const codeViews = new Set(views.map((v) => v.name));
  const viewDbOnly = [...dbViews].filter((v) => !codeViews.has(v)).sort();
  const viewCodeOnly = [...codeViews].filter((v) => !dbViews.has(v)).sort();

  const dbTables = new Set(Object.keys(snap.tables));
  const codeTables = new Set(tables.map((t) => t.name));
  const tblDbOnly = [...dbTables].filter((t) => !codeTables.has(t)).sort();
  const tblCodeOnly = [...codeTables].filter((t) => !dbTables.has(t)).sort();

  const ok =
    tableColumnDrift.length === 0 &&
    fnDbOnly.length === 0 &&
    fnCodeOnly.length === 0 &&
    viewDbOnly.length === 0 &&
    viewCodeOnly.length === 0 &&
    tblDbOnly.length === 0 &&
    tblCodeOnly.length === 0;

  return {
    capturedAt: snap.capturedAt,
    ok,
    tableColumnDrift,
    functions: { dbOnly: fnDbOnly, dbOnlyExpected: fnDbOnlyExpected, codeOnly: fnCodeOnly },
    views: { dbOnly: viewDbOnly, codeOnly: viewCodeOnly },
    tables: { dbOnly: tblDbOnly, codeOnly: tblCodeOnly },
  };
}

// ── Coverage (Test Coverage Dashboard) ──────────────────────────────────────────

interface CoverageFile {
  file: string;
  lines: number;
  hit: number;
  pct: number;
  fnPct: number;
}
interface CoverageDir {
  dir: string;
  lines: number;
  hit: number;
  pct: number;
  files: number;
}
interface CoverageData {
  totals: { lines: number; hit: number; pct: number; files: number };
  dirs: CoverageDir[];
  files: CoverageFile[];
}

function extractCoverage(lcovPath: string): CoverageData | null {
  let raw: string;
  try {
    raw = readFileSync(lcovPath, "utf8");
  } catch {
    return null;
  }

  const files: CoverageFile[] = [];
  for (const rec of raw.split("end_of_record")) {
    const sf = rec.match(/SF:(.+)/)?.[1]?.trim();
    if (!sf) continue;
    const lf = Number(rec.match(/LF:(\d+)/)?.[1] ?? 0);
    const lh = Number(rec.match(/LH:(\d+)/)?.[1] ?? 0);
    const fnf = Number(rec.match(/FNF:(\d+)/)?.[1] ?? 0);
    const fnh = Number(rec.match(/FNH:(\d+)/)?.[1] ?? 0);
    // Normalise to a repo-relative path under src/.
    const rel = sf.replace(/^.*?\/(src\/)/, "$1").replace(/^.*?badminton-app\//, "");
    files.push({
      file: rel,
      lines: lf,
      hit: lh,
      pct: lf ? Number(((100 * lh) / lf).toFixed(1)) : 0,
      fnPct: fnf ? Number(((100 * fnh) / fnf).toFixed(1)) : 0,
    });
  }
  if (files.length === 0) return null;

  // Roll up by directory (everything up to the filename).
  const dirMap = new Map<string, { lines: number; hit: number; files: number }>();
  for (const f of files) {
    const dir = f.file.includes("/") ? f.file.slice(0, f.file.lastIndexOf("/")) : ".";
    const agg = dirMap.get(dir) ?? { lines: 0, hit: 0, files: 0 };
    agg.lines += f.lines;
    agg.hit += f.hit;
    agg.files += 1;
    dirMap.set(dir, agg);
  }
  const dirs: CoverageDir[] = [...dirMap.entries()]
    .map(([dir, a]) => ({
      dir,
      lines: a.lines,
      hit: a.hit,
      files: a.files,
      pct: a.lines ? Number(((100 * a.hit) / a.lines).toFixed(1)) : 0,
    }))
    .sort((a, b) => a.dir.localeCompare(b.dir));

  const totalLines = files.reduce((s, f) => s + f.lines, 0);
  const totalHit = files.reduce((s, f) => s + f.hit, 0);

  return {
    totals: {
      lines: totalLines,
      hit: totalHit,
      pct: totalLines ? Number(((100 * totalHit) / totalLines).toFixed(1)) : 0,
      files: files.length,
    },
    dirs,
    files: files.sort((a, b) => a.file.localeCompare(b.file)),
  };
}

// ── Action signature detail (Action Signature Reference) ─────────────────────────

interface ActionDetail {
  file: string;
  name: string;
  signature: string; // params + return, trimmed to one line
  auth: string[]; // detected auth gates within the function body
  tables: string[]; // .from("x")
  rpcs: string[]; // .rpc("y")
  broadcasts: string[]; // broadcast*/postBroadcast targets
  pushes: boolean; // schedules a Web Push via pushToPlayers
}

function sliceFunctionBody(content: string, startIdx: number): string {
  // From the first '{' after startIdx, return the brace-balanced body.
  const open = content.indexOf("{", startIdx);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") {
      depth--;
      if (depth === 0) return content.slice(open, i + 1);
    }
  }
  return content.slice(open);
}

function extractActionDetails(actionsDir: string): ActionDetail[] {
  let files: string[];
  try {
    files = readdirSync(actionsDir)
      .filter((f) => f.endsWith(".ts"))
      .sort();
  } catch {
    return [];
  }

  const out: ActionDetail[] = [];
  for (const file of files) {
    const content = readFileSync(join(actionsDir, file), "utf8");
    const fnRe = /^export\s+(?:async\s+)?function\s+(\w+)\s*\(/gm;
    let m: RegExpExecArray | null;
    while ((m = fnRe.exec(content)) !== null) {
      const name = m[1];
      // Signature: from the function name to the first '{' of the body.
      const sigStart = m.index;
      const bodyOpen = content.indexOf("{", sigStart);
      const signature = content
        .slice(content.indexOf(name, sigStart), bodyOpen === -1 ? undefined : bodyOpen)
        .replace(/\s+/g, " ")
        .trim();
      const body = sliceFunctionBody(content, sigStart);

      const tables = new Set<string>();
      let mm: RegExpExecArray | null;
      const reFrom = /\.from\(\s*["'`](\w+)["'`]/g;
      while ((mm = reFrom.exec(body))) tables.add(mm[1]);
      const rpcs = new Set<string>();
      const reRpc = /\.rpc\(\s*["'`](\w+)["'`]/g;
      while ((mm = reRpc.exec(body))) rpcs.add(mm[1]);
      const broadcasts = new Set<string>();
      const reBc = /\b(broadcast\w+)\s*\(/g;
      while ((mm = reBc.exec(body))) broadcasts.add(mm[1]);

      const auth: string[] = [];
      if (/getAuthenticatedUser\s*\(/.test(body)) auth.push("getAuthenticatedUser");
      if (/isSessionOrganizer\s*\(/.test(body)) auth.push("isSessionOrganizer");
      if (/createServiceClient\s*\(/.test(body)) auth.push("createServiceClient");

      out.push({
        file,
        name,
        signature,
        auth,
        tables: [...tables].sort(),
        rpcs: [...rpcs].sort(),
        broadcasts: [...broadcasts].sort(),
        pushes: /pushToPlayers\s*\(/.test(body),
      });
    }
  }
  return out;
}

// ── Broadcast event catalog (extracted from broadcast.ts) ───────────────────────

interface BroadcastEntry {
  event: string; // realtime event name
  payloadType: string; // TS payload interface name
  types?: string[]; // union members for organizer_intervention
}

function extractBroadcasts(path: string): BroadcastEntry[] {
  let src: string;
  try {
    src = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: BroadcastEntry[] = [];
  // event names come from postBroadcast(`...`, "event_name", payload)
  const re = /postBroadcast\([^,]+,\s*["'`](\w+)["'`]/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(src))) {
    const event = m[1];
    if (seen.has(event)) continue;
    seen.add(event);
    out.push({ event, payloadType: "" });
  }
  // organizer_intervention union members
  const unionMatch = src.match(/OrganizerInterventionType\s*=\s*([\s\S]*?);/);
  if (unionMatch) {
    const members = [...unionMatch[1].matchAll(/["'`](\w+)["'`]/g)].map((x) => x[1]);
    const oi = out.find((b) => b.event === "organizer_intervention");
    if (oi) oi.types = members;
  }
  return out;
}

// ── State machines (queue_status + match_status) — curated ───────────────────────

interface StateEdge {
  from: string;
  to: string;
  label: string;
}
interface StateMachine {
  name: string;
  field: string;
  states: string[];
  edges: StateEdge[];
}

const STATE_MACHINES: StateMachine[] = [
  {
    name: "Queue lifecycle",
    field: "queue_entries.status",
    states: ["waiting", "drafted", "on_deck", "playing", "left"],
    edges: [
      { from: "waiting", to: "drafted", label: "engine drafts player into an unpublished match" },
      { from: "drafted", to: "on_deck", label: "organizer publishes the draft" },
      { from: "waiting", to: "on_deck", label: "manual on-deck create / publish" },
      { from: "on_deck", to: "playing", label: "match called to a court (promoteOnDeckMatch)" },
      { from: "waiting", to: "playing", label: "swapped into a live match" },
      { from: "playing", to: "waiting", label: "match ends / score submitted" },
      { from: "drafted", to: "waiting", label: "draft cleared / cap change" },
      { from: "on_deck", to: "waiting", label: "on-deck match cleared" },
      { from: "waiting", to: "left", label: "player checks out / removed" },
      { from: "playing", to: "left", label: "organizer removes mid-match" },
    ],
  },
  {
    name: "Match lifecycle",
    field: "matches.status",
    states: ["pending", "in_progress", "completed", "cancelled"],
    edges: [
      { from: "pending", to: "in_progress", label: "called to court (court assigned)" },
      { from: "in_progress", to: "completed", label: "score submitted" },
      { from: "pending", to: "cancelled", label: "draft/on-deck cleared" },
      { from: "in_progress", to: "cancelled", label: "match cancelled" },
      { from: "completed", to: "in_progress", label: "score reverted (revert_match_to_active)" },
    ],
  },
];

// ── Main ───────────────────────────────────────────────────────────────────────

function run(): void {
  const t0 = Date.now();
  console.log("[extract] starting…");

  const { tables, views, enums, rpcs } = extractDatabase(
    resolve(HOST_ROOT, "src/types/database.ts")
  );
  const constants = extractConstants(resolve(HOST_ROOT, "src/lib/constants.ts"));
  const actions = extractActions(resolve(HOST_ROOT, "src/app/actions"));
  const designTokens = extractDesignTokens(
    resolve(HOST_ROOT, "src/app/globals.css"),
    resolve(HOST_ROOT, "src/app/layout.tsx")
  );

  // ── Feature-page data ──
  const migrations = extractMigrations(resolve(HOST_ROOT, "supabase/migrations"));
  const broadcasts = extractBroadcasts(resolve(HOST_ROOT, "src/lib/broadcast.ts"));
  const actionDetails = extractActionDetails(resolve(HOST_ROOT, "src/app/actions"));
  const coverage = extractCoverage(resolve(HOST_ROOT, "coverage/lcov.info"));
  const snapshot = readSnapshot(resolve(__dirname, "../src/data/live-schema-snapshot.json"));
  const schemaDrift = snapshot ? computeDrift(snapshot, tables, views, rpcs) : null;

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
    broadcasts,
    gotchas: CURATED_GOTCHAS,
    components: [],
    scenarios: [],
    designTokens,
    migrations,
    rlsPolicies: snapshot?.policies ?? [],
    rlsCapturedAt: snapshot?.capturedAt ?? "",
    coverage,
    schemaDrift,
    actionDetails,
    stateMachines: STATE_MACHINES,
  };

  writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + "\n");

  const ms = Date.now() - t0;
  console.log(`[extract] ✓ done in ${ms}ms`);
  console.log(`  tables:       ${tables.length}`);
  console.log(`  views:        ${views.length}`);
  console.log(`  enums:        ${enums.length}`);
  console.log(`  rpcs:         ${rpcs.length}`);
  console.log(`  constants:    ${constants.length}`);
  console.log(`  actions:      ${actions.length} files (${actionDetails.length} fns)`);
  console.log(`  migrations:   ${migrations.length}`);
  console.log(`  broadcasts:   ${broadcasts.length}`);
  console.log(`  rlsPolicies:  ${manifest.rlsPolicies.length}`);
  console.log(`  coverage:     ${coverage ? coverage.totals.pct + "% lines" : "n/a"}`);
  console.log(`  schemaDrift:  ${schemaDrift ? (schemaDrift.ok ? "clean" : "DRIFT") : "n/a"}`);
  console.log(`  → ${OUT_PATH}`);
}

run();
