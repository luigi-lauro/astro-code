// Phase 25 t13 — spec for principles delivery via the SessionStart / PreCompact
// hooks (P10, D1, CRITERIA C10). Spawns hooks/astro-update.mjs and
// hooks/astro-precompact.mjs as real subprocesses against an isolated HOME and a
// seeded ASTRO_PRINCIPLES_DIR store — nothing here touches a developer's real
// `~/.astro/principles`. The hooks do not read principles yet (t14 wires that in),
// so these assertions currently fail RED (ADR-018 applies to hook subprocess specs
// too, per this phase's plan).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { git } from '../lib/git.mjs';

const FRAMEWORK = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE_HOOK = join(FRAMEWORK, 'hooks', 'astro-update.mjs');
const PRECOMPACT_HOOK = join(FRAMEWORK, 'hooks', 'astro-precompact.mjs');
const AC = join(FRAMEWORK, 'bin', 'ac.mjs');

function seededStore(home) {
  const store = mkdtempSync(join(tmpdir(), 'ac-hooks-store-'));
  const env = { ...process.env, HOME: home, ASTRO_PRINCIPLES_DIR: store };
  for (let i = 0; i < 150; i++) {
    spawnSync(process.execPath, [AC, 'principles', 'add', `default statement number ${i}`, '--kind', 'pattern'], { encoding: 'utf8', env });
  }
  for (const [n, why] of [['1', 'WHYRULE1'], ['2', 'WHYRULE2'], ['3', 'WHYRULE3']]) {
    spawnSync(process.execPath, [AC, 'principles', 'add', `rule statement ${n}`, '--kind', 'pattern', '--strength', 'rule', '--why', why], { encoding: 'utf8', env });
  }
  spawnSync(process.execPath, [AC, 'principles', 'add', 'a default with a special why', '--kind', 'pattern', '--why', 'WHYDEFAULT'], { encoding: 'utf8', env });
  return store;
}

function mkProject(home, store) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-hooks-proj-'));
  git(['init', '--quiet'], { cwd: dir });
  git(['config', 'user.email', 'dev@example.com'], { cwd: dir });
  git(['config', 'user.name', 'dev'], { cwd: dir });
  const env = { ...process.env, HOME: home, ASTRO_PRINCIPLES_DIR: store };
  spawnSync(process.execPath, [AC, 'init'], { cwd: dir, encoding: 'utf8', env });
  return dir;
}

function runHook(hook, input, home, store) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ASTRO_PRINCIPLES_DIR: store },
    windowsHide: true,
  });
}

test('SessionStart startup: additionalContext carries all 3 rules + whys + index, never WHYDEFAULT', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ac-hooks-home-'));
  const store = seededStore(home);
  const proj = mkProject(home, store);
  const r = runHook(UPDATE_HOOK, { cwd: proj, source: 'startup' }, home, store);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout || '{}');
  const ctx = out?.hookSpecificOutput?.additionalContext || '';
  assert.ok(ctx.includes('WHYRULE1'));
  assert.ok(ctx.includes('WHYRULE2'));
  assert.ok(ctx.includes('WHYRULE3'));
  assert.ok(!ctx.includes('WHYDEFAULT'));
});

test('SessionStart is present on clear/compact too (banner-skip rule is visual only)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ac-hooks-home-'));
  const store = seededStore(home);
  const proj = mkProject(home, store);
  const r = runHook(UPDATE_HOOK, { cwd: proj, source: 'clear' }, home, store);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout || '{}');
  assert.ok(out?.hookSpecificOutput?.additionalContext);
});

// #116: the SessionStart parts re-deliver the brief on `compact`; PreCompact's
// systemMessage (user-facing) no longer carries a second, uncapped copy.
test('PreCompact systemMessage carries the position note, not the principles brief', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ac-hooks-home-'));
  const store = seededStore(home);
  const proj = mkProject(home, store);
  const r = runHook(PRECOMPACT_HOOK, { cwd: proj }, home, store);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout || '{}');
  assert.ok(!(out.systemMessage || '').includes('WHYRULE1'));
});

test('outside an astro project: no section, no error, exit 0', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ac-hooks-home-'));
  const store = seededStore(home);
  const bare = mkdtempSync(join(tmpdir(), 'ac-hooks-bare-'));
  const r = runHook(UPDATE_HOOK, { cwd: bare, source: 'startup' }, home, store);
  assert.strictEqual(r.status, 0, r.stderr);
});

// ── #116: the brief is split under Claude Code's 10,000-character additionalContext cap ──

const PRINCIPLES_HOOK = join(FRAMEWORK, 'hooks', 'astro-principles.mjs');

function runPart(arg, input, home, store) {
  return spawnSync(process.execPath, [PRINCIPLES_HOOK, arg], {
    input: JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, HOME: home, ASTRO_PRINCIPLES_DIR: store }, windowsHide: true,
  });
}

function bigStore(home, n = 24) {
  const store = mkdtempSync(join(tmpdir(), 'ac-hooks-big-'));
  const env = { ...process.env, HOME: home, ASTRO_PRINCIPLES_DIR: store };
  for (let i = 0; i < n; i++) {
    const r = spawnSync(process.execPath, [AC, 'principles', 'add',
      `RULE${String(i).padStart(2, '0')}START ${'long statement words '.repeat(50)}RULE${String(i).padStart(2, '0')}END`,
      '--kind', 'pattern', '--strength', 'rule', '--why', `BIGWHY${i} ${'reason '.repeat(60)}`], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
  }
  return store;
}

test('#116: a brief over the cap arrives in parts, each under 10,000 characters, every rule whole', () => {
  const home = mkdtempSync(join(tmpdir(), 'ac-hooks-home-'));
  const store = bigStore(home);
  const proj = mkProject(home, store);
  const ctxs = [];
  const first = JSON.parse(runHook(UPDATE_HOOK, { cwd: proj, source: 'compact' }, home, store).stdout || '{}');
  ctxs.push(first?.hookSpecificOutput?.additionalContext || '');
  for (const arg of ['2/4', '3/4', '4/4']) {
    const r = runPart(arg, { cwd: proj, source: 'compact' }, home, store);
    assert.equal(r.status, 0, r.stderr);
    if (r.stdout) ctxs.push(JSON.parse(r.stdout).hookSpecificOutput.additionalContext);
  }
  assert.ok(ctxs.length >= 2, 'the brief was split');
  for (const c of ctxs) assert.ok(c.length <= 10000, `a part is ${c.length} characters`);
  const all = ctxs.join('\n');
  for (let i = 0; i < 24; i++) {
    const id = String(i).padStart(2, '0');
    assert.ok(all.includes(`RULE${id}START`) && all.includes(`RULE${id}END`), `rule ${id} arrived whole`);
  }
  assert.ok(!all.includes('BIGWHY'), 'whys are left to ac principles show');
  assert.match(ctxs[0], /ac principles show <id>/);
  assert.ok(!all.includes('CUT'), 'nothing was cut');
});

test('#116: a part with nothing in it writes nothing (no attachment)', () => {
  const home = mkdtempSync(join(tmpdir(), 'ac-hooks-home-'));
  const store = seededStore(home);
  const proj = mkProject(home, store);
  const r = runPart('4/4', { cwd: proj, source: 'startup' }, home, store);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('#116: principles.sessionBrief false in ~/.astro/config.json turns the hooks\' brief off', () => {
  const home = mkdtempSync(join(tmpdir(), 'ac-hooks-home-'));
  const store = seededStore(home);
  const proj = mkProject(home, store);
  mkdirSync(join(home, '.astro'), { recursive: true });
  writeFileSync(join(home, '.astro', 'config.json'), JSON.stringify({ principles: { sessionBrief: false } }));
  const out = JSON.parse(runHook(UPDATE_HOOK, { cwd: proj, source: 'startup' }, home, store).stdout || '{}');
  assert.equal(out.hookSpecificOutput, undefined);
  assert.equal(runPart('2/4', { cwd: proj, source: 'startup' }, home, store).stdout, '');
});

test('#116: the installer registers one SessionStart entry per extra part, idempotently', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ac-hooks-inst-'));
  const dir = join(home, '.claude');
  mkdirSync(dir, { recursive: true });
  const { registerHooks, unregisterHooks } = await import('../lib/hosts/claude.mjs');
  registerHooks(dir, home);
  registerHooks(dir, home);
  const cmds = () => (JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).hooks?.SessionStart || [])
    .flatMap((e) => e.hooks.map((h) => h.command));
  const parts = cmds().filter((c) => c.includes('astro-principles.mjs'));
  assert.deepEqual(parts.map((c) => c.split(' ').pop()), ['2/4', '3/4', '4/4']);
  unregisterHooks(dir, home);
  assert.equal(cmds().length, 0);
});
