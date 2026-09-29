// Phase 102 (a2) — sources[] in the offline manifest schema + validate_manifest.py
// (SRC-01..03). Mirrors astro's tests/kits/source-manifest.test.ts (t2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = join(ROOT, 'templates/kit/tools/validate_manifest.py');
const DEMO = JSON.parse(readFileSync(join(ROOT, 'examples/kit-convert-demo/commit-digest/kit.json'), 'utf8'));
const hasPython = spawnSync('python3', ['--version']).status === 0;

function validSource(overrides = {}) {
  return { id: 'erp', engine: 'sqlserver', access: 'read_only', description: 'ERP', ...overrides };
}

function validate(patch) {
  const m = structuredClone(DEMO);
  Object.assign(m, patch);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete m[k];
  }
  const file = join(mkdtempSync(join(tmpdir(), 'ac-vm-src-')), 'kit.json');
  writeFileSync(file, JSON.stringify(m, null, 2));
  return spawnSync('python3', [VALIDATOR, file], { encoding: 'utf8' });
}

test('a valid sources entry passes, including adhoc:false', { skip: !hasPython }, () => {
  const res1 = validate({ contract_version: '^1.1.0', sources: [validSource()] });
  assert.equal(res1.status, 0, res1.stderr);
  const res2 = validate({ contract_version: '^1.1.0', sources: [validSource({ adhoc: false })] });
  assert.equal(res2.status, 0, res2.stderr);
});

test('sources: [] and omitted sources pass with ^1.0.0', { skip: !hasPython }, () => {
  const res1 = validate({ contract_version: '^1.0.0', sources: [] });
  assert.equal(res1.status, 0, res1.stderr);
  const res2 = validate({ contract_version: '^1.0.0' });
  assert.equal(res2.status, 0, res2.stderr);
});

test('manifest_version stays 4', { skip: !hasPython }, () => {
  assert.equal(DEMO.manifest_version, 4);
});

const c1aCases = [
  ['id uppercase', { id: 'Erp' }],
  ['id leading digit', { id: '1erp' }],
  ['id too long', { id: 'e'.repeat(33) }],
  ['engine not sqlserver', { engine: 'postgres' }],
  ['access not read_only', { access: 'read_write' }],
  ['description empty', { description: '' }],
  ['description too long', { description: 'x'.repeat(501) }],
  ['unknown key', { unknown: 'nope' }],
  ['adhoc string', { adhoc: 'no' }],
  ['adhoc number', { adhoc: 0 }],
];
for (const [label, patch] of c1aCases) {
  test(`invalid sources entry exits 1 with SRC-01: ${label}`, { skip: !hasPython }, () => {
    const res = validate({ contract_version: '^1.1.0', sources: [validSource(patch)] });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /SRC-01/);
    assert.match(res.stderr, /sources\[0\]/);
  });
}

test('duplicate source id exits 1 with SRC-02', { skip: !hasPython }, () => {
  const res = validate({
    contract_version: '^1.1.0',
    sources: [validSource(), validSource({ description: 'ERP again' })],
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /SRC-02/);
});

for (const cv of ['1.0.0', null, '^1.0.0']) {
  test(`contract_version=${cv} with non-empty sources exits 1 with SRC-03`, { skip: !hasPython }, () => {
    const patch = { sources: [validSource()], contract_version: cv };
    const res = validate(patch);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /SRC-03/);
    assert.match(res.stderr, /declare contract_version \^1\.1\.0/);
  });
}
