// Phase 106 p1 (C9 base) — _astro_client.py, the shared stdlib HTTP client
// kit tools use to talk to a hosted Astro instance, driven against the
// stub-server test harness (tests/fixtures/stub_astro_server.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStubServer, runPython } from './fixtures/stub_astro_server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = join(ROOT, 'templates/kit/tools');
const hasPython = spawnSync('python3', ['--version']).status === 0;

// No ASTRO_* leaking from the host/CI environment into any of these runs.
const CLEAN_ENV = {
  ASTRO_BASE_URL: '',
  ASTRO_ADMIN_EMAIL: '',
  ASTRO_ADMIN_PASSWORD: '',
  ASTRO_HTTP_TIMEOUT: '',
};

function importPreamble() {
  return `
import sys
sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})
import _astro_client as astro
`;
}

test('imports cleanly under python3 -I -S (stdlib only, no site-packages) and exposes the C9 surface', { skip: !hasPython }, async () => {
  const script = `${importPreamble()}
for name in ("log", "ok", "warn", "die", "env_credentials", "one_off_from_env", "login", "request_json", "resolve_kit_id", "redact"):
    assert callable(getattr(astro, name)), name
print("OK")
`;
  const res = await runPython(['-c', script], { env: CLEAN_ENV });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /OK/);
});

test('login sends the password only in the JSON body, never on the URL or in output', { skip: !hasPython }, async () => {
  const stub = await startStubServer((req) => {
    if (req.method === 'POST' && req.path === '/api/auth/login') {
      return { status: 200, body: { accessToken: 'tok-123' } };
    }
    return { status: 404, body: { error: 'not_found' } };
  });
  try {
    const script = `${importPreamble()}
token = astro.login(${JSON.stringify(stub.url)}, "admin@example.com", "hunter2-secret")
print(token)
`;
    const res = await runPython(['-c', script], { env: CLEAN_ENV });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(res.stdout.trim().split('\n').pop(), 'tok-123');
    assert.ok(!res.stdout.includes('hunter2-secret'), 'password leaked to stdout');
    assert.ok(!res.stderr.includes('hunter2-secret'), 'password leaked to stderr');

    assert.equal(stub.requests.length, 1);
    const [req] = stub.requests;
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/api/auth/login');
    assert.ok(!req.url.includes('hunter2-secret'), 'password leaked onto the URL/query string');
    const sent = JSON.parse(req.body);
    assert.deepEqual(sent, { email: 'admin@example.com', password: 'hunter2-secret' });
  } finally {
    await stub.close();
  }
});

test('env_credentials exits 2 naming the missing variables, and never prints a value', { skip: !hasPython }, async () => {
  const script = `${importPreamble()}
astro.env_credentials()
`;
  const res = await runPython(['-c', script], {
    env: { ASTRO_BASE_URL: '', ASTRO_ADMIN_EMAIL: '', ASTRO_ADMIN_PASSWORD: '' },
  });
  assert.equal(res.status, 2, res.stdout + res.stderr);
  for (const name of ['ASTRO_BASE_URL', 'ASTRO_ADMIN_EMAIL', 'ASTRO_ADMIN_PASSWORD']) {
    assert.ok(res.stderr.includes(name), `expected ${name} to be named in: ${res.stderr}`);
  }
});

test('env_credentials names only the variables actually missing, and normalizes the base URL', { skip: !hasPython }, async () => {
  const script = `${importPreamble()}
base, email, password = astro.env_credentials()
print(base)
print(email)
assert password == "s3cret", password
`;
  const res = await runPython(['-c', script], {
    env: { ASTRO_BASE_URL: 'example.test', ASTRO_ADMIN_EMAIL: 'admin@example.com', ASTRO_ADMIN_PASSWORD: 's3cret' },
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const [base, email] = res.stdout.trim().split('\n');
  assert.equal(base, 'https://example.test');
  assert.equal(email, 'admin@example.com');
  assert.ok(!res.stdout.includes('s3cret') && !res.stderr.includes('s3cret'));
});

test('a server that never answers dies 6 within the configured timeout', { skip: !hasPython }, async () => {
  const stub = await startStubServer(() => null); // never respond
  try {
    const script = `${importPreamble()}
astro.request_json("GET", ${JSON.stringify(stub.url)} + "/slow")
`;
    const started = Date.now();
    const res = await runPython(['-c', script], { env: { ...CLEAN_ENV, ASTRO_HTTP_TIMEOUT: '1' } });
    const elapsedMs = Date.now() - started;
    assert.equal(res.status, 6, res.stdout + res.stderr);
    assert.ok(elapsedMs < 10_000, `expected the 1s timeout to be honored, took ${elapsedMs}ms`);
  } finally {
    await stub.close();
  }
});

test("one_off_from_env('erp-main') reads ASTRO_SOURCE_ERP_MAIN_*", { skip: !hasPython }, async () => {
  const script = `${importPreamble()}
import json
conn = astro.one_off_from_env("erp-main")
print(json.dumps(conn))
`;
  const res = await runPython(['-c', script], {
    env: {
      ...CLEAN_ENV,
      ASTRO_SOURCE_ERP_MAIN_HOST: 'db.example.test',
      ASTRO_SOURCE_ERP_MAIN_PORT: '1433',
      ASTRO_SOURCE_ERP_MAIN_DATABASE: 'Erp',
      ASTRO_SOURCE_ERP_MAIN_USERNAME: 'svc',
      ASTRO_SOURCE_ERP_MAIN_PASSWORD: 'one-off-pw',
      ASTRO_SOURCE_ERP_MAIN_TRUST_SERVER_CERTIFICATE: 'true',
    },
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {
    host: 'db.example.test',
    port: 1433,
    database: 'Erp',
    username: 'svc',
    password: 'one-off-pw',
    trustServerCertificate: true,
  });
});

test('one_off_from_env returns None when no HOST is configured for that source', { skip: !hasPython }, async () => {
  const script = `${importPreamble()}
import json
print(json.dumps(astro.one_off_from_env("unconfigured-source")))
`;
  const res = await runPython(['-c', script], { env: CLEAN_ENV });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(res.stdout.trim(), 'null');
});

test('an error body echoing the password back is printed redacted', { skip: !hasPython }, async () => {
  const stub = await startStubServer((req) => {
    if (req.method === 'POST' && req.path === '/api/auth/login') {
      return { status: 418, body: { message: 'rejected credentials for password=teapot-pw' } };
    }
    return { status: 404, body: { error: 'not_found' } };
  });
  try {
    const script = `${importPreamble()}
astro.login(${JSON.stringify(stub.url)}, "admin@example.com", "teapot-pw")
`;
    const res = await runPython(['-c', script], { env: CLEAN_ENV });
    assert.notEqual(res.status, 0);
    assert.ok(!res.stderr.includes('teapot-pw'), `password leaked unredacted: ${res.stderr}`);
    assert.ok(res.stderr.includes('***'), `expected a redaction marker in: ${res.stderr}`);
    assert.ok(!res.stdout.includes('teapot-pw'));
  } finally {
    await stub.close();
  }
});

test('redact() replaces every secret, ignores empties, and leaves unrelated text alone', { skip: !hasPython }, async () => {
  const script = `${importPreamble()}
assert astro.redact("password is hunter2 and hunter2 again", {"hunter2"}) == "password is *** and *** again"
assert astro.redact("nothing secret here", set()) == "nothing secret here"
assert astro.redact("foo and bar", {"foo", "bar", "", None}) == "*** and ***"
print("OK")
`;
  const res = await runPython(['-c', script], { env: CLEAN_ENV });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /OK/);
});

test('resolve_kit_id reads kit.json (name IS the id) and dies 2 when absent', { skip: !hasPython }, async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'ac-astro-client-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'kit.json'), JSON.stringify({ name: 'commit-digest', version: '0.1.0' }));

  const okScript = `${importPreamble()}
from pathlib import Path
print(astro.resolve_kit_id(Path(${JSON.stringify(dir)})))
`;
  const okRes = await runPython(['-c', okScript], { env: CLEAN_ENV });
  assert.equal(okRes.status, 0, okRes.stdout + okRes.stderr);
  assert.equal(okRes.stdout.trim(), 'commit-digest');

  const missingDir = join(dir, 'nope');
  const missingScript = `${importPreamble()}
from pathlib import Path
astro.resolve_kit_id(Path(${JSON.stringify(missingDir)}))
`;
  const missingRes = await runPython(['-c', missingScript], { env: CLEAN_ENV });
  assert.equal(missingRes.status, 2, missingRes.stdout + missingRes.stderr);
});
