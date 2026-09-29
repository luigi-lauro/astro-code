#!/usr/bin/env python3
"""kit_test.py — Tier 1 offline kit test: everything checkable WITHOUT a
hosted Astro instance.

Publishing a kit to test it is a slow feedback loop, and most kit breakage is
not subtle: a recipe phase that declares no output, a deliverable nothing
produces, an EXAMPLES.md missing the sections Astro reads, a report script
that does not even compile. This tool catches that class in under a second,
on the developer's machine, before anything is uploaded.

Scope — deliberately NOT the whole story:

  Tier 1 (this tool)  static: manifest, recipe, EXAMPLES, scripts, parity
  Tier 2              run the recipe against a local Astro + local registry
  Tier 3              run it inside the worker image with the tools installed

Tier 1 proves the kit is WELL-FORMED. It cannot prove the kit WORKS — only
running it does that. Every check here is mechanical and deterministic; no
check depends on an agent's judgement.

Stdlib-only, matching validate_manifest.py / parity_check.py (no requests,
no jsondiff). PyYAML is used when importable because it is authoritative,
but is NOT required — a restricted parser covers the recipe subset the kit
template emits, and refuses (loudly) to guess at anything outside it.
The data-source checks (src/sources/<id>/schema.json) never use PyYAML: the
file is plain JSON, read with the stdlib `json` module.

## Invocation

    python3 tools/kit_test.py                 # from the kit root
    python3 tools/kit_test.py --kit-root .
    python3 tools/kit_test.py --json          # machine-readable report

## Exit codes (matching validate_manifest.py, D-07)

    0  clean — no failures; warnings alone are still 0
    1  one or more checks FAILED
    2  usage / I/O error (not a kit root, unreadable file)
"""

from __future__ import annotations

import sys

# Python version guard — must run BEFORE any 3.10-only syntax below.
if sys.version_info < (3, 10):
    print(
        f"error: Python 3.10+ required, got "
        f"{sys.version_info.major}.{sys.version_info.minor}",
        file=sys.stderr,
    )
    sys.exit(2)

import argparse
import json
import py_compile
import re
import subprocess
import tempfile
from pathlib import Path

import errno
import os
import stat

try:  # authoritative when present; never required
    import yaml as _pyyaml
except ImportError:  # pragma: no cover - depends on the host env
    _pyyaml = None

# Escape hatch so the builtin fallback parser can be exercised on a machine
# that HAS PyYAML — otherwise the fallback only ever runs where it cannot be
# tested, which is how fallbacks rot.
if os.environ.get("KIT_TEST_NO_PYYAML") == "1":
    _pyyaml = None


# ── Result model ──────────────────────────────────────────────────────────

FAIL = "FAIL"
WARN = "WARN"
PASS = "PASS"


class Report:
    """Ordered check results. `failed` drives the exit code; warnings do not."""

    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str, str]] = []  # (status, group, id, message)

    def add(self, status: str, group: str, check_id: str, message: str) -> None:
        self.rows.append((status, group, check_id, message))

    def ok(self, group: str, check_id: str, message: str) -> None:
        self.add(PASS, group, check_id, message)

    def warn(self, group: str, check_id: str, message: str) -> None:
        self.add(WARN, group, check_id, message)

    def fail(self, group: str, check_id: str, message: str) -> None:
        self.add(FAIL, group, check_id, message)

    @property
    def failed(self) -> list[tuple[str, str, str, str]]:
        return [r for r in self.rows if r[0] == FAIL]

    @property
    def warned(self) -> list[tuple[str, str, str, str]]:
        return [r for r in self.rows if r[0] == WARN]


# ── Minimal recipe-YAML reader ────────────────────────────────────────────

class RecipeParseError(Exception):
    """The recipe uses YAML this restricted reader will not guess at."""


def _strip_comment(line: str) -> str:
    """Drop a trailing ` #comment`. Respects quotes so a '#' inside a quoted
    scalar survives. Not a general YAML lexer — good enough for the subset,
    and anything ambiguous is rejected upstream rather than guessed."""
    out: list[str] = []
    quote: str | None = None
    for i, ch in enumerate(line):
        if quote:
            out.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in ('"', "'"):
            quote = ch
            out.append(ch)
            continue
        if ch == "#" and (i == 0 or line[i - 1] in " \t"):
            break
        out.append(ch)
    return "".join(out).rstrip()


def _unquote(v: str) -> str:
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
        return v[1:-1]
    return v


def parse_recipe_min(text: str) -> dict:
    """Parse the recipe subset the kit template emits:

        name: <scalar>
        description: >
          folded block
        version: <scalar>
        phases:
          - name: <scalar>
            goal: >
              folded block
            constraints:
              - "quoted string"
            input: []
            output:
              - path/to/file

    Raises RecipeParseError on anything outside that shape rather than
    silently mis-reading it — a wrong parse would produce confident, wrong
    findings, which is worse than no findings.
    """
    lines = text.splitlines()
    doc: dict = {}
    phases: list[dict] = []
    i = 0
    n = len(lines)

    def indent_of(s: str) -> int:
        return len(s) - len(s.lstrip(" "))

    def read_block(start: int, base_indent: int) -> tuple[str, int]:
        """Consume an indented folded/literal block scalar."""
        parts: list[str] = []
        j = start
        while j < n:
            raw = lines[j]
            if not raw.strip():
                parts.append("")
                j += 1
                continue
            if indent_of(raw) <= base_indent:
                break
            parts.append(raw.strip())
            j += 1
        return ("\n".join(parts).strip(), j)

    def read_list(start: int, base_indent: int) -> tuple[list[str], int]:
        """Consume a block sequence of scalars."""
        items: list[str] = []
        j = start
        while j < n:
            raw = _strip_comment(lines[j])
            if not raw.strip():
                j += 1
                continue
            ind = indent_of(raw)
            if ind <= base_indent:
                break
            s = raw.strip()
            if not s.startswith("- "):
                raise RecipeParseError(
                    f"line {j + 1}: expected a '- ' list item, got: {s[:60]!r}"
                )
            items.append(_unquote(s[2:]))
            j += 1
        return (items, j)

    while i < n:
        raw = _strip_comment(lines[i])
        if not raw.strip():
            i += 1
            continue
        ind = indent_of(raw)
        s = raw.strip()

        if ind != 0:
            raise RecipeParseError(
                f"line {i + 1}: unexpected indentation at top level: {s[:60]!r}"
            )
        if ":" not in s:
            raise RecipeParseError(f"line {i + 1}: expected 'key: value', got {s[:60]!r}")

        key, _, rest = s.partition(":")
        key = key.strip()
        rest = rest.strip()

        if key == "phases":
            if rest:
                raise RecipeParseError(
                    f"line {i + 1}: inline 'phases:' value is not supported"
                )
            i += 1
            # Each phase begins with a '- ' at some consistent indent.
            cur: dict | None = None
            phase_indent: int | None = None
            while i < n:
                raw2 = _strip_comment(lines[i])
                if not raw2.strip():
                    i += 1
                    continue
                ind2 = indent_of(raw2)
                if ind2 == 0:
                    break  # back to a top-level key
                s2 = raw2.strip()

                if s2.startswith("- "):
                    if phase_indent is None:
                        phase_indent = ind2
                    cur = {}
                    phases.append(cur)
                    s2 = s2[2:].strip()
                    ind2 = ind2 + 2

                if cur is None:
                    raise RecipeParseError(
                        f"line {i + 1}: content before the first '- ' phase item"
                    )
                if ":" not in s2:
                    raise RecipeParseError(
                        f"line {i + 1}: expected 'key: value' inside a phase, got {s2[:60]!r}"
                    )
                k2, _, v2 = s2.partition(":")
                k2 = k2.strip()
                v2 = v2.strip()

                if v2 in (">", "|", ">-", "|-", ">+", "|+"):
                    val, i = read_block(i + 1, ind2)
                    cur[k2] = val
                    continue
                if v2 == "[]":
                    cur[k2] = []
                    i += 1
                    continue
                if v2 == "":
                    items, i = read_list(i + 1, ind2)
                    cur[k2] = items
                    continue
                cur[k2] = _unquote(v2)
                i += 1
            doc["phases"] = phases
            continue

        if rest in (">", "|", ">-", "|-", ">+", "|+"):
            val, i = read_block(i + 1, ind)
            doc[key] = val
            continue
        if rest == "":
            items, i = read_list(i + 1, ind)
            doc[key] = items
            continue
        doc[key] = _unquote(rest)
        i += 1

    return doc


# ── Phase 102 r4 (C5): the ONE text semantics of every sources check ───────
# Mirrors astro's source-text.ts exactly, so offline and server can never
# disagree through language defaults:
#   - Decoding: UTF-8, invalid bytes -> U+FFFD, one leading BOM dropped.
#   - Whitespace: EXACTLY [ \t\n\r\f\v] plus U+FEFF (a stray BOM counts as
#     whitespace). NBSP, U+2028/U+2029, U+0085, U+3000 and \x1c-\x1f are
#     ordinary characters. Never str.strip() / isspace() / splitlines() / \s.
#   - Lines: split on "\n" only; one trailing "\r" dropped from each line.
#   - Regexes: re.ASCII (so \b and IGNORECASE are ASCII-only, as in JS without
#     the `u` flag), [0-9] never \d, [^\n] never `.`, and \Z never `$` (a
#     Python `$` also matches before a trailing newline).
#   - Lengths (typed string defaults): UTF-16 code units, as JS `.length` and
#     SQL Server's nvarchar(n) count them.

_WS = "[ \t\n\r\f\v\ufeff]"
_NON_WS = "[^ \t\n\r\f\v\ufeff]"
_WS_CHARS = " \t\n\r\f\v\ufeff"
_HAS_WS_RE = re.compile(_WS)


def _trim_ws(text: str) -> str:
    return text.strip(_WS_CHARS)


def _is_blank(text: str) -> bool:
    return _trim_ws(text) == ""


def _split_lines(text: str) -> list[str]:
    return [line[:-1] if line.endswith("\r") else line for line in text.split("\n")]


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _ascii_int(text: str) -> int:
    """int() of an already-validated ASCII "-?[0-9]+" string of ANY length.
    int() refuses more than 4300 digits (a ValueError traceback); JS reads the
    same text with Number/BigInt. Beyond 4000 significant digits the value is
    clamped to +/-10**4000, which exceeds every bound and cap it is compared
    against, so the verdict is the server's."""
    neg = text.startswith("-")
    digits = (text[1:] if neg else text).lstrip("0") or "0"
    value = 10 ** 4000 if len(digits) > 4000 else int(digits)
    return -value if neg else value


# ── Phase 102: schema.json reader + walker (SRC-06/07) ─────────────────────
# Mirrors astro's source-schema.ts and its JSON Schema
# (schemas/source-schema.v1.schema.json, copied byte-identical here). r2
# (ADR-016): the file is plain JSON, read with the stdlib `json` module —
# never PyYAML. Parsing is made exactly as strict as the server's: one leading
# UTF-8 BOM stripped (a second is an error), a duplicate key rejected at any
# depth (json.loads would silently keep the last value), and NaN/Infinity or
# a number overflowing to infinity rejected (JSON.parse has no such literals).
# No patternProperties support in _schema_engine.py, so the shape is checked
# by a hand walker over the parsed dict that follows the JSON Schema keyword
# for keyword (Ajv semantics: presence, not truthiness; integral floats count
# as integers; patterns match the whole string).

class SourceSchemaParseError(Exception):
    """schema.json is not strict, plain JSON."""


_TABLE_PART = r"(?:\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$#@]*)"
_TABLE_KEY_RE = re.compile(rf"{_TABLE_PART}\.{_TABLE_PART}", re.ASCII)
_JOIN_RE = re.compile(rf"{_TABLE_PART}\.{_TABLE_PART}\.{_TABLE_PART}", re.ASCII)

_TABLE_FIELDS = {"purpose", "kind", "grain", "rows", "columns", "rules"}
_COLUMN_FIELDS = {"meaning", "type", "key", "joins", "unit", "tz", "values", "sensitive"}


def _reject_duplicate_keys(pairs: list) -> dict:
    out: dict = {}
    for key, value in pairs:
        if key in out:
            raise SourceSchemaParseError(f"duplicate key {json.dumps(key, ensure_ascii=False)}")
        out[key] = value
    return out


def _reject_constant(name: str):
    raise SourceSchemaParseError(f"{name} is not valid JSON")


def _finite_float(literal: str) -> float:
    value = float(literal)
    if value in (float("inf"), float("-inf")):
        raise SourceSchemaParseError(f"number {literal} is out of range")
    return value


def _finite_int(literal: str) -> int:
    if float(literal) in (float("inf"), float("-inf")):
        raise SourceSchemaParseError(f"number {literal} is out of range")
    return int(literal)


def load_source_schema_json(raw: bytes):
    """Strictly parse schema.json bytes. Raises SourceSchemaParseError (or a
    ValueError subclass from json) on anything the server's parser rejects."""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SourceSchemaParseError(f"is not valid UTF-8 ({exc.reason} at byte {exc.start})") from None
    if text.startswith("\ufeff"):
        text = text[1:]
    return json.loads(
        text,
        object_pairs_hook=_reject_duplicate_keys,
        parse_constant=_reject_constant,
        parse_float=_finite_float,
        parse_int=_finite_int,
    )


def _normalize_table_key(key: str) -> str:
    """Mirrors source-schema.ts normalizeTableKey: per "."-part, a leading "["
    and a trailing "]" are each dropped independently; no trimming."""
    norm = []
    for part in key.split("."):
        if part.startswith("["):
            part = part[1:]
        if part.endswith("]"):
            part = part[:-1]
        norm.append(part)
    return ".".join(norm).lower()


def _is_str(v) -> bool:
    return isinstance(v, str)


def _is_nonempty_str(v) -> bool:
    return isinstance(v, str) and len(v) >= 1


def _is_integer(v) -> bool:
    """JSON Schema `integer`: any number with a zero fractional part."""
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return True
    return isinstance(v, float) and v.is_integer()


def validate_source_schema(data, source_id: str) -> tuple[list, list]:
    """Hand walker mirroring source-schema.v1.schema.json. Returns
    (errors, warnings) as (check, source_id, file, message) tuples — SRC-06
    for anything structurally wrong, SRC-07 for an undeclared `joins`
    target (never blocks, C6)."""
    file = "schema.json"
    errors: list[tuple[str, str, str, str]] = []
    warnings: list[tuple[str, str, str, str]] = []

    def fail(msg: str) -> None:
        errors.append(("SRC-06", source_id, file, msg))

    if not isinstance(data, dict):
        fail(f"schema.json must be a JSON object, got {type(data).__name__}")
        return errors, warnings

    unknown_top = set(data.keys()) - {"version", "tables"}
    if unknown_top:
        fail(f"unknown top-level key(s): {', '.join(sorted(unknown_top))}")
    if "version" not in data:
        fail("missing required 'version'")
    else:
        version = data["version"]
        if isinstance(version, bool) or not isinstance(version, (int, float)) or version != 1:
            fail(f"version must be 1, got {json.dumps(version)}")

    if "tables" not in data:
        fail("missing required 'tables'")
        return errors, warnings
    tables = data["tables"]
    if not isinstance(tables, dict):
        fail("'tables' must be an object")
        return errors, warnings

    declared = {_normalize_table_key(k) for k in tables.keys()}

    for table_key, table in tables.items():
        where = f"tables.{table_key}"
        if not _TABLE_KEY_RE.fullmatch(table_key):
            fail(f"tables.{json.dumps(table_key)} is not schema-qualified (expected schema.table)")
            continue
        if not isinstance(table, dict):
            fail(f"{where}: must be an object")
            continue
        unknown = set(table.keys()) - _TABLE_FIELDS
        if unknown:
            fail(f"{where}: unknown key(s): {', '.join(sorted(unknown))}")
        if "purpose" not in table:
            fail(f"{where}: missing required 'purpose'")
        elif not _is_nonempty_str(table["purpose"]):
            fail(f"{where}: purpose must be a non-empty string")
        if "kind" in table and table["kind"] not in ("table", "view"):
            fail(f"{where}: kind must be 'table' or 'view'")
        if "grain" in table and not _is_str(table["grain"]):
            fail(f"{where}: grain must be a string")
        if "rows" in table and not (_is_str(table["rows"]) or _is_integer(table["rows"])):
            fail(f"{where}: rows must be a string or integer")
        if "rules" in table:
            rules = table["rules"]
            if not isinstance(rules, list) or any(not _is_str(r) for r in rules):
                fail(f"{where}: rules must be a list of strings")

        if "columns" not in table:
            continue
        columns = table["columns"]
        if not isinstance(columns, dict):
            fail(f"{where}: columns must be an object")
            continue
        for col_name, col in columns.items():
            cwhere = f"{where}.columns.{col_name}"
            if not isinstance(col, dict):
                fail(f"{cwhere}: must be an object")
                continue
            unknown_c = set(col.keys()) - _COLUMN_FIELDS
            if unknown_c:
                fail(f"{cwhere}: unknown key(s): {', '.join(sorted(unknown_c))}")
            if "meaning" not in col:
                fail(f"{cwhere}: missing required 'meaning'")
            elif not _is_nonempty_str(col["meaning"]):
                fail(f"{cwhere}: meaning must be a non-empty string")
            for field in ("type", "unit", "tz"):
                if field in col and not _is_str(col[field]):
                    fail(f"{cwhere}: {field} must be a string")
            for field in ("key", "sensitive"):
                if field in col and not isinstance(col[field], bool):
                    fail(f"{cwhere}: {field} must be a boolean")
            if "values" in col:
                values = col["values"]
                if not isinstance(values, dict) or any(not _is_str(v) for v in values.values()):
                    fail(f"{cwhere}: values must be an object of strings")
            if "joins" in col:
                joins = col["joins"]
                if not _is_str(joins) or not _JOIN_RE.fullmatch(joins):
                    fail(f"{cwhere}: joins must be a schema.table.column reference")
                else:
                    parts = joins.split(".")
                    target = _normalize_table_key(f"{parts[0]}.{parts[1]}")
                    if target not in declared:
                        warnings.append((
                            "SRC-07", source_id, file,
                            f"{table_key}.{col_name}.joins references undeclared table '{parts[0]}.{parts[1]}'",
                        ))

    return errors, warnings


# ── Phase 102 (a4): SQL Server type list + named-query header parser ───────
# Line-for-line ports of astro's sql-types.ts, sql-guard.ts and
# source-query.ts (t4/t5/t6). Data-driven from schemas/sqlserver-types.v1.json
# (byte-identical to astro's copy; t9 enforces parity), loaded lazily and only
# when a source query is actually checked — kit_test.py stays standalone
# (tests/kit_run_local.test.mjs copies it alone). A missing type file is a
# SRC FAIL with a clear message, never a traceback.

_SQLSERVER_TYPES_CACHE: dict | None = None
_SQLSERVER_TYPES_LOAD_ERROR: str | None = None


def _load_sqlserver_types() -> dict | None:
    global _SQLSERVER_TYPES_CACHE, _SQLSERVER_TYPES_LOAD_ERROR
    if _SQLSERVER_TYPES_CACHE is not None:
        return _SQLSERVER_TYPES_CACHE
    if _SQLSERVER_TYPES_LOAD_ERROR is not None:
        return None
    path = Path(__file__).resolve().parent / "schemas" / "sqlserver-types.v1.json"
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _SQLSERVER_TYPES_LOAD_ERROR = f"sqlserver-types.v1.json unavailable: {exc}"
        return None
    _SQLSERVER_TYPES_CACHE = {t["name"].lower(): t for t in doc.get("types", [])}
    return _SQLSERVER_TYPES_CACHE


_SQLTYPE_TOKEN_RE = re.compile(r"^([A-Za-z][A-Za-z0-9]*)(?:\(([^()]*)\))?\Z", re.ASCII)


def parse_sql_type(token) -> tuple[bool, dict | str]:
    """(ok, {name, literal, args}) or (False, error). Mirrors sql-types.ts."""
    types = _load_sqlserver_types()
    if types is None:
        return False, _SQLSERVER_TYPES_LOAD_ERROR or "sqlserver-types.v1.json unavailable"
    if not isinstance(token, str) or token != _trim_ws(token) or token == "":
        return False, f"empty or malformed sqltype: {token!r}"
    if _HAS_WS_RE.search(token):
        return False, f"sqltype must be a single token with no whitespace: '{token}'"
    m = _SQLTYPE_TOKEN_RE.match(token)
    if not m:
        return False, f"malformed sqltype: '{token}'"
    raw_name, raw_args = m.group(1), m.group(2)
    d = types.get(raw_name.lower())
    if d is None:
        return False, f"unknown sqltype: '{raw_name}'"
    name, literal, args_kind, bounds = d["name"], d["literal"], d["args"], d.get("bounds", {})

    if args_kind == "none":
        if raw_args is not None:
            return False, f"{name} takes no arguments: '{token}'"
        return True, {"name": name, "literal": literal, "args": {"kind": "none"}}
    if args_kind == "length":
        if raw_args is None:
            return False, f"{name} requires (n): '{token}'"
        if not re.match(r"^[1-9][0-9]*\Z", raw_args, re.ASCII):
            return False, f"{name} length must be a positive integer: '{token}'"
        length = _ascii_int(raw_args)
        max_len = bounds.get("maxLength")
        if max_len and length > max_len:
            return False, f"{name}({length}) exceeds max length {max_len}"
        return True, {"name": name, "literal": literal, "args": {"kind": "length", "length": length}}
    if args_kind == "length_or_max":
        if raw_args is None:
            return False, f"{name} requires (n) or (max): '{token}'"
        if raw_args.lower() == "max":
            return True, {"name": name, "literal": literal, "args": {"kind": "max"}}
        if not re.match(r"^[1-9][0-9]*\Z", raw_args, re.ASCII):
            return False, f"{name} length must be a positive integer or 'max': '{token}'"
        length = _ascii_int(raw_args)
        max_len = bounds.get("maxLength")
        if max_len and length > max_len:
            return False, f"{name}({length}) exceeds max length {max_len}"
        return True, {"name": name, "literal": literal, "args": {"kind": "length", "length": length}}
    if args_kind == "precision_scale":
        if raw_args is None:
            return True, {"name": name, "literal": literal, "args": {"kind": "precision_scale", "precision": 18, "scale": 0}}
        pm = re.match(r"^([0-9]+)(?:,([0-9]+))?\Z", raw_args, re.ASCII)
        if not pm:
            return False, f"{name} args must be (p) or (p,s): '{token}'"
        precision = _ascii_int(pm.group(1))
        scale = _ascii_int(pm.group(2)) if pm.group(2) is not None else 0
        max_p = bounds.get("maxPrecision", 38)
        if precision < 1 or precision > max_p:
            return False, f"{name} precision must be 1..{max_p}: '{token}'"
        if scale < 0 or scale > precision:
            return False, f"{name} scale must be 0..precision: '{token}'"
        return True, {"name": name, "literal": literal, "args": {"kind": "precision_scale", "precision": precision, "scale": scale}}
    if args_kind == "fraction":
        if raw_args is None:
            return True, {"name": name, "literal": literal, "args": {"kind": "fraction", "fraction": 7}}
        if not re.match(r"^[0-7]\Z", raw_args, re.ASCII):
            return False, f"{name} fraction must be 0..7: '{token}'"
        return True, {"name": name, "literal": literal, "args": {"kind": "fraction", "fraction": int(raw_args)}}
    return False, f"unsupported args kind {args_kind!r} for {name}"  # pragma: no cover — data drift guard


_DEF_DATE_RE = re.compile(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})\Z", re.ASCII)
_DEF_DATETIME_RE = re.compile(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,7}))?)?)?\Z", re.ASCII)
_DEF_TIME_RE = re.compile(r"^([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,7}))?)?\Z", re.ASCII)
_DEF_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z", re.ASCII)
_DEF_OFFSET_RE = re.compile(r"^([^\n]*?)(Z|[+-][0-9]{2}:[0-9]{2})\Z", re.ASCII)


def _is_real_date(y: int, mo: int, d: int) -> bool:
    import datetime as _dt
    try:
        _dt.date(y, mo, d)
        return True
    except ValueError:
        return False


def _valid_time_parts(h: str, mi: str, s: str | None = None) -> bool:
    hh, mm = int(h), int(mi)
    ss = int(s) if s is not None else 0
    return 0 <= hh <= 23 and 0 <= mm <= 59 and 0 <= ss <= 59


def parse_default_literal(sql_type_token, literal) -> tuple[bool, str]:
    """(ok, value) or (False, error). Mirrors sql-types.ts parseDefaultLiteral."""
    ok, parsed = parse_sql_type(sql_type_token)
    if not ok:
        return False, parsed
    if not isinstance(literal, str) or literal == "":
        return False, "default literal must be non-empty"
    kind, args, name = parsed["literal"], parsed["args"], parsed["name"]
    types = _load_sqlserver_types() or {}

    if kind == "int":
        if not re.match(r"^-?[0-9]+\Z", literal, re.ASCII):
            return False, f"'{literal}' is not a valid int literal"
        n = _ascii_int(literal)
        bounds = types.get(name.lower(), {}).get("bounds", {})
        # int(), never float: bigint's bounds are decimal strings in the
        # shared JSON (a JSON number cannot carry 2^63 exactly into JS).
        if "min" in bounds and n < int(bounds["min"]):
            return False, f"'{literal}' is below the minimum for {name}"
        if "max" in bounds and n > int(bounds["max"]):
            return False, f"'{literal}' is above the maximum for {name}"
        return True, literal
    if kind == "bit":
        if literal not in ("0", "1", "true", "false"):
            return False, f"'{literal}' is not a valid bit literal"
        return True, literal
    if kind == "decimal":
        if not re.match(r"^-?[0-9]+(\.[0-9]+)?\Z", literal, re.ASCII):
            return False, f"'{literal}' is not a valid decimal literal"
        if args["kind"] == "precision_scale":
            body_ = literal.lstrip("-")
            int_part, _, frac_part = body_.partition(".")
            if len(frac_part) > args["scale"]:
                return False, f"'{literal}' has more decimal places than scale {args['scale']}"
            trimmed_int = int_part.lstrip("0") or ""
            if len(trimmed_int) > args["precision"] - args["scale"]:
                return False, f"'{literal}' has more integer digits than precision allows"
        return True, literal
    if kind == "float":
        if not re.match(r"^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?\Z", literal, re.ASCII):
            return False, f"'{literal}' is not a valid float literal"
        return True, literal
    if kind == "string":
        if args["kind"] == "length" and _utf16_len(literal) > args["length"]:
            return False, f"'{literal}' is longer than the declared length {args['length']}"
        return True, literal
    if kind == "date":
        m = _DEF_DATE_RE.match(literal)
        if not m or not _is_real_date(int(m.group(1)), int(m.group(2)), int(m.group(3))):
            return False, f"'{literal}' is not a valid date literal (YYYY-MM-DD)"
        return True, literal
    if kind == "datetime":
        m = _DEF_DATETIME_RE.match(literal)
        if not m:
            return False, f"'{literal}' is not a valid datetime literal"
        if not _is_real_date(int(m.group(1)), int(m.group(2)), int(m.group(3))):
            return False, f"'{literal}' is not a real calendar date"
        if m.group(4) is not None and not _valid_time_parts(m.group(4), m.group(5), m.group(6)):
            return False, f"'{literal}' has an invalid time part"
        return True, literal
    if kind == "datetimeoffset":
        off = _DEF_OFFSET_RE.match(literal)
        if not off:
            return False, f"'{literal}' is not a valid datetimeoffset literal"
        m = _DEF_DATETIME_RE.match(off.group(1))
        if not m:
            return False, f"'{literal}' is not a valid datetimeoffset literal"
        if not _is_real_date(int(m.group(1)), int(m.group(2)), int(m.group(3))):
            return False, f"'{literal}' is not a real calendar date"
        if m.group(4) is not None and not _valid_time_parts(m.group(4), m.group(5), m.group(6)):
            return False, f"'{literal}' has an invalid time part"
        return True, literal
    if kind == "time":
        m = _DEF_TIME_RE.match(literal)
        if not m or not _valid_time_parts(m.group(1), m.group(2), m.group(3)):
            return False, f"'{literal}' is not a valid time literal (HH:MM[:SS[.f]])"
        return True, literal
    if kind == "uuid":
        if not _DEF_UUID_RE.match(literal):
            return False, f"'{literal}' is not a valid uniqueidentifier literal"
        return True, literal
    return False, f"unsupported literal kind {kind!r}"  # pragma: no cover — data drift guard


# ── Body scan and single-SELECT guard (mirrors sql-guard.ts, t5) ───────────

_FORBIDDEN_KEYWORDS = [
    "INSERT", "UPDATE", "DELETE", "MERGE", "EXEC", "EXECUTE", "DROP", "ALTER",
    "CREATE", "TRUNCATE", "GRANT", "REVOKE", "DENY", "INTO", "DECLARE",
    "OPENROWSET", "OPENQUERY", "OPENDATASOURCE", "BULK", "DBCC", "BACKUP",
    "RESTORE", "SHUTDOWN", "KILL", "USE", "WAITFOR", "RECONFIGURE",
]
# re.ASCII: \b and IGNORECASE are ASCII-only, as in sql-guard.ts (no `u` flag)
# — `éDROP` holds DROP, and the Kelvin sign in `\u212aILL` is not K.
_FORBIDDEN_RE = re.compile(r"\b(" + "|".join(_FORBIDDEN_KEYWORDS) + r")\b", re.IGNORECASE | re.ASCII)
_FIRST_KEYWORD_RE = re.compile(rf"^{_WS}*([A-Za-z]+)\b", re.ASCII)
_BODY_PARAM_RE = re.compile(r"(?<!@)@([A-Za-z_][A-Za-z0-9_]*)", re.ASCII)


def strip_sql(sql: str) -> str:
    out: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        c = sql[i]
        c2 = sql[i + 1] if i + 1 < n else ""
        if c == "-" and c2 == "-":
            while i < n and sql[i] != "\n":
                i += 1
            out.append(" ")
            continue
        if c == "/" and c2 == "*":
            depth = 1
            i += 2
            while i < n and depth > 0:
                pair = sql[i:i + 2]
                if pair == "/*":
                    depth += 1
                    i += 2
                elif pair == "*/":
                    depth -= 1
                    i += 2
                else:
                    i += 1
            out.append(" ")
            continue
        if c == "'":
            i += 1
            while i < n:
                if sql[i:i + 2] == "''":
                    i += 2
                    continue
                if sql[i] == "'":
                    i += 1
                    break
                i += 1
            out.append(" ")
            continue
        if c == "[":
            i += 1
            while i < n and sql[i] != "]":
                i += 1
            if i < n:
                i += 1
            out.append(" ")
            continue
        if c == '"':
            i += 1
            while i < n:
                if sql[i:i + 2] == '""':
                    i += 2
                    continue
                if sql[i] == '"':
                    i += 1
                    break
                i += 1
            out.append(" ")
            continue
        out.append(c)
        i += 1
    return "".join(out)


def check_single_select(body: str) -> tuple[bool, str | None]:
    trimmed = _trim_ws(strip_sql(body))
    if trimmed.endswith(";"):
        trimmed = _trim_ws(trimmed[:-1])
    if len(trimmed) == 0:
        return False, "empty query body"
    if ";" in trimmed:
        return False, "body must be a single statement (unexpected ';')"
    m = _FIRST_KEYWORD_RE.match(trimmed)
    first_keyword = m.group(1).upper() if m else None
    if first_keyword not in ("SELECT", "WITH"):
        return False, "body must start with SELECT or WITH"
    fm = _FORBIDDEN_RE.search(trimmed)
    if fm:
        return False, f"body contains a forbidden keyword: {fm.group(1).upper()}"
    return True, None


def scan_body_params(body: str) -> list[str]:
    stripped = strip_sql(body)
    seen: set[str] = set()
    out: list[str] = []
    for m in _BODY_PARAM_RE.finditer(stripped):
        name = m.group(1)
        key = name.lower()
        if key not in seen:
            seen.add(key)
            out.append(name)
    return out


# ── Named-query header parser (mirrors source-query.ts, t6) ────────────────

_QNAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}\Z", re.ASCII)
_QPARAM_NAME_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\Z", re.ASCII)
# [^\n]* not .*: U+2028/U+2029/\r inside a line are ordinary text (source-text.ts).
_QTAG_LINE_RE = re.compile(rf"^--{_WS}*@([A-Za-z_][A-Za-z0-9_]*)(?:{_WS}+([^\n]*))?\Z", re.ASCII)
_QPARAM_LINE_RE = re.compile(rf"^([A-Za-z_][A-Za-z0-9_]*){_WS}+({_NON_WS}+){_WS}+(required|optional)\b([^\n]*)\Z", re.ASCII)
_QRETURNS_COL_RE = re.compile(rf"^({_NON_WS}+){_WS}+({_NON_WS}+)\Z", re.ASCII)
_QDEFAULT_TRAILER_RE = re.compile(r"^default=([^\n]*)\Z", re.ASCII)
_QMAX_ROWS_RE = re.compile(r"^[1-9][0-9]*\Z", re.ASCII)
_SQL_SUFFIX_RE = re.compile(r"\.sql\Z", re.ASCII | re.IGNORECASE)


def _split_outside_parens(text: str) -> list[str]:
    parts: list[str] = []
    depth = 0
    current: list[str] = []
    for ch in text:
        if ch == "(":
            depth += 1
        if ch == ")":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            parts.append("".join(current))
            current = []
            continue
        current.append(ch)
    parts.append("".join(current))
    return parts


def _parse_default_trailer(trailing: str) -> tuple[bool, str | None]:
    t = _trim_ws(trailing)
    if t == "":
        return True, None
    m = _QDEFAULT_TRAILER_RE.match(t)
    if not m:
        return False, None
    rest = m.group(1)
    if rest.startswith("'"):
        i = 1
        chars: list[str] = []
        while i < len(rest):
            if rest[i:i + 2] == "''":
                chars.append("'")
                i += 2
                continue
            if rest[i] == "'":
                i += 1
                break
            chars.append(rest[i])
            i += 1
        if i != len(rest):
            return False, None
        return True, "".join(chars)
    if _HAS_WS_RE.search(rest) or rest == "":
        return False, None
    return True, rest


def check_named_query(source_id: str, file_name: str, text: str) -> tuple[list[tuple[str, str, str, str]], dict | None]:
    """Returns (errors, query). errors are (check, source_id, file, message)
    tuples, matching validate_source_schema's shape."""
    errors: list[tuple[str, str, str, str]] = []

    def err(check: str, message: str) -> None:
        errors.append((check, source_id, file_name, message))

    stem = _SQL_SUFFIX_RE.sub("", file_name)
    lines = _split_lines(text)

    i = 0
    header_lines: list[str] = []
    while i < len(lines) and (_is_blank(lines[i]) or lines[i].startswith("--")):
        header_lines.append(lines[i])
        i += 1
    body = "\n".join(lines[i:])

    name_value: str | None = None
    name_count = 0
    description_value: str | None = None
    description_count = 0
    params: list[dict] = []
    param_names_seen: set[str] = set()
    returns_raw: str | None = None
    returns_count = 0
    max_rows_value: int | None = None
    max_rows_count = 0

    for line in header_lines:
        m = _QTAG_LINE_RE.match(line)
        if not m:
            continue
        tag, raw_rest = m.group(1), m.group(2)
        rest = _trim_ws(raw_rest or "")

        if tag == "name":
            name_count += 1
            name_value = rest
        elif tag == "description":
            description_count += 1
            description_value = rest
        elif tag == "param":
            pm = _QPARAM_LINE_RE.match(rest)
            if not pm:
                err("SRC-10", f"malformed @param line: '{_trim_ws(line)}'")
                continue
            pname, sqltype, qualifier, trailer = pm.group(1), pm.group(2), pm.group(3), pm.group(4)
            if not _QPARAM_NAME_PATTERN.match(pname):
                err("SRC-10", f"@param name '{pname}' is not a valid identifier")
                continue
            key = pname.lower()
            if key in param_names_seen:
                err("SRC-10", f"duplicate @param name '{pname}'")
                continue
            param_names_seen.add(key)

            type_ok, type_result = parse_sql_type(sqltype)
            if not type_ok:
                err("SRC-10", f"@param {pname}: {type_result}")
                continue

            trailer_ok, trailer_literal = _parse_default_trailer(trailer)
            if not trailer_ok:
                err("SRC-10", f"@param {pname}: malformed trailing text '{_trim_ws(trailer)}'")
                continue
            has_default = trailer_literal is not None
            if has_default and qualifier == "required":
                err("SRC-10", f"@param {pname}: default is only allowed on optional params")
                continue
            if has_default:
                lit_ok, lit_result = parse_default_literal(sqltype, trailer_literal)
                if not lit_ok:
                    err("SRC-10", f"@param {pname}: default '{trailer_literal}' does not parse for {sqltype}: {lit_result}")
                    continue

            param = {"name": pname, "sqlType": sqltype, "required": qualifier == "required"}
            if has_default:
                param["default"] = trailer_literal
            params.append(param)
        elif tag == "returns":
            returns_count += 1
            returns_raw = rest
        elif tag == "max_rows":
            max_rows_count += 1
            if not _QMAX_ROWS_RE.match(rest):
                err("SRC-12", f"@max_rows must be a positive integer: '{rest}'")
            else:
                max_rows_value = _ascii_int(rest)
        else:
            err("SRC-08", f"unknown tag '@{tag}'")

    if name_count == 0:
        err("SRC-08", "missing @name")
    elif name_count > 1:
        err("SRC-08", "duplicate @name")
    elif name_value != stem:
        err("SRC-08", f"@name '{name_value}' must equal the file stem '{stem}'")
    elif not _QNAME_PATTERN.match(name_value or ""):
        err("SRC-08", f"@name '{name_value}' must match ^[a-z][a-z0-9_]{{0,63}}$")

    if description_count == 0:
        err("SRC-08", "missing @description")
    elif description_count > 1:
        err("SRC-08", "duplicate @description")
    elif not description_value:
        err("SRC-08", "@description must be non-empty")

    if max_rows_count > 1:
        err("SRC-12", "duplicate @max_rows")

    returns: list[dict] = []
    if returns_count == 0:
        err("SRC-11", "missing @returns")
    elif returns_count > 1:
        err("SRC-11", "duplicate @returns")
    elif not returns_raw or _is_blank(returns_raw):
        err("SRC-11", "@returns must declare at least one column")
    else:
        seen_cols: set[str] = set()
        for piece in _split_outside_parens(returns_raw):
            p = _trim_ws(piece)
            if p == "":
                err("SRC-11", "@returns has an empty column entry")
                continue
            cm = _QRETURNS_COL_RE.match(p)
            if not cm:
                err("SRC-11", f"@returns column '{p}' must be 'Col sqltype'")
                continue
            col_name, sqltype = cm.group(1), cm.group(2)
            if not _QPARAM_NAME_PATTERN.match(col_name):
                err("SRC-11", f"@returns column name '{col_name}' is not a valid identifier")
                continue
            key = col_name.lower()
            if key in seen_cols:
                err("SRC-11", f"duplicate @returns column '{col_name}'")
                continue
            type_ok, type_result = parse_sql_type(sqltype)
            if not type_ok:
                err("SRC-11", f"@returns column {col_name}: {type_result}")
                continue
            seen_cols.add(key)
            returns.append({"name": col_name, "sqlType": sqltype})

    guard_ok, guard_reason = check_single_select(body)
    if not guard_ok:
        err("SRC-13", guard_reason or "body is not a single SELECT")

    raw_body_params = scan_body_params(body)
    body_param_keys = {p.lower() for p in raw_body_params}
    declared_keys = {p["name"].lower() for p in params}
    for bp_key in sorted(body_param_keys):
        if bp_key not in declared_keys:
            original = next((p for p in raw_body_params if p.lower() == bp_key), bp_key)
            err("SRC-09", f"body references undeclared param '@{original}'")
    for p in params:
        if p["name"].lower() not in body_param_keys:
            err("SRC-09", f"declared @param '{p['name']}' is never used in the body")

    if errors:
        return errors, None

    query: dict = {"name": name_value, "params": params, "returns": returns}
    if max_rows_count > 0 and max_rows_value is not None:
        query["maxRows"] = max_rows_value
    return errors, query


def _read_text_like_server(path: Path) -> str:
    """Decode as astroport does (fflate strFromU8): one leading BOM dropped,
    invalid UTF-8 replaced with U+FFFD rather than rejected."""
    return path.read_bytes().decode("utf-8-sig", errors="replace")


_MISSING_ERRNOS = {errno.ENOENT, errno.ENOTDIR, errno.ELOOP}


def _file_kind(path: Path) -> tuple[str, OSError | None]:
    """("file", None) for a regular file (following symlinks); ("missing",
    None) for anything else the server would not see as that file — absent,
    a directory, a broken symlink, a symlink loop; ("error", exc) when the OS
    refuses to say (e.g. EACCES on the parent). Never raises."""
    try:
        st = os.stat(path)
    except OSError as exc:
        if exc.errno in _MISSING_ERRNOS:
            return "missing", None
        return "error", exc
    return ("file", None) if stat.S_ISREG(st.st_mode) else ("missing", None)


def _list_dir(path: Path) -> tuple[list[str], OSError | None]:
    """(names, None), ([], None) when the directory is absent or not a
    directory, or ([], exc) when it exists but cannot be listed. Never raises."""
    try:
        return os.listdir(path), None
    except OSError as exc:
        if exc.errno in _MISSING_ERRNOS:
            return [], None
        return [], exc


def check_sources(root: Path, manifest: dict | None, rep: Report) -> None:
    """SRC-04..14: per-source SOURCE.md/schema.json presence + validity,
    named query header/body checks, and the adhoc:false rule. Runs against
    the AUTHORED tree (src/sources/<id>/...), not the zip layout.

    Every filesystem call is guarded (C4): an unreadable directory or file is
    reported as the check it blocks, with the OS error — never a traceback."""
    if not isinstance(manifest, dict):
        return
    sources = manifest.get("sources")
    if not isinstance(sources, list):
        return
    for src in sources:
        if not isinstance(src, dict):
            continue
        source_id = src.get("id")
        if not isinstance(source_id, str):
            continue
        adhoc = src.get("adhoc") is not False
        src_dir = root / "src" / "sources" / source_id
        # Exact-case directory listing — Sources/ or Schema.json fails here
        # exactly as it does on the server (SRC-05/SRC-04 zip convention).
        listing, list_err = _list_dir(src_dir)
        if list_err is not None:
            rep.fail("sources", "SRC-04", f"{source_id}: src/sources/{source_id}/ cannot be read, so SOURCE.md cannot be checked: {list_err}")
            rep.fail("sources", "SRC-05", f"{source_id}: src/sources/{source_id}/ cannot be read, so schema.json cannot be checked: {list_err}")
            continue
        names = set(listing)

        # SOURCE.md and queries are decoded like the server (see
        # _read_text_like_server). A name that is not a regular file (a
        # directory, a broken symlink) is "missing", exactly as the server
        # sees a zip that only holds SOURCE.md/x or schema.json/x. A file that
        # cannot be stat'ed or read fails the same check with the OS error.
        # ── SRC-04: SOURCE.md present and non-empty ──
        kind, kind_err = _file_kind(src_dir / "SOURCE.md") if "SOURCE.md" in names else ("missing", None)
        if kind == "error":
            rep.fail("sources", "SRC-04", f"{source_id}: SOURCE.md cannot be read: {kind_err}")
        elif kind == "missing":
            rep.fail("sources", "SRC-04", f"{source_id}: SOURCE.md missing")
        else:
            try:
                source_md = _read_text_like_server(src_dir / "SOURCE.md")
            except OSError as exc:
                rep.fail("sources", "SRC-04", f"{source_id}: SOURCE.md cannot be read: {exc}")
            else:
                # "Empty" = only [ \t\n\r\f\v] and U+FEFF (text semantics above).
                if _is_blank(source_md):
                    rep.fail("sources", "SRC-04", f"{source_id}: SOURCE.md is empty")

        # ── SRC-05..07: schema.json (ADR-016) ──
        # Only the exact name counts: a schema.yaml shipped instead is
        # "schema.json missing". Raw bytes go to the strict JSON reader,
        # which strips exactly one leading BOM itself.
        kind, kind_err = _file_kind(src_dir / "schema.json") if "schema.json" in names else ("missing", None)
        if kind == "error":
            rep.fail("sources", "SRC-05", f"{source_id}: schema.json cannot be read: {kind_err}")
            continue
        if kind == "missing":
            rep.fail("sources", "SRC-05", f"{source_id}: schema.json missing")
            continue
        try:
            raw_schema = (src_dir / "schema.json").read_bytes()
        except OSError as exc:
            rep.fail("sources", "SRC-05", f"{source_id}: schema.json cannot be read: {exc}")
            continue
        try:
            data = load_source_schema_json(raw_schema)
        except SourceSchemaParseError as exc:
            rep.fail("sources", "SRC-06", f"{source_id}: schema.json {exc}")
            continue
        except (ValueError, RecursionError) as exc:  # json.JSONDecodeError et al.
            rep.fail("sources", "SRC-06", f"{source_id}: schema.json is not valid JSON: {exc}")
            continue
        errors, warnings = validate_source_schema(data, source_id)
        for check, sid, file, msg in errors:
            rep.fail("sources", check, f"{sid}: {file}: {msg}")
        for check, sid, file, msg in warnings:
            rep.warn("sources", check, f"{sid}: {file}: {msg}")

        # ── SRC-08..13: named queries (direct *.sql children of queries/) ──
        # Membership mirrors source-files.ts: ASCII-case-insensitive ".sql"
        # suffix on the name (so a file named just ".sql" counts, stem "").
        queries_dir = src_dir / "queries"
        query_listing, q_list_err = _list_dir(queries_dir)
        if q_list_err is not None:
            rep.fail("sources", "SRC-08", f"{source_id}: queries/ cannot be read, so its named queries cannot be checked: {q_list_err}")
            continue
        query_count = 0  # every *.sql the server would see, readable or not
        for qname in sorted(n for n in query_listing if _SQL_SUFFIX_RE.search(n)):
            kind, kind_err = _file_kind(queries_dir / qname)
            if kind == "missing":
                continue
            query_count += 1
            if kind == "error":
                rep.fail("sources", "SRC-08", f"{source_id}: {qname}: cannot be read: {kind_err}")
                continue
            try:
                qtext = _read_text_like_server(queries_dir / qname)
            except OSError as exc:
                rep.fail("sources", "SRC-08", f"{source_id}: {qname}: cannot be read: {exc}")
                continue
            qerrors, _query = check_named_query(source_id, qname, qtext)
            for check, sid, file, msg in qerrors:
                rep.fail("sources", check, f"{sid}: {file}: {msg}")

        # ── SRC-14: adhoc:false requires >= 1 named query ──
        if not adhoc and query_count == 0:
            rep.fail("sources", "SRC-14", f"{source_id}: adhoc is false but declares zero named queries")


def load_recipe(path: Path) -> tuple[dict, str]:
    """Return (recipe_dict, parser_name). PyYAML wins when available."""
    text = path.read_text(encoding="utf-8")
    if _pyyaml is not None:
        data = _pyyaml.safe_load(text)
        if not isinstance(data, dict):
            raise RecipeParseError("recipe did not parse to a mapping")
        return (data, "PyYAML")
    return (parse_recipe_min(text), "builtin")


# ── Path helpers ──────────────────────────────────────────────────────────

_WILDCARD = re.compile(r"[*?\[\]]")


def escapes_root(rel: str) -> bool:
    """True if `rel` is absolute or climbs out of its root — mirrors the
    containment guard in astro's recipe-executor.validatePhaseOutputs
    (T-73-02), so a recipe rejected there is rejected here first."""
    p = rel.strip()
    if not p or p.startswith("/") or p.startswith("~"):
        return True
    parts = Path(p).parts
    depth = 0
    for part in parts:
        if part == "..":
            depth -= 1
            if depth < 0:
                return True
        elif part not in (".",):
            depth += 1
    return False


# ── Checks ────────────────────────────────────────────────────────────────

REQUIRED_EXAMPLE_SECTIONS = [
    "Quick Start",
    "Examples",
    "Argument Reference",
    "Common Patterns",
]

# KIT-CONTRACT.md: Astro's base image already ships these; declaring them is
# noise at best and a version conflict at worst.
BASE_IMAGE_TOOLS = {
    "bash", "coreutils", "grep", "sed", "awk", "jq",
    "git", "curl", "wget", "tar", "unzip",
}

SNAKE_CASE = re.compile(r"^[a-z][a-z0-9_]*$")


def check_manifest(root: Path, rep: Report) -> dict | None:
    """Delegate manifest validation to the vendored validator — never
    reimplement it here; one source of truth (it owns the v3/v4 schemas)."""
    kit_json = root / "kit.json"
    if not kit_json.is_file():
        rep.fail("manifest", "M-01", "kit.json not found at the kit root")
        return None

    try:
        manifest = json.loads(kit_json.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        rep.fail("manifest", "M-01", f"kit.json is not valid JSON: {exc}")
        return None

    validator = root / "tools" / "validate_manifest.py"
    if validator.is_file():
        proc = subprocess.run(
            [sys.executable, str(validator), str(kit_json)],
            capture_output=True, text=True, cwd=str(root),
        )
        if proc.returncode == 0:
            rep.ok("manifest", "M-02", "validate_manifest.py clean")
        else:
            detail = (proc.stderr or proc.stdout or "").strip().splitlines()
            head = detail[0] if detail else f"exit {proc.returncode}"
            rep.fail("manifest", "M-02", f"validate_manifest.py failed: {head}")
    else:
        rep.warn("manifest", "M-02", "tools/validate_manifest.py missing — manifest shape unchecked")

    # Base-image allowlist (contract rule, not currently schema-enforced).
    for tool in (manifest.get("requires", {}) or {}).get("tools", []) or []:
        if not isinstance(tool, dict):
            continue
        name = str(tool.get("name", "")).lower()
        if tool.get("source") == "apt" and name in BASE_IMAGE_TOOLS:
            rep.warn(
                "manifest", "M-03",
                f"requires.tools declares base-image tool {name!r} — the contract says do not declare it",
            )

    return manifest


def check_recipe(root: Path, manifest: dict | None, rep: Report) -> None:
    recipes_dir = root / "src" / "recipes"
    if not recipes_dir.is_dir():
        rep.fail("recipe", "R-01", "src/recipes/ not found — the kit has no execution contract")
        return

    files = sorted(p for p in recipes_dir.glob("*.yaml"))
    if not files:
        rep.fail("recipe", "R-01", "no *.yaml in src/recipes/")
        return
    rep.ok("recipe", "R-01", f"found {len(files)} recipe(s)")

    for rpath in files:
        rel = rpath.relative_to(root)
        try:
            recipe, parser = load_recipe(rpath)
        except RecipeParseError as exc:
            rep.fail("recipe", "R-02", f"{rel}: cannot parse — {exc}")
            continue
        except Exception as exc:  # PyYAML errors
            rep.fail("recipe", "R-02", f"{rel}: YAML error — {exc}")
            continue
        rep.ok("recipe", "R-02", f"{rel}: parses ({parser})")

        # Required top-level fields — mirrors astro's recipe-schema.ts.
        for field in ("name", "description"):
            if not str(recipe.get(field, "")).strip():
                rep.fail("recipe", "R-03", f"{rel}: '{field}' is required and non-empty")

        phases = recipe.get("phases")
        if not isinstance(phases, list) or not phases:
            rep.fail("recipe", "R-03", f"{rel}: 'phases' must be a non-empty list")
            continue

        seen_names: set[str] = set()
        produced: set[str] = set()  # outputs of all PRECEDING phases
        all_outputs: set[str] = set()

        for idx, ph in enumerate(phases):
            label = f"{rel} phase[{idx}]"
            if not isinstance(ph, dict):
                rep.fail("recipe", "R-04", f"{label}: not a mapping")
                continue

            name = str(ph.get("name", "")).strip()
            if not name:
                rep.fail("recipe", "R-04", f"{label}: 'name' is required")
            else:
                label = f"{rel} phase '{name}'"
                if name in seen_names:
                    rep.fail("recipe", "R-05", f"{label}: duplicate phase name")
                seen_names.add(name)
                if not SNAKE_CASE.match(name):
                    rep.warn("recipe", "R-05", f"{label}: name is not snake_case")

            if not str(ph.get("goal", "")).strip():
                rep.fail("recipe", "R-06", f"{label}: 'goal' is required and non-empty")

            outputs = ph.get("output") or []
            if not isinstance(outputs, list) or not outputs:
                # astro's schema: output.min(1). A phase with no output can
                # never be validated as complete by the recipe executor.
                rep.fail(
                    "recipe", "R-07",
                    f"{label}: must declare at least one 'output' "
                    "(astro validates phase completion by output existence)",
                )
                outputs = []

            inputs = ph.get("input") or []
            if not isinstance(inputs, list):
                rep.fail("recipe", "R-08", f"{label}: 'input' must be a list")
                inputs = []

            for out in outputs:
                if escapes_root(str(out)):
                    rep.fail("recipe", "R-09", f"{label}: output {out!r} escapes the work dir")
            for inp in inputs:
                if escapes_root(str(inp)):
                    rep.fail("recipe", "R-09", f"{label}: input {inp!r} escapes the work dir")

            # Dataflow: an input should come from an earlier phase or ship in
            # src/. WARN, not FAIL — a kit may legitimately read something the
            # invocation supplied at runtime.
            for inp in inputs:
                si = str(inp)
                if si in produced:
                    continue
                if (root / "src" / si).exists() or (root / si).exists():
                    continue
                rep.warn(
                    "recipe", "R-10",
                    f"{label}: input {si!r} is not produced by an earlier phase "
                    "and does not ship in src/ — runtime-supplied?",
                )

            produced.update(str(o) for o in outputs)
            all_outputs.update(str(o) for o in outputs)

        rep.ok(
            "recipe", "R-04",
            f"{rel}: {len(phases)} phase(s) well-formed "
            f"({', '.join(sorted(seen_names)) or 'unnamed'})",
        )

        # The contract's definition of done: "every declared artifact is
        # actually produced by the workflow the recipe describes". Until now
        # that was a human eyeball; here it is mechanical.
        if manifest:
            artifacts = (manifest.get("outputs", {}) or {}).get("artifacts", []) or []
            reachable = 0
            for art in artifacts:
                apath = art.get("path") if isinstance(art, dict) else art
                if not apath:
                    continue
                apath = str(apath)
                if apath in all_outputs:
                    reachable += 1
                    continue
                if _WILDCARD.search(apath):
                    rep.warn(
                        "recipe", "R-11",
                        f"artifact {apath!r} contains a wildcard — cannot match it to a phase output",
                    )
                    continue
                rep.fail(
                    "recipe", "R-11",
                    f"artifact {apath!r} (kit.json outputs.artifacts) is produced by NO "
                    f"phase in {rel} — the kit would finish with nothing to deliver",
                )
            if reachable:
                rep.ok(
                    "recipe", "R-11",
                    f"{reachable}/{len(artifacts)} declared artifact(s) produced by a phase",
                )
            if artifacts:
                tagged = [
                    a for a in artifacts
                    if isinstance(a, dict) and "email_attachment" in (a.get("tags") or [])
                ]
                if len(tagged) > 1:
                    rep.fail(
                        "recipe", "R-12",
                        f"{len(tagged)} artifacts carry 'email_attachment' — at most ONE may",
                    )


def check_examples(root: Path, rep: Report) -> None:
    path = root / "src" / "EXAMPLES.md"
    if not path.is_file():
        rep.fail("examples", "E-01", "src/EXAMPLES.md missing (Astro reads it to learn how to invoke the kit)")
        return
    text = path.read_text(encoding="utf-8")
    headings = {
        m.group(1).strip().lower()
        for m in re.finditer(r"^#{1,3}\s+(.+?)\s*$", text, re.MULTILINE)
    }
    missing = [s for s in REQUIRED_EXAMPLE_SECTIONS if s.lower() not in headings]
    if missing:
        rep.fail("examples", "E-02", f"EXAMPLES.md missing required section(s): {', '.join(missing)}")
    else:
        rep.ok("examples", "E-02", "EXAMPLES.md has all 4 required sections")

    # Each example carries 4 labelled fields. The house format bolds the colon
    # too (`**Prompt:**`), so match the label with an optional inner colon.
    missing_fields = []
    for field in ("Prompt", "Arguments", "Expected workflow", "Produces"):
        pattern = r"\*\*\s*" + re.escape(field) + r"\s*:?\s*\*\*"
        if not re.search(pattern, text, re.IGNORECASE):
            missing_fields.append(field)
    if missing_fields:
        rep.warn(
            "examples", "E-03",
            f"EXAMPLES.md examples missing labelled field(s): {', '.join(missing_fields)}",
        )
    else:
        rep.ok("examples", "E-03", "examples carry all 4 labelled fields")


def check_required_docs(root: Path, rep: Report) -> None:
    for name in ("CLAUDE.md", "README.md"):
        if (root / "src" / name).is_file():
            rep.ok("docs", "D-01", f"src/{name} present")
        else:
            rep.fail("docs", "D-01", f"src/{name} missing (required by the kit contract)")


def check_scripts(root: Path, rep: Report) -> None:
    src = root / "src"
    if not src.is_dir():
        rep.fail("scripts", "S-01", "src/ not found")
        return
    pys = sorted(src.rglob("*.py"))
    if not pys:
        rep.warn("scripts", "S-01", "no python scripts under src/ — deliverables must be script-generated")
        return
    broken = 0
    with tempfile.TemporaryDirectory() as tmp:
        for py in pys:
            try:
                py_compile.compile(
                    str(py),
                    cfile=str(Path(tmp) / (py.stem + ".pyc")),
                    doraise=True,
                )
            except py_compile.PyCompileError as exc:
                broken += 1
                first = str(exc).strip().splitlines()
                rep.fail(
                    "scripts", "S-02",
                    f"{py.relative_to(root)}: syntax error — {first[-1] if first else exc}",
                )
    if not broken:
        rep.ok("scripts", "S-02", f"{len(pys)} python file(s) compile")


def check_parity(root: Path, rep: Report) -> None:
    manifest = root / "tools" / "parity" / "parity.json"
    checker = root / "tools" / "parity_check.py"
    if not manifest.is_file():
        rep.warn("parity", "P-01", "no tools/parity/parity.json — no golden-fixture coverage of the scripts")
        return
    if not checker.is_file():
        rep.fail("parity", "P-01", "parity.json present but tools/parity_check.py missing")
        return
    proc = subprocess.run(
        [sys.executable, str(checker), "--manifest", str(manifest)],
        capture_output=True, text=True, cwd=str(root),
    )
    if proc.returncode == 0:
        rep.ok("parity", "P-02", "parity_check.py clean")
    else:
        detail = (proc.stdout or proc.stderr or "").strip().splitlines()
        rep.fail("parity", "P-02", f"parity_check.py failed: {detail[-1] if detail else proc.returncode}")


def check_build(root: Path, rep: Report) -> None:
    zip_path = root / "dist" / "kit.zip"
    if zip_path.is_file():
        rep.ok("build", "B-01", "dist/kit.zip present")
    else:
        rep.warn("build", "B-01", "dist/kit.zip not built yet — run ./tools/build_kit.sh")


# ── Reporting ─────────────────────────────────────────────────────────────

SYMBOL = {PASS: "✓", WARN: "!", FAIL: "✗"}


def render(rep: Report, root: Path) -> None:
    print(f"kit-test — {root}")
    print()
    group = None
    for status, grp, cid, msg in rep.rows:
        if grp != group:
            print(f"  {grp}")
            group = grp
        print(f"    {SYMBOL[status]} [{cid}] {msg}")
    print()
    nf, nw = len(rep.failed), len(rep.warned)
    npass = len([r for r in rep.rows if r[0] == PASS])
    print(f"  {npass} passed, {nw} warning(s), {nf} failure(s)")
    if nf:
        print()
        print("  Tier 1 FAILED — fix the above before publishing.")
    else:
        print()
        print("  Tier 1 clean. Note: this proves the kit is well-formed, NOT that it works —")
        print("  only a real run (Tier 2/3) does that.")


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="kit_test.py",
        description="Tier 1 offline kit test — static checks, no Astro instance required.",
    )
    parser.add_argument("--kit-root", default=".", help="kit root directory (default: cwd)")
    parser.add_argument("--json", action="store_true", help="emit a machine-readable report on stdout")
    parser.add_argument("--skip-parity", action="store_true", help="do not run parity_check.py")
    args = parser.parse_args()

    root = Path(args.kit_root).resolve()
    if not root.is_dir():
        print(f"error: not a directory: {root}", file=sys.stderr)
        return 2
    if not (root / "kit.json").is_file() and not (root / "src").is_dir():
        print(f"error: {root} does not look like a kit root (no kit.json, no src/)", file=sys.stderr)
        return 2

    rep = Report()
    manifest = check_manifest(root, rep)
    check_required_docs(root, rep)
    check_sources(root, manifest, rep)
    check_recipe(root, manifest, rep)
    check_examples(root, rep)
    check_scripts(root, rep)
    if not args.skip_parity:
        check_parity(root, rep)
    check_build(root, rep)

    if args.json:
        print(json.dumps({
            "kit_root": str(root),
            "results": [
                {"status": s, "group": g, "id": c, "message": m}
                for s, g, c, m in rep.rows
            ],
            "failures": len(rep.failed),
            "warnings": len(rep.warned),
        }, indent=2))
    else:
        render(rep, root)

    return 1 if rep.failed else 0


if __name__ == "__main__":
    sys.exit(main())
