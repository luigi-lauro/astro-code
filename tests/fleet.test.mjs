// Astro Fleet connector — the client half of astro-fleet phase 36. The wire contract is
// fixed by the fleet; these tests pin our side of it: what each hook event becomes,
// that nothing sensitive leaks, that settings.json is merged and restored exactly, that
// the queue drains/retains/backs off as the fleet's status codes say, and that the hook
// itself always exits 0, fast and silent. Real filesystem, a real local HTTP server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git } from '../lib/git.mjs';
import {
  mapEvent, normalizeRemote, resolveProject, hiddenName, enqueueHookEvent, trimQueue,
  readQueue, flush, fleetPaths, saveConfig, loadState, updateState, chunkEvents,
  QUEUE_MAX, QUEUE_MAX_AUTH_FAILED, EVENT_TTL_MS, HOOK_MARKER,
} from '../hooks/_astro-fleet.mjs';
import {
  registerFleetHooks, unregisterFleetHooks, hookCommand, connect, disconnect, status,
  setColor, HOOK_EVENTS, BACKUP_SUFFIX,
} from '../lib/fleet.mjs';

const FRAMEWORK = join(dirname(fileURLToPath(import.meta.url)), '..');
const AC = join(FRAMEWORK, 'bin', 'ac.mjs');
const HOOK = join(FRAMEWORK, 'hooks', 'astro-fleet-hook.mjs');
const tmp = (p = 'ac-fleet-') => mkdtempSync(join(tmpdir(), p));

// A fake fleet: answers each request with the next scripted response (the last one
// repeats) and records every body it received. Mirrors the real fleet's order of checks
// (docs/forge/INGEST.md): a scripted 401/429/404/… stands for a refusal that happens
// BEFORE the events check; a batch that passes it with no events gets
// 400 {"error":"no recognised events"} and writes nothing. `acceptEmpty` plays a later
// fleet that answers an empty batch with 200. `sessions` is what the fleet would store.
async function fakeFleet(script = [{ status: 200 }], { acceptEmpty = false } = {}) {
  const calls = [];
  const sessions = new Set();
  let i = 0;
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || 'null');
      calls.push({ url: req.url, auth: req.headers.authorization, body: parsed });
      const r = script[Math.min(i++, script.length - 1)];
      const events = parsed?.events ?? [];
      let status = r.status;
      let out = r.body ?? (status === 200 ? { accepted: events.length } : { error: 'x' });
      if (status === 200 && events.length === 0 && !acceptEmpty) {
        status = 400;
        out = { error: 'no recognised events' };
      }
      if (status === 200) for (const e of events) sessions.add(e.session_id);
      res.writeHead(status, { 'content-type': 'application/json', ...(r.headers || {}) });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, calls, sessions, close: () => new Promise((r) => srv.close(r)) };
}

// A port that was just free: connecting to it is a plain ECONNREFUSED ("server down").
// Not a well-known closed port like 9 — fetch refuses those itself as "bad port".
const DOWN = await (async () => {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`;
})();

const connected = (dir, url, extra = {}) => saveConfig({ url, token: 'tok-secret-abcd', color: '#4fb3ff', name: 'alex', paused: false, hide_names: false, ...extra }, dir);
const ev = (n, ts = new Date().toISOString()) => ({ type: 'prompt', session_id: `s${n}`, ts, project: { name: 'p' } });
const fill = (dir, events) => writeFileSync(fleetPaths(dir).queue, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

// ── event mapping ──────────────────────────────────────────────────────────────

const PROJECT = { name: 'shop', repo_url: 'https://github.com/acme/shop' };
const SENSITIVE = {
  prompt: 'SECRET PROMPT TEXT', tool_name: 'Bash', tool_input: { command: 'cat ~/.ssh/id_rsa' },
  tool_response: { stdout: 'SECRET OUTPUT' }, transcript_path: '/Users/alex/.claude/projects/x.jsonl',
  message: 'Claude needs your permission to use Bash', last_assistant_message: 'SECRET REPLY',
  agent_transcript_path: '/Users/alex/.claude/agent.jsonl', permission_mode: 'default',
};

test('every Claude Code hook event maps to its fixed wire type, with project and cwd on every event', () => {
  const want = {
    SessionStart: 'session_start', SessionEnd: 'session_end', UserPromptSubmit: 'prompt',
    PreToolUse: 'tool', PostToolUse: 'tool', Notification: 'waiting', Stop: 'stop',
    SubagentStart: 'subagent_start', SubagentStop: 'subagent_stop',
  };
  for (const [hook, type] of Object.entries(want)) {
    const e = mapEvent({ hook_event_name: hook, session_id: 'S1', cwd: '/Users/alex/dev/shop', agent_id: 'A1', agent_type: 'Explore' },
      { project: PROJECT, now: Date.parse('2026-10-01T12:00:00.789Z') });
    assert.equal(e.type, type, hook);
    assert.equal(e.session_id, 'S1');
    assert.equal(e.ts, '2026-10-01T12:00:00Z');
    assert.equal(e.cwd, '/Users/alex/dev/shop');
    assert.deepEqual(e.project, PROJECT);
    if (type.startsWith('subagent_')) {
      assert.equal(e.agent_id, 'A1');
      assert.equal(e.agent_type, 'Explore');
    } else {
      assert.ok(!('agent_id' in e) && !('agent_type' in e), `${hook} must not carry agent fields`);
    }
  }
});

test('nothing sensitive leaks: prompt text, tool payloads, messages and transcript paths are absent', () => {
  for (const hook of HOOK_EVENTS) {
    const e = mapEvent({ hook_event_name: hook, session_id: 'S', cwd: '/w/shop', agent_id: 'a', agent_type: 't', ...SENSITIVE }, { project: PROJECT });
    const wire = JSON.stringify(e);
    for (const bad of ['SECRET', 'id_rsa', 'transcript', 'jsonl', 'permission', 'Bash']) assert.ok(!wire.includes(bad), `${hook} leaked ${bad}: ${wire}`);
    assert.deepEqual(Object.keys(e).filter((k) => !['type', 'session_id', 'ts', 'cwd', 'project', 'agent_id', 'agent_type'].includes(k)), []);
  }
});

test('unknown hook events and payloads without a session_id are ignored', () => {
  assert.equal(mapEvent({ hook_event_name: 'PreCompact', session_id: 'S' }), null);
  assert.equal(mapEvent({ hook_event_name: 'Stop' }), null);
  assert.equal(mapEvent(null), null);
});

test('hide_names sends a stable p-<8 hex> name and drops repo_url and cwd', () => {
  const a = mapEvent({ hook_event_name: 'Stop', session_id: 'S', cwd: '/Users/alex/dev/shop' }, { project: PROJECT, hideNames: true });
  const b = mapEvent({ hook_event_name: 'Stop', session_id: 'T', cwd: '/elsewhere/shop' }, { project: PROJECT, hideNames: true });
  assert.match(a.project.name, /^p-[0-9a-f]{8}$/);
  assert.equal(a.project.name, b.project.name, 'same project key → same hash');
  assert.ok(!('repo_url' in a.project) && !('cwd' in a));
  assert.ok(!JSON.stringify(a).includes('shop') && !JSON.stringify(a).includes('acme'));
  // no remote: the key is the cwd basename, as on the fleet side
  assert.equal(hiddenName({ name: 'x' }, '/a/b/api'), hiddenName({ name: 'y' }, '/c/api'));
  assert.notEqual(hiddenName({ name: 'x' }, '/a/b/api'), hiddenName({ name: 'x' }, '/a/b/web'));
});

test('git remotes normalise to https with credentials and .git stripped; local paths give no repo_url', () => {
  const cases = {
    'git@github.com:org/repo.git': 'https://github.com/org/repo',
    'ssh://git@github.com:22/org/repo.git': 'https://github.com/org/repo',
    'https://user:ghp_TOKEN@github.com/org/repo.git': 'https://github.com/org/repo',
    'https://x-access-token@gitlab.example.com:8443/g/sub/repo/': 'https://gitlab.example.com:8443/g/sub/repo',
    'git://example.com/org/repo': 'https://example.com/org/repo',
    '/srv/git/repo.git': null,
    'file:///srv/git/repo.git': null,
    '../relative/repo': null,
    '': null,
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(normalizeRemote(raw), want, raw);
});

test('project identity comes from origin, else the cwd basename', () => {
  const repo = join(tmp(), 'checkout-dir');
  mkdirSync(repo);
  git(['init', '--quiet'], { cwd: repo });
  assert.deepEqual(resolveProject(repo), { name: 'checkout-dir' });
  git(['remote', 'add', 'origin', 'git@github.com:acme/shop.git'], { cwd: repo });
  assert.deepEqual(resolveProject(repo), { name: 'shop', repo_url: 'https://github.com/acme/shop' });
  const plain = join(tmp(), 'notes');
  mkdirSync(plain);
  assert.deepEqual(resolveProject(plain), { name: 'notes' });
});

// ── the hot path ───────────────────────────────────────────────────────────────

test('enqueue: not connected and paused queue nothing; project is resolved once per session and cwd', () => {
  const dir = tmp();
  assert.equal(enqueueHookEvent({ hook_event_name: 'Stop', session_id: 'S', cwd: '/w' }, { dir }).why, 'not-connected');
  connected(dir, DOWN, { paused: true });
  assert.equal(enqueueHookEvent({ hook_event_name: 'Stop', session_id: 'S', cwd: '/w' }, { dir }).why, 'paused');
  connected(dir, DOWN);
  let forks = 0;
  const resolve = (cwd) => { forks++; return { name: 'w', repo_url: 'https://h/o/w' }; };
  for (const h of ['SessionStart', 'UserPromptSubmit', 'Stop', 'UserPromptSubmit']) {
    assert.equal(enqueueHookEvent({ hook_event_name: h, session_id: 'S', cwd: '/w' }, { dir, resolve }).queued, true);
  }
  assert.equal(forks, 1, 'git forked once for the session, not per event');
  enqueueHookEvent({ hook_event_name: 'Stop', session_id: 'OTHER', cwd: '/w' }, { dir, resolve });
  assert.equal(forks, 2, 'a new session re-resolves');
  const q = readQueue(fleetPaths(dir).queue);
  assert.deepEqual(q.map((e) => e.type), ['session_start', 'prompt', 'stop', 'prompt', 'stop']);
  assert.ok(q.every((e) => e.project.repo_url === 'https://h/o/w' && e.cwd === '/w'));
});

test('consecutive tool events for one session coalesce to at most one per 5 s', () => {
  const dir = tmp();
  connected(dir, DOWN);
  const resolve = () => ({ name: 'w' });
  const t0 = Date.parse('2026-10-01T12:00:00Z');
  const fire = (sid, dt, h = 'PreToolUse') => enqueueHookEvent({ hook_event_name: h, session_id: sid, cwd: '/w' }, { dir, resolve, now: t0 + dt }).queued;
  assert.equal(fire('S', 0), true);
  assert.equal(fire('S', 1000, 'PostToolUse'), false);
  assert.equal(fire('S', 4999), false);
  assert.equal(fire('T', 4999), true, 'other sessions are independent');
  assert.equal(fire('S', 5000), true);
  assert.equal(fire('S', 5001, 'Stop'), true, 'non-tool events are never coalesced');
});

test('queue housekeeping: events older than 24 h are dropped and the cap keeps the newest', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const old = ev('old', new Date(now - EVENT_TTL_MS - 1000).toISOString());
  const fresh = Array.from({ length: QUEUE_MAX + 10 }, (_, i) => ev(i, new Date(now - 1000).toISOString()));
  const t = trimQueue([old, ...fresh], { now });
  assert.equal(t.length, QUEUE_MAX);
  assert.equal(t[0].session_id, 's10', 'oldest dropped first');
  assert.equal(t.at(-1).session_id, `s${QUEUE_MAX + 9}`);
  assert.ok(!t.includes(old));
  // and the hot path enforces the cap on its own, without a flusher
  const dir = tmp();
  connected(dir, DOWN);
  fill(dir, fresh);
  enqueueHookEvent(
    { hook_event_name: 'Stop', session_id: 'new', cwd: '/w' },
    { dir, resolve: () => ({ name: 'w' }), now },
  );
  const q = readQueue(fleetPaths(dir).queue);
  assert.equal(q.length, QUEUE_MAX);
  assert.equal(q.at(-1).session_id, 'new');
});

// ── the flusher, against a fake fleet ─────────────────────────────────────────

test('2xx drains the queue in batches of ≤100 with the bearer token and current colour', async () => {
  const f = await fakeFleet();
  const dir = tmp();
  connected(dir, f.url, { color: '#ff0000' });
  fill(dir, Array.from({ length: 250 }, (_, i) => ev(i)));
  const r = await flush({ dir });
  await f.close();
  assert.equal(r.sent, 250);
  assert.deepEqual(f.calls.map((c) => c.body.events.length), [100, 100, 50]);
  assert.ok(f.calls.every((c) => c.url === '/api/ingest/events' && c.auth === 'Bearer tok-secret-abcd' && c.body.color === '#ff0000'));
  assert.equal(f.calls[0].body.events[0].session_id, 's0', 'oldest first');
  assert.equal(readQueue(fleetPaths(dir).queue).length, 0);
  assert.ok(loadState(dir).last_success);
});

test('5xx and network errors keep the queue and back off exponentially from 1 s to 60 s', async () => {
  const f = await fakeFleet([{ status: 503 }]);
  const dir = tmp();
  connected(dir, f.url);
  fill(dir, [ev(1), ev(2)]);
  let t = Date.parse('2026-10-01T12:00:00Z');
  const now = () => t;
  // ts must be fresh relative to the clock we inject
  fill(dir, [ev(1, new Date(t).toISOString()), ev(2, new Date(t).toISOString())]);
  assert.equal((await flush({ dir, now })).why, 'backoff');
  assert.equal(readQueue(fleetPaths(dir).queue).length, 2);
  assert.equal(loadState(dir).backoff_until, t + 1000);
  assert.equal((await flush({ dir, now })).why, 'backoff');
  assert.equal(f.calls.length, 1, 'no request inside the back-off window');
  const seen = [];
  for (let k = 0; k < 8; k++) {
    t = loadState(dir).backoff_until;
    await flush({ dir, now });
    seen.push(loadState(dir).backoff_ms);
  }
  assert.deepEqual(seen, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.match(loadState(dir).last_error.message, /HTTP 503/);
  await f.close();
  // unreachable fleet: same treatment
  connected(dir, DOWN);
  updateState(dir, (s) => { delete s.backoff_until; delete s.backoff_ms; return s; });
  assert.equal((await flush({ dir, now })).why, 'backoff');
  assert.equal(readQueue(fleetPaths(dir).queue).length, 2);
  assert.match(loadState(dir).last_error.message, /ECONNREFUSED — retrying/);
});

test('429 keeps the queue and honours Retry-After', async () => {
  const f = await fakeFleet([{ status: 429, headers: { 'retry-after': '7' } }]);
  const dir = tmp();
  connected(dir, f.url);
  fill(dir, [ev(1)]);
  const t = Date.now();
  assert.equal((await flush({ dir, now: () => t })).why, 'backoff');
  await f.close();
  assert.equal(loadState(dir).backoff_until, t + 7000);
  assert.equal(readQueue(fleetPaths(dir).queue).length, 1);
});

test('401 stops sending, records the error and keeps at most the newest 1000 events', async () => {
  const f = await fakeFleet([{ status: 401 }]);
  const dir = tmp();
  connected(dir, f.url);
  fill(dir, Array.from({ length: 1500 }, (_, i) => ev(i)));
  assert.equal((await flush({ dir })).why, 'auth-failed');
  assert.equal((await flush({ dir, force: true })).why, 'auth-failed', 'stays stopped');
  await f.close();
  assert.equal(f.calls.length, 1);
  const st = loadState(dir);
  assert.equal(st.auth_failed, true);
  assert.match(st.last_error.message, /token invalid or revoked/);
  const q = readQueue(fleetPaths(dir).queue);
  assert.equal(q.length, QUEUE_MAX_AUTH_FAILED);
  assert.equal(q.at(-1).session_id, 's1499');
});

test('413 splits the batch and resends the halves', async () => {
  const f = await fakeFleet([{ status: 413 }, { status: 200 }, { status: 413 }, { status: 200 }, { status: 200 }]);
  const dir = tmp();
  connected(dir, f.url);
  fill(dir, Array.from({ length: 8 }, (_, i) => ev(i)));
  const r = await flush({ dir });
  await f.close();
  assert.equal(r.sent, 8);
  assert.deepEqual(f.calls.map((c) => c.body.events.length), [8, 4, 4, 2, 2]);
  assert.deepEqual(f.calls.slice(1).filter((_, i) => i !== 1).flatMap((c) => c.body.events.map((e) => e.session_id)),
    ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7']);
  assert.equal(readQueue(fleetPaths(dir).queue).length, 0);
});

test('a batch is split client-side to stay under 256 KiB', () => {
  const big = Array.from({ length: 40 }, (_, i) => ({ ...ev(i), cwd: '/x'.repeat(5000) }));
  const chunks = chunkEvents(big, '#4fb3ff');
  assert.ok(chunks.length > 1);
  assert.equal(chunks.flat().length, 40);
  for (const c of chunks) assert.ok(Buffer.byteLength(JSON.stringify({ color: '#4fb3ff', events: c })) <= 256 * 1024);
});

test('400 drops the malformed batch and logs it', async () => {
  const f = await fakeFleet([{ status: 400 }, { status: 200 }]);
  const dir = tmp();
  connected(dir, f.url);
  fill(dir, [ev(1)]);
  await flush({ dir });
  await f.close();
  assert.equal(readQueue(fleetPaths(dir).queue).length, 0);
  assert.match(readFileSync(fleetPaths(dir).log, 'utf8'), /HTTP 400/);
  assert.ok(!readFileSync(fleetPaths(dir).log, 'utf8').includes('tok-secret'));
});

test('the flusher drops expired events instead of sending them', async () => {
  const f = await fakeFleet();
  const dir = tmp();
  connected(dir, f.url);
  fill(dir, [ev('old', new Date(Date.now() - EVENT_TTL_MS - 60_000).toISOString()), ev('new')]);
  await flush({ dir });
  await f.close();
  assert.deepEqual(f.calls.flatMap((c) => c.body.events.map((e) => e.session_id)), ['snew']);
});

// ── settings.json merge ─────────────────────────────────────────────────────────

const USER_SETTINGS = `{
    "model": "opus",
    "hooks": {
        "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "my-guard.sh" } ] } ],
        "Stop": [ { "hooks": [ { "type": "command", "command": "say done" } ] } ]
    }
}
`;
const ourCount = (data) => Object.values(data.hooks || {}).flat().filter((e) => (e.hooks || []).some((h) => h.command.includes(HOOK_MARKER))).length;

test('connect adds our hooks next to the user\'s, twice without duplicating; disconnect restores the file byte for byte', () => {
  const cfg = tmp();
  const file = join(cfg, 'settings.json');
  writeFileSync(file, USER_SETTINGS);
  const cmd = hookCommand('/home/u/.astro/code/hooks');
  assert.ok(registerFleetHooks(cfg, cmd).ok);
  assert.ok(registerFleetHooks(cfg, cmd).ok);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(data.model, 'opus');
  assert.equal(ourCount(data), HOOK_EVENTS.length, 'one entry per event, not two');
  for (const evt of HOOK_EVENTS) assert.equal(data.hooks[evt].filter((e) => e.hooks.some((h) => h.command === cmd)).length, 1, evt);
  assert.equal(data.hooks.PreToolUse[0].hooks[0].command, 'my-guard.sh', 'user hook kept, first');
  assert.equal(data.hooks.Stop[0].hooks[0].command, 'say done');
  assert.equal(data.hooks.PreToolUse[1].matcher, '*');
  assert.ok(!('matcher' in data.hooks.Stop[1]) && !('matcher' in data.hooks.UserPromptSubmit[0]));
  assert.equal(readFileSync(file + BACKUP_SUFFIX, 'utf8'), USER_SETTINGS, 'one-time backup of the original');

  assert.ok(unregisterFleetHooks(cfg).ok);
  assert.equal(readFileSync(file, 'utf8'), USER_SETTINGS, 'exactly as before connect');
});

test('disconnect removes only our hooks when the user changed settings while connected', () => {
  const cfg = tmp();
  const file = join(cfg, 'settings.json');
  writeFileSync(file, USER_SETTINGS);
  registerFleetHooks(cfg, hookCommand('/h'));
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.hooks.Notification.push({ matcher: '*', hooks: [{ type: 'command', command: 'notify-send hi' }] });
  data.theme = 'dark';
  writeFileSync(file, JSON.stringify(data));
  unregisterFleetHooks(cfg);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(ourCount(after), 0);
  assert.equal(after.theme, 'dark');
  assert.deepEqual(after.hooks.Notification, [{ matcher: '*', hooks: [{ type: 'command', command: 'notify-send hi' }] }]);
  assert.deepEqual(Object.keys(after.hooks).sort(), ['Notification', 'PreToolUse', 'Stop']);
});

test('a settings.json that connect created is removed again on disconnect; an unparseable one is never touched', () => {
  const cfg = tmp();
  registerFleetHooks(cfg, hookCommand('/h'));
  assert.ok(existsSync(join(cfg, 'settings.json')));
  unregisterFleetHooks(cfg);
  assert.ok(!existsSync(join(cfg, 'settings.json')));

  const bad = tmp();
  writeFileSync(join(bad, 'settings.json'), '{ not json');
  assert.equal(registerFleetHooks(bad, hookCommand('/h')).ok, false);
  assert.equal(readFileSync(join(bad, 'settings.json'), 'utf8'), '{ not json');
});

// ── connect / status / disconnect ────────────────────────────────────────────────

test('connect probes, writes a 0600 config in a 0700 dir and wires hooks; status redacts the token', async () => {
  const f = await fakeFleet();
  const home = tmp();
  const dir = join(home, '.astro');
  const cfgDir = join(home, '.claude');
  const r = await connect({ url: `${f.url}/`, token: 'tok-secret-wxyz', color: 'FF8800', name: 'alex', frameworkRoot: FRAMEWORK, hooksDir: join(dir, 'code', 'hooks'), configDirs: [cfgDir], dir });
  await f.close();
  assert.equal(r.ok, true, r.error);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, { events: [], color: '#ff8800' }, 'the probe is an empty batch plus the colour, nothing else');
  assert.equal(f.sessions.size, 0, 'connect leaves no session (and so no bay) on the fleet');
  assert.equal(statSync(fleetPaths(dir).config).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.ok(existsSync(join(dir, 'code', 'hooks', 'astro-fleet-hook.mjs')));
  const s = status({ configDirs: [cfgDir], dir });
  assert.equal(s.token, '…wxyz');
  assert.equal(s.url, f.url);
  assert.ok(!JSON.stringify(s).includes('tok-secret'));
  assert.equal(s.config_mode, '0600');
  assert.ok(s.hooks[0].installed);
  assert.ok(setColor('#00aa00', dir).ok);
  assert.equal(status({ dir }).color, '#00aa00');
  disconnect({ configDirs: [cfgDir], dir });
  assert.ok(!existsSync(fleetPaths(dir).config) && !existsSync(fleetPaths(dir).queue));
  assert.equal(status({ dir }).connected, false);
});

test('connect refuses bad input and a rejected token without writing anything', async () => {
  const f = await fakeFleet([{ status: 401 }]);
  const home = tmp();
  const dir = join(home, '.astro');
  const base = { token: 't', frameworkRoot: FRAMEWORK, hooksDir: join(dir, 'h'), configDirs: [join(home, '.claude')], dir };
  assert.match((await connect({ ...base, url: 'http://fleet.example.com' })).error, /https/);
  assert.match((await connect({ ...base, url: f.url, color: '#12345' })).error, /colour/);
  const r = await connect({ ...base, url: f.url });
  await f.close();
  assert.equal(r.ok, false);
  assert.match(r.error, /401 — token invalid or revoked/);
  assert.ok(!existsSync(fleetPaths(dir).config));
  assert.ok(!existsSync(join(home, '.claude', 'settings.json')));
});

test('the connect probe passes on 400 "no recognised events" and on 200, and fails on anything else', async () => {
  const run = async (script, opts) => {
    const f = await fakeFleet(script, opts);
    const home = tmp();
    const dir = join(home, '.astro');
    const r = await connect({ url: f.url, token: 'tok', frameworkRoot: FRAMEWORK, hooksDir: join(dir, 'h'), configDirs: [join(home, '.claude')], dir });
    await f.close();
    assert.ok(f.calls.every((c) => Array.isArray(c.body.events) && c.body.events.length === 0), 'only empty batches are sent');
    assert.ok(f.calls.every((c) => c.auth === 'Bearer tok'));
    assert.equal(f.sessions.size, 0);
    assert.equal(existsSync(fleetPaths(dir).config), r.ok, 'config written exactly when connected');
    return r;
  };
  assert.equal((await run([{ status: 200 }])).ok, true, 'today\'s fleet: 400 no recognised events');
  assert.equal((await run([{ status: 200 }], { acceptEmpty: true })).ok, true, 'a fleet that accepts empty batches');
  const other = await run([{ status: 400, body: { error: 'malformed JSON' } }]);
  assert.equal(other.ok, false);
  assert.match(other.error, /HTTP 400 — .*malformed JSON/);
  assert.match((await run([{ status: 400, body: 'no recognised events' }])).error, /HTTP 400/, 'the text must be the JSON error field');
  assert.match((await run([{ status: 401 }])).error, /token invalid or revoked/);
  assert.match((await run([{ status: 404 }])).error, /no ingest endpoint at that URL \(is fleet phase 36 deployed\?\)/);
  assert.match((await run([{ status: 429, headers: { 'retry-after': '1' } }])).error, /rate limited, try again in a second/);
  assert.match((await run([{ status: 500 }])).error, /HTTP 500/);
});

// ── the hook process itself ──────────────────────────────────────────────────────

function runHook(home, payload) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, HOME: home, ASTRO_FLEET_DIR: '' },
  });
  return { ...r, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

test('the hook exits 0, silently and within budget: config missing, paused, server down, URL unreachable', () => {
  const payload = { hook_event_name: 'PreToolUse', session_id: 'S', cwd: FRAMEWORK, ...SENSITIVE };
  const scenarios = {
    'config missing': () => {},
    paused: (d) => connected(d, DOWN, { paused: true }),
    'server down': (d) => connected(d, DOWN),
    'URL unreachable': (d) => connected(d, 'https://10.255.255.1'),
  };
  // Node's own cold start is most of the budget; measure a no-op process as the floor
  // so the assertion is about the hook's work, not this machine's speed.
  const floor = runHook(tmp(), {}).ms;
  for (const [name, setup] of Object.entries(scenarios)) {
    const home = tmp();
    setup(join(home, '.astro'));
    const r = runHook(home, payload);
    assert.equal(r.status, 0, name);
    assert.equal(r.stdout, '', `${name}: no stdout`);
    assert.equal(r.stderr, '', `${name}: no stderr`);
    assert.ok(r.ms < Math.max(500, floor + 150), `${name}: took ${r.ms.toFixed(0)} ms`);
    const q = readQueue(join(home, '.astro', 'fleet-queue.jsonl'));
    assert.equal(q.length, name === 'server down' || name === 'URL unreachable' ? 1 : 0, name);
    if (q.length) assert.ok(!JSON.stringify(q).includes('SECRET'));
  }
  // garbage on stdin is still exit 0 and silent
  const home = tmp();
  connected(join(home, '.astro'), DOWN);
  const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
});

test('end to end: the hook queues, its detached flusher delivers to the fleet', async () => {
  const f = await fakeFleet();
  const home = tmp();
  connected(join(home, '.astro'), f.url);
  const child = spawn(process.execPath, [HOOK], { env: { ...process.env, HOME: home, ASTRO_FLEET_DIR: '' }, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'E2E', cwd: FRAMEWORK, source: 'startup' }));
  await new Promise((r) => child.on('exit', r));
  for (let i = 0; i < 100 && !f.calls.length; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 100));
  await f.close();
  assert.equal(f.calls.length, 1);
  const [e] = f.calls[0].body.events;
  assert.equal(e.type, 'session_start');
  assert.equal(e.session_id, 'E2E');
  assert.equal(e.cwd, FRAMEWORK);
  assert.ok(e.project.name);
  assert.equal(readQueue(join(home, '.astro', 'fleet-queue.jsonl')).length, 0);
});

test('ac fleet CLI: connect → status → pause → disconnect against a fake fleet, with HOME isolated', async () => {
  const f = await fakeFleet();
  const home = tmp();
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '', ASTRO_FLEET_DIR: '' };
  delete env.CLAUDE_CONFIG_DIR;
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'settings.json'), USER_SETTINGS);
  const ac = (...args) => new Promise((resolve) => {
    const c = spawn(process.execPath, [AC, 'fleet', ...args], { env, cwd: home });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code) => resolve({ code, out, err }));
  });
  let r = await ac('connect', f.url, '--token', 'tok-cli-9876', '--color', '#4fb3ff', '--name', 'alex');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /connected ✓/);
  assert.ok(!r.out.includes('tok-cli-9876'));
  r = await ac('connect', f.url, '--token', 'tok-cli-9876');
  assert.equal(r.code, 0, r.err);
  assert.equal(ourCount(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))), HOOK_EVENTS.length);
  r = await ac('status');
  assert.match(r.out, /Token:\s+…9876/);
  assert.ok(!r.out.includes('tok-cli'));
  assert.match((await ac('pause')).out, /paused/);
  assert.match((await ac('status')).out, /Reporting: paused/);
  assert.equal((await ac('connect', f.url, '--token', 't', '--bogus')).code, 1, 'unknown flags are refused');
  r = await ac('disconnect');
  assert.equal(r.code, 0, r.err);
  await f.close();
  assert.equal(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'), USER_SETTINGS);
  assert.ok(!existsSync(join(home, '.astro', 'fleet.json')));
  rmSync(home, { recursive: true, force: true });
});
