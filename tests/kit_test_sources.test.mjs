// Phase 102 (a5) — kit_test.py SOURCE.md/adhoc checks (SRC-04/14) and the
// full source-spec-cases.json corpus matrix (t1), run through both
// validate_manifest.py (SRC-01..03) and kit_test.py (SRC-04..14). Mirrors
// astro's astroport upload-route corpus test (t8).
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
const hasPython = spawnSync('python3', ['--version']).status === 0;

const CORPUS = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/source-spec-cases.json'), 'utf8'));

function applyMergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const result = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = applyMergePatch(result[key], value);
  }
  return result;
}

/** Builds a scratch kit for one corpus case: fresh template tools/ copy,
 * the corpus's own (merge-patched) manifest as kit.json, and its files
 * written under the authored src/sources/<id>/ tree. */
function scratchKitForCase(c) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-kittest-corpus-'));
  cpSync(KIT_SRC, dir, { recursive: true });
  cpSync(join(TOOLS_DIR, 'kit_test.py'), join(dir, 'tools/kit_test.py'));
  cpSync(join(TOOLS_DIR, 'validate_manifest.py'), join(dir, 'tools/validate_manifest.py'));
  cpSync(join(TOOLS_DIR, '_schema_engine.py'), join(dir, 'tools/_schema_engine.py'));
  mkdirSync(join(dir, 'tools/schemas'), { recursive: true });
  for (const f of ['kit-manifest.v4.schema.json', 'kit-manifest.v3.schema.json', 'sqlserver-types.v1.json', 'source-schema.v1.schema.json']) {
    cpSync(join(TOOLS_DIR, 'schemas', f), join(dir, 'tools/schemas', f));
  }

  const manifest = applyMergePatch(structuredClone(CORPUS.base.manifest), c.manifest ?? {});
  manifest.manifest_version = 4;
  writeFileSync(join(dir, 'kit.json'), JSON.stringify(manifest, null, 2));

  const filesMap = { ...CORPUS.base.files, ...(c.files ?? {}) };
  for (const [relPath, content] of Object.entries(filesMap)) {
    const abs = join(dir, relPath);
    if (content === null) {
      try { rmSync(abs, { force: true }); } catch { /* ignore */ }
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function runValidateManifest(dir, env = {}) {
  const res = spawnSync('python3', ['tools/validate_manifest.py', 'kit.json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

function runKitTest(dir, env = {}) {
  const res = spawnSync('python3', ['tools/kit_test.py', '--json', '--skip-parity'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  let report = null;
  try { report = JSON.parse(res.stdout); } catch { /* ignore */ }
  return { status: res.status, out: `${res.stdout || ''}${res.stderr || ''}`, report };
}

function hasTraceback(out) {
  return /Traceback \(most recent call last\)/.test(out);
}

// r2 (ADR-016, C4): the sources checks do not depend on PyYAML. The second
// run makes `import yaml` raise ImportError via a PYTHONPATH shim; verdicts
// and every sources row must be identical to the normal run.
const NO_PYYAML_SHIM = mkdtempSync(join(tmpdir(), 'ac-no-pyyaml-'));
mkdirSync(join(NO_PYYAML_SHIM, 'yaml'));
writeFileSync(join(NO_PYYAML_SHIM, 'yaml', '__init__.py'), 'raise ImportError("PyYAML disabled for this test")\n');
const NO_PYYAML_ENV = { PYTHONPATH: [NO_PYYAML_SHIM, process.env.PYTHONPATH].filter(Boolean).join(':') };
after(() => rmSync(NO_PYYAML_SHIM, { recursive: true, force: true }));

const sourceRows = (kt) => JSON.stringify((kt.report?.results ?? []).filter((r) => r.group === 'sources'));

test('corpus matrix agrees with validate_manifest.py + kit_test.py, with and without PyYAML', { skip: !hasPython }, () => {
  for (const c of CORPUS.cases) {
    const dir = scratchKitForCase(c);
    const runs = [['PyYAML as installed', {}], ['PyYAML unimportable', NO_PYYAML_ENV]].map(([label, env]) => {
      const vm = runValidateManifest(dir, env);
      const kt = runKitTest(dir, env);
      return { label, vm, kt };
    });

    for (const { label, vm, kt } of runs) {
      assert.ok(!hasTraceback(vm.out), `${c.name} (${label}): validate_manifest.py traceback\n${vm.out}`);
      assert.ok(!hasTraceback(kt.out), `${c.name} (${label}): kit_test.py traceback\n${kt.out}`);

      const offlineOk = vm.status === 0 && kt.status === 0;
      assert.equal(offlineOk, c.expect.ok, `${c.name} (${label}): expected ok=${c.expect.ok}, got vm=${vm.status} kt=${kt.status}\n${vm.out}\n${kt.out}`);

      if (!c.expect.ok && c.expect.check) {
        const combined = `${vm.out}\n${kt.out}`;
        assert.ok(combined.includes(c.expect.check), `${c.name} (${label}): expected ${c.expect.check} to appear\n${combined}`);
      }
      if (c.expect.message) {
        const messages = [vm.out, ...(kt.report?.results ?? []).map((r) => r.message)].join('\n');
        assert.ok(messages.includes(c.expect.message), `${c.name} (${label}): expected ${JSON.stringify(c.expect.message)}\n${messages}`);
      }
      if (c.expect.ok && c.expect.warn) {
        const rows = kt.report?.results ?? [];
        for (const w of c.expect.warn) {
          assert.ok(rows.some((r) => r.id === w.check && r.status === 'WARN'), `${c.name} (${label}): expected WARN ${w.check}\n${kt.out}`);
        }
      }
    }
    assert.equal(sourceRows(runs[0].kt), sourceRows(runs[1].kt), `${c.name}: sources rows differ without PyYAML`);
    assert.equal(runs[0].vm.out, runs[1].vm.out, `${c.name}: validate_manifest.py output differs without PyYAML`);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the untouched demo kit (no sources) still passes both tools', { skip: !hasPython }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-kittest-nosrc2-'));
  cpSync(KIT_SRC, dir, { recursive: true });
  cpSync(join(TOOLS_DIR, 'kit_test.py'), join(dir, 'tools/kit_test.py'));
  cpSync(join(TOOLS_DIR, 'validate_manifest.py'), join(dir, 'tools/validate_manifest.py'));
  const vm = runValidateManifest(dir);
  const kt = runKitTest(dir);
  assert.equal(vm.status, 0, vm.out);
  assert.equal(kt.status, 0, kt.out);
  rmSync(dir, { recursive: true, force: true });
});
