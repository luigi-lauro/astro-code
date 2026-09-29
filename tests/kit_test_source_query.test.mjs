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
    join(srcDir, 'schema.yaml'),
    'version: 1\ntables:\n  dbo.Orders:\n    purpose: x\n    columns:\n      OrderId:\n        meaning: y\n',
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
