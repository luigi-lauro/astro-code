#!/usr/bin/env python3
"""kit_source.py — author or refresh a kit's data source by introspecting the
real database THROUGH a running Astro instance (ADR-022), never a local
driver. Writes `src/sources/<id>/schema.json` and `src/sources/<id>/
SOURCE.md`. First run creates both from scratch; every later run MERGES —
author-written fields are never lost, and drift from the database (a table or
column gone, or a renamed type) is flagged in the report only, never deleted.

Stdlib only, like publish_kit.py / kit_test.py / _astro_client.py. Credentials
are read from the environment ONLY (there is no --password flag; passing one
is an argparse error):

    ASTRO_BASE_URL (or --base), ASTRO_ADMIN_EMAIL, ASTRO_ADMIN_PASSWORD
    ASTRO_SOURCE_<ID>_HOST/_PORT/_DATABASE/_USERNAME/_PASSWORD/
        _TRUST_SERVER_CERTIFICATE  — a one-off connection, used instead of
        the source's binding when ASTRO_SOURCE_<ID>_HOST is set.

Usage:
    kit_source.py <source_id> [--base URL] [--kit-root DIR]
                  [--include GLOB]... [--exclude GLOB]... [--sample-values]

Exit codes:
    0  ok
    2  usage: undeclared source id, missing env, not a kit root — checked
       BEFORE any network call, and nothing is written
    3  auth failed
    4  introspection refused (any 4xx after login)
    6  network or instance error (5xx / timeout)
    7  the merged result fails validate_source_schema (should never happen;
       nothing is written)

On any non-zero exit nothing is written. Files are written atomically (temp
file + os.replace).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import quote

# `-I` drops the script's own directory from sys.path (PLAN.md's "where the
# code differs" note) — insert it before importing sibling modules.
_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import _astro_client as astro  # noqa: E402
from kit_test import (  # noqa: E402
    SourceSchemaParseError,
    load_source_schema_json,
    validate_source_schema,
    _normalize_table_key,
)

# A bare `schema`/`table` identifier — kit_test.py's `_TABLE_PART`'s unbracketed
# alternative. Anything else (a name with a space, a dash, …) is wrapped in
# brackets in the written table key.
_BARE_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$#@]*$")


def _table_key(schema: str, name: str) -> str:
    if _BARE_IDENT_RE.match(schema) and _BARE_IDENT_RE.match(name):
        return f"{schema}.{name}"
    return f"[{schema}].[{name}]"


def _ident(part: str) -> str:
    return part if _BARE_IDENT_RE.match(part) else f"[{part}]"


def _joins_ref(fk: dict) -> str:
    return f"{_table_key(fk['refSchema'], fk['refTable'])}.{_ident(fk['refColumns'][0])}"


def _unbracket(part: str) -> str:
    return part[1:-1] if part.startswith("[") and part.endswith("]") else part


def _sensitive_columns(existing: dict | None) -> list[str]:
    """`schema.table.column` (raw names, no brackets) for every column the
    local schema.json marks `sensitive: true` — sent so the instance skips
    them even before this schema.json has been uploaded."""
    out: list[str] = []
    for key, table in ((existing or {}).get("tables") or {}).items():
        m = re.fullmatch(r"(\[[^\]]+\]|[^.\[\]]+)\.(\[[^\]]+\]|[^.\[\]]+)", key)
        if not m or not isinstance(table, dict):
            continue
        for col_name, col in (table.get("columns") or {}).items():
            if isinstance(col, dict) and col.get("sensitive") is True:
                out.append(f"{_unbracket(m.group(1))}.{_unbracket(m.group(2))}.{col_name}")
    return sorted(out)


def _resolve_kit_id(root: Path) -> str:
    """Mirrors publish_kit.py's load_manifest/build_upload_manifest: prefer
    registry-entry.json's `id`, else kit.json's `name` (which IS the id)."""
    for name in ("registry-entry.json", "kit.json"):
        path = root / name
        if path.is_file():
            try:
                data = json.loads(path.read_text())
            except json.JSONDecodeError as exc:
                astro.die(2, f"{path} is not valid JSON: {exc}")
            kit_id = data.get("id") or data.get("name")
            if kit_id:
                return str(kit_id)
    astro.die(2, f"no kit id found (looked for registry-entry.json / kit.json under {root})")


def _load_declared_sources(root: Path) -> list[dict]:
    path = root / "kit.json"
    if not path.is_file():
        astro.die(2, f"no kit.json found at {path}")
    try:
        manifest = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        astro.die(2, f"{path} is not valid JSON: {exc}")
    sources = manifest.get("sources")
    return sources if isinstance(sources, list) else []


def _new_table_entry(obj: dict, sample_values: bool) -> dict:
    entry: dict = {
        "purpose": obj.get("description") or "TODO: what this table holds and when to use it",
        "kind": "table" if obj.get("type") == "table" else "view",
    }
    if obj.get("approxRows") is not None:
        entry["rows"] = int(obj["approxRows"])
    entry["columns"] = {}
    single_col_fks: dict[str, dict] = {}
    for fk in obj.get("foreignKeys") or []:
        cols = fk.get("columns") or []
        ref_cols = fk.get("refColumns") or []
        if len(cols) == 1 and len(ref_cols) == 1:
            single_col_fks[cols[0]] = fk
    pk_columns = set(obj.get("primaryKey") or [])
    for col in obj.get("columns") or []:
        name = col["name"]
        col_entry: dict = {
            "meaning": col.get("description") or "TODO: what this column means",
            "type": col["sqlType"],
        }
        if name in pk_columns:
            col_entry["key"] = True
        fk = single_col_fks.get(name)
        if fk:
            col_entry["joins"] = _joins_ref(fk)
        values = col.get("values")
        if sample_values and values:
            col_entry["values"] = {v: "" for v in values}
        entry["columns"][name] = col_entry
    return entry


def _merge_table_entry(existing: dict, obj: dict, sample_values: bool) -> dict:
    """Refreshes the structural fields (`kind`, `rows` at the table level;
    `type`, `key` per column) and keeps everything else verbatim. New columns
    are added like a first run; columns gone from the database are kept
    unchanged (the caller flags them)."""
    merged = dict(existing)
    merged["kind"] = "table" if obj.get("type") == "table" else "view"
    if obj.get("approxRows") is not None:
        merged["rows"] = int(obj["approxRows"])

    existing_columns = dict(existing.get("columns") or {})
    by_lower = {k.lower(): k for k in existing_columns}
    single_col_fks: dict[str, dict] = {}
    for fk in obj.get("foreignKeys") or []:
        cols = fk.get("columns") or []
        ref_cols = fk.get("refColumns") or []
        if len(cols) == 1 and len(ref_cols) == 1:
            single_col_fks[cols[0]] = fk
    pk_columns = set(obj.get("primaryKey") or [])

    merged_columns = dict(existing_columns)
    for col in obj.get("columns") or []:
        name = col["name"]
        existing_key = by_lower.get(name.lower())
        if existing_key is None:
            col_entry: dict = {
                "meaning": col.get("description") or "TODO: what this column means",
                "type": col["sqlType"],
            }
            if name in pk_columns:
                col_entry["key"] = True
            fk = single_col_fks.get(name)
            if fk:
                col_entry["joins"] = _joins_ref(fk)
            values = col.get("values")
            if sample_values and values:
                col_entry["values"] = {v: "" for v in values}
            merged_columns[name] = col_entry
        else:
            col_entry = dict(merged_columns[existing_key])
            col_entry["type"] = col["sqlType"]
            if name in pk_columns:
                col_entry["key"] = True
            if "joins" not in col_entry:
                fk = single_col_fks.get(name)
                if fk:
                    col_entry["joins"] = _joins_ref(fk)
            if "values" not in col_entry and col_entry.get("sensitive") is not True:
                values = col.get("values")
                if sample_values and values:
                    col_entry["values"] = {v: "" for v in values}
            if existing_key != name:
                del merged_columns[existing_key]
            merged_columns[name] = col_entry
    merged["columns"] = merged_columns
    return merged


def build_schema(existing: dict | None, objects: list[dict], sample_values: bool) -> tuple[dict, dict]:
    """Returns (merged schema dict, report). `report` has `added` (tables,
    columns), `flagged` (tables, columns gone from the database) and
    `typeChanges` ([{table, column, old, new}])."""
    report = {"added_tables": [], "added_columns": [], "flagged_tables": [], "flagged_columns": [], "type_changes": [], "sampled": [], "kept_keys": []}

    existing_tables: dict = dict(existing.get("tables") or {}) if existing else {}
    by_norm = {_normalize_table_key(k): k for k in existing_tables}
    seen_norms: set[str] = set()
    merged_tables = dict(existing_tables)

    for obj in objects:
        key = _table_key(obj["schema"], obj["name"])
        norm = _normalize_table_key(key)
        seen_norms.add(norm)
        existing_key = by_norm.get(norm)
        if existing_key is None:
            merged_tables[key] = _new_table_entry(obj, sample_values)
            report["added_tables"].append(key)
            for col_name in merged_tables[key]["columns"]:
                report["added_columns"].append(f"{key}.{col_name}")
            for col in obj.get("columns") or []:
                if sample_values and col.get("values"):
                    report["sampled"].append(f"{key}.{col['name']}")
        else:
            before = existing_tables[existing_key]
            before_cols = {k.lower(): (k, v) for k, v in (before.get("columns") or {}).items()}
            after = _merge_table_entry(before, obj, sample_values)
            # type changes + newly added columns, from the diff of before/after.
            new_col_names = {c["name"] for c in (obj.get("columns") or [])}
            for col in obj.get("columns") or []:
                prior = before_cols.get(col["name"].lower())
                if prior is None:
                    report["added_columns"].append(f"{existing_key}.{col['name']}")
                    if sample_values and col.get("values"):
                        report["sampled"].append(f"{existing_key}.{col['name']}")
                else:
                    prior_name, prior_entry = prior
                    if prior_entry.get("key") is True and col["name"] not in set(obj.get("primaryKey") or []):
                        report["kept_keys"].append(f"{existing_key}.{col['name']}")
                    if (
                        sample_values
                        and col.get("values")
                        and "values" not in prior_entry
                        and prior_entry.get("sensitive") is not True
                    ):
                        report["sampled"].append(f"{existing_key}.{col['name']}")
                    old_type = prior_entry.get("type")
                    if old_type is not None and old_type != col["sqlType"]:
                        report["type_changes"].append(
                            {"table": existing_key, "column": col["name"], "old": old_type, "new": col["sqlType"]}
                        )
            for col_name_lower, (col_name, _) in before_cols.items():
                if not any(c["name"].lower() == col_name_lower for c in (obj.get("columns") or [])):
                    report["flagged_columns"].append(f"{existing_key}.{col_name}")
            if existing_key != key:
                del merged_tables[existing_key]
            merged_tables[key] = after

    for norm_key, orig_key in by_norm.items():
        if norm_key not in seen_norms:
            report["flagged_tables"].append(orig_key)

    merged = dict(existing) if existing else {}
    merged["version"] = 1
    merged["tables"] = merged_tables
    return merged, report


def build_source_md(source_id: str, database: str, objects: list[dict]) -> str:
    lines = [f"# {source_id}", "", f"Database: {database}", "", "## Tables", ""]
    for obj in sorted(objects, key=lambda o: (o["schema"], o["name"])):
        key = _table_key(obj["schema"], obj["name"])
        kind = "table" if obj.get("type") == "table" else "view"
        rows = obj.get("approxRows")
        suffix = f", ~{rows} rows" if rows is not None else ""
        lines.append(f"- {key} ({kind}{suffix})")
    # The prompts below are the questions an agent reading this file cannot answer from
    # column names alone. They mirror KIT-CONTRACT.md "Writing a good source" so the
    # author fills the skeleton with knowledge, not with a restated table list.
    # `## Purpose`/`## Rules`/`## Units`/`## Time zones` are kept as headings: the
    # sources tests and existing authored files rely on them.
    lines += [
        "",
        "<!-- Fill every TODO, then delete these comments. Guide: KIT-CONTRACT.md",
        '     "Writing a good source". The reader is an agent that has never seen this',
        "     database — write what it cannot infer from column names. -->",
        "",
        "## Purpose",
        "",
        "TODO: what this database is, and when an agent should query it — and when it",
        "should NOT (questions another source or the kit's inputs answer better).",
        "",
        "## Which tables answer which questions",
        "",
        "TODO: map each question the kit asks to the tables that answer it, e.g.",
        '"open orders per customer → dbo.Orders joined to dbo.Customers on CustomerId".',
        "",
        "## Grain",
        "",
        "TODO: what one row means in each table the kit uses (one order line, one daily",
        "snapshot, one current-version row, …) — wrong grain is how totals double count.",
        "",
        "## Rules",
        "",
        "TODO: filters that must ALWAYS apply — soft-deletes (e.g. IsDeleted = 0), status",
        "codes to include or exclude, test/internal tenants, current-version flags.",
        "",
        "## Units",
        "",
        "TODO: the currency of each amount, net or gross (VAT?), cents or units, and the",
        "unit of every quantity or measurement column.",
        "",
        "## Time zones",
        "",
        "TODO: the time zone of each family of date/time columns (UTC, the server's local",
        "time, or a business date with no time zone).",
        "",
        "## Known traps",
        "",
        "TODO: columns that do not mean what their name says, legacy codes, stale or",
        "look-alike tables to avoid, slow tables that need a selective WHERE.",
        "",
    ]
    return "\n".join(lines)


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _print_summary(report: dict, source_md_created: bool, source_id: str) -> None:
    if report["added_tables"] or report["added_columns"]:
        astro.log("added:")
        for t in report["added_tables"]:
            astro.log(f"  table {t}")
        for c in report["added_columns"]:
            astro.log(f"  column {c}")
    if report["flagged_tables"] or report["flagged_columns"]:
        astro.log("flagged (missing in database):")
        for t in report["flagged_tables"]:
            astro.log(f"  table {t}")
        for c in report["flagged_columns"]:
            astro.log(f"  column {c}")
    if report["type_changes"]:
        astro.log("type changes:")
        for ch in report["type_changes"]:
            astro.log(f"  {ch['table']}.{ch['column']} {ch['old']} → {ch['new']}")
    if report["kept_keys"]:
        astro.log("kept author key (not in the database's primary key — check it still holds):")
        for c in report["kept_keys"]:
            astro.log(f"  column {c}")
    if report["sampled"]:
        astro.log("sampled values (review before publishing — they ship in the kit):")
        for c in report["sampled"]:
            astro.log(f"  {c}")
    if source_md_created:
        astro.ok(f"created src/sources/{source_id}/schema.json and SOURCE.md")
    else:
        astro.ok(f"updated src/sources/{source_id}/schema.json (SOURCE.md left untouched)")


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="kit_source.py",
        description="Author or refresh a kit's data source by introspecting the database through a running Astro instance.",
    )
    parser.add_argument("source_id", help="the source id, as declared in kit.json's sources[]")
    parser.add_argument("--base", help="Astro instance base URL (default: ASTRO_BASE_URL)")
    parser.add_argument("--kit-root", default=".", help="kit root directory (default: cwd)")
    parser.add_argument("--include", action="append", default=[], help="schema.table glob to include (repeatable)")
    parser.add_argument("--exclude", action="append", default=[], help="schema.table glob to exclude (repeatable)")
    parser.add_argument("--sample-values", action="store_true", help="opt into sampling distinct values for low-cardinality columns")
    args = parser.parse_args()

    root = Path(args.kit_root).resolve()
    if not (root / "kit.json").is_file():
        astro.die(2, f"no kit.json found at {root} — not a kit root")

    sources = _load_declared_sources(root)
    declared_ids = [s.get("id") for s in sources if isinstance(s, dict)]
    if args.source_id not in declared_ids:
        astro.die(
            2,
            f"source '{args.source_id}' is not declared in kit.json's sources[] (declared: {', '.join(declared_ids) or 'none'})",
        )

    one_off = astro.one_off_from_env(args.source_id)

    if args.base:
        base = args.base.rstrip("/")
        if not re.match(r"^https?://", base):
            base = "https://" + base
        email = os.environ.get("ASTRO_ADMIN_EMAIL")
        password = os.environ.get("ASTRO_ADMIN_PASSWORD")
        missing = [n for n, v in (("ASTRO_ADMIN_EMAIL", email), ("ASTRO_ADMIN_PASSWORD", password)) if not v]
        if missing:
            astro.die(2, "missing required environment variable(s): " + ", ".join(missing))
    else:
        base, email, password = astro.env_credentials()

    kit_id = _resolve_kit_id(root)

    src_dir = root / "src" / "sources" / args.source_id
    schema_path = src_dir / "schema.json"
    source_md_path = src_dir / "SOURCE.md"

    existing: dict | None = None
    if schema_path.is_file():
        try:
            existing = load_source_schema_json(schema_path.read_bytes())
        except (SourceSchemaParseError, ValueError) as exc:
            astro.die(2, f"existing schema.json is not valid: {exc}")

    token = astro.login(base, email, password)

    body: dict = {"sampleValues": bool(args.sample_values)}
    if args.include:
        body["include"] = args.include
    if args.exclude:
        body["exclude"] = args.exclude
    sensitive = _sensitive_columns(existing)
    if sensitive:
        body["sensitiveColumns"] = sensitive
    if one_off:
        body["connection"] = one_off

    url = f"{base}/api/kit-packages/{quote(kit_id)}/sources/{quote(args.source_id)}/introspect"
    status, resp = astro.request_json("POST", url, token, body)
    if one_off and status == 404 and isinstance(resp, dict) and resp.get("error") == "kit_not_found":
        status, resp = astro.request_json("POST", f"{base}/api/sources/introspect", token, body)

    if status >= 500 or status == 0:
        astro.die(6, f"introspection failed ({status}): {resp.get('message') or resp.get('error') or resp}")
    if status != 200:
        astro.die(4, f"introspection refused ({status}): {resp.get('message') or resp.get('error') or resp}")

    objects = resp.get("objects") or []
    database = resp.get("database") or ""

    merged, report = build_schema(existing, objects, args.sample_values)

    errors, _warnings = validate_source_schema(merged, args.source_id)
    if errors:
        astro.die(7, "merged schema.json fails validation: " + "; ".join(m for _c, _s, _f, m in errors))

    source_md_created = not source_md_path.is_file()
    if source_md_created:
        _atomic_write(source_md_path, build_source_md(args.source_id, database, objects))

    _atomic_write(schema_path, json.dumps(merged, indent=2, ensure_ascii=False) + "\n")

    _print_summary(report, source_md_created, args.source_id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
