// The cross-host agent runner: astro-code owns wave orchestration, each host
// only answers "how do I invoke one headless agent".
//
// Every test here injects a fake spawn, so the whole orchestration layer is
// verified without spending a token or needing any harness installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getHost } from '../lib/hosts/index.mjs';
import { runWave, buildInvocation, defaultSpawn } from '../lib/hosts/runner.mjs';
import { missingFromWave } from '../lib/waves.mjs';

const claude = getHost('claude');
const codex = getHost('codex');

/** A spawn stub: decides per-call from the argv it is handed. */
function fakeSpawn(handler) {
  const calls = [];
  const fn = async (opts) => { calls.push(opts); return handler(opts, calls.length - 1); };
  fn.calls = calls;
  return fn;
}
const ok = (stdout = 'done') => async () => ({ code: 0, stdout, stderr: '' });

// --- argv construction ----------------------------------------------------------

test('Claude runs headless with --print and an appended system prompt', () => {
  const inv = buildInvocation(claude, {
    prompt: 'do it', model: 'opus', systemPrompt: 'you are x', tools: ['Read', 'Bash'],
  });
  assert.equal(inv.command, 'claude');
  assert.ok(inv.args.includes('--print'));
  assert.deepEqual(inv.args.slice(inv.args.indexOf('--model'), inv.args.indexOf('--model') + 2), ['--model', 'opus']);
  assert.ok(inv.args.includes('--append-system-prompt'));
  assert.equal(inv.args[inv.args.length - 1], 'do it');
});

test('Codex delegates worktree isolation to the host; Claude cannot', () => {
  const task = { prompt: 'p', worktree: true, cwd: '/tmp/wt' };
  const c = buildInvocation(codex, task);
  assert.ok(c.args.includes('--worktree'), 'codex isolates natively');
  assert.equal(c.worktreeByHost, true);

  const a = buildInvocation(claude, task);
  assert.ok(!a.args.includes('--worktree'), 'claude has no such flag');
  assert.equal(a.worktreeByHost, false, 'and says so, rather than implying it happened');
  assert.equal(a.cwd, '/tmp/wt', 'so the caller-made worktree is used as the spawn cwd');
});

// --- the honest part: a schema that cannot be enforced --------------------------

test('a schema is enforced by Codex and only REQUESTED on Claude — and it says which', () => {
  const schema = { type: 'object', properties: { verdict: { type: 'string' } } };

  const c = buildInvocation(codex, { prompt: 'p', schema, schemaFile: '/tmp/s.json' });
  assert.ok(c.args.includes('--output-schema'), 'codex enforces it provider-side');
  assert.equal(c.schemaEnforced, true);
  assert.equal(c.args[c.args.length - 1], 'p', 'so the prompt is NOT polluted with the schema');

  const a = buildInvocation(claude, { prompt: 'p', schema });
  assert.equal(a.schemaEnforced, false, 'claude cannot enforce it — must not claim otherwise');
  assert.match(a.args[a.args.length - 1], /ONLY a JSON object/, 'falls back to asking in the prompt');
  assert.match(a.args[a.args.length - 1], /"verdict"/, 'and includes the actual schema');
});

test('schemaEnforced is null when no schema was asked for', () => {
  assert.equal(buildInvocation(claude, { prompt: 'p' }).schemaEnforced, null);
  assert.equal(buildInvocation(codex, { prompt: 'p' }).schemaEnforced, null);
});

// --- orchestration --------------------------------------------------------------

test('a wave runs concurrently up to the cap and returns results positionally', async () => {
  const tasks = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, prompt: `p${i}` }));
  let live = 0;
  let peak = 0;
  const spawnFn = async () => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return { code: 0, stdout: 'x', stderr: '' };
  };
  const results = await runWave(tasks, { host: claude, concurrency: 2, spawnFn });
  assert.equal(results.length, 6);
  assert.ok(results.every((r) => r && r.ok));
  assert.deepEqual(results.map((r) => r.id), tasks.map((t) => t.id), 'positional, in task order');
  assert.ok(peak <= 2, `concurrency cap respected (peak ${peak})`);
});

test('a failed agent becomes a positional HOLE, never a rejected batch', async () => {
  // This mirrors the Workflow tool's parallel() contract, which waves.mjs
  // depends on: a wave that silently lost work is the bug that guarantee
  // exists to prevent.
  const tasks = [{ id: 'a', prompt: '1' }, { id: 'b', prompt: '2' }, { id: 'c', prompt: '3' }];
  const spawnFn = async (o) => (o.args.at(-1) === '2'
    ? { code: 1, stdout: '', stderr: 'boom' }
    : { code: 0, stdout: 'fine', stderr: '' });

  const results = await runWave(tasks, { host: claude, spawnFn });
  assert.equal(results.length, 3);
  assert.equal(results[1], null, 'the failure is a falsy hole at its own index');
  assert.ok(results[0].ok && results[2].ok);

  // and the existing recovery path finds exactly that hole
  assert.deepEqual(missingFromWave(tasks, results).map((t) => t.id), ['b']);
});

test('a spawn that throws is contained, not propagated', async () => {
  const spawnFn = async () => { throw new Error('ENOENT: no such binary'); };
  const results = await runWave([{ id: 'a', prompt: 'x' }], { host: claude, spawnFn });
  assert.deepEqual(results, [null], 'one broken host must not lose the whole wave');
});

test('an empty wave is a no-op, not a hang', async () => {
  assert.deepEqual(await runWave([], { host: claude, spawnFn: ok() }), []);
});

test('a host with no execCommand is rejected loudly', async () => {
  await assert.rejects(
    () => runWave([{ prompt: 'x' }], { host: { id: 'fake' } }),
    /cannot run agents/,
  );
});

// --- result extraction ----------------------------------------------------------

test('json results are parsed, including a JSONL stream where the last line wins', async () => {
  const single = await runWave([{ id: 'a', prompt: 'p', json: true }], {
    host: claude, spawnFn: ok('{"verdict":"pass"}'),
  });
  assert.deepEqual(single[0].result, { verdict: 'pass' });

  const stream = await runWave([{ id: 'a', prompt: 'p', json: true }], {
    host: codex, spawnFn: ok('{"type":"start"}\n{"type":"item"}\n{"verdict":"done"}'),
  });
  assert.deepEqual(stream[0].result, { verdict: 'done' }, 'JSONL: last parseable line');
});

test('unparseable json degrades to raw text instead of throwing', async () => {
  const r = await runWave([{ id: 'a', prompt: 'p', json: true }], {
    host: claude, spawnFn: ok('not json at all'),
  });
  assert.equal(r[0].result, 'not json at all');
});

// --- optional parseResult adapter hook -------------------------------------------

test('a host with parseResult uses it instead of readResult on exit 0', async () => {
  const fakeHost = { id: 'fake', execCommand: () => ({ command: 'fake', args: [] }), parseResult: (stdout) => `parsed:${stdout}` };
  const r = await runWave([{ id: 'a', prompt: 'p' }], { host: fakeHost, spawnFn: ok('raw') });
  assert.equal(r[0].result, 'parsed:raw');
});

test('a nullish parseResult return is a positional hole, same as a non-zero exit', async () => {
  const fakeHost = { id: 'fake', execCommand: () => ({ command: 'fake', args: [] }), parseResult: () => null };
  const events = [];
  const r = await runWave([{ id: 'a', prompt: 'p' }], {
    host: fakeHost, spawnFn: ok('garbage'), onProgress: (e) => events.push(e),
  });
  assert.deepEqual(r, [null]);
  const end = events.find((e) => e.phase === 'end');
  assert.equal(end.ok, false);
  assert.equal(end.error, 'unparseable result');
});

test('parseResult is never called on a non-zero exit', async () => {
  let called = false;
  const fakeHost = {
    id: 'fake', execCommand: () => ({ command: 'fake', args: [] }),
    parseResult: () => { called = true; return 'x'; },
  };
  const r = await runWave([{ id: 'a', prompt: 'p' }], {
    host: fakeHost, spawnFn: async () => ({ code: 1, stdout: '', stderr: 'boom' }),
  });
  assert.equal(r[0], null);
  assert.equal(called, false, 'parseResult must only run on exit 0');
});

test('a throwing parseResult is a positional hole, not a rejected batch', async () => {
  const fakeHost = {
    id: 'fake', execCommand: () => ({ command: 'fake', args: [] }),
    parseResult: () => { throw new Error('boom'); },
  };
  const r = await runWave([{ id: 'a', prompt: 'p' }], { host: fakeHost, spawnFn: ok('raw') });
  assert.deepEqual(r, [null]);
});

test('a host without parseResult keeps the raw-text/JSON readResult fallback', async () => {
  const r = await runWave([{ id: 'a', prompt: 'p' }], { host: claude, spawnFn: ok('plain text') });
  assert.equal(r[0].result, 'plain text');
});

test('progress is reported per task for both start and end', async () => {
  const events = [];
  await runWave([{ id: 'a', prompt: 'p' }], {
    host: claude, spawnFn: ok(), onProgress: (e) => events.push(`${e.phase}:${e.task.id}`),
  });
  assert.deepEqual(events, ['start:a', 'end:a']);
});

test('every task field the adapters accept is actually forwarded', () => {
  // A field silently dropped between the task and the adapter produces argv
  // that looks right in review and is wrong on the wire — which is exactly how
  // --sandbox went missing from the first live Codex run.
  const inv = buildInvocation(codex, {
    prompt: 'p', model: 'gpt-5-codex', sandbox: 'read-only', outFile: '/tmp/o', json: true,
  });
  assert.ok(inv.args.includes('--sandbox'), '--sandbox must reach the argv');
  assert.equal(inv.args[inv.args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(inv.args.includes('--output-last-message'));
  assert.ok(inv.args.includes('--json'));

  const c = buildInvocation(claude, { prompt: 'p', permissionMode: 'acceptEdits' });
  assert.equal(c.args[c.args.indexOf('--permission-mode') + 1], 'acceptEdits');
});

// --- Cursor end-to-end (C8) -------------------------------------------------------
// Pins the whole stack — buildInvocation + spawn + parseResult — for a host that
// already exists (t10/t11). Dynamic import per ADR-018, even though nothing here
// is RED: the adapter is reached only through the runner's public surface.

test('C8: three Cursor tasks through runWave — argv shape, spawn cwd, and parseResult', async () => {
  const cursor = (await import('../lib/hosts/cursor.mjs')).default;
  const tasks = [
    { id: 'a', prompt: 'p1', model: 'm1', worktree: true, cwd: '/tmp/w' },
    { id: 'b', prompt: 'p2', cwd: '/tmp/w' },
    { id: 'c', prompt: 'p3', cwd: '/tmp/w' },
  ];
  const calls = [];
  const spawnFn = async (opts) => {
    calls.push({ command: opts.command, args: opts.args, cwd: opts.cwd });
    const i = calls.length - 1;
    if (i === 0) return { code: 0, stdout: JSON.stringify({ type: 'result', result: 'done-1' }), stderr: '' };
    if (i === 1) return { code: 1, stdout: '', stderr: 'boom' };
    return { code: 0, stdout: 'not json', stderr: '' };
  };
  const results = await runWave(tasks, { host: cursor, spawnFn, concurrency: 1 });

  for (const c of calls) {
    assert.equal(c.command, 'cursor-agent');
    assert.ok(c.args.includes('-p'));
    assert.equal(c.args[c.args.indexOf('--output-format') + 1], 'json');
    assert.ok(c.args.includes('--force'), '--force present');
    assert.ok(c.args.includes('--trust'), '--trust present');
    assert.equal(c.cwd, '/tmp/w', 'spawn cwd comes from the task, not host.execCommand');
  }
  assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'm1', 'task 1 only: --model');
  assert.ok(calls[0].args.includes('-w'), 'task 1 only: -w');
  assert.ok(!calls[1].args.includes('--model') && !calls[1].args.includes('-w'), 'task 2: neither');
  assert.ok(!calls[2].args.includes('--model') && !calls[2].args.includes('-w'), 'task 3: neither');
  assert.equal(calls[0].args.at(-1), 'p1', 'prompt is always the last argv token');
  assert.equal(calls[1].args.at(-1), 'p2');
  assert.equal(calls[2].args.at(-1), 'p3');

  assert.equal(results[0].ok, true);
  assert.equal(results[0].result, 'done-1', 'exit 0 + well-formed result → parseResult wins over readResult');
  assert.equal(results[1], null, 'non-zero exit stays a hole even for a host with parseResult');
  assert.equal(results[2], null, 'exit 0 but unparseable JSON is a hole, not a crash');
});

test('Cursor hang path: a timeout kills the stuck process and the task still resolves to a hole', async () => {
  const cursor = (await import('../lib/hosts/cursor.mjs')).default;
  // Swap in a process that never exits on its own — the real risk this host's
  // header note warns about (`-p` with a history of hanging) — instead of
  // `cursor-agent`'s own argv, and let defaultSpawn's real SIGTERM-on-timeout
  // path do the killing.
  const spawnFn = (opts) => defaultSpawn({
    ...opts, command: process.execPath, args: ['-e', 'setInterval(() => {}, 1e3)'],
  });
  const results = await runWave([{ id: 'a', prompt: 'hang me' }], {
    host: cursor, spawnFn, timeoutMs: 300,
  });
  assert.deepEqual(results, [null], 'the timeout must still resolve the wave, not hang the test');
});
