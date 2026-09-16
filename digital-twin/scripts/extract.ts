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
import { fileURLToPath, pathToFileURL } from "url";
import {
  extractBroadcasts,
  extractChannels,
  extractComponents,
  extractGotchas,
  extractRoutes,
  type BroadcastEntry,
  type ChannelEntry,
  type ComponentNode,
  type GotchaEntry,
  type RouteEntry,
} from "./extract-host.ts";

const CHECK_MODE = process.argv.includes("--check");

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST_ROOT = resolve(__dirname, "../../"); // badminton-app/
const OUT_PATH = resolve(__dirname, "../src/data/manifest.json");

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
  channels: ChannelEntry[];
  broadcasts: BroadcastEntry[];
  gotchas: GotchaEntry[];
  components: ComponentNode[];
  routes: RouteEntry[];
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
export interface LiveSnapshot {
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
  /** Columns present on both sides whose NULL-ability disagrees (high-signal,
   *  vocabulary-independent — unlike raw Postgres↔TS type-name comparison). */
  columnNullabilityDrift: { table: string; column: string; db: string; code: string }[];
  /** Known-benign nullability differences (e.g. GENERATED columns) — surfaced
   *  but not counted as drift. */
  columnNullabilityExpected: {
    table: string;
    column: string;
    db: string;
    code: string;
    reason: string;
  }[];
  /** dbOnly = real drift; dbOnlyExpected = triggers / SECURITY DEFINER helpers
   *  that are intentionally NOT exposed as PostgREST RPCs. */
  functions: { dbOnly: string[]; dbOnlyExpected: string[]; codeOnly: string[] };
  views: { dbOnly: string[]; codeOnly: string[] };
  tables: { dbOnly: string[]; dbOnlyExpected: string[]; codeOnly: string[] };
}

/** DB functions intentionally absent from the TS RPC type: trigger functions,
 *  SECURITY DEFINER RLS helpers, and `_`-prefixed internal helpers. Not drift. */
const EXPECTED_DB_ONLY_FNS = new Set([
  "handle_new_session",
  "handle_new_user",
  "set_updated_at",
  "touch_push_subscription_updated_at",
  "is_session_organizer",
  "has_match_access",
  "is_club_member",
  "is_match_club_member",
  "is_session_club_member",
  "session_access_level",
  "log_queue_status_change",
  "realtime_topic_session_id",
]);

/**
 * Live tables the TypeScript schema will not declare. Rebuild backups from
 * 20260812 — drop is gated on explicit DDL approval. Until then they must
 * not fail schemaDrift.ok.
 */
const EXPECTED_DB_ONLY_TABLES = new Set([
  "player_partnerships_prerebuild_20260812",
  "player_rivalries_prerebuild_20260812",
]);

/** Known-benign column nullability differences, keyed `table.column`. */
const EXPECTED_NULLABILITY = new Map<string, string>([
  [
    "session_wrapped_stats.point_diff",
    "GENERATED column (points_for − points_against). Postgres marks generated columns nullable, but it is never null in practice, so the TS type is `number`.",
  ],
  [
    "matches.is_held",
    "GENERATED ALWAYS AS (cardinality(pulled_player_ids) > 0). Postgres marks generated columns nullable; the TS type is `boolean`.",
  ],
  [
    "matches.final_classification",
    "GENERATED column (created_method × modified). Postgres marks generated columns nullable; the TS type is MatchClassification.",
  ],
]);

/** Strip Supabase RPC arg conventions so we compare on the bare function name. */
export function computeDrift(
  snap: LiveSnapshot,
  tables: TableEntry[],
  views: ViewEntry[],
  rpcs: RPCEntry[]
): SchemaDrift {
  const codeTableMap = new Map(tables.map((t) => [t.name, t.columns]));
  const tableColumnDrift: SchemaDrift["tableColumnDrift"] = [];
  const columnNullabilityDrift: SchemaDrift["columnNullabilityDrift"] = [];
  const columnNullabilityExpected: SchemaDrift["columnNullabilityExpected"] = [];
  for (const [tbl, cols] of Object.entries(snap.tables)) {
    const codeCols = codeTableMap.get(tbl);
    if (!codeCols) continue; // table-level drift handled below
    const codeNames = codeCols.map((c) => c.name);
    const dbNames = cols.map((c) => c[0]);
    const dbOnly = dbNames.filter((c) => !codeNames.includes(c));
    const codeOnly = codeNames.filter((c) => !dbNames.includes(c));
    if (dbOnly.length || codeOnly.length) tableColumnDrift.push({ table: tbl, dbOnly, codeOnly });

    // Nullability parity for columns present on BOTH sides.
    const codeByName = new Map(codeCols.map((c) => [c.name, c]));
    for (const [colName, , dbNullable] of cols) {
      const cc = codeByName.get(colName);
      if (cc && cc.nullable !== dbNullable) {
        const reason = EXPECTED_NULLABILITY.get(`${tbl}.${colName}`);
        const entry = {
          table: tbl,
          column: colName,
          db: dbNullable ? "NULL" : "NOT NULL",
          code: cc.nullable ? "| null" : "non-null",
        };
        if (reason) columnNullabilityExpected.push({ ...entry, reason });
        else columnNullabilityDrift.push(entry);
      }
    }
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
  const tblDbOnlyAll = [...dbTables].filter((t) => !codeTables.has(t));
  const tblDbOnlyExpected = tblDbOnlyAll.filter((t) => EXPECTED_DB_ONLY_TABLES.has(t)).sort();
  const tblDbOnly = tblDbOnlyAll.filter((t) => !EXPECTED_DB_ONLY_TABLES.has(t)).sort();
  const tblCodeOnly = [...codeTables].filter((t) => !dbTables.has(t)).sort();

  const ok =
    tableColumnDrift.length === 0 &&
    columnNullabilityDrift.length === 0 &&
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
    columnNullabilityDrift,
    columnNullabilityExpected,
    functions: { dbOnly: fnDbOnly, dbOnlyExpected: fnDbOnlyExpected, codeOnly: fnCodeOnly },
    views: { dbOnly: viewDbOnly, codeOnly: viewCodeOnly },
    tables: { dbOnly: tblDbOnly, dbOnlyExpected: tblDbOnlyExpected, codeOnly: tblCodeOnly },
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
export interface CoverageData {
  totals: { lines: number; hit: number; pct: number; files: number };
  dirs: CoverageDir[];
  files: CoverageFile[];
}

export function extractCoverage(lcovPath: string, preserveFrom = OUT_PATH): CoverageData | null {
  let raw: string;
  try {
    raw = readFileSync(lcovPath, "utf8");
  } catch {
    // Preserve the last committed coverage block so a machine that has never
    // run `npm run test:unit:coverage` cannot wipe it by re-extracting.
    try {
      const existing = JSON.parse(readFileSync(preserveFrom, "utf8")) as Manifest;
      if (existing.coverage) {
        console.log(
          `[extract] coverage/lcov.info missing — preserving committed coverage (${existing.coverage.totals.pct}% lines)`
        );
        return existing.coverage;
      }
    } catch {
      // first extract, no prior manifest
    }
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
  // From the first '{' after startIdx, return the brace-balanced body — but
  // skip braces inside line/block comments, '…'/"…" strings, and `…` template
  // literals so a lone '}' in a comment or string can't unbalance the count.
  const open = content.indexOf("{", startIdx);
  if (open === -1) return "";
  let depth = 0;
  const n = content.length;
  let i = open;
  while (i < n) {
    const ch = content[i];
    const next = content[i + 1];
    if (ch === "/" && next === "/") {
      const nl = content.indexOf("\n", i + 2);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = content.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < n && content[i] !== ch) {
        if (content[i] === "\\") i++; // skip escaped char
        i++;
      }
      i++; // closing quote/backtick
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return content.slice(open, i + 1);
    }
    i++;
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

// ── State machines (queue_status + match_status + held drafts) — curated ───────

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
  {
    name: "Held-draft lifecycle",
    field: "deriveHeldState",
    states: ["HOLDING", "RESTING", "READY"],
    edges: [
      {
        from: "HOLDING",
        to: "RESTING",
        label: "source match ends; held_ready_at still null",
      },
      {
        from: "RESTING",
        to: "READY",
        label: "held_ready_at stamped (promotable)",
      },
      {
        from: "HOLDING",
        to: "READY",
        label: "held_ready_at stamped while source still in_progress",
      },
    ],
  },
];

// ── Main ───────────────────────────────────────────────────────────────────────

/** Keys that vary by environment / clock and must not fail `--check`. */
export const CHECK_IGNORE_KEYS = new Set(["_lastExtracted", "coverage"]);

export function canonicalForCheck(manifest: Manifest): string {
  const copy = { ...(manifest as unknown as Record<string, unknown>) };
  for (const key of CHECK_IGNORE_KEYS) delete copy[key];
  return JSON.stringify(copy);
}

function differingKeys(a: Manifest, b: Manifest): string[] {
  const aRec = a as unknown as Record<string, unknown>;
  const bRec = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(aRec), ...Object.keys(bRec)]);
  const out: string[] = [];
  for (const key of keys) {
    if (CHECK_IGNORE_KEYS.has(key)) continue;
    if (JSON.stringify(aRec[key]) !== JSON.stringify(bRec[key])) {
      out.push(key);
    }
  }
  return out.sort();
}

export function buildManifest(): Manifest {
  const { tables, views, enums, rpcs } = extractDatabase(
    resolve(HOST_ROOT, "src/types/database.ts")
  );
  const constants = extractConstants(resolve(HOST_ROOT, "src/lib/constants.ts"));
  const actions = extractActions(resolve(HOST_ROOT, "src/app/actions"));
  const designTokens = extractDesignTokens(
    resolve(HOST_ROOT, "src/app/globals.css"),
    resolve(HOST_ROOT, "src/app/layout.tsx")
  );

  const migrations = extractMigrations(resolve(HOST_ROOT, "supabase/migrations"));
  const broadcasts = extractBroadcasts(resolve(HOST_ROOT, "src/lib/broadcast.ts"));
  const actionDetails = extractActionDetails(resolve(HOST_ROOT, "src/app/actions"));
  const coverage = extractCoverage(resolve(HOST_ROOT, "coverage/lcov.info"));
  const snapshot = readSnapshot(resolve(__dirname, "../src/data/live-schema-snapshot.json"));
  const schemaDrift = snapshot ? computeDrift(snapshot, tables, views, rpcs) : null;
  const channels = extractChannels(HOST_ROOT);
  const components = extractComponents(HOST_ROOT, {
    components: resolve(HOST_ROOT, "src/components"),
    hooks: resolve(HOST_ROOT, "src/hooks"),
    actions: resolve(HOST_ROOT, "src/app/actions"),
  });
  const routes = extractRoutes(resolve(HOST_ROOT, "src/app"), HOST_ROOT);
  const gotchas = extractGotchas(
    resolve(HOST_ROOT, "APP_MANIFEST.md"),
    resolve(__dirname, "../src/data/gotcha-sidecar.json")
  );

  return {
    _version: 2,
    _lastExtracted: new Date().toISOString(),
    tables,
    views,
    enums,
    rpcs,
    constants,
    actions,
    channels,
    broadcasts,
    gotchas,
    components,
    routes,
    designTokens,
    migrations,
    rlsPolicies: snapshot?.policies ?? [],
    rlsCapturedAt: snapshot?.capturedAt ?? "",
    coverage,
    schemaDrift,
    actionDetails,
    stateMachines: STATE_MACHINES,
  };
}

function logSummary(manifest: Manifest, ms: number): void {
  console.log(`[extract] ✓ done in ${ms}ms`);
  console.log(`  tables:       ${manifest.tables.length}`);
  console.log(`  views:        ${manifest.views.length}`);
  console.log(`  enums:        ${manifest.enums.length}`);
  console.log(`  rpcs:         ${manifest.rpcs.length}`);
  console.log(`  constants:    ${manifest.constants.length}`);
  console.log(
    `  actions:      ${manifest.actions.length} files (${manifest.actionDetails.length} fns)`
  );
  console.log(`  migrations:   ${manifest.migrations.length}`);
  console.log(`  broadcasts:   ${manifest.broadcasts.length}`);
  console.log(`  channels:     ${manifest.channels.length}`);
  console.log(`  gotchas:      ${manifest.gotchas.length}`);
  console.log(`  components:   ${manifest.components.length}`);
  console.log(`  routes:       ${manifest.routes.length}`);
  console.log(`  rlsPolicies:  ${manifest.rlsPolicies.length}`);
  console.log(
    `  coverage:     ${manifest.coverage ? manifest.coverage.totals.pct + "% lines" : "n/a"}`
  );
  console.log(
    `  schemaDrift:  ${manifest.schemaDrift ? (manifest.schemaDrift.ok ? "clean" : "DRIFT") : "n/a"}`
  );
}

export function run(): void {
  const t0 = Date.now();
  console.log(`[extract] starting${CHECK_MODE ? " (--check)" : ""}…`);

  const manifest = buildManifest();
  const nextBody = JSON.stringify(manifest, null, 2) + "\n";

  if (CHECK_MODE) {
    let disk: Manifest;
    try {
      disk = JSON.parse(readFileSync(OUT_PATH, "utf8")) as Manifest;
    } catch {
      console.error(
        "[extract] ✗ no committed manifest at digital-twin/src/data/manifest.json.\n" +
          "       Run `cd digital-twin && npm run extract`, then stage the result."
      );
      process.exit(1);
    }
    if (canonicalForCheck(manifest) !== canonicalForCheck(disk)) {
      const keys = differingKeys(manifest, disk);
      console.error(
        "[extract] ✗ committed manifest.json is stale.\n" +
          `       Differing keys: ${keys.join(", ") || "(unknown)"}\n` +
          "       Run `cd digital-twin && npm run extract`, then stage digital-twin/src/data/manifest.json."
      );
      process.exit(1);
    }
    console.log(
      "[extract] ✓ committed manifest matches host source (ignoring _lastExtracted, coverage)"
    );
    return;
  }

  writeFileSync(OUT_PATH, nextBody);
  logSummary(manifest, Date.now() - t0);
  console.log(`  → ${OUT_PATH}`);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) run();
