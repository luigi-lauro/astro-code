// Cursor host adapter — install/uninstall, black-box, subprocess only (phase 35 t3).
//
// RED by design (ADR-018): `cursor-agent`/Cursor is not registered in `HOSTS` yet
// (that lands in t13), so nothing here can pass today — `ac install` cannot detect,
// let alone wire, a host it does not know about. These tests reach the adapter only
// by spawning the real `bin/ac.mjs` CLI against a throwaway fake $HOME; they never
// import `lib/hosts/cursor.mjs` (it does not exist yet) or any other `lib/` module,
// so nothing here can crash at module load ahead of t10/t11/t13 landing it.
//
// Every run below uses a CLEAN env (P10/CRITERIA sandbox recipe): HOME is the fake
// home, PATH never carries the real `node`'s dir or any real `cursor-agent`/`agent`/
// `claude`/`codex`, and `CURSOR_CONFIG_DIR`/`CLAUDE_CONFIG_DIR`/`CODEX_HOME` are never
// inherited — so this suite stays green or red for the same reason on every machine,
// including the developer's Mac where `cursor-agent` and astro-agent's `agent` already
// sit on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, lstatSync, readdirSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRAMEWORK = join(dirname(fileURLToPath(import.meta.url)), '..');
const AC = join(FRAMEWORK, 'bin', 'ac.mjs');

function tmpHome(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// A directory holding only the stub binaries named in `names` — never the real ones.
// Each stub is `#!/bin/sh` and, if ever run, appends a marker under $HOME so a test
// can prove it was NEVER executed (C7: `agent` must never be probed or run).
function stubDir(names) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-stub-'));
  for (const name of names) {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\necho stub >> "$HOME/${name}-ran"\nexit 0\n`);
    chmodSync(p, 0o755);
  }
  return dir;
}

// Helper per PLAN t3: spawn the real CLI with a clean env — `extra` is a list of
// PATH entries (stub dirs) to prepend; `env` can additionally set e.g.
// CURSOR_CONFIG_DIR. Never spreads `process.env`.
function run(T, args, { extra = [], env = {} } = {}) {
  return spawnSync(process.execPath, [AC, ...args], {
    env: { HOME: T, PATH: [...extra, '/usr/bin', '/bin'].join(':'), ...env },
    encoding: 'utf8',
    timeout: 60000,
  });
}

function assertAgentNeverRan(T) {
  assert.ok(!existsSync(join(T, 'cursor-agent-ran')), 'cursor-agent must never be executed by install/uninstall');
  assert.ok(!existsSync(join(T, 'agent-ran')), "the binary named `agent` (astro-agent's) must never be probed or run");
}

const sourceCommandNames = () => readdirSync(join(FRAMEWORK, 'commands')).filter((f) => f.endsWith('.md')).sort();
const sourceAgentNames = () => readdirSync(join(FRAMEWORK, 'agents')).filter((f) => f.endsWith('.md')).sort();

// --- C1 -------------------------------------------------------------------------

test('C1 — Cursor-only home: install delivers the full command+agent set as plain files, no other host dir', () => {
  const T = tmpHome('ac-cur-c1-');
  mkdirSync(join(T, '.cursor'), { recursive: true });
  const res = run(T, ['install']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Cursor/, 'install output names Cursor as a wired host');

  const cmdDir = join(T, '.cursor', 'commands');
  const agentDir = join(T, '.cursor', 'agents');
  assert.deepEqual(readdirSync(cmdDir).filter((f) => f.endsWith('.md')).sort(), sourceCommandNames());
  assert.deepEqual(readdirSync(agentDir).filter((f) => f.endsWith('.md')).sort(), sourceAgentNames());

  for (const f of readdirSync(cmdDir)) assert.ok(!lstatSync(join(cmdDir, f)).isSymbolicLink(), `${f} must be a regular file, not a symlink`);
  for (const f of readdirSync(agentDir)) assert.ok(!lstatSync(join(agentDir, f)).isSymbolicLink(), `${f} must be a regular file, not a symlink`);

  assert.ok(!existsSync(join(T, '.claude')), 'install must not create a Claude config dir');
  assert.ok(!existsSync(join(T, '.codex')), 'install must not create a Codex config dir');
  assertAgentNeverRan(T);
});

// --- C2 -------------------------------------------------------------------------

test('C2 — CURSOR_CONFIG_DIR relocates every Cursor artifact; ~/.cursor is never touched', () => {
  const T = tmpHome('ac-cur-c2-');
  const alt = join(T, 'alt-cursor');
  mkdirSync(alt, { recursive: true });
  const res = run(T, ['install'], { env: { CURSOR_CONFIG_DIR: alt } });
  assert.equal(res.status, 0, res.stderr);

  assert.ok(readdirSync(join(alt, 'commands')).some((f) => f.endsWith('.md')), 'commands land under the relocated dir');
  assert.ok(readdirSync(join(alt, 'agents')).some((f) => f.endsWith('.md')), 'agents land under the relocated dir');
  assert.ok(existsSync(join(alt, 'hooks.json')), 'hooks.json lands under the relocated dir (Claude absent → native branch)');
  assert.ok(existsSync(join(alt, 'cli-config.json')), 'cli-config.json lands under the relocated dir');
  assert.ok(!existsSync(join(T, '.cursor')), '~/.cursor must not exist once CURSOR_CONFIG_DIR relocates everything');
  assertAgentNeverRan(T);
});

// --- C3 (install level) ----------------------------------------------------------

test('C3 — installed Cursor commands keep the source body verbatim behind a Cursor host note; other hosts carry no such note', () => {
  const T = tmpHome('ac-cur-c3-');
  mkdirSync(join(T, '.cursor'), { recursive: true });
  const res = run(T, ['install']);
  assert.equal(res.status, 0, res.stderr);

  const installedPlan = readFileSync(join(T, '.cursor', 'commands', 'astro-plan.md'), 'utf8');
  assert.match(installedPlan, /^---\n/, 'installed command starts with frontmatter');
  assert.match(installedPlan, /Running on Cursor/, 'installed command carries the Cursor host note');

  const sourcePlan = readFileSync(join(FRAMEWORK, 'commands', 'astro-plan.md'), 'utf8');
  const sourceBody = sourcePlan.replace(/^---\n[\s\S]*?\n---\n/, '');
  assert.ok(installedPlan.includes(sourceBody.trim()), 'source body appears verbatim in the installed file');

  const claudeHome = tmpHome('ac-cur-c3-claude-');
  mkdirSync(join(claudeHome, '.claude'), { recursive: true });
  const claudeRes = run(claudeHome, ['install']);
  assert.equal(claudeRes.status, 0, claudeRes.stderr);
  const claudeInstalledPlan = readFileSync(join(claudeHome, '.claude', 'commands', 'astro-plan.md'), 'utf8');
  assert.doesNotMatch(claudeInstalledPlan, /Running on Cursor/, "Claude's own copy must never carry the Cursor note");

  assertAgentNeverRan(T);
  assertAgentNeverRan(claudeHome);
});

// --- C5 -------------------------------------------------------------------------

function seedCursorUserFiles(dir) {
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({
    version: 1,
    hooks: { stop: [{ command: 'echo user-stop' }], afterFileEdit: [{ command: 'echo user-edit' }] },
  }));
  writeFileSync(join(dir, 'cli-config.json'), JSON.stringify({
    permissions: { allow: ['Shell(ls)'] },
    editor: { vimMode: true },
  }));
}

test('C5 — Claude absent: install wires native hooks + status line into Cursor, merged with the user\'s own entries', () => {
  const T = tmpHome('ac-cur-c5-');
  mkdirSync(join(T, '.cursor'), { recursive: true });
  seedCursorUserFiles(join(T, '.cursor'));

  const res = run(T, ['install']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Cursor.*hooks: native/, '(e) install output states the native-hooks branch was taken');

  const hooksPath = join(T, '.cursor', 'hooks.json');
  const cfgPath = join(T, '.cursor', 'cli-config.json');
  const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
  assert.equal(hooks.version, 1);
  assert.deepEqual(hooks.hooks.stop.find((h) => h.command === 'echo user-stop'), { command: 'echo user-stop' }, '(a) user stop entry intact');
  assert.ok(hooks.hooks.afterFileEdit.some((h) => h.command === 'echo user-edit'), '(a) user afterFileEdit entry intact');
  const astroHookCommands = Object.values(hooks.hooks).flat().filter((h) => /astro-/.test(h.command || ''));
  assert.ok(astroHookCommands.length > 0, '(a) astro-code entries were added');

  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.deepEqual(cfg.permissions, { allow: ['Shell(ls)'] }, '(b) user config keys survive deep-equal');
  assert.deepEqual(cfg.editor, { vimMode: true }, '(b) user config keys survive deep-equal');
  assert.ok(cfg.statusLine && typeof cfg.statusLine.command === 'string', '(b) a statusLine command was wired');
  const sl = spawnSync('sh', ['-c', cfg.statusLine.command], { env: { HOME: T }, input: '{}', encoding: 'utf8', timeout: 10000 });
  assert.equal(sl.status, 0, '(b) statusLine command exits 0');
  assert.ok(sl.stdout.split('\n').some((l) => l.trim().length > 0), '(b) statusLine command prints a non-empty line');

  // (c) drift guard: every Claude hook event astro-code registers must be mapped
  // into a Cursor hooks.json key, or skipped and said so.
  const claudeHome = tmpHome('ac-cur-c5-claude-');
  mkdirSync(join(claudeHome, '.claude'), { recursive: true });
  assert.equal(run(claudeHome, ['install']).status, 0);
  const settings = JSON.parse(readFileSync(join(claudeHome, '.claude', 'settings.json'), 'utf8'));
  const claudeEvents = Object.keys(settings.hooks || {}).filter((evt) =>
    (settings.hooks[evt] || []).some((e) => (e.hooks || []).some((h) => /astro-/.test(h.command || ''))));
  assert.ok(claudeEvents.length > 0, 'sanity: the Claude-only install registers at least one astro hook event');
  const EVENT_MAP = { SessionStart: 'sessionStart', PreCompact: 'preCompact', UserPromptSubmit: 'beforeSubmitPrompt', Stop: 'stop' };
  for (const evt of claudeEvents) {
    const cursorName = EVENT_MAP[evt];
    const mapped = cursorName && Array.isArray(hooks.hooks[cursorName]) &&
      hooks.hooks[cursorName].some((h) => /astro-/.test(h.command || ''));
    const skipped = new RegExp(`skipped.*${evt}|${evt}.*skipped`, 'i').test(res.stdout);
    assert.ok(mapped || skipped, `(c) Claude hook event "${evt}" must be mapped into Cursor or named as skipped — unaccounted for`);
  }

  // (d) every astro hook command in hooks.json points at a script that exists
  // and runs cleanly under the fake HOME.
  for (const h of astroHookCommands) {
    const scriptMatch = h.command.match(/"([^"]+\.mjs)"/);
    assert.ok(scriptMatch, `astro hook command names a .mjs script: ${h.command}`);
    assert.ok(existsSync(scriptMatch[1]), `astro hook script exists on disk: ${scriptMatch[1]}`);
    const out = spawnSync('sh', ['-c', h.command], { env: { HOME: T }, input: '{}', encoding: 'utf8', timeout: 10000 });
    assert.equal(out.status, 0, `(d) astro hook command exits 0: ${h.command}\n${out.stderr}`);
  }

  // (f) re-running install is idempotent — byte-identical files.
  const hooksBefore = readFileSync(hooksPath, 'utf8');
  const cfgBefore = readFileSync(cfgPath, 'utf8');
  assert.equal(run(T, ['install']).status, 0);
  assert.equal(readFileSync(hooksPath, 'utf8'), hooksBefore, '(f) second install leaves hooks.json byte-identical');
  assert.equal(readFileSync(cfgPath, 'utf8'), cfgBefore, '(f) second install leaves cli-config.json byte-identical');

  assertAgentNeverRan(T);
  assertAgentNeverRan(claudeHome);
});

// --- C6 -------------------------------------------------------------------------

test('C6 — Claude present: install strips any native Cursor hooks/statusline and says Cursor runs the Claude hooks via import', () => {
  const T = tmpHome('ac-cur-c6-');
  mkdirSync(join(T, '.cursor'), { recursive: true });
  seedCursorUserFiles(join(T, '.cursor'));
  assert.equal(run(T, ['install']).status, 0); // native branch first, as in C5

  mkdirSync(join(T, '.claude'), { recursive: true });
  const res = run(T, ['install']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Cursor.*via Claude Code import/, 'install output states the import branch');

  const hooks = JSON.parse(readFileSync(join(T, '.cursor', 'hooks.json'), 'utf8'));
  const allEntries = Object.values(hooks.hooks).flat();
  assert.equal(allEntries.length, 2, 'hooks.json holds exactly the two user entries');
  assert.ok(allEntries.every((h) => !/astro-/.test(h.command || '')), 'no astro-code entry remains in hooks.json');

  const cfg = JSON.parse(readFileSync(join(T, '.cursor', 'cli-config.json'), 'utf8'));
  assert.ok(!cfg.statusLine, 'no astro-code statusLine remains once Claude is present');
  assert.deepEqual(cfg.permissions, { allow: ['Shell(ls)'] });
  assert.deepEqual(cfg.editor, { vimMode: true });

  const settings = JSON.parse(readFileSync(join(T, '.claude', 'settings.json'), 'utf8'));
  assert.match(JSON.stringify(settings.hooks || {}), /astro-/, "Claude's own settings.json received astro-code's hooks");

  assert.deepEqual(readdirSync(join(T, '.cursor', 'commands')).filter((f) => f.endsWith('.md')).sort(), sourceCommandNames(),
    'Cursor commands remain installed');
  assert.deepEqual(readdirSync(join(T, '.cursor', 'agents')).filter((f) => f.endsWith('.md')).sort(), sourceAgentNames(),
    'Cursor agents remain installed');

  // Fresh home, both hosts present from the start: both wired, no astro entry in Cursor's files.
  const both = tmpHome('ac-cur-c6-both-');
  mkdirSync(join(both, '.claude'), { recursive: true });
  mkdirSync(join(both, '.cursor'), { recursive: true });
  const bothRes = run(both, ['install']);
  assert.equal(bothRes.status, 0, bothRes.stderr);
  assert.ok(readdirSync(join(both, '.cursor', 'commands')).some((f) => f.endsWith('.md')), 'Cursor wired');
  assert.ok(readdirSync(join(both, '.claude', 'commands')).some((f) => f.endsWith('.md')), 'Claude wired');
  for (const f of ['hooks.json', 'cli-config.json']) {
    const p = join(both, '.cursor', f);
    if (!existsSync(p)) continue; // absent files are fine (C6)
    const data = JSON.parse(readFileSync(p, 'utf8'));
    assert.doesNotMatch(JSON.stringify(data), /astro-/, `no astro-code entry in Cursor's ${f} when Claude is present from the start`);
  }

  assertAgentNeverRan(T);
  assertAgentNeverRan(both);
});

// --- C7 -------------------------------------------------------------------------

test('C7 — detection is config-dir-or-cursor-agent; the binary named `agent` is never probed or run', () => {
  // (a) neither signal present → Cursor not wired, no $T/.cursor, no "Cursor →" line.
  const Ta = tmpHome('ac-cur-c7a-');
  const agentOnly = stubDir(['agent']);
  const resA = run(Ta, ['install'], { extra: [agentOnly] });
  assert.equal(resA.status, 0, resA.stderr);
  assert.ok(!existsSync(join(Ta, '.cursor')), '(a) no .cursor dir is created with neither signal present');
  assert.doesNotMatch(resA.stdout, /Cursor\s*→/, '(a) no "Cursor →" line when neither signal is present');
  assertAgentNeverRan(Ta);

  // (b) a stub cursor-agent on PATH only (no .cursor dir) → Cursor gets wired.
  const Tb = tmpHome('ac-cur-c7b-');
  const cursorAgentOnly = stubDir(['cursor-agent', 'agent']);
  const resB = run(Tb, ['install'], { extra: [cursorAgentOnly] });
  assert.equal(resB.status, 0, resB.stderr);
  assert.ok(existsSync(join(Tb, '.cursor', 'commands')), '(b) a stub cursor-agent on PATH is enough to wire Cursor');
  assertAgentNeverRan(Tb);

  // (c) only $T/.cursor present (no binary on PATH at all) → Cursor gets wired.
  const Tc = tmpHome('ac-cur-c7c-');
  mkdirSync(join(Tc, '.cursor'), { recursive: true });
  const resC = run(Tc, ['install']);
  assert.equal(resC.status, 0, resC.stderr);
  assert.ok(existsSync(join(Tc, '.cursor', 'commands')), '(c) an existing .cursor dir alone is enough to wire Cursor');
  assertAgentNeverRan(Tc);

  for (const T of [Ta, Tb, Tc]) {
    assert.equal(run(T, ['uninstall']).status, 0);
    assertAgentNeverRan(T);
  }
});

// --- C9 -------------------------------------------------------------------------

test('C9 — uninstall removes astro-code from Cursor and only astro-code', () => {
  const T = tmpHome('ac-cur-c9-');
  mkdirSync(join(T, '.cursor'), { recursive: true });
  seedCursorUserFiles(join(T, '.cursor'));
  assert.equal(run(T, ['install']).status, 0); // native branch (Claude absent)

  const userCmd = join(T, '.cursor', 'commands', 'my-cmd.md');
  const userAgent = join(T, '.cursor', 'agents', 'my-agent.md');
  writeFileSync(userCmd, '# a user command');
  writeFileSync(userAgent, '# a user agent');
  const hooksBefore = readFileSync(join(T, '.cursor', 'hooks.json'), 'utf8');
  const cfgBefore = JSON.parse(readFileSync(join(T, '.cursor', 'cli-config.json'), 'utf8'));

  const res = run(T, ['uninstall']);
  assert.equal(res.status, 0, res.stderr);

  assert.deepEqual(readdirSync(join(T, '.cursor', 'commands')).filter((f) => f.startsWith('astro-')), [],
    'no astro-* command remains');
  assert.deepEqual(readdirSync(join(T, '.cursor', 'agents')).filter((f) => f.startsWith('astro-')), [],
    'no astro-* agent remains');
  assert.equal(readFileSync(userCmd, 'utf8'), '# a user command', "the user's own command survives unchanged");
  assert.equal(readFileSync(userAgent, 'utf8'), '# a user agent', "the user's own agent survives unchanged");

  const hooksAfter = JSON.parse(readFileSync(join(T, '.cursor', 'hooks.json'), 'utf8'));
  const allEntries = Object.values(hooksAfter.hooks).flat();
  assert.ok(allEntries.some((h) => h.command === 'echo user-stop'), 'user stop hook survives uninstall');
  assert.ok(allEntries.some((h) => h.command === 'echo user-edit'), 'user afterFileEdit hook survives uninstall');
  assert.ok(allEntries.every((h) => !/astro-/.test(h.command || '')), 'no astro-code hook entry remains');

  const cfgAfter = JSON.parse(readFileSync(join(T, '.cursor', 'cli-config.json'), 'utf8'));
  assert.deepEqual(cfgAfter.permissions, cfgBefore.permissions, "user cli-config.json keys survive unchanged");
  assert.deepEqual(cfgAfter.editor, cfgBefore.editor, "user cli-config.json keys survive unchanged");
  assert.ok(!cfgAfter.statusLine, 'no astro-code statusLine remains after uninstall');

  assert.ok(existsSync(join(T, '.cursor')), '$T/.cursor itself must still exist');
  assert.ok(hooksBefore.length > 0); // sanity: we actually captured a pre-uninstall snapshot

  assertAgentNeverRan(T);
});
