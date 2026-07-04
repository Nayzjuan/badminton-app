#!/usr/bin/env python3
"""
Badminton App — Supabase production backup
Run anytime: python3 backups/run_backup.py

Fetches all rows from all tables via Supabase REST API (service role key),
generates INSERT-based SQL, and writes a timestamped file to this directory.
No external dependencies — stdlib only.

Restore-safety (see ARRAY_COLUMNS / GENERATED_COLUMNS below):
  • Postgres ARRAY columns (text[], uuid[]) are emitted as array literals
    ('{"a","b"}'::text[]), NOT as jsonb — the REST API returns them as JSON
    lists, which would otherwise restore-fail with "is of type text[] but
    expression is of type jsonb".
  • GENERATED (STORED) columns are OMITTED from the column list + VALUES —
    Postgres rejects inserting a non-DEFAULT value into a generated column.

Credentials
-----------
Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment (or .env),
OR create a backups/.env file with:
    SUPABASE_URL=https://xxx.supabase.co
    SUPABASE_SERVICE_KEY=eyJ...
"""
import json
import os
import urllib.request
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

# ── Credentials (env-first, .env fallback) ───────────────────────────────────
def _load_dotenv(path: Path):
    """Minimal .env loader — no external deps."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))

_load_dotenv(Path(__file__).parent / ".env")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY  = os.environ.get("SUPABASE_SERVICE_KEY", "")

if not SUPABASE_URL or not SERVICE_KEY:
    print("Error: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.")
    print("  Create backups/.env with those two variables, or export them.")
    import sys; sys.exit(1)
OUTPUT_DIR  = Path(__file__).parent          # same folder as this script
BATCH_SIZE  = 1000

# Table order respects FK dependencies (parents before children).
# Kept in sync with the public base tables in the live schema — see the
# pg_class relkind='r' inventory. Last reconciled 2026-06-24 (added
# player_renames, match_events, player_partnerships, player_rivalries).
TABLES = [
    "profiles",
    "clubs",                # multi-tenant: before sessions (sessions.club_id FK)
    "club_members",         # FK: → clubs, profiles
    "club_invites",         # FK: → clubs, profiles
    "sessions",
    "session_organizers",
    "courts",
    "push_subscriptions",
    "identity_migrations",
    "player_renames",          # FK: → profiles (rename history)
    "queue_entries",
    "matches",
    "match_games",          # must come after matches (FK: match_games.match_id → matches.id)
    "match_players",        # FK: → matches, profiles
    "match_events",         # FK: → matches (ON DELETE SET NULL), sessions — provenance audit trail
    "player_partnerships",  # FK: → profiles, sessions (cross-session stats)
    "player_rivalries",     # FK: → profiles, sessions (cross-session stats)
    "session_wrapped_stats",
]

# ── Column-type overrides (schema-driven; reconcile when the schema changes) ──
# ARRAY_COLUMNS: Postgres array columns must be dumped as array literals, not
#   jsonb. Maps table -> {column: sql_array_type}. Every element is double-quoted
#   (valid for text[] AND uuid[]); see pg_array_literal().
ARRAY_COLUMNS = {
    "matches":               {"pulled_player_ids": "uuid[]"},
    "session_wrapped_stats": {"earned_awards": "text[]"},
}
# GENERATED_COLUMNS: STORED generated columns — must be OMITTED from INSERTs
#   (Postgres derives them; inserting a value errors). Maps table -> {columns}.
GENERATED_COLUMNS = {
    "matches":               {"is_held", "final_classification"},
    "session_wrapped_stats": {"point_diff"},
}
# Reconcile both maps against prod whenever the schema changes (last: 2026-07-01):
#   SELECT c.relname, a.attname, t.typname, (t.typcategory='A') AS is_array,
#          a.attgenerated
#   FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
#     JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid
#   WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
#     AND (t.typcategory='A' OR a.attgenerated<>'') ORDER BY c.relname, a.attnum;

HEADERS = {
    "apikey":        SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type":  "application/json",
}

# ── Helpers ───────────────────────────────────────────────────────────────────

def sql_value(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return repr(v)
    if isinstance(v, (dict, list)):
        raw = json.dumps(v, ensure_ascii=False, separators=(',', ':'))
        return f"'{raw.replace(chr(39), chr(39)+chr(39))}'::jsonb"
    return f"'{str(v).replace(chr(39), chr(39)+chr(39))}'"


def pg_array_literal(items, sql_type: str) -> str:
    """Render a Python list as a Postgres array literal — e.g. text[] ->
    '{"ice_cold","point_machine"}'::text[]. Each element is double-quoted with
    embedded " and \\ escaped, which is valid for text[] and uuid[] alike; a NULL
    element becomes the unquoted token NULL. The whole literal is single-quoted
    (with ' doubled) and cast to the column's array type."""
    if items is None:
        return "NULL"
    parts = []
    for el in items:
        if el is None:
            parts.append("NULL")
        else:
            s = str(el).replace("\\", "\\\\").replace('"', '\\"')
            parts.append(f'"{s}"')
    inner = "{" + ",".join(parts) + "}"
    return f"'{inner.replace(chr(39), chr(39)+chr(39))}'::{sql_type}"


def fetch_all_rows(table: str) -> list:
    rows, offset = [], 0
    while True:
        params = urllib.parse.urlencode({"select": "*", "limit": BATCH_SIZE, "offset": offset})
        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/{table}?{params}",
            headers=HEADERS, method="GET"
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            batch = json.loads(resp.read().decode("utf-8"))
        if not batch:
            break
        rows.extend(batch)
        end = offset + len(batch)
        print(f"  {table}: rows {offset+1}–{end}")
        if len(batch) < BATCH_SIZE:
            break
        offset += BATCH_SIZE
    return rows


def build_sql(table: str, rows: list) -> list:
    if not rows:
        return [f"-- {table}: 0 rows"]
    generated = GENERATED_COLUMNS.get(table, set())
    arrays = ARRAY_COLUMNS.get(table, {})
    # Skip generated columns entirely (can't be inserted).
    cols = [c for c in rows[0].keys() if c not in generated]
    col_list = ", ".join(cols)

    def render(col: str, val) -> str:
        # Array columns -> Postgres array literal; everything else -> sql_value
        # (which still emits genuine jsonb objects/arrays as ::jsonb).
        if col in arrays:
            return pg_array_literal(val, arrays[col])
        return sql_value(val)

    return [
        f"INSERT INTO public.{table} ({col_list}) VALUES ({', '.join(render(c, r[c]) for c in cols)});"
        for r in rows
    ]

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    ts       = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
    out_path = OUTPUT_DIR / f"db_backup_{ts}.sql"

    print(f"\n{'='*58}")
    print(f"  Badminton App — Supabase backup")
    print(f"  Output: {out_path.name}")
    print(f"{'='*58}\n")

    lines   = [
        "-- ============================================================",
        f"-- Badminton App — Supabase production backup",
        f"-- Generated : {ts}",
        f"-- Project   : usxftpexoimletqmrggb (supabase)",
        "-- ============================================================",
        "",
        "SET client_encoding = 'UTF8';",
        "BEGIN;",
        "",
    ]
    summary = []

    for table in TABLES:
        print(f"Fetching {table}…")
        rows  = fetch_all_rows(table)
        count = len(rows)
        summary.append((table, count))
        print(f"  → {count} rows\n")

        lines += [
            f"-- ------------------------------------------------------------",
            f"-- {table}  ({count} rows)",
            f"-- ------------------------------------------------------------",
            f"ALTER TABLE public.{table} DISABLE TRIGGER ALL;",
            "",
            *build_sql(table, rows),
            "",
            f"ALTER TABLE public.{table} ENABLE TRIGGER ALL;",
            "",
        ]

    total = sum(c for _, c in summary)
    lines += [
        "COMMIT;",
        "",
        "-- ============================================================",
        "-- Row counts",
        *[f"--   {t:<30} {c:>6} rows" for t, c in summary],
        f"--   {'TOTAL':<30} {total:>6} rows",
        "-- ============================================================",
    ]

    out_path.write_text("\n".join(lines), encoding="utf-8")

    print(f"\n{'='*58}")
    print(f"  Written : {out_path}")
    print(f"  Size    : {out_path.stat().st_size:,} bytes")
    print(f"  Rows    : {total:,} total")
    print(f"{'='*58}")
    print()
    for t, c in summary:
        print(f"  {t:<30} {c:>5}")
    print(f"  {'TOTAL':<30} {total:>5}")


if __name__ == "__main__":
    main()
