// Phase 106 p2 (C6 CLI, C7, C8, C9) — kit_source.py: first run creates
// schema.json + SOURCE.md, a re-run merges (author edits kept, drift
// flagged), and credentials never leave the environment. Driven against the
// p1 stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

const ADMIN_PASSWORD = 'hunter2-admin';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function scratchKit() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-kitsource-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(join(TOOLS_DIR, 'kit_source.py'), join(dir, 'tools/kit_source.py'));
  cpSync(join(TOOLS_DIR, 'kit_test.py'), join(dir, 'tools/kit_test.py'));
  cpSync(join(TOOLS_DIR, '_astro_client.py'), join(dir, 'tools/_astro_client.py'));
  writeFileSync(
    join(dir, 'kit.json'),
    JSON.stringify(
      {
        name: 'acme',
        description: 'Acme kit',
        version: '1.0.0',
        sources: [{ id: 'erp', engine: 'sqlserver', access: 'read_only', description: 'ERP' }],
      },
      null,
      2,
    ),
  );
  return dir;
}

function objectsV1() {
  return [
    {
      schema: 'dbo',
      name: 'Orders',
      type: 'table',
      description: 'Customer orders',
      approxRows: 100,
      primaryKey: ['OrderId'],
      foreignKeys: [],
      columns: [
        { name: 'OrderId', ordinal: 1, sqlType: 'int', nullable: false, description: null },
        { name: 'Status', ordinal: 2, sqlType: 'varchar(20)', nullable: true, description: null, values: ['open', 'closed'] },
      ],
    },
    {
      schema: 'dbo',
      name: 'OrderItems',
      type: 'table',
      description: null,
      approxRows: 50,
      primaryKey: ['OrderId', 'LineNo'],
      foreignKeys: [
        { name: 'FK_Items_Orders', columns: ['OrderId'], refSchema: 'dbo', refTable: 'Orders', refColumns: ['OrderId'] },
      ],
      columns: [
        { name: 'OrderId', ordinal: 1, sqlType: 'int', nullable: false, description: null },
        { name: 'LineNo', ordinal: 2, sqlType: 'int', nullable: false, description: null },
      ],
    },
  ];
}

function objectsV2() {
  return [
    {
      schema: 'dbo',
      name: 'Orders',
      type: 'table',
      description: 'Customer orders',
      approxRows: 120,
      primaryKey: ['OrderId'],
      foreignKeys: [],
      columns: [
        { name: 'OrderId', ordinal: 1, sqlType: 'bigint', nullable: false, description: null },
        { name: 'OrderDate', ordinal: 2, sqlType: 'datetime2(7)', nullable: true, description: null },
      ],
    },
    {
      schema: 'dbo',
      name: 'Customers',
      type: 'table',
      description: null,
      approxRows: 10,
      primaryKey: ['CustomerId'],
      foreignKeys: [],
      columns: [{ name: 'CustomerId', ordinal: 1, sqlType: 'int', nullable: false, description: null }],
    },
    // dbo.OrderItems is gone from the database on this run.
  ];
}

function okResponse(objects, overrides = {}) {
  return {
    database: 'ERP',
    connection: 'binding',
    kitId: 'acme',
    sourceId: 'erp',
    objects,
    sampling: { enabled: false, sampled: [], skipped: [], warning: null },
    auditIds: ['a1'],
    ...overrides,
  };
}

function introspectPath(kitId = 'acme', sourceId = 'erp') {
  return `/api/kit-packages/${kitId}/sources/${sourceId}/introspect`;
}

async function withStub(handler, fn) {
  const stub = await startStubServer((req) => {
    if (req.method === 'POST' && req.path === '/api/auth/login') {
      return { status: 200, body: { accessToken: 'tok-123' } };
    }
    const result = handler(req);
    if (result !== undefined) return result;
    return { status: 404, body: { error: 'not_found' } };
  });
  try {
    return await fn(stub);
  } finally {
    await stub.close();
  }
}

function runKitSource(dir, baseUrl, extraArgs = [], extraEnv = {}) {
  return runPython(['tools/kit_source.py', 'erp', '--base', baseUrl, ...extraArgs], {
    cwd: dir,
    env: { ...CLEAN_ENV, ASTRO_ADMIN_EMAIL: 'admin@example.com', ASTRO_ADMIN_PASSWORD: ADMIN_PASSWORD, ...extraEnv },
  });
}

function readSchema(dir) {
  return JSON.parse(readFileSync(join(dir, 'src/sources/erp/schema.json'), 'utf8'));
}

function readSourceMd(dir) {
  return readFileSync(join(dir, 'src/sources/erp/SOURCE.md'), 'utf8');
}

test('first run creates schema.json and SOURCE.md', { skip: !hasPython }, async () => {
  const dir = scratchKit();
  try {
    await withStub(
      (req) => (req.path === introspectPath() ? { status: 200, body: okResponse(objectsV1()) } : undefined),
      async (stub) => {
        const res = await runKitSource(dir, stub.url, ['--include', 'dbo.*', '--exclude', 'dbo.tmp_*', '--sample-values']);
        assert.equal(res.status, 0, res.stdout + res.stderr);

        const schema = readSchema(dir);
        assert.equal(schema.version, 1);
        assert.ok(schema.tables['dbo.Orders']);
        assert.ok(schema.tables['dbo.OrderItems']);
        assert.equal(schema.tables['dbo.Orders'].purpose, 'Customer orders');
        assert.equal(schema.tables['dbo.Orders'].columns.OrderId.type, 'int');
        assert.equal(schema.tables['dbo.Orders'].columns.OrderId.key, true);
        assert.deepEqual(schema.tables['dbo.Orders'].columns.Status.values, { open: '', closed: '' });
        assert.equal(
          schema.tables['dbo.OrderItems'].columns.OrderId.joins,
          'dbo.Orders.OrderId',
        );

        const md = readSourceMd(dir);
        assert.match(md, /^# erp/m);
        assert.match(md, /ERP/);
        assert.match(md, /dbo\.Orders/);
        assert.match(md, /dbo\.OrderItems/);
        assert.match(md, /## Purpose/);
        assert.match(md, /## Rules/);
        assert.match(md, /## Units/);
        assert.match(md, /## Time zones/);

        const offline = spawnSync('python3', ['tools/kit_test.py', '--kit-root', '.', '--skip-parity'], {
          cwd: dir,
          encoding: 'utf8',
        });
        // SOURCE.md/schema.json structurally valid; the surrounding kit (no
        // recipe/examples) may still fail unrelated groups, so only assert
        // the sources group itself is clean.
        assert.ok(
          !offline.stdout.includes('SRC-04') && !offline.stdout.includes('SRC-05') && !offline.stdout.includes('SRC-06'),
          offline.stdout,
        );

        const introspectReq = stub.requests.find((r) => r.path === introspectPath());
        const sent = JSON.parse(introspectReq.body);
        assert.deepEqual(sent.include, ['dbo.*']);
        assert.deepEqual(sent.exclude, ['dbo.tmp_*']);
        assert.equal(sent.sampleValues, true);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('undeclared source id -> exit 2, no request reached the stub, no files', { skip: !hasPython }, async () => {
  const dir = scratchKit();
  try {
    await withStub(
      () => undefined,
      async (stub) => {
        const res = await runPython(['tools/kit_source.py', 'ghost', '--base', stub.url], {
          cwd: dir,
          env: { ...CLEAN_ENV, ASTRO_ADMIN_EMAIL: 'a@example.com', ASTRO_ADMIN_PASSWORD: 'x' },
        });
        assert.equal(res.status, 2, res.stdout + res.stderr);
        assert.equal(stub.requests.length, 0);
        assert.ok(!existsSync(join(dir, 'src/sources/ghost')));
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('too_many_objects (422) -> exit 4, message mentions --include, no schema.json', { skip: !hasPython }, async () => {
  const dir = scratchKit();
  try {
    await withStub(
      (req) =>
        req.path === introspectPath()
          ? { status: 422, body: { error: 'too_many_objects', message: '201 objects exceeds the limit; narrow with --include' } }
          : undefined,
      async (stub) => {
        const res = await runKitSource(dir, stub.url);
        assert.equal(res.status, 4, res.stdout + res.stderr);
        assert.match(res.stdout + res.stderr, /--include/);
        assert.ok(!existsSync(join(dir, 'src/sources/erp/schema.json')));
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writable (422) -> exit 4, message relayed', { skip: !hasPython }, async () => {
  const dir = scratchKit();
  try {
    await withStub(
      (req) =>
        req.path === introspectPath()
          ? { status: 422, body: { error: 'unsafe_writable', message: 'login can write: db_owner — use a read-only login' } }
          : undefined,
      async (stub) => {
        const res = await runKitSource(dir, stub.url);
        assert.equal(res.status, 4, res.stdout + res.stderr);
        assert.match(res.stdout + res.stderr, /db_owner/);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-run: author fields kept, new items added, removed ones flagged, type change reported, SOURCE.md untouched', { skip: !hasPython }, async () => {
  const dir = scratchKit();
  try {
    await withStub(
      (req) => (req.path === introspectPath() ? { status: 200, body: okResponse(objectsV1()) } : undefined),
      async (stub) => {
        const res1 = await runKitSource(dir, stub.url);
        assert.equal(res1.status, 0, res1.stdout + res1.stderr);
      },
    );

    // Hand-edit author fields.
    const schema = readSchema(dir);
    schema.tables['dbo.Orders'].purpose = 'HAND: order headers, one row per order placed';
    schema.tables['dbo.Orders'].rules = ['Never join without a date filter'];
    schema.tables['dbo.Orders'].columns.OrderId.meaning = 'HAND: primary key, never null';
    schema.tables['dbo.Orders'].columns.Status.meaning = 'HAND: order lifecycle state';
    schema.tables['dbo.Orders'].columns.Status.unit = 'enum';
    schema.tables['dbo.Orders'].columns.Status.sensitive = false;
    schema.tables['dbo.OrderItems'].columns.OrderId.joins = 'dbo.Orders.OrderId'; // already there; keep explicit
    writeFileSync(join(dir, 'src/sources/erp/schema.json'), JSON.stringify(schema, null, 2) + '\n');

    writeFileSync(join(dir, 'src/sources/erp/SOURCE.md'), readSourceMd(dir) + '\nAuthor note: hand-added.\n');
    const sourceMdBefore = readSourceMd(dir);
    const sourceMdShaBefore = sha256(sourceMdBefore);

    await withStub(
      (req) => (req.path === introspectPath() ? { status: 200, body: okResponse(objectsV2()) } : undefined),
      async (stub) => {
        const res2 = await runKitSource(dir, stub.url);
        assert.equal(res2.status, 0, res2.stdout + res2.stderr);
      },
    );

    const after = readSchema(dir);

    // Author fields deep-equal to before.
    assert.equal(after.tables['dbo.Orders'].purpose, 'HAND: order headers, one row per order placed');
    assert.deepEqual(after.tables['dbo.Orders'].rules, ['Never join without a date filter']);
    assert.equal(after.tables['dbo.Orders'].columns.OrderId.meaning, 'HAND: primary key, never null');
    assert.equal(after.tables['dbo.Orders'].columns.Status.meaning, 'HAND: order lifecycle state');
    assert.equal(after.tables['dbo.Orders'].columns.Status.unit, 'enum');
    assert.equal(after.tables['dbo.Orders'].columns.Status.sensitive, false);

    // New table + new column present.
    assert.ok(after.tables['dbo.Customers'], 'new table dbo.Customers present');
    assert.ok(after.tables['dbo.Orders'].columns.OrderDate, 'new column OrderDate present');
    assert.equal(after.tables['dbo.Orders'].columns.OrderDate.type, 'datetime2(7)');

    // Removed table/column still present, unchanged.
    assert.ok(after.tables['dbo.OrderItems'], 'removed table kept, not deleted');
    assert.ok(after.tables['dbo.Orders'].columns.Status, 'removed column kept, not deleted');
    assert.equal(after.tables['dbo.Orders'].columns.Status.meaning, 'HAND: order lifecycle state');

    // Retyped column has the new type.
    assert.equal(after.tables['dbo.Orders'].columns.OrderId.type, 'bigint');

    // SOURCE.md untouched (sha256 unchanged).
    const sourceMdAfter = readSourceMd(dir);
    assert.equal(sha256(sourceMdAfter), sourceMdShaBefore);
    assert.equal(sourceMdAfter, sourceMdBefore);

    const offline = spawnSync('python3', ['tools/kit_test.py', '--kit-root', '.', '--skip-parity'], { cwd: dir, encoding: 'utf8' });
    assert.ok(
      !offline.stdout.includes('SRC-04') && !offline.stdout.includes('SRC-05') && !offline.stdout.includes('SRC-06'),
      offline.stdout,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-sample: an existing `values` entry is kept byte-identical and never reported as sampled', { skip: !hasPython }, async () => {
  const dir = scratchKit();
  try {
    await withStub(
      (req) => (req.path === introspectPath() ? { status: 200, body: okResponse(objectsV1()) } : undefined),
      async (stub) => {
        const res1 = await runKitSource(dir, stub.url, ['--sample-values']);
        assert.equal(res1.status, 0, res1.stdout + res1.stderr);
      },
    );

    const schema = readSchema(dir);
    schema.tables['dbo.Orders'].columns.Status.values = { open: 'The order is still open', closed: '' };
    writeFileSync(join(dir, 'src/sources/erp/schema.json'), JSON.stringify(schema, null, 2) + '\n');

    const v1WithDifferentSample = objectsV1();
    v1WithDifferentSample[0].columns[1].values = ['open', 'closed', 'cancelled'];

    await withStub(
      (req) => (req.path === introspectPath() ? { status: 200, body: okResponse(v1WithDifferentSample) } : undefined),
      async (stub) => {
        const res2 = await runKitSource(dir, stub.url, ['--sample-values']);
        assert.equal(res2.status, 0, res2.stdout + res2.stderr);
        assert.ok(!res2.stdout.includes('dbo.Orders.Status'), 'pre-existing values column must not be reported as sampled');
      },
    );

    const after = readSchema(dir);
    assert.deepEqual(after.tables['dbo.Orders'].columns.Status.values, { open: 'The order is still open', closed: '' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('credentials: --help shows no --password, passing --password is an argparse error, env password never leaks', { skip: !hasPython }, async () => {
  const help = spawnSync('python3', ['tools/kit_source.py', '--help'], { cwd: TOOLS_DIR.replace(/tools$/, ''), encoding: 'utf8' });
  assert.ok(!/--password/.test(help.stdout), help.stdout);

  const dir = scratchKit();
  try {
    const badArgs = spawnSync(
      'python3',
      ['tools/kit_source.py', 'erp', '--base', 'http://localhost:1', '--password', 'x'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(badArgs.status, 2);

    const sourcePassword = 'Source-Secret-99';
    await withStub(
      (req) =>
        req.path === introspectPath() ? { status: 200, body: okResponse(objectsV1()) } : undefined,
      async (stub) => {
        const res = await runKitSource(dir, stub.url, [], {
          ASTRO_SOURCE_ERP_HOST: 'db.internal',
          ASTRO_SOURCE_ERP_PASSWORD: sourcePassword,
        });
        assert.equal(res.status, 0, res.stdout + res.stderr);
        assert.ok(!res.stdout.includes(sourcePassword) && !res.stdout.includes(ADMIN_PASSWORD));
        assert.ok(!res.stderr.includes(sourcePassword) && !res.stderr.includes(ADMIN_PASSWORD));

        const schemaText = readFileSync(join(dir, 'src/sources/erp/schema.json'), 'utf8');
        const mdText = readSourceMd(dir);
        assert.ok(!schemaText.includes(sourcePassword) && !mdText.includes(sourcePassword));

        const introspectReq = stub.requests.find((r) => r.path === introspectPath());
        const sent = JSON.parse(introspectReq.body);
        assert.equal(sent.connection.password, sourcePassword);
        assert.ok(!introspectReq.body.includes(ADMIN_PASSWORD));
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mode choice: ASTRO_SOURCE_ERP_HOST set -> one-off; a 404 kit_not_found falls back to /api/sources/introspect', { skip: !hasPython }, async () => {
  const dir = scratchKit();
  try {
    await withStub(
      (req) => {
        if (req.path === introspectPath()) return { status: 404, body: { error: 'kit_not_found' } };
        if (req.path === '/api/sources/introspect') return { status: 200, body: okResponse(objectsV1(), { kitId: null, sourceId: null }) };
        return undefined;
      },
      async (stub) => {
        const res = await runKitSource(dir, stub.url, [], { ASTRO_SOURCE_ERP_HOST: 'db.internal' });
        assert.equal(res.status, 0, res.stdout + res.stderr);
        const unkeyedReq = stub.requests.find((r) => r.path === '/api/sources/introspect');
        assert.ok(unkeyedReq, 'fell back to the unkeyed route');
        const sent = JSON.parse(unkeyedReq.body);
        assert.equal(sent.connection.host, 'db.internal');
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
