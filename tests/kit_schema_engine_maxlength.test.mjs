// Phase 102 (a1) — maxLength in the offline schema engine (_schema_engine.py).
// Spawns python3 against a tiny inline schema so this stays independent of
// any real kit-manifest schema change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = join(ROOT, 'templates/kit/tools');
const hasPython = spawnSync('python3', ['--version']).status === 0;

function runMaxLength(value) {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})
import _schema_engine as se
schema = {"type": "string", "maxLength": 500}
errors = se.validate(schema, ${JSON.stringify(value)})
for e in errors:
    print(f"{e.path}|{e.rule}|{e.reason}")
sys.exit(1 if errors else 0)
`;
  return spawnSync('python3', ['-c', script], { encoding: 'utf8' });
}

test('500 code points passes', { skip: !hasPython }, () => {
  const res = runMaxLength('x'.repeat(500));
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('501 code points fails with a path-precise error', { skip: !hasPython }, () => {
  const res = runMaxLength('x'.repeat(501));
  assert.equal(res.status, 1);
  assert.match(res.stdout, /\|maxLength\|/);
  assert.match(res.stdout, /501/);
});

test('length is counted in code points, not UTF-16 units', { skip: !hasPython }, () => {
  // U+1F600 (grinning face) is one code point but two UTF-16 units in JS;
  // Python's len() on str counts code points, so 500 of them must pass.
  const res500 = runMaxLength('\u{1F600}'.repeat(500));
  assert.equal(res500.status, 0, res500.stdout + res500.stderr);
  const res501 = runMaxLength('\u{1F600}'.repeat(501));
  assert.equal(res501.status, 1);
  assert.match(res501.stdout, /501/);
});

test('other unknown keywords still raise NotImplementedError', { skip: !hasPython }, () => {
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})
import _schema_engine as se
try:
    se.validate({"type": "string", "notARealKeyword": True}, "x")
    sys.exit(1)
except NotImplementedError:
    sys.exit(0)
`;
  const res = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});
