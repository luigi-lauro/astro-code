// Phase 102 (a3) — kit_test.py schema.yaml checks (SRC-05..07) with a
// PyYAML-optional parser. Mirrors astro's tests/kits/source-schema.test.ts (t3).
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
const hasPython = spawnSync('python3', ['--version']).status === 0;
const hasYaml = hasPython && spawnSync('python3', ['-c', 'import yaml']).status === 0;

function scratchKit(schemaYaml) {
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
  if (schemaYaml !== null) writeFileSync(join(srcDir, 'schema.yaml'), schemaYaml);
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

const VALID_YAML = `version: 1
tables:
  dbo.Orders:
    purpose: Order header records
    kind: table
    rows: "~2M"
    columns:
      OrderId:
        meaning: Primary key
        type: int
        key: true
      Total:
        meaning: Order total
        type: decimal(18,2)
`;

for (const noPyyaml of [false, true]) {
  const envLabel = noPyyaml ? 'KIT_TEST_NO_PYYAML=1' : 'PyYAML';
  const env = noPyyaml ? { KIT_TEST_NO_PYYAML: '1' } : {};

  test(`a valid schema.yaml passes cleanly (${envLabel})`, { skip: !hasPython }, () => {
    const dir = scratchKit(VALID_YAML);
    const res = runKitTest(dir, env);
    assert.equal(res.status, 0, res.out);
    rmSync(dir, { recursive: true, force: true });
  });

  test(`missing schema.yaml is SRC-05 (${envLabel})`, { skip: !hasPython }, () => {
    const dir = scratchKit(null);
    const res = runKitTest(dir, env);
    assert.equal(res.status, 1);
    const row = res.report.results.find((r) => r.id === 'SRC-05');
    assert.ok(row, res.out);
    assert.equal(row.status, 'FAIL');
    rmSync(dir, { recursive: true, force: true });
  });

  const src06Cases = [
    ['unparseable YAML', 'version: 1\n  tables: [broken'],
    ['missing version', 'tables:\n  dbo.Orders:\n    purpose: x\n    columns:\n      A:\n        meaning: y\n'],
    [
      'table without purpose',
      'version: 1\ntables:\n  dbo.Orders:\n    columns:\n      A:\n        meaning: y\n',
    ],
    [
      'column without meaning',
      'version: 1\ntables:\n  dbo.Orders:\n    purpose: x\n    columns:\n      A:\n        type: int\n',
    ],
    [
      'unknown key (meanin)',
      'version: 1\ntables:\n  dbo.Orders:\n    purpose: x\n    columns:\n      A:\n        meanin: y\n',
    ],
    [
      'unqualified table key',
      'version: 1\ntables:\n  v_OpenOrders:\n    purpose: x\n    columns:\n      A:\n        meaning: y\n',
    ],
  ];
  for (const [label, yaml] of src06Cases) {
    test(`SRC-06: ${label} (${envLabel})`, { skip: !hasPython }, () => {
      const dir = scratchKit(yaml);
      const res = runKitTest(dir, env);
      assert.equal(res.status, 1, res.out);
      const row = res.report.results.find((r) => r.id === 'SRC-06');
      assert.ok(row, res.out);
      rmSync(dir, { recursive: true, force: true });
    });
  }

  test(`SRC-07 is a WARN row with exit 0 (${envLabel})`, { skip: !hasPython }, () => {
    const yaml = `version: 1
tables:
  dbo.Orders:
    purpose: x
    columns:
      A:
        meaning: y
        joins: dbo.Unknown.Id
`;
    const dir = scratchKit(yaml);
    const res = runKitTest(dir, env);
    assert.equal(res.status, 0, res.out);
    const row = res.report.results.find((r) => r.id === 'SRC-07');
    assert.ok(row, res.out);
    assert.equal(row.status, 'WARN');
    rmSync(dir, { recursive: true, force: true });
  });
}

test('the fallback parser agrees with PyYAML on the valid fixture', { skip: !hasYaml }, () => {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'templates/kit/tools'))})
import kit_test
text = ${JSON.stringify(VALID_YAML)}
builtin = kit_test.parse_yaml_min_nested(text)
import yaml
pyyaml = yaml.safe_load(text)
assert builtin == pyyaml, (builtin, pyyaml)
print("OK")
`;
  const res = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('the untouched demo kit (no sources) still passes', { skip: !hasPython }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-kittest-nosrc-'));
  cpSync(KIT_SRC, dir, { recursive: true });
  cpSync(TOOL_SRC, join(dir, 'tools/kit_test.py'));
  const res = runKitTest(dir);
  assert.equal(res.status, 0, res.out);
  rmSync(dir, { recursive: true, force: true });
});

// ── Phase 102 r1 (C4/C5): the fallback parser covers the YAML forms PyYAML
// and astro's `yaml` accept, and both offline parsers reject duplicate keys.

const R1_FORMS = [
  ['folded block scalar', 'a:\n  purpose: >\n    Order header\n    records, one per order\n\n    second para\n  next: x\n'],
  ['literal block scalar', 'a:\n  purpose: |\n    line one\n      indented # not a comment\n    line three\n'],
  ['chomping strip/keep', 'a: |-\n  stripped\nb: >+\n  kept\n\nc: >-\n  x\n'],
  ['block scalar in a list', 'rules:\n  - >-\n    Totals exclude\n    cancelled lines\n  - plain\n'],
  ['empty flow collections', 'tables: {}\nrules: []\n'],
  ['flow mapping', "col: {meaning: Primary key, type: int, key: true}\nvalues: {O: Open, C: 'Closed, final', D: \"it''s\"}\n"],
  ['flow sequence', 'rules: [a, "b, c", \'d\', 12, true]\nnested: {x: [1, 2], y: {z: w}}\n'],
];

test('the fallback parser agrees with PyYAML on the r1 YAML forms', { skip: !hasYaml }, () => {
  const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'templates/kit/tools'))})
import kit_test, yaml
for label, text in json.loads(${JSON.stringify(JSON.stringify(R1_FORMS))}):
    builtin = kit_test.parse_yaml_min_nested(text)
    pyyaml = yaml.safe_load(text)
    assert builtin == pyyaml, (label, builtin, pyyaml)
print("OK")
`;
  const res = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('the fallback parser reads the r1 YAML forms (no PyYAML needed)', { skip: !hasPython }, () => {
  const script = `
import sys, json
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'templates/kit/tools'))})
import kit_test
forms = dict(json.loads(${JSON.stringify(JSON.stringify(R1_FORMS))}))
p = kit_test.parse_yaml_min_nested
assert p(forms['folded block scalar'])['a'] == {'purpose': 'Order header records, one per order\\nsecond para\\n', 'next': 'x'}
assert p(forms['literal block scalar'])['a']['purpose'] == 'line one\\n  indented # not a comment\\nline three\\n'
assert p(forms['chomping strip/keep']) == {'a': 'stripped', 'b': 'kept\\n\\n', 'c': 'x'}
assert p(forms['block scalar in a list']) == {'rules': ['Totals exclude cancelled lines', 'plain']}
assert p(forms['empty flow collections']) == {'tables': {}, 'rules': []}
assert p(forms['flow mapping'])['values'] == {'O': 'Open', 'C': 'Closed, final', 'D': "it''s"}
assert p(forms['flow sequence'])['rules'] == ['a', 'b, c', 'd', 12, True]
assert p('\\ufeffversion: 1\\n') == {'version': 1}
print("OK")
`;
  const res = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

for (const noPyyaml of [false, true]) {
  const label = noPyyaml ? 'builtin' : 'PyYAML';
  test(`load_source_schema_yaml rejects duplicate keys (${label})`, { skip: !hasPython || (!noPyyaml && !hasYaml) }, () => {
    const script = `
import sys
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'templates/kit/tools'))})
import kit_test
if ${noPyyaml ? 'True' : 'False'}:
    kit_test._pyyaml = None
for text in ['a: 1\\na: 2\\n', 'a:\\n  b: 1\\n  b: 2\\n', 'a: {b: 1, b: 2}\\n']:
    try:
        kit_test.load_source_schema_yaml(text)
    except Exception as exc:
        assert 'duplicate' in str(exc).lower(), (text, exc)
    else:
        raise AssertionError('accepted duplicate key: ' + repr(text))
print("OK")
`;
    const res = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
  });
}
