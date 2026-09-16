/**
 * Capture the public schema of the database pointed at by DATABASE_URL
 * into digital-twin/src/data/live-schema-snapshot.json.
 *
 * Usage:
 *   npx tsx scripts/capture-schema-snapshot.ts
 *   cd digital-twin && npm run capture-snapshot
 *
 * Loads DATABASE_URL the same way scripts/prod-snapshot.ts does
 * (.env.test then .env.local). Local integration tests additionally keep
 * a copy in tests/integration/.env — that file is a fallback only.
 *
 * The twin's committed snapshot is the LIVE project, bootstrapped via
 * Supabase MCP. Re-run this script against that DATABASE_URL after DDL.
 */
import pg from "pg";
import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(REPO, ".env.test") });
dotenv.config({ path: path.join(REPO, ".env.local"), override: false });
dotenv.config({ path: path.join(REPO, "tests/integration/.env"), override: false });

const OUT = path.join(REPO, "digital-twin/src/data/live-schema-snapshot.json");

const SCALAR_TYPES: Record<string, string> = {
  int2: "smallint",
  int4: "integer",
  int8: "bigint",
  bool: "boolean",
  varchar: "character varying",
  bpchar: "character",
  float4: "real",
  float8: "double precision",
};

function pgTypeName(typname: string): string {
  if (typname.startsWith("_")) {
    return `${pgTypeName(typname.slice(1))}[]`;
  }
  return SCALAR_TYPES[typname] ?? typname;
}

interface ColRow {
  table_name: string;
  column_name: string;
  typname: string;
  attnum: number;
  nullable: boolean;
}

interface PolicyRow {
  table: string;
  name: string;
  cmd: string;
  roles: string;
  using: string | null;
  withCheck: string | null;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "[capture-schema-snapshot] DATABASE_URL is not set.\n" +
        "Add it to .env.local (live) or tests/integration/.env (local).\n" +
        "Shape: see tests/integration/env.example"
    );
  }

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const cols = (
      await client.query<ColRow>(`
        SELECT c.relname AS table_name,
               a.attname AS column_name,
               t.typname,
               a.attnum,
               NOT a.attnotnull AS nullable
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
        JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND a.attnum > 0
          AND NOT a.attisdropped
        ORDER BY c.relname, a.attnum
      `)
    ).rows;

    const views = (
      await client.query<{ relname: string }>(`
        SELECT c.relname
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
        ORDER BY c.relname
      `)
    ).rows.map((r) => r.relname);

    const functions = (
      await client.query<{ proname: string }>(`
        SELECT DISTINCT p.proname
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind = 'f'
        ORDER BY p.proname
      `)
    ).rows.map((r) => r.proname);

    const policies = (
      await client.query<PolicyRow>(`
        SELECT tablename AS table,
               policyname AS name,
               cmd,
               array_to_string(roles, ', ') AS roles,
               qual AS "using",
               with_check AS "withCheck"
        FROM pg_catalog.pg_policies
        WHERE schemaname = 'public'
        ORDER BY tablename, policyname
      `)
    ).rows;

    const tables: Record<string, [string, string, boolean][]> = {};
    for (const row of cols) {
      (tables[row.table_name] ??= []).push([
        row.column_name,
        pgTypeName(row.typname),
        row.nullable,
      ]);
    }

    const snapshot = {
      _note:
        "Point-in-time snapshot of the LIVE Supabase public schema. Captured via information_schema / pg_catalog. Consumed by extract.ts to compute schema drift vs src/types/database.ts, and to power the RLS Policy Explorer. Re-capture with: npx tsx scripts/capture-schema-snapshot.ts",
      capturedAt: new Date().toISOString().slice(0, 10),
      tables,
      views,
      functions,
      policies: policies.map((p) => ({
        table: p.table,
        name: p.name,
        cmd: p.cmd,
        roles: p.roles,
        using: p.using,
        withCheck: p.withCheck,
      })),
    };

    fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + "\n");
    console.log(
      `[capture-schema-snapshot] wrote ${OUT}\n` +
        `  tables:    ${Object.keys(tables).length}\n` +
        `  views:     ${views.length}\n` +
        `  functions: ${functions.length}\n` +
        `  policies:  ${policies.length}\n` +
        `  capturedAt ${snapshot.capturedAt}`
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
