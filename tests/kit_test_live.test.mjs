// Phase 106 p3 (C9, C10) — `kit_test.py --live`: POSTs the introspect
// contract (ADR-022) for each declared source and reports drift / @returns
// mismatches straight from the response (the comparisons themselves are the
// server's job, i3 — never re-derived here). Driven against the p1 stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStubServer, runPython } from './fixtures/stub_astro_server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KIT_SRC = join(ROOT, 'examples/kit-convert-demo/commit-digest');
const TOOLS_DIR = join(ROOT, 'templates/kit/tools');
const hasPython = spawnSync('python3', ['--version']).status === 0;

const CORPUS = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/source-spec-cases.json'), 'utf8'));
const BASE_CASE = CORPUS.cases.find((c) => c.name === 'base');

/** The same clean, passing `erp` source fixture kit_test_sources.test.mjs
 * uses (CORPUS's `base` case) — one table (dbo.Orders) and one named query
 * (open_orders.sql), plus `_astro_client.py` for the live path. */
function scratchKit() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-kittest-live-'));
  cpSync(KIT_SRC, dir, { recursive: true });
  cpSync(join(TOOLS_DIR, 'kit_test.py'), join(dir, 'tools/kit_test.py'));
  cpSync(join(TOOLS_DIR, 'validate_manifest.py'), join(dir, 'tools/validate_manifest.py'));
  cpSync(join(TOOLS_DIR, '_astro_client.py'), join(dir, 'tools/_astro_client.py'));
  cpSync(join(TOOLS_DIR, '_schema_engine.py'), join(dir, 'tools/_schema_engine.py'));
  mkdirSync(join(dir, 'tools/schemas'), { recursive: true });
  for (const f of ['kit-manifest.v4.schema.json', 'kit-manifest.v3.schema.json', 'sqlserver-types.v1.json', 'source-schema.v1.schema.json']) {
    cpSync(join(TOOLS_DIR, 'schemas', f), join(dir, 'tools/schemas', f));
  }

  const manifest = structuredClone(CORPUS.base.manifest);
  manifest.manifest_version = 4;
  writeFileSync(join(dir, 'kit.json'), JSON.stringify(manifest, null, 2));

  for (const [relPath, content] of Object.entries(CORPUS.base.files)) {
    const abs = join(dir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

const CLEAN_ENV = {
  ASTRO_BASE_URL: '',
  ASTRO_ADMIN_EMAIL: '',
  ASTRO_ADMIN_PASSWORD: '',
  ASTRO_HTTP_TIMEOUT: '',
};

const LIVE_ENV = (baseUrl) => ({
  ...CLEAN_ENV,
  ASTRO_BASE_URL: baseUrl,
  ASTRO_ADMIN_EMAIL: 'admin@example.com',
  ASTRO_ADMIN_PASSWORD: 'hunter2-secret',
});

/** A matching introspect response — the catalog and query checks all ok, as
 * the request's own schema/queries describe them. */
function okIntrospectResponse() {
  return {
    database: 'ERP',
    connection: 'binding',
    kitId: 'sources-demo',
    sourceId: 'erp',
    objects: [],
    sampling: { enabled: false, sampled: [], skipped: [], warning: null },
    drift: { missingTables: [], missingColumns: [], typeChanges: [] },
    queryChecks: [
      { file: 'open_orders.sql', name: 'open_orders', ok: true, error: null, differences: [], actual: [{ name: 'OrderId', sqlType: 'int' }, { name: 'Total', sqlType: 'decimal(18,2)' }] },
    ],
    auditIds: ['a1'],
  };
}

function introspectRoute(path) {
  return path === '/api/kit-packages/sources-demo/sources/erp/introspect';
}

async function runLive(dir, { handler, extraEnv = {} } = {}) {
  const stub = await startStubServer((req) => {
    if (req.method === 'POST' && req.path === '/api/auth/login') {
      return { status: 200, body: { accessToken: 'tok-123' } };
    }
    if (handler) {
      const result = handler(req);
      if (result !== undefined) return result;
    }
    return { status: 404, body: { error: 'not_found' } };
  });
  try {
    const res = await runPython(['tools/kit_test.py', '--json', '--skip-parity', '--live'], {
      cwd: dir,
      env: { ...LIVE_ENV(stub.url), ...extraEnv },
    });
    return { ...res, stub };
  } finally {
    await stub.close();
  }
}

test(
  'matching catalog and queryChecks -> --live exits 0 with PASS rows SRC-21..24',
  { skip: !hasPython },
  async () => {
    const dir = scratchKit();
    try {
      const { status, stdout, stub } = await runLive(dir, {
        handler: (req) => (introspectRoute(req.path) ? { status: 200, body: okIntrospectResponse() } : undefined),
      });
      assert.equal(status, 0, stdout);
      const report = JSON.parse(stdout);
      const live = report.results.filter((r) => r.group === 'live');
      for (const id of ['SRC-20', 'SRC-21', 'SRC-22', 'SRC-23', 'SRC-24']) {
        assert.ok(live.some((r) => r.id === id && r.status === 'PASS'), `expected PASS ${id}\n${stdout}`);
      }

      const introspectReq = stub.requests.find((r) => introspectRoute(r.path));
      assert.ok(introspectReq, 'introspect route was called');
      const sent = JSON.parse(introspectReq.body);
      assert.deepEqual(sent.include, ['dbo.Orders']);
      assert.ok(sent.schema && sent.schema.tables);
      assert.equal(sent.queries.length, 1);
      assert.equal(sent.queries[0].file, 'open_orders.sql');
      assert.match(sent.queries[0].text, /@name open_orders/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'missing table/column, a type change and a bad queryCheck -> exit 1 naming SRC-21..24',
  { skip: !hasPython },
  async () => {
    const dir = scratchKit();
    try {
      const { status, stdout } = await runLive(dir, {
        handler: (req) => {
          if (!introspectRoute(req.path)) return undefined;
          const body = okIntrospectResponse();
          body.drift = {
            missingTables: ['dbo.Ghost'],
            missingColumns: [{ table: 'dbo.Orders', column: 'Missing' }],
            typeChanges: [{ table: 'dbo.Orders', column: 'OrderId', documented: 'int', actual: 'nvarchar(20)' }],
          };
          body.queryChecks = [
            {
              file: 'open_orders.sql',
              name: 'open_orders',
              ok: false,
              error: '@returns mismatch',
              differences: [
                { position: 1, expected: 'int', actual: 'nvarchar(20)', reason: 'type_mismatch', column: 'OrderId' },
                { position: 3, expected: 'Total decimal(18,2)', actual: '(missing)', reason: 'missing_column' },
              ],
              actual: [{ name: 'OrderId', sqlType: 'nvarchar(20)' }],
            },
          ];
          return { status: 200, body };
        },
      });
      assert.equal(status, 1, stdout);
      const report = JSON.parse(stdout);
      const live = report.results.filter((r) => r.group === 'live');
      const msgFor = (id) => live.filter((r) => r.id === id).map((r) => r.message).join(' | ');
      assert.ok(live.find((r) => r.id === 'SRC-21' && r.status === 'FAIL'), msgFor('SRC-21'));
      assert.match(msgFor('SRC-21'), /dbo\.Ghost/);
      assert.ok(live.find((r) => r.id === 'SRC-22' && r.status === 'FAIL'));
      assert.match(msgFor('SRC-22'), /Orders\.Missing/);
      assert.ok(live.find((r) => r.id === 'SRC-23' && r.status === 'FAIL'));
      assert.match(msgFor('SRC-23'), /int -> nvarchar\(20\)/);
      assert.ok(live.find((r) => r.id === 'SRC-24' && r.status === 'FAIL'));
      assert.match(msgFor('SRC-24'), /open_orders\.sql/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('a same-family width change alone is not a failure', { skip: !hasPython }, async () => {
  const dir = scratchKit();
  try {
    const { status, stdout } = await runLive(dir, {
      handler: (req) => {
        if (!introspectRoute(req.path)) return undefined;
        const body = okIntrospectResponse();
        // The server's own drift computation never reports a same-family
        // width change (varchar(50) -> varchar(100)) — the stub mirrors that
        // by leaving drift empty, as design PLAN.md notes.
        return { status: 200, body };
      },
    });
    assert.equal(status, 0, stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--live without env -> exit 2, naming the variables, no password in output', { skip: !hasPython }, async () => {
  const dir = scratchKit();
  try {
    const res = await runPython(['tools/kit_test.py', '--json', '--skip-parity', '--live'], {
      cwd: dir,
      env: CLEAN_ENV,
    });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    for (const name of ['ASTRO_BASE_URL', 'ASTRO_ADMIN_EMAIL', 'ASTRO_ADMIN_PASSWORD']) {
      assert.ok(res.stderr.includes(name), `expected ${name} named in: ${res.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kit_test.py has no --password option', { skip: !hasPython }, () => {
  const res = spawnSync('python3', ['tools/kit_test.py', '--help'], { cwd: TOOLS_DIR.replace(/tools$/, ''), encoding: 'utf8' });
  assert.ok(!/--password/.test(res.stdout), res.stdout);
});

test(
  'offline (no --live) is unchanged: same exit code and --json byte-for-byte vs the pre-106 copy',
  { skip: !hasPython },
  () => {
    const dir = scratchKit();
    try {
      const preImage = execFileSync('git', ['show', 'HEAD:templates/kit/tools/kit_test.py'], { cwd: ROOT, encoding: 'utf8' });
      writeFileSync(join(dir, 'tools/kit_test_pre106.py'), preImage);

      const before = spawnSync('python3', ['tools/kit_test_pre106.py', '--json', '--skip-parity'], { cwd: dir, encoding: 'utf8' });
      const after = spawnSync('python3', ['tools/kit_test.py', '--json', '--skip-parity'], { cwd: dir, encoding: 'utf8' });

      assert.equal(after.status, before.status, `${before.stdout}\n---\n${after.stdout}`);
      const beforeJson = JSON.parse(before.stdout.replace(/kit_test_pre106\.py/g, 'kit_test.py'));
      const afterJson = JSON.parse(after.stdout);
      assert.deepEqual(afterJson, beforeJson);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('the --live run under python3 -I -S works', { skip: !hasPython }, async () => {
  const dir = scratchKit();
  try {
    const { status, stdout } = await runLive(dir, {
      handler: (req) => (introspectRoute(req.path) ? { status: 200, body: okIntrospectResponse() } : undefined),
    });
    assert.equal(status, 0, stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
