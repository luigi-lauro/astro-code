// Fix 2026-10-01-phase-106-kit-tools-sensitive-sampling — reproductions of
// the four phase 106 verify failures (C5, C7, C8, C10) against the p1 stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStubServer, runPython } from './fixtures/stub_astro_server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = join(ROOT, 'templates/kit/tools');
const hasPython = spawnSync('python3', ['--version']).status === 0;

const CLEAN_ENV = {
  ASTRO_BASE_URL: '',
  ASTRO_ADMIN_EMAIL: '',
  ASTRO_ADMIN_PASSWORD: '',
  ASTRO_HTTP_TIMEOUT: '',
  ASTRO_SOURCE_ERP_HOST: '',
  ASTRO_SOURCE_ERP_PORT: '',
  ASTRO_SOURCE_ERP_DATABASE: '',
  ASTRO_SOURCE_ERP_USERNAME: '',
  ASTRO_SOURCE_ERP_PASSWORD: '',
  ASTRO_SOURCE_ERP_TRUST_SERVER_CERTIFICATE: '',
};

const INTROSPECT = '/api/kit-packages/acme/sources/erp/introspect';

function scratchKit() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-kitsource-fix-'));
  mkdirSync(join(dir, 'tools/schemas'), { recursive: true });
  for (const f of ['kit_source.py', 'kit_test.py', '_astro_client.py', 'validate_manifest.py', '_schema_engine.py']) {
    cpSync(join(TOOLS_DIR, f), join(dir, 'tools', f));
  }
  for (const f of ['kit-manifest.v4.schema.json', 'kit-manifest.v3.schema.json', 'sqlserver-types.v1.json', 'source-schema.v1.schema.json']) {
    cpSync(join(TOOLS_DIR, 'schemas', f), join(dir, 'tools/schemas', f));
  }
  writeFileSync(
    join(dir, 'kit.json'),
    JSON.stringify({
      name: 'acme',
      description: 'Acme kit',
      version: '1.0.0',
      sources: [{ id: 'erp', engine: 'sqlserver', access: 'read_only', description: 'ERP' }],
    }),
  );
  return dir;
}

function writeSchema(dir, schema) {
  mkdirSync(join(dir, 'src/sources/erp'), { recursive: true });
  writeFileSync(join(dir, 'src/sources/erp/schema.json'), JSON.stringify(schema, null, 2));
  writeFileSync(join(dir, 'src/sources/erp/SOURCE.md'), '# erp\n');
}

const readSchema = (dir) => JSON.parse(readFileSync(join(dir, 'src/sources/erp/schema.json'), 'utf8'));

function response(objects) {
  return {
    database: 'ERP',
    connection: 'binding',
    kitId: 'acme',
    sourceId: 'erp',
    objects,
    sampling: { enabled: true, sampled: [], skipped: [], warning: null },
    drift: { missingTables: [], missingColumns: [], typeChanges: [] },
    queryChecks: [],
    auditIds: ['a1'],
  };
}

async function withStub(objects, fn) {
  const stub = await startStubServer((req) => {
    if (req.method === 'POST' && req.path === '/api/auth/login') return { status: 200, body: { accessToken: 'tok' } };
    if (req.path === INTROSPECT) return { status: 200, body: response(objects) };
    return { status: 404, body: { error: 'not_found' } };
  });
  try {
    return await fn(stub);
  } finally {
    await stub.close();
  }
}

function run(dir, script, args, baseUrl) {
  return runPython([`tools/${script}`, ...args], {
    cwd: dir,
    env: { ...CLEAN_ENV, ASTRO_BASE_URL: baseUrl, ASTRO_ADMIN_EMAIL: 'a@example.com', ASTRO_ADMIN_PASSWORD: 'pw' },
  });
}

const col = (name, sqlType, extra = {}) => ({ name, ordinal: 1, sqlType, nullable: true, description: null, ...extra });

test('C5: columns marked sensitive locally are sent to the server and never get values', { skip: !hasPython }, async () => {
  const dir = scratchKit();
  try {
    writeSchema(dir, {
      version: 1,
      tables: {
        'dbo.T': { purpose: 'p', kind: 'table', columns: { Region: { meaning: 'm', type: 'varchar(20)', sensitive: true } } },
        '[dbo].[Order Lines]': { purpose: 'p', kind: 'table', columns: { Note: { meaning: 'm', type: 'varchar(20)', sensitive: true } } },
      },
    });
    // A server that ignores the hint still must not get the values into the file.
    const objects = [
      { schema: 'dbo', name: 'T', type: 'table', primaryKey: [], foreignKeys: [], columns: [col('Region', 'varchar(20)', { values: ['v1', 'v2'] })] },
      { schema: 'dbo', name: 'Order Lines', type: 'table', primaryKey: [], foreignKeys: [], columns: [col('Note', 'varchar(20)', { values: ['x'] })] },
    ];
    await withStub(objects, async (stub) => {
      const res = await run(dir, 'kit_source.py', ['erp', '--sample-values'], stub.url);
      assert.equal(res.status, 0, res.stdout + res.stderr);
      const sent = JSON.parse(stub.requests.find((r) => r.path === INTROSPECT).body);
      assert.deepEqual([...(sent.sensitiveColumns ?? [])].sort(), ['dbo.Order Lines.Note', 'dbo.T.Region']);
      const schema = readSchema(dir);
      assert.equal(schema.tables['dbo.T'].columns.Region.values, undefined);
      assert.equal(schema.tables['[dbo].[Order Lines]'].columns.Note.values, undefined);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C7: a FK to a table whose name needs brackets writes a bracketed joins and exits 0', { skip: !hasPython }, async () => {
  const dir = scratchKit();
  try {
    const objects = [
      {
        schema: 'dbo', name: 'Orders', type: 'table', primaryKey: ['OrderId'],
        foreignKeys: [{ name: 'FK', columns: ['LineId'], refSchema: 'dbo', refTable: 'Order Lines', refColumns: ['Line Id'] }],
        columns: [col('OrderId', 'int'), col('LineId', 'int')],
      },
      { schema: 'dbo', name: 'Order Lines', type: 'table', primaryKey: ['Line Id'], foreignKeys: [], columns: [col('Line Id', 'int')] },
    ];
    await withStub(objects, async (stub) => {
      const res = await run(dir, 'kit_source.py', ['erp'], stub.url);
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.equal(readSchema(dir).tables['dbo.Orders'].columns.LineId.joins, '[dbo].[Order Lines].[Line Id]');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C8: an author-written key on a column outside the primary key is kept and reported', { skip: !hasPython }, async () => {
  const dir = scratchKit();
  try {
    writeSchema(dir, {
      version: 1,
      tables: {
        'sales.vOrders': { purpose: 'p', kind: 'view', columns: { OrderId: { meaning: 'Logical key of the view', type: 'int', key: true } } },
      },
    });
    const objects = [{ schema: 'sales', name: 'vOrders', type: 'view', primaryKey: [], foreignKeys: [], columns: [col('OrderId', 'int')] }];
    await withStub(objects, async (stub) => {
      const res = await run(dir, 'kit_source.py', ['erp'], stub.url);
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.equal(readSchema(dir).tables['sales.vOrders'].columns.OrderId.key, true);
      assert.match(res.stdout + res.stderr, /sales\.vOrders\.OrderId/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C10: --live sends documented table keys in a form the server can match exactly', { skip: !hasPython }, async () => {
  const dir = scratchKit();
  try {
    writeSchema(dir, {
      version: 1,
      tables: {
        '[dbo].[Order Lines]': { purpose: 'p', kind: 'table', columns: { Id: { meaning: 'm', type: 'int' } } },
        'dbo.tbl$x': { purpose: 'p', kind: 'table', columns: { Id: { meaning: 'm', type: 'int' } } },
      },
    });
    await withStub([], async (stub) => {
      await run(dir, 'kit_test.py', ['--json', '--skip-parity', '--live'], stub.url);
      const sent = JSON.parse(stub.requests.find((r) => r.path === INTROSPECT).body);
      assert.deepEqual([...sent.include].sort(), ['[dbo].[Order Lines]', 'dbo.tbl$x']);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C9: --live redacts a source password the instance echoes back in an error', { skip: !hasPython }, async () => {
  const dir = scratchKit();
  const canary = 'Src-Canary-66';
  try {
    writeSchema(dir, { version: 1, tables: { 'dbo.T': { purpose: 'p', kind: 'table', columns: { Id: { meaning: 'm', type: 'int' } } } } });
    const stub = await startStubServer((req) => {
      if (req.method === 'POST' && req.path === '/api/auth/login') return { status: 200, body: { accessToken: 'tok' } };
      if (req.path === INTROSPECT) {
        const pw = JSON.parse(req.body).connection?.password;
        return { status: 422, body: { error: 'unsafe_writable', message: `login ro with password ${pw} can write` } };
      }
      return { status: 404, body: { error: 'not_found' } };
    });
    try {
      for (const extra of [[], ['--json']]) {
        const res = await runPython(['tools/kit_test.py', '--skip-parity', '--live', ...extra], {
          cwd: dir,
          env: {
            ...CLEAN_ENV,
            ASTRO_BASE_URL: stub.url,
            ASTRO_ADMIN_EMAIL: 'a@example.com',
            ASTRO_ADMIN_PASSWORD: 'pw',
            ASTRO_SOURCE_ERP_HOST: 'db.example',
            ASTRO_SOURCE_ERP_USERNAME: 'ro',
            ASTRO_SOURCE_ERP_PASSWORD: canary,
          },
        });
        const out = res.stdout + res.stderr;
        assert.match(out, /SRC-20/, out);
        assert.ok(!out.includes(canary), out);
        assert.match(out, /password \*\*\* can write/, out);
      }
    } finally {
      await stub.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
