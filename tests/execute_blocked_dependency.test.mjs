// Reproduction + contract for fix 2026-10-01-execute-phase-dispatches-dependents-of
// (GitHub issue #100).
//
// execute-phase.mjs dispatched a task whose dependency had just come back WITHOUT a
// commit (an executor that stopped at a BLOCKED point), in both the lean batch's
// per-task recovery and the sequential wave loop, and counted every attempt in
// `executed`. Only the completeness audit afterwards noticed the missing commits — by
// then the dependent executor had already run on top of a blocked predecessor.
//
// Contract: a task whose depends_on names a task that did not commit THIS run is not
// dispatched, transitively; it is reported under `blocked` with the id that stopped it;
// and `executed` counts tasks that landed, not attempts.
//
// Driven end-to-end like tests/workflows.test.mjs: the script body is wrapped in an
// AsyncFunction(phase, agent, parallel, log, args) with recording stubs. No git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WF_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows', 'execute-phase.mjs');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const chain = (n, extra = {}) =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`,
    title: `Task ${i + 1}`,
    file: `file${i + 1}.mjs`,
    depends_on: i === 0 ? [] : [`t${i}`],
    done: false,
    ...(extra[`t${i + 1}`] || {}),
  }));

// `blocked`: ids whose per-task executor reports no commit. `batchCommitted`: what the
// batch reports (lean path only).
async function run(args, { tasks, blocked = [], batchCommitted }) {
  const calls = [];
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts });
    const props = (opts.schema && opts.schema.properties) || {};
    if ('tasks' in props) return { tasks };
    if ('committed' in props) return { committed: batchCommitted, summary: 'batch' };
    if ('missing' in props) return { missing: [] };
    if ('integrated' in props) return { integrated: true, branches: [] };
    if ('criteriaFound' in props) return { passed: true, criteriaFound: true, summary: 'ok', criteria: [] };
    if ('ranSuite' in props || 'passed' in props) return { ranSuite: true, passed: true, testsRun: 3 };
    const id = (prompt.match(/^Implement task (\S+)/) || [])[1];
    return blocked.includes(id)
      ? { summary: `BLOCKED — ${id} stopped at an owner-approval point`, branch: 'main', commit: null }
      : { summary: 'done', branch: 'main', commit: `sha-${id}` };
  };
  const parallel = async (thunks) => Promise.all(thunks.map((f) => f()));
  const src = readFileSync(WF_FILE, 'utf8').replace(/^export const meta/m, 'const meta');
  const result = await new AsyncFunction('phase', 'agent', 'parallel', 'log', 'args', src)(
    () => {}, agent, parallel, () => {}, { root: '/tmp/proj', phase: '01-chain', ...args },
  );
  const dispatched = calls
    .map((c) => c.opts && c.opts.label)
    .filter((l) => l && l.startsWith('exec:'))
    .map((l) => l.split(' ')[0]);
  return { result, dispatched };
}

test('lean batch recovery: a task whose dependency did not commit is not dispatched (the issue\'s repro)', async () => {
  const { result, dispatched } = await run(
    { strategy: 'sequential' },
    { tasks: chain(3), batchCommitted: ['t1'], blocked: ['t2'] },
  );
  assert.deepEqual(dispatched, ['exec:batch', 'exec:t2'], 't3 must not be dispatched after t2 came back without a commit');
  assert.equal(result.executed, 1, 'executed counts landed tasks, not attempts');
  assert.deepEqual(result.blocked.map((b) => b.id), ['t2', 't3']);
  assert.match(result.blocked[1].reason, /t2/);
});

test('sequential per-task loop: dependents of a blocked task are skipped, transitively', async () => {
  const { result, dispatched } = await run(
    { strategy: 'sequential', execMode: 'per-task' },
    { tasks: chain(4), blocked: ['t2'] },
  );
  assert.deepEqual(dispatched, ['exec:t1', 'exec:t2']);
  assert.equal(result.executed, 1);
  assert.deepEqual(result.blocked.map((b) => b.id), ['t2', 't3', 't4']);
  assert.match(result.blocked[2].reason, /t3/, 't4 names the dependency that stopped it');
});

test('a declared commit-free task that makes no commit does not block its dependents', async () => {
  const { result, dispatched } = await run(
    { strategy: 'sequential', execMode: 'per-task' },
    { tasks: chain(3, { t2: { no_commit: true } }), blocked: ['t2'] },
  );
  assert.deepEqual(dispatched, ['exec:t1', 'exec:t2', 'exec:t3']);
  assert.equal(result.executed, 3);
  assert.deepEqual(result.blocked, []);
});

test('an all-landed run dispatches everything and blocks nothing', async () => {
  const { result, dispatched } = await run(
    { strategy: 'sequential', execMode: 'per-task' },
    { tasks: chain(3) },
  );
  assert.deepEqual(dispatched, ['exec:t1', 'exec:t2', 'exec:t3']);
  assert.equal(result.executed, 3);
  assert.deepEqual(result.blocked, []);
});
