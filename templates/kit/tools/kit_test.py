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

import os

try:  # authoritative when present; never required
    import yaml as _pyyaml
except ImportError:  # pragma: no cover - depends on the host env
    _pyyaml = None

# Escape hatch so the builtin fallback parser can be exercised on a machine
# that HAS PyYAML — otherwise the fallback only ever runs where it cannot be
# tested, which is how fallbacks rot.
if os.environ.get("KIT_TEST_NO_PYYAML") == "1":
    _pyyaml = None

if _pyyaml is not None:
    class _UniqueKeySafeLoader(_pyyaml.SafeLoader):
        """SafeLoader that rejects a duplicated mapping key, as astro's `yaml`
        parser does ("Map keys must be unique") — PyYAML otherwise keeps the
        last value silently, so offline would accept what the server 422s."""

        def construct_mapping(self, node, deep=False):
            if isinstance(node, _pyyaml.MappingNode):
                seen = set()
                for key_node, _value in node.value:
                    if key_node.tag == "tag:yaml.org,2002:merge":
                        continue
                    key = self.construct_object(key_node, deep=deep)
                    try:
                        duplicate = key in seen
                    except TypeError:  # unhashable key — PyYAML rejects it below
                        continue
                    if duplicate:
                        raise _pyyaml.constructor.ConstructorError(
                            "while constructing a mapping", node.start_mark,
                            f"found duplicate key {key!r}", key_node.start_mark)
                    seen.add(key)
            return super().construct_mapping(node, deep=deep)


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


# ── Phase 102 (a3): PyYAML-optional schema.yaml reader ─────────────────────
# Mirrors astro's source-schema.ts (t3) and its JSON Schema
# (schemas/source-schema.v1.schema.json, copied byte-identical here). No
# patternProperties support in _schema_engine.py, so this is a hand walker
# over the parsed dict instead of a schema-engine call (recipe-validator
# precedent). Never skips silently — anything outside the documented
# block-style subset is an SRC-06 FAIL, in both the PyYAML and builtin path.

class SourceSchemaParseError(Exception):
    """schema.yaml uses YAML this restricted reader will not guess at."""


_TABLE_PART = r"(?:\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$#@]*)"
_TABLE_KEY_RE = re.compile(rf"^{_TABLE_PART}\.{_TABLE_PART}$")
_JOIN_RE = re.compile(rf"^{_TABLE_PART}\.{_TABLE_PART}\.{_TABLE_PART}$")
_INT_RE = re.compile(r"^-?[0-9]+$")

_TABLE_FIELDS = {"purpose", "kind", "grain", "rows", "columns", "rules"}
_COLUMN_FIELDS = {"meaning", "type", "key", "joins", "unit", "tz", "values", "sensitive"}


def _yaml_min_plain(v: str):
    """Type a plain (unquoted) scalar: int, true/false, empty -> None."""
    v = v.strip()
    if v == "":
        return None
    if v.lower() == "true":
        return True
    if v.lower() == "false":
        return False
    if _INT_RE.match(v):
        return int(v)
    return v


def _yaml_min_scalar(v: str):
    v = v.strip()
    if v.startswith("{") or v.startswith("["):
        return _yaml_min_flow(v)
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
        return v[1:-1]
    return _yaml_min_plain(v)


def _yaml_min_flow(text: str):
    """Single-line flow collection: `{}`, `[]`, `{a: 1, b: 'x, y'}`,
    `[a, "b, c"]`, nested. Quoted scalars may contain `,:[]{}`; a duplicate
    key is rejected. Anything else (e.g. a flow spanning lines) raises."""
    n = len(text)

    def ws(i: int) -> int:
        while i < n and text[i] in " \t":
            i += 1
        return i

    def quoted(i: int) -> tuple[str, int]:
        q = text[i]
        out: list[str] = []
        i += 1
        while i < n:
            ch = text[i]
            if q == "'" and ch == "'":
                if i + 1 < n and text[i + 1] == "'":
                    out.append("'")
                    i += 2
                    continue
                return "".join(out), i + 1
            if q == '"' and ch == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if q == '"' and ch == '"':
                return "".join(out), i + 1
            out.append(ch)
            i += 1
        raise SourceSchemaParseError(f"unterminated quoted scalar in flow collection {text[:60]!r}")

    def plain(i: int) -> tuple[object, int]:
        # A plain scalar ends at a flow indicator or a ': ' key separator.
        start = i
        while i < n:
            ch = text[i]
            if ch in ",[]{}":
                break
            if ch == ":" and (i + 1 >= n or text[i + 1] in " ,[]{}"):
                break
            i += 1
        return _yaml_min_plain(text[start:i]), i

    def value(i: int) -> tuple[object, int]:
        i = ws(i)
        if i >= n:
            raise SourceSchemaParseError(f"incomplete flow collection {text[:60]!r}")
        ch = text[i]
        if ch == "{":
            return mapping(i)
        if ch == "[":
            return sequence(i)
        if ch in ('"', "'"):
            return quoted(i)
        return plain(i)

    def mapping(i: int) -> tuple[dict, int]:
        out: dict = {}
        i = ws(i + 1)
        while True:
            if i >= n:
                raise SourceSchemaParseError(f"unterminated flow mapping {text[:60]!r}")
            if text[i] == "}":
                return out, i + 1
            key, i = value(i)
            i = ws(i)
            val = None
            if i < n and text[i] == ":":
                i = ws(i + 1)
                if i < n and text[i] not in ",}":
                    val, i = value(i)
                    i = ws(i)
            try:
                duplicate = key in out
            except TypeError:
                raise SourceSchemaParseError(f"unsupported flow mapping key in {text[:60]!r}")
            if duplicate:
                raise SourceSchemaParseError(f"duplicate key {key!r} in flow mapping")
            out[key] = val
            if i < n and text[i] == ",":
                i = ws(i + 1)
            elif i < n and text[i] == "}":
                continue
            else:
                raise SourceSchemaParseError(f"expected ',' or '}}' in flow mapping {text[:60]!r}")

    def sequence(i: int) -> tuple[list, int]:
        out: list = []
        i = ws(i + 1)
        while True:
            if i >= n:
                raise SourceSchemaParseError(f"unterminated flow sequence {text[:60]!r}")
            if text[i] == "]":
                return out, i + 1
            item, i = value(i)
            out.append(item)
            i = ws(i)
            if i < n and text[i] == ",":
                i = ws(i + 1)
            elif i < n and text[i] == "]":
                continue
            else:
                raise SourceSchemaParseError(f"expected ',' or ']' in flow sequence {text[:60]!r}")

    result, end = value(0)
    if ws(end) != n:
        raise SourceSchemaParseError(f"unexpected content after flow collection {text[:60]!r}")
    return result


_BLOCK_SCALAR_RE = re.compile(r"^([|>])(?:([+-])([1-9])?|([1-9])([+-])?)?$")


def _yaml_min_block_scalar(header: str, lines: list[str], i: int, n: int, parent_indent: int) -> tuple[str, int]:
    """Read a `|`/`>` block scalar (clip/strip/keep chomping, optional
    indentation indicator) whose content starts at lines[i]. Content lines
    are taken raw — a '#' inside is text, not a comment."""
    m = _BLOCK_SCALAR_RE.match(header)
    style = m.group(1)
    chomp = m.group(2) or m.group(5) or ""
    explicit = m.group(3) or m.group(4)

    def indent_of(s: str) -> int:
        return len(s) - len(s.lstrip(" "))

    if explicit:
        block_indent = parent_indent + int(explicit)
    else:
        k = i
        while k < n and not lines[k].strip():
            k += 1
        block_indent = indent_of(lines[k]) if k < n else parent_indent + 1
    if block_indent <= parent_indent:
        block_indent = parent_indent + 1

    body: list[str] = []
    while i < n:
        ln = lines[i]
        if not ln.strip():
            body.append(ln[block_indent:] if len(ln) > block_indent else "")
            i += 1
            continue
        if indent_of(ln) < block_indent:
            break
        body.append(ln[block_indent:])
        i += 1

    trailing = 0
    while body and body[-1] == "":
        body.pop()
        trailing += 1

    if style == "|":
        content = "\n".join(body)
    else:
        content = ""
        pending = 0
        prev_kind = None
        for ln in body:
            if ln == "":
                pending += 1
                continue
            kind = "more" if ln[0] in " \t" else "text"
            if prev_kind is None:
                content += "\n" * pending
            elif prev_kind == "text" and kind == "text":
                content += " " if pending == 0 else "\n" * pending
            else:
                content += "\n" * (pending + 1)
            content += ln
            prev_kind = kind
            pending = 0

    if not body:
        return ("\n" * trailing if chomp == "+" else ""), i
    if chomp == "-":
        return content, i
    if chomp == "+":
        return content + "\n" + "\n" * trailing, i
    return content + "\n", i


def _yaml_min_split_key_value(s: str, lineno: int) -> tuple[str, str]:
    """Split 'key: value' on the first unquoted colon. A quoted key may
    itself contain '.' (table keys) — find its closing quote first."""
    if s and s[0] in ('"', "'"):
        q = s[0]
        j = 1
        while j < len(s) and s[j] != q:
            j += 1
        if j >= len(s):
            raise SourceSchemaParseError(f"line {lineno + 1}: unterminated quoted key")
        remainder = s[j + 1:]
        if not remainder.startswith(":"):
            raise SourceSchemaParseError(f"line {lineno + 1}: expected ':' after quoted key")
        return s[0:j + 1], remainder[1:]
    if ":" not in s:
        raise SourceSchemaParseError(f"line {lineno + 1}: expected 'key: value', got {s[:60]!r}")
    idx = s.find(":")
    return s[:idx], s[idx + 1:]


def _yaml_min_block(lines: list[str], i: int, n: int, base_indent: int) -> tuple[dict, int]:
    """Parse a block mapping whose keys all sit at `base_indent`."""
    result: dict = {}

    def indent_of(s: str) -> int:
        return len(s) - len(s.lstrip(" "))

    while i < n:
        raw = _strip_comment(lines[i])
        if not raw.strip():
            i += 1
            continue
        ind = indent_of(raw)
        if ind < base_indent:
            break
        if ind > base_indent:
            raise SourceSchemaParseError(f"line {i + 1}: unexpected indentation")
        s = raw.strip()
        if s.startswith("- "):
            raise SourceSchemaParseError(f"line {i + 1}: unexpected list item in a mapping")
        key_raw, rest = _yaml_min_split_key_value(s, i)
        key = _yaml_min_scalar(key_raw)
        if not isinstance(key, str):
            key = key_raw.strip()
        rest = rest.strip()
        if key in result:
            raise SourceSchemaParseError(f"line {i + 1}: duplicate key {key!r}")
        if _BLOCK_SCALAR_RE.match(rest):
            result[key], i = _yaml_min_block_scalar(rest, lines, i + 1, n, base_indent)
            continue
        if rest != "":
            result[key] = _yaml_min_scalar(rest)
            i += 1
            continue
        # Nested block: find the first non-blank following line to learn
        # whether it is a mapping or a list, and at what indent.
        j = i + 1
        k = j
        while k < n and not lines[k].strip():
            k += 1
        if k >= n or indent_of(lines[k]) <= base_indent:
            result[key] = None
            i = j
            continue
        nested_indent = indent_of(lines[k])
        if _strip_comment(lines[k]).strip().startswith("- "):
            items, i = _yaml_min_list(lines, j, n, nested_indent)
            result[key] = items
        else:
            nested, i = _yaml_min_block(lines, j, n, nested_indent)
            result[key] = nested
    return result, i


def _yaml_min_list(lines: list[str], i: int, n: int, item_indent: int) -> tuple[list, int]:
    items: list = []

    def indent_of(s: str) -> int:
        return len(s) - len(s.lstrip(" "))

    while i < n:
        raw = _strip_comment(lines[i])
        if not raw.strip():
            i += 1
            continue
        ind = indent_of(raw)
        if ind < item_indent:
            break
        if ind > item_indent:
            raise SourceSchemaParseError(f"line {i + 1}: unexpected indentation in list")
        s = raw.strip()
        if not s.startswith("- "):
            break
        item = s[2:].strip()
        if _BLOCK_SCALAR_RE.match(item):
            value, i = _yaml_min_block_scalar(item, lines, i + 1, n, item_indent)
            items.append(value)
            continue
        items.append(_yaml_min_scalar(item))
        i += 1
    return items, i


def parse_yaml_min_nested(text: str) -> dict:
    """Restricted block-style YAML reader for schema.yaml: nested mappings,
    block lists, single-line flow collections (`{}`, `[]`, `{a: b}`,
    `[a, b]`), `|`/`>` block scalars, quoted/plain scalars, ints,
    true/false and comments. A duplicate key is rejected. Anything else
    raises SourceSchemaParseError — never a silent skip, never a traceback."""
    if text.startswith("\ufeff"):
        text = text[1:]
    lines = text.splitlines()
    n = len(lines)
    i = 0
    while i < n and not lines[i].strip():
        i += 1
    if i >= n:
        return {}
    if len(lines[i]) - len(lines[i].lstrip(" ")) != 0:
        raise SourceSchemaParseError(f"line {i + 1}: top-level content must start at column 0")
    result, i = _yaml_min_block(lines, i, n, 0)
    while i < n and not lines[i].strip():
        i += 1
    if i < n:
        raise SourceSchemaParseError(f"line {i + 1}: unexpected trailing content")
    return result


def load_source_schema_yaml(text: str) -> tuple[dict, str]:
    """Return (data, parser_name). PyYAML wins when available (decision 2)."""
    if _pyyaml is not None:
        data = _pyyaml.load(text, Loader=_UniqueKeySafeLoader)
        if not isinstance(data, dict):
            raise SourceSchemaParseError("schema.yaml did not parse to a mapping")
        return (data, "PyYAML")
    return (parse_yaml_min_nested(text), "builtin")


def _normalize_table_key(key: str) -> str:
    norm = []
    for part in key.split("."):
        part = part.strip()
        if part.startswith("[") and part.endswith("]"):
            part = part[1:-1]
        norm.append(part.lower())
    return ".".join(norm)


def validate_source_schema(data, source_id: str) -> tuple[list, list]:
    """Hand walker mirroring source-schema.v1.schema.json (t3). Returns
    (errors, warnings) as (check, source_id, file, message) tuples — SRC-06
    for anything structurally wrong, SRC-07 for an undeclared `joins`
    target (never blocks, C6)."""
    file = "schema.yaml"
    errors: list[tuple[str, str, str, str]] = []
    warnings: list[tuple[str, str, str, str]] = []

    def fail(msg: str) -> None:
        errors.append(("SRC-06", source_id, file, msg))

    if not isinstance(data, dict):
        fail("schema.yaml must be a mapping")
        return errors, warnings

    unknown_top = set(data.keys()) - {"version", "tables"}
    if unknown_top:
        fail(f"unknown top-level key(s): {', '.join(sorted(unknown_top))}")
    if data.get("version") != 1:
        fail(f"version must be 1, got {data.get('version')!r}")

    tables = data.get("tables")
    if tables is None:
        fail("missing 'tables'")
        return errors, warnings
    if not isinstance(tables, dict):
        fail("'tables' must be a mapping")
        return errors, warnings

    declared = {_normalize_table_key(k) for k in tables.keys()}

    for table_key, table in tables.items():
        if not isinstance(table_key, str) or not _TABLE_KEY_RE.match(table_key):
            fail(f"tables.{table_key!r} is not schema-qualified (expected schema.table)")
            continue
        if not isinstance(table, dict):
            fail(f"tables.{table_key}: must be a mapping")
            continue
        unknown = set(table.keys()) - _TABLE_FIELDS
        if unknown:
            fail(f"tables.{table_key}: unknown key(s): {', '.join(sorted(unknown))}")
        if not table.get("purpose"):
            fail(f"tables.{table_key}: missing required 'purpose'")
        kind = table.get("kind")
        if kind is not None and kind not in ("table", "view"):
            fail(f"tables.{table_key}: kind must be 'table' or 'view'")
        rows = table.get("rows")
        if rows is not None and (isinstance(rows, bool) or not isinstance(rows, (str, int))):
            fail(f"tables.{table_key}: rows must be a string or integer")
        rules = table.get("rules")
        if rules is not None and (not isinstance(rules, list) or any(not isinstance(r, str) for r in rules)):
            fail(f"tables.{table_key}: rules must be a list of strings")

        columns = table.get("columns")
        if columns is None:
            continue
        if not isinstance(columns, dict):
            fail(f"tables.{table_key}: columns must be a mapping")
            continue
        for col_name, col in columns.items():
            if not isinstance(col, dict):
                fail(f"tables.{table_key}.columns.{col_name}: must be a mapping")
                continue
            unknown_c = set(col.keys()) - _COLUMN_FIELDS
            if unknown_c:
                fail(f"tables.{table_key}.columns.{col_name}: unknown key(s): {', '.join(sorted(unknown_c))}")
            if not col.get("meaning"):
                fail(f"tables.{table_key}.columns.{col_name}: missing required 'meaning'")
            if "key" in col and not isinstance(col["key"], bool):
                fail(f"tables.{table_key}.columns.{col_name}: key must be a boolean")
            if "sensitive" in col and not isinstance(col["sensitive"], bool):
                fail(f"tables.{table_key}.columns.{col_name}: sensitive must be a boolean")
            values = col.get("values")
            if values is not None and (not isinstance(values, dict) or any(not isinstance(v, str) for v in values.values())):
                fail(f"tables.{table_key}.columns.{col_name}: values must be a string map")
            joins = col.get("joins")
            if joins is not None:
                if not isinstance(joins, str) or not _JOIN_RE.match(joins):
                    fail(f"tables.{table_key}.columns.{col_name}: joins must be a schema.table.column reference")
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


_SQLTYPE_TOKEN_RE = re.compile(r"^([A-Za-z][A-Za-z0-9]*)(?:\(([^()]*)\))?$")


def parse_sql_type(token) -> tuple[bool, dict | str]:
    """(ok, {name, literal, args}) or (False, error). Mirrors sql-types.ts."""
    types = _load_sqlserver_types()
    if types is None:
        return False, _SQLSERVER_TYPES_LOAD_ERROR or "sqlserver-types.v1.json unavailable"
    if not isinstance(token, str) or token != token.strip() or token == "":
        return False, f"empty or malformed sqltype: {token!r}"
    if re.search(r"\s", token):
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
        if not re.match(r"^[1-9][0-9]*$", raw_args):
            return False, f"{name} length must be a positive integer: '{token}'"
        length = int(raw_args)
        max_len = bounds.get("maxLength")
        if max_len and length > max_len:
            return False, f"{name}({length}) exceeds max length {max_len}"
        return True, {"name": name, "literal": literal, "args": {"kind": "length", "length": length}}
    if args_kind == "length_or_max":
        if raw_args is None:
            return False, f"{name} requires (n) or (max): '{token}'"
        if raw_args.lower() == "max":
            return True, {"name": name, "literal": literal, "args": {"kind": "max"}}
        if not re.match(r"^[1-9][0-9]*$", raw_args):
            return False, f"{name} length must be a positive integer or 'max': '{token}'"
        length = int(raw_args)
        max_len = bounds.get("maxLength")
        if max_len and length > max_len:
            return False, f"{name}({length}) exceeds max length {max_len}"
        return True, {"name": name, "literal": literal, "args": {"kind": "length", "length": length}}
    if args_kind == "precision_scale":
        if raw_args is None:
            return True, {"name": name, "literal": literal, "args": {"kind": "precision_scale", "precision": 18, "scale": 0}}
        pm = re.match(r"^([0-9]+)(?:,([0-9]+))?$", raw_args)
        if not pm:
            return False, f"{name} args must be (p) or (p,s): '{token}'"
        precision = int(pm.group(1))
        scale = int(pm.group(2)) if pm.group(2) is not None else 0
        max_p = bounds.get("maxPrecision", 38)
        if precision < 1 or precision > max_p:
            return False, f"{name} precision must be 1..{max_p}: '{token}'"
        if scale < 0 or scale > precision:
            return False, f"{name} scale must be 0..precision: '{token}'"
        return True, {"name": name, "literal": literal, "args": {"kind": "precision_scale", "precision": precision, "scale": scale}}
    if args_kind == "fraction":
        if raw_args is None:
            return True, {"name": name, "literal": literal, "args": {"kind": "fraction", "fraction": 7}}
        if not re.match(r"^[0-7]$", raw_args):
            return False, f"{name} fraction must be 0..7: '{token}'"
        return True, {"name": name, "literal": literal, "args": {"kind": "fraction", "fraction": int(raw_args)}}
    return False, f"unsupported args kind {args_kind!r} for {name}"  # pragma: no cover — data drift guard


_DEF_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_DEF_DATETIME_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?)?$")
_DEF_TIME_RE = re.compile(r"^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?$")
_DEF_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


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
        if not re.match(r"^-?[0-9]+$", literal):
            return False, f"'{literal}' is not a valid int literal"
        n = int(literal)
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
        if not re.match(r"^-?[0-9]+(\.[0-9]+)?$", literal):
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
        if not re.match(r"^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$", literal):
            return False, f"'{literal}' is not a valid float literal"
        return True, literal
    if kind == "string":
        if args["kind"] == "length" and len(literal) > args["length"]:
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
        off = re.match(r"^(.*?)(Z|[+-]\d{2}:\d{2})$", literal)
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
_FORBIDDEN_RE = re.compile(r"\b(" + "|".join(_FORBIDDEN_KEYWORDS) + r")\b", re.IGNORECASE)
_FIRST_KEYWORD_RE = re.compile(r"^\s*([A-Za-z]+)\b")
_BODY_PARAM_RE = re.compile(r"(?<!@)@([A-Za-z_][A-Za-z0-9_]*)")


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
    trimmed = strip_sql(body).strip()
    if trimmed.endswith(";"):
        trimmed = trimmed[:-1].strip()
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

_QNAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_QPARAM_NAME_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_QTAG_LINE_RE = re.compile(r"^--\s*@([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.*))?$")
_QMAX_ROWS_RE = re.compile(r"^[1-9][0-9]*$")


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
    t = trailing.strip()
    if t == "":
        return True, None
    m = re.match(r"^default=(.*)$", t)
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
    if re.search(r"\s", rest) or rest == "":
        return False, None
    return True, rest


def check_named_query(source_id: str, file_name: str, text: str) -> tuple[list[tuple[str, str, str, str]], dict | None]:
    """Returns (errors, query). errors are (check, source_id, file, message)
    tuples, matching validate_source_schema's shape."""
    errors: list[tuple[str, str, str, str]] = []

    def err(check: str, message: str) -> None:
        errors.append((check, source_id, file_name, message))

    stem = re.sub(r"\.sql$", "", file_name, flags=re.IGNORECASE)
    lines = re.split(r"\r\n|\n", text)

    i = 0
    header_lines: list[str] = []
    while i < len(lines) and (lines[i].strip() == "" or lines[i].startswith("--")):
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
        rest = (raw_rest or "").strip()

        if tag == "name":
            name_count += 1
            name_value = rest
        elif tag == "description":
            description_count += 1
            description_value = rest
        elif tag == "param":
            pm = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s+(\S+)\s+(required|optional)\b(.*)$", rest)
            if not pm:
                err("SRC-10", f"malformed @param line: '{line.strip()}'")
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
                err("SRC-10", f"@param {pname}: malformed trailing text '{trailer.strip()}'")
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
                max_rows_value = int(rest)
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
    elif not returns_raw or returns_raw.strip() == "":
        err("SRC-11", "@returns must declare at least one column")
    else:
        seen_cols: set[str] = set()
        for piece in _split_outside_parens(returns_raw):
            p = piece.strip()
            if p == "":
                err("SRC-11", "@returns has an empty column entry")
                continue
            cm = re.match(r"^(\S+)\s+(\S+)$", p)
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


def check_sources(root: Path, manifest: dict | None, rep: Report) -> None:
    """SRC-04..14: per-source SOURCE.md/schema.yaml presence + validity,
    named query header/body checks, and the adhoc:false rule. Runs against
    the AUTHORED tree (src/sources/<id>/...), not the zip layout."""
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
        # Exact-case directory listing — Sources/ or Schema.yaml fails here
        # exactly as it does on the server (SRC-05/SRC-04 zip convention).
        names = set(os.listdir(src_dir)) if src_dir.is_dir() else set()

        # Files are read as utf-8-sig: a leading BOM is dropped exactly as
        # astroport's TextDecoder (fflate strFromU8) drops it server-side.
        # ── SRC-04: SOURCE.md present and non-empty ──
        if "SOURCE.md" not in names:
            rep.fail("sources", "SRC-04", f"{source_id}: SOURCE.md missing")
        elif not (src_dir / "SOURCE.md").read_text(encoding="utf-8-sig").strip():
            rep.fail("sources", "SRC-04", f"{source_id}: SOURCE.md is empty")

        if "schema.yaml" not in names:
            rep.fail("sources", "SRC-05", f"{source_id}: schema.yaml missing")
            continue
        text = (src_dir / "schema.yaml").read_text(encoding="utf-8-sig")
        try:
            data, _parser = load_source_schema_yaml(text)
        except Exception as exc:  # SourceSchemaParseError or a PyYAML error
            rep.fail("sources", "SRC-06", f"{source_id}: schema.yaml is not valid YAML: {exc}")
            continue
        errors, warnings = validate_source_schema(data, source_id)
        for check, sid, file, msg in errors:
            rep.fail("sources", check, f"{sid}: {file}: {msg}")
        for check, sid, file, msg in warnings:
            rep.warn("sources", check, f"{sid}: {file}: {msg}")

        # ── SRC-08..13: named queries (direct *.sql children of queries/) ──
        queries_dir = src_dir / "queries"
        query_files: list[Path] = []
        if queries_dir.is_dir():
            query_files = sorted(p for p in queries_dir.iterdir() if p.is_file() and p.suffix.lower() == ".sql")
            for qfile in query_files:
                qtext = qfile.read_text(encoding="utf-8-sig")
                qerrors, _query = check_named_query(source_id, qfile.name, qtext)
                for check, sid, file, msg in qerrors:
                    rep.fail("sources", check, f"{sid}: {file}: {msg}")

        # ── SRC-14: adhoc:false requires >= 1 named query ──
        if not adhoc and len(query_files) == 0:
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
