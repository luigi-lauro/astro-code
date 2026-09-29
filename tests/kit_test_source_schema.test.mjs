// Phase 102 — kit_test.py schema.json checks (SRC-05..07). Mirrors astro's
// tests/kits/source-schema.test.ts. r2 (ADR-016): the per-source schema file
// is plain JSON read with json.loads — one leading BOM stripped, duplicate
// keys rejected (object_pairs_hook) and named, NaN/Infinity rejected — and
// none of it depends on PyYAML: every case runs twice, once normally and once
// with a PYTHONPATH shim that makes `import yaml` raise ImportError.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KIT_SRC = join(ROOT, 'examples/kit-convert-demo/commit-digest');
const TOOLS_DIR = join(ROOT, 'templates/kit/tools');
const TOOL_SRC = join(TOOLS_DIR, 'kit_test.py');
const hasPython = spawnSync('python3', ['--version']).status === 0;

/** A PYTHONPATH dir whose `yaml` package raises ImportError on import. */
const NO_PYYAML_SHIM = mkdtempSync(join(tmpdir(), 'ac-no-pyyaml-'));
mkdirSync(join(NO_PYYAML_SHIM, 'yaml'));
writeFileSync(join(NO_PYYAML_SHIM, 'yaml', '__init__.py'), 'raise ImportError("PyYAML disabled for this test")\n');
const NO_PYYAML_ENV = { PYTHONPATH: [NO_PYYAML_SHIM, process.env.PYTHONPATH].filter(Boolean).join(':') };

function scratchKit(schemaJson, { fileName = 'schema.json' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-kittest-src-'));
  cpSync(KIT_SRC, dir, { recursive: true });
  cpSync(TOOL_SRC, join(dir, 'tools/kit_test.py'));

  const kitJsonPath = join(dir, 'kit.json');
  const manifest = JSON.parse(readFileSync(kitJsonPath, 'utf8'));
  manifest.contract_version = '^1.1.0';
  manifest.sources = [{ id: 'erp', engine: 'sqlserver', access: 'read_only', description: 'ERP' }];
  writeFileSync(kitJsonPath, JSON.stringify(manifest, null, 2));

  const srcDir = join(dir, 'src/sources/erp');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'SOURCE.md'), '# ERP\n\nThe ERP database.\n');
  if (schemaJson !== null) writeFileSync(join(srcDir, fileName), schemaJson);
  return dir;
}

function runKitTest(kitDir, env = {}) {
  const res = spawnSync('python3', ['tools/kit_test.py', '--json', '--skip-parity'], {
    cwd: kitDir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  let report = null;
  try { report = JSON.parse(res.stdout); } catch { /* fall through */ }
  return { status: res.status, out: `${res.stdout || ''}${res.stderr || ''}`, report };
}

const VALID = {
  version: 1,
  tables: {
    'dbo.Orders': {
      purpose: 'Order header records',
      kind: 'table',
      rows: '~2M',
      columns: {
        OrderId: { meaning: 'Primary key', type: 'int', key: true },
        Total: { meaning: 'Order total', type: 'decimal(18,2)' },
      },
    },
  },
};
const VALID_JSON = JSON.stringify(VALID, null, 2);
const withTable = (table) => JSON.stringify({ version: 1, tables: { 'dbo.Orders': table } });

const SRC06_CASES = [
  ['empty file', ''],
  ['truncated JSON', VALID_JSON.slice(0, 40)],
  ['trailing comma', '{"version": 1, "tables": {},}'],
  ['// comment', '{\n  // v\n  "version": 1,\n  "tables": {}\n}'],
  ['/* */ comment', '{ /* v */ "version": 1, "tables": {} }'],
  ['single quotes', "{'version': 1, 'tables': {}}"],
  ['NaN', '{"version": 1, "tables": {"dbo.T": {"purpose": "x", "rows": NaN}}}'],
  ['Infinity', '{"version": 1, "tables": {"dbo.T": {"purpose": "x", "rows": Infinity}}}'],
  ['1e400', '{"version": 1, "tables": {"dbo.T": {"purpose": "x", "rows": 1e400}}}'],
  ['YAML content', 'version: 1\ntables: {}\n'],
  ['two BOMs', `\uFEFF\uFEFF${VALID_JSON}`],
  ['top-level array', '[]'],
  ['missing version', JSON.stringify({ tables: {} })],
  ['version true', JSON.stringify({ version: true, tables: {} })],
  ['table without purpose', withTable({ columns: { A: { meaning: 'y' } } })],
  ['purpose 5', withTable({ purpose: 5 })],
  ['purpose null', withTable({ purpose: null })],
  ['meaning ["x"]', withTable({ purpose: 'x', columns: { A: { meaning: ['x'] } } })],
  ['meaning true', withTable({ purpose: 'x', columns: { A: { meaning: true } } })],
  ['column without meaning', withTable({ purpose: 'x', columns: { A: { type: 'int' } } })],
  ['unknown key (meanin)', withTable({ purpose: 'x', columns: { A: { meanin: 'y' } } })],
  ['grain a number', withTable({ purpose: 'x', grain: 1 })],
  ['columns null', withTable({ purpose: 'x', columns: null })],
  ['unqualified table key', JSON.stringify({ version: 1, tables: { v_OpenOrders: { purpose: 'x' } } })],
  ['table key with a trailing newline', JSON.stringify({ version: 1, tables: { 'dbo.Orders\n': { purpose: 'x' } } })],
];

const DUPLICATE_CASES = [
  ['version twice, invalid first', '{"version": 2, "version": 1, "tables": {}}', 'version'],
  ['table key twice', '{"version": 1, "tables": {"dbo.O": {"purpose": "a"}, "dbo.O": {"purpose": "b"}}}', 'dbo.O'],
  ['column twice', '{"version": 1, "tables": {"dbo.O": {"purpose": "a", "columns": {"Id": {"meaning": "x"}, "Id": {"meaning": "y"}}}}}', 'Id'],
  ['meaning twice', '{"version": 1, "tables": {"dbo.O": {"purpose": "a", "columns": {"Id": {"meaning": "x", "meaning": "y"}}}}}', 'meaning'],
];

for (const [envLabel, env] of [['PyYAML as installed', {}], ['PyYAML unimportable', NO_PYYAML_ENV]]) {
  test(`a valid schema.json passes cleanly, with or without a leading BOM (${envLabel})`, { skip: !hasPython }, () => {
    for (const text of [VALID_JSON, `\uFEFF${VALID_JSON}`]) {
      const dir = scratchKit(text);
      const res = runKitTest(dir, env);
      assert.equal(res.status, 0, res.out);
      assert.ok(!/skip|degrad/i.test(res.report.results.filter((r) => r.group === 'sources').map((r) => r.message).join('\n')));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`missing schema.json is SRC-05 (${envLabel})`, { skip: !hasPython }, () => {
    const dir = scratchKit(null);
    const res = runKitTest(dir, env);
    assert.equal(res.status, 1);
    const row = res.report.results.find((r) => r.id === 'SRC-05');
    assert.ok(row, res.out);
    assert.equal(row.status, 'FAIL');
    assert.match(row.message, /schema\.json missing/);
    rmSync(dir, { recursive: true, force: true });
  });

  test(`a schema.yaml shipped instead of schema.json is SRC-05 (${envLabel})`, { skip: !hasPython }, () => {
    const yaml = 'version: 1\ntables:\n  dbo.Orders:\n    purpose: x\n    columns:\n      A:\n        meaning: y\n';
    const dir = scratchKit(yaml, { fileName: 'schema.yaml' });
    const res = runKitTest(dir, env);
    assert.equal(res.status, 1, res.out);
    assert.ok(res.report.results.find((r) => r.id === 'SRC-05'), res.out);
    rmSync(dir, { recursive: true, force: true });
  });

  for (const [label, text] of SRC06_CASES) {
    test(`SRC-06: ${label} (${envLabel})`, { skip: !hasPython }, () => {
      const dir = scratchKit(text);
      const res = runKitTest(dir, env);
      assert.equal(res.status, 1, res.out);
      assert.ok(!/Traceback/.test(res.out), res.out);
      const row = res.report.results.find((r) => r.id === 'SRC-06');
      assert.ok(row, res.out);
      assert.match(row.message, /schema\.json/);
      rmSync(dir, { recursive: true, force: true });
    });
  }

  for (const [label, text, key] of DUPLICATE_CASES) {
    test(`SRC-06 names the duplicated key: ${label} (${envLabel})`, { skip: !hasPython }, () => {
      const dir = scratchKit(text);
      const res = runKitTest(dir, env);
      assert.equal(res.status, 1, res.out);
      const row = res.report.results.find((r) => r.id === 'SRC-06');
      assert.ok(row, res.out);
      assert.ok(row.message.includes(`duplicate key ${JSON.stringify(key)}`), row.message);
      rmSync(dir, { recursive: true, force: true });
    });
  }

  test(`invalid UTF-8 in schema.json is SRC-06, not a traceback (${envLabel})`, { skip: !hasPython }, () => {
    const dir = scratchKit(null);
    writeFileSync(join(dir, 'src/sources/erp/schema.json'), Buffer.from([0x7b, 0xff, 0x7d]));
    const res = runKitTest(dir, env);
    assert.equal(res.status, 1, res.out);
    assert.ok(!/Traceback/.test(res.out), res.out);
    assert.ok(res.report.results.find((r) => r.id === 'SRC-06'), res.out);
    rmSync(dir, { recursive: true, force: true });
  });

  test(`SRC-07 is a WARN row with exit 0 (${envLabel})`, { skip: !hasPython }, () => {
    const dir = scratchKit(withTable({ purpose: 'x', columns: { A: { meaning: 'y', joins: 'dbo.Unknown.Id' } } }));
    const res = runKitTest(dir, env);
    assert.equal(res.status, 0, res.out);
    const row = res.report.results.find((r) => r.id === 'SRC-07');
    assert.ok(row, res.out);
    assert.equal(row.status, 'WARN');
    assert.match(row.message, /dbo\.Unknown/);
    rmSync(dir, { recursive: true, force: true });
  });
}

test('the untouched demo kit (no sources) still passes', { skip: !hasPython }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-kittest-nosrc-'));
  cpSync(KIT_SRC, dir, { recursive: true });
  cpSync(TOOL_SRC, join(dir, 'tools/kit_test.py'));
  const res = runKitTest(dir);
  assert.equal(res.status, 0, res.out);
  rmSync(dir, { recursive: true, force: true });
});

test('the walker field sets match the shared JSON Schema exactly', { skip: !hasPython }, () => {
  const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})
import kit_test
schema = json.load(open(${JSON.stringify(join(TOOLS_DIR, 'schemas/source-schema.v1.schema.json'))}))
assert set(schema['properties']) == {'version', 'tables'}, schema['properties']
assert set(schema['$defs']['Table']['properties']) == kit_test._TABLE_FIELDS
assert set(schema['$defs']['Column']['properties']) == kit_test._COLUMN_FIELDS
print("OK")
`;
  const res = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('the sources schema.json path never imports yaml', { skip: !hasPython }, () => {
  // With a yaml module that is importable but explodes on any use, loading
  // schema.json still works: the sources checks never touch PyYAML.
  const shim = mkdtempSync(join(tmpdir(), 'ac-yaml-bomb-'));
  mkdirSync(join(shim, 'yaml'));
  writeFileSync(join(shim, 'yaml', '__init__.py'), 'def __getattr__(name):\n    raise RuntimeError("yaml used: " + name)\n');
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})
import kit_test
data = kit_test.load_source_schema_json(${JSON.stringify(`\uFEFF${VALID_JSON}`)}.encode("utf-8"))
errors, warnings = kit_test.validate_source_schema(data, "erp")
assert errors == [] and warnings == [], (errors, warnings)
print("OK")
`;
  const res = spawnSync('python3', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: shim },
  });
  rmSync(shim, { recursive: true, force: true });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('the r1 YAML schema reader and duplicate-key loader are gone', { skip: !hasPython }, () => {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})
import kit_test
for name in ('parse_yaml_min_nested', 'load_source_schema_yaml', '_UniqueKeySafeLoader', '_yaml_min_flow'):
    assert not hasattr(kit_test, name), name
print("OK")
`;
  const res = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('KIT-CONTRACT.md: the documented schema.json example passes, and the Data sources section has no YAML', { skip: !hasPython }, () => {
  const doc = readFileSync(join(ROOT, 'templates/kit/KIT-CONTRACT.md'), 'utf8');
  const start = doc.indexOf('## Data sources');
  const end = doc.indexOf('\n## ', start + 1);
  assert.ok(start >= 0 && end > start, 'Data sources section present');
  const section = doc.slice(start, end);
  assert.doesNotMatch(section, /schema\.ya?ml|yaml/i, 'the sources docs must not describe a YAML schema file');
  for (const rule of [/no\s+comments/i, /no\s+trailing\s+commas/i, /duplicate\s+keys\s+are\s+rejected/i, /non-empty\s+strings/i]) {
    assert.match(section, rule);
  }
  const m = /### `schema\.json` shape[\s\S]*?```json\n([\s\S]*?)```/.exec(section);
  assert.ok(m, 'schema.json example block present');
  for (const env of [{}, NO_PYYAML_ENV]) {
    const dir = scratchKit(m[1]);
    const res = runKitTest(dir, env);
    assert.equal(res.status, 0, res.out);
    rmSync(dir, { recursive: true, force: true });
  }
});

after(() => rmSync(NO_PYYAML_SHIM, { recursive: true, force: true }));
