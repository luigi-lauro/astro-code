// Phase 102 (a4) — kit_test.py query checks: type list, header grammar,
// SELECT guard (SRC-08..13). Mirrors astro's tests/kits/sql-types.test.ts,
// sql-guard.test.ts and source-query.test.ts (t4/t5/t6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KIT_SRC = join(ROOT, 'examples/kit-convert-demo/commit-digest');
const TOOL_SRC = join(ROOT, 'templates/kit/tools/kit_test.py');
const TOOLS_DIR = join(ROOT, 'templates/kit/tools');
const hasPython = spawnSync('python3', ['--version']).status === 0;

const BASE_QUERY = `-- @name open_orders
-- @description Open orders for a customer
-- @param CustomerId int required
-- @returns OrderId int, Total decimal(18,2)
SELECT OrderId, Total FROM dbo.Orders WHERE CustomerId = @CustomerId
`;

function scratchKit(querySql, { fileName = 'open_orders.sql' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-kittest-qry-'));
  cpSync(KIT_SRC, dir, { recursive: true });
  cpSync(TOOL_SRC, join(dir, 'tools/kit_test.py'));
  cpSync(join(TOOLS_DIR, 'schemas/sqlserver-types.v1.json'), join(dir, 'tools/schemas/sqlserver-types.v1.json'));

  const kitJsonPath = join(dir, 'kit.json');
  const manifest = JSON.parse(readFileSync(kitJsonPath, 'utf8'));
  manifest.contract_version = '^1.1.0';
  manifest.sources = [{ id: 'erp', engine: 'sqlserver', access: 'read_only', description: 'ERP' }];
  writeFileSync(kitJsonPath, JSON.stringify(manifest, null, 2));

  const srcDir = join(dir, 'src/sources/erp');
  mkdirSync(join(srcDir, 'queries'), { recursive: true });
  writeFileSync(join(srcDir, 'SOURCE.md'), '# ERP\n\nThe ERP database.\n');
  writeFileSync(
    join(srcDir, 'schema.json'),
    JSON.stringify({ version: 1, tables: { 'dbo.Orders': { purpose: 'x', columns: { OrderId: { meaning: 'y' } } } } }),
  );
  if (querySql !== null) writeFileSync(join(srcDir, 'queries', fileName), querySql);
  return dir;
}

function runKitTest(kitDir) {
  const res = spawnSync('python3', ['tools/kit_test.py', '--json', '--skip-parity'], {
    cwd: kitDir,
    encoding: 'utf8',
  });
  let report = null;
  try { report = JSON.parse(res.stdout); } catch { /* ignore */ }
  return { status: res.status, out: `${res.stdout || ''}${res.stderr || ''}`, report };
}

function assertCheck(res, check) {
  assert.equal(res.status, 1, res.out);
  const row = res.report?.results.find((r) => r.id === check);
  assert.ok(row, `expected ${check} to fire\n${res.out}`);
}

// ── C16: type matrix, run through parse_sql_type directly ──────────────────

const acceptedTypes = ['int', 'bigint', 'bit', 'decimal(18,2)', 'nvarchar(50)', 'nvarchar(max)', 'NVARCHAR(MAX)', 'varchar(max)', 'date', 'datetime2', 'uniqueidentifier'];
const rejectedTypes = ['nvarchar(abc)', 'decimal(x,y)', 'varchar(-1)', 'strng', '', 'nvarchar(9000)', 'decimal(40,2)'];

test('parse_sql_type accepts the C16 matrix', { skip: !hasPython }, () => {
  const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})
import kit_test
for t in ${JSON.stringify(acceptedTypes)}:
    ok, v = kit_test.parse_sql_type(t)
    assert ok, (t, v)
for t in ${JSON.stringify(rejectedTypes)}:
    ok, v = kit_test.parse_sql_type(t)
    assert not ok, (t, v)
print("OK")
`;
  const res = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('parse_default_literal matches astro (int/date/bit/guid)', { skip: !hasPython }, () => {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})
import kit_test
assert kit_test.parse_default_literal('nvarchar(20)', 'Open')[0]
assert kit_test.parse_default_literal('int', '100')[0]
assert kit_test.parse_default_literal('date', '2026-01-01')[0]
assert not kit_test.parse_default_literal('int', 'abc')[0]
assert not kit_test.parse_default_literal('date', 'yesterday')[0]
assert not kit_test.parse_default_literal('date', '2026-02-30')[0]
assert not kit_test.parse_default_literal('bit', '2')[0]
assert not kit_test.parse_default_literal('uniqueidentifier', 'not-a-guid')[0]
print("OK")
`;
  const res = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

// ── C13: single-SELECT guard ─────────────────────────────────────────────

test('check_single_select accepts SELECT/WITH and rejects writes/stacking', { skip: !hasPython }, () => {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})
import kit_test
accepted = [
    "SELECT OrderId FROM dbo.Orders WHERE CustomerId = @CustomerId",
    "WITH cte AS (SELECT OrderId FROM dbo.Orders) SELECT OrderId FROM cte",
    "SELECT OrderId FROM dbo.Orders;",
]
for b in accepted:
    ok, reason = kit_test.check_single_select(b)
    assert ok, (b, reason)
rejected = [
    "UPDATE dbo.Orders SET Total = 0",
    "DELETE FROM dbo.Orders",
    "INSERT INTO dbo.Orders (CustomerId) VALUES (1)",
    "EXEC dbo.sp_x @CustomerId",
    "SELECT 1; DROP TABLE dbo.Orders",
    "SELECT 1; SELECT 2",
    "SELECT OrderId INTO #tmp FROM dbo.Orders",
    "",
]
for b in rejected:
    ok, reason = kit_test.check_single_select(b)
    assert not ok, b
print("OK")
`;
  const res = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

// ── astro phase 104 r3: statement boundaries over the T-SQL token stream ──
// The shared corpus's `single_select` table (byte-identical with astro's copy)
// pins the guard: T-SQL needs no ';' between statements, so `SELECT 1 COMMIT`
// must be rejected here exactly as the server rejects it.

test('check_single_select matches every row of the shared single_select table (phase 104 r3)', { skip: !hasPython }, () => {
  const corpus = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/source-spec-cases.json'), 'utf8'));
  assert.ok(Array.isArray(corpus.single_select) && corpus.single_select.length > 100);
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})
import kit_test
rows = json.loads(sys.stdin.read())
print(json.dumps([[r["sql"], kit_test.check_single_select(r["sql"])[0]] for r in rows if kit_test.check_single_select(r["sql"])[0] != r["ok"]]))
`;
  const res = spawnSync('python3', ['-c', script], { encoding: 'utf8', input: JSON.stringify(corpus.single_select) });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), [], 'rows whose offline verdict differs from the corpus');
});

test('tokenize_sql is lossless, nests block comments and flags a -- comment ending at a bare CR (phase 104 r3)', { skip: !hasPython }, () => {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})
import kit_test
sql = "SELECT N'a''b', [x]]y], \\"q\\"\\"r\\" /* a /* b */ c */ FROM t -- x\\r\\n"
toks = kit_test.tokenize_sql(sql)
assert "".join(t["text"] for t in toks) == sql
assert [(t["kind"], t["text"]) for t in toks if t["kind"] != "ws"] == [
    ("word", "SELECT"), ("string", "N'a''b'"), ("punct", ","), ("qident", "[x]]y]"), ("punct", ","),
    ("qident", '"q""r"'), ("comment", "/* a /* b */ c */"), ("word", "FROM"), ("word", "t"), ("comment", "-- x"),
], toks
bare = [t for t in kit_test.tokenize_sql("SELECT 1 --x\\rCOMMIT") if t["kind"] == "comment"][0]
crlf = [t for t in kit_test.tokenize_sql("SELECT 1 --x\\r\\nFROM t") if t["kind"] == "comment"][0]
assert bare["flag"] == "ambiguous" and crlf["flag"] == ""
for sql in ["SELECT 1 AS Value COMMIT", "SELECT 1 AS Value SET LOCK_TIMEOUT -1 SELECT a AS Value FROM t", "SELECT 1 AS Value BEGIN TRAN", "SELECT 1 AS Value SELECT 2 AS Value"]:
    ok, reason = kit_test.check_single_select(sql)
    assert not ok, sql
print("OK")
`;
  const res = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('tokenize_sql ends numeric literals where SQL Server does and flags an ambiguous end (phase 104 r4)', { skip: !hasPython }, () => {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})
import kit_test
def sig(sql):
    return [[t["kind"], t["text"], t["flag"]] for t in kit_test.tokenize_sql(sql) if t["kind"] != "ws"]
assert sig("SELECT 1eCOMMIT") == [["word", "SELECT", ""], ["number", "1e", "ambiguous"], ["word", "COMMIT", ""]], sig("SELECT 1eCOMMIT")
assert sig("SELECT .5eBEGIN") == [["word", "SELECT", ""], ["number", ".5e", "ambiguous"], ["word", "BEGIN", ""]]
assert sig("1E+ 1e-5 1. 1e") == [["number", "1E+", ""], ["number", "1e-5", ""], ["number", "1.", ""], ["number", "1e", ""]]
assert sig("1COMMIT") == [["number", "1", "ambiguous"], ["word", "COMMIT", ""]]
assert sig("1e--x")[0] == ["number", "1e-", "ambiguous"]
assert sig("0x 0xAB $1.50 $.5 $ \\u20ac5") == [
    ["number", "0x", ""], ["number", "0xAB", ""], ["number", "$1.50", ""], ["number", "$.5", ""], ["number", "$", ""], ["number", "\\u20ac5", ""],
]
assert sig("0xBEGIN") == [["number", "0xBE", "ambiguous"], ["word", "GIN", ""]]
assert sig("$COMMIT") == [["number", "$", "ambiguous"], ["word", "COMMIT", ""]]
ok, reason = kit_test.check_single_select("SELECT 1eCOMMIT")
assert not ok and "numeric literal" in reason, reason
print("OK")
`;
  const res = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

// ── End-to-end via kit_test.py CLI, mirroring the C11-C14 rejection matrix ─

test('the base query passes cleanly', { skip: !hasPython }, () => {
  const dir = scratchKit(BASE_QUERY);
  const res = runKitTest(dir);
  assert.equal(res.status, 0, res.out);
  rmSync(dir, { recursive: true, force: true });
});

test('SRC-11: @returns missing', { skip: !hasPython }, () => {
  const dir = scratchKit(BASE_QUERY.replace('-- @returns OrderId int, Total decimal(18,2)\n', ''));
  assertCheck(runKitTest(dir), 'SRC-11');
  rmSync(dir, { recursive: true, force: true });
});

test('SRC-10: @param without required|optional', { skip: !hasPython }, () => {
  const dir = scratchKit(BASE_QUERY.replace('@param CustomerId int required', '@param CustomerId int'));
  assertCheck(runKitTest(dir), 'SRC-10');
  rmSync(dir, { recursive: true, force: true });
});

test('SRC-08: @name pattern violation (OpenOrders.sql)', { skip: !hasPython }, () => {
  const dir = scratchKit(BASE_QUERY.replace('@name open_orders', '@name OpenOrders'), { fileName: 'OpenOrders.sql' });
  assertCheck(runKitTest(dir), 'SRC-08');
  rmSync(dir, { recursive: true, force: true });
});

test('SRC-13: body is not a single SELECT', { skip: !hasPython }, () => {
  const dir = scratchKit(
    BASE_QUERY.replace(
      'SELECT OrderId, Total FROM dbo.Orders WHERE CustomerId = @CustomerId\n',
      'UPDATE dbo.Orders SET Total = 0 WHERE CustomerId = @CustomerId\n',
    ),
  );
  assertCheck(runKitTest(dir), 'SRC-13');
  rmSync(dir, { recursive: true, force: true });
});

for (const [label, body] of [
  ['WITH (NOLOCK)', 'SELECT OrderId, Total FROM dbo.Orders WITH (NOLOCK) WHERE CustomerId = @CustomerId\n'],
  ['legacy (NOLOCK)', 'SELECT OrderId, Total FROM dbo.Orders (nolock) WHERE CustomerId = @CustomerId\n'],
  ['READUNCOMMITTED', 'SELECT OrderId, Total FROM dbo.Orders WITH (READUNCOMMITTED) WHERE CustomerId = @CustomerId\n'],
  ['READPAST', 'SELECT OrderId, Total FROM dbo.Orders WITH (READPAST) WHERE CustomerId = @CustomerId\n'],
  ['SET TRANSACTION ISOLATION LEVEL SNAPSHOT', 'SELECT OrderId, Total FROM dbo.Orders WHERE CustomerId = @CustomerId SET TRANSACTION ISOLATION LEVEL SNAPSHOT\n'],
]) {
  test(`SRC-15: body carries a locking/isolation hint (${label}) (phase 104 r2)`, { skip: !hasPython }, () => {
    const dir = scratchKit(BASE_QUERY.replace('SELECT OrderId, Total FROM dbo.Orders WHERE CustomerId = @CustomerId\n', body));
    assertCheck(runKitTest(dir), 'SRC-15');
    rmSync(dir, { recursive: true, force: true });
  });
}

test('SRC-15: a hint only inside a comment or string literal passes (phase 104 r2)', { skip: !hasPython }, () => {
  const dir = scratchKit(
    BASE_QUERY.replace(
      'SELECT OrderId, Total FROM dbo.Orders WHERE CustomerId = @CustomerId\n',
      "-- never WITH (NOLOCK)\nSELECT OrderId, Total FROM dbo.Orders WHERE CustomerId = @CustomerId AND 'NOLOCK' <> '' /* READ UNCOMMITTED */\n",
    ),
  );
  const res = runKitTest(dir);
  assert.equal(res.status, 0, res.out);
  rmSync(dir, { recursive: true, force: true });
});

test('SRC-12: bad @max_rows', { skip: !hasPython }, () => {
  const dir = scratchKit(BASE_QUERY.replace('-- @returns', '-- @max_rows 0\n-- @returns'));
  assertCheck(runKitTest(dir), 'SRC-12');
  rmSync(dir, { recursive: true, force: true });
});

test('SRC-09: an undeclared @Other referenced in the body', { skip: !hasPython }, () => {
  const dir = scratchKit(BASE_QUERY.replace('WHERE CustomerId = @CustomerId', 'WHERE CustomerId = @CustomerId AND Region = @Other'));
  assertCheck(runKitTest(dir), 'SRC-09');
  rmSync(dir, { recursive: true, force: true });
});

test('accepted: optional params with defaults, no queries error', { skip: !hasPython }, () => {
  const dir = scratchKit(`-- @name open_orders
-- @description Open orders for a customer
-- @param CustomerId int required
-- @param Status nvarchar(20) optional default=Open
-- @param Limit int optional default=100
-- @param Since date optional default=2026-01-01
-- @returns OrderId int, Total decimal(18,2)
SELECT OrderId, Total FROM dbo.Orders
WHERE CustomerId = @CustomerId AND Status = @Status AND Since <= @Since AND 1 <= @Limit
`);
  const res = runKitTest(dir);
  assert.equal(res.status, 0, res.out);
  rmSync(dir, { recursive: true, force: true });
});

// ── Phase 102 r1 (C12): bigint defaults are range-checked with exact ints ──

test('parse_default_literal range-checks bigint exactly', { skip: !hasPython }, () => {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})
import kit_test
assert kit_test.parse_default_literal('bigint', '9223372036854775807')[0]
assert kit_test.parse_default_literal('bigint', '-9223372036854775808')[0]
assert not kit_test.parse_default_literal('bigint', '9223372036854775808')[0]
assert not kit_test.parse_default_literal('bigint', '-9223372036854775809')[0]
assert kit_test.parse_default_literal('int', '2147483647')[0]
assert not kit_test.parse_default_literal('int', '2147483648')[0]
print("OK")
`;
  const res = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

// r4 (C5): the one text semantics, mirrored from astro's source-text.ts —
// whitespace is exactly [ \t\n\r\f\v] + U+FEFF, lines split on "\n" only with
// one trailing "\r" dropped, lengths in UTF-16 code units. Cross-language
// agreement on whole kits is pinned by the "C5 r4" corpus cases.
test('text semantics primitives match source-text.ts', { skip: !hasPython }, () => {
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})
import kit_test as k
out = {
  "blank_ws": k._is_blank(" \\t\\n\\r\\f\\v\\ufeff"),
  "content": [k._is_blank(c) for c in ["\\u00a0", "\\u0085", "\\u2028", "\\u2029", "\\u3000", "\\x1c", "\\x1d", "\\x1e", "\\x1f"]],
  "trim": k._trim_ws("\\ufeff a\\u00a0\\t"),
  "lines": k._split_lines("a\\r\\nb\\u2028c\\rd\\n\\x85e\\r\\r\\n"),
  "utf16": k._utf16_len("\\U0001F600\\U0001F600"),
}
print(json.dumps(out))
`;
  const res = spawnSync('python3', ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.blank_ws, true);
  assert.deepEqual(out.content, Array(9).fill(false));
  assert.equal(out.trim, 'a ');
  assert.deepEqual(out.lines, ['a', 'b c\rd', '\x85e\r', '']);
  assert.equal(out.utf16, 4);
});

// r5 (C12): every type's default is range-checked against SQL Server's
// documented limits. Same table as astro's sql-types.test.ts — the shared
// corpus's `default_literals` (byte-identical in both repos).
test('parse_default_literal applies SQL Server ranges (shared default_literals table)', { skip: !hasPython }, () => {
  const corpus = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/source-spec-cases.json'), 'utf8'));
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})
import kit_test
cases = json.loads(sys.stdin.read())
print(json.dumps([kit_test.parse_default_literal(c["type"], c["literal"])[0] for c in cases]))
`;
  const res = spawnSync('python3', ['-c', script], { encoding: 'utf8', input: JSON.stringify(corpus.default_literals) });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const verdicts = JSON.parse(res.stdout);
  const wrong = corpus.default_literals
    .map((c, i) => ({ ...c, got: verdicts[i] }))
    .filter((c) => c.got !== c.ok)
    .map((c) => `${c.type} default=${c.literal.slice(0, 40)} expected ok=${c.ok} got ${c.got}${c.note ? ` (${c.note})` : ''}`);
  assert.deepEqual(wrong, []);
});
