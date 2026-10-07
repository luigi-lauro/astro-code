// Cursor host adapter — hook/status-line wiring (phase 35, PLAN.md P7).
//
// Cursor hooks only when Claude Code is absent (otherwise Cursor imports the
// Claude hooks itself and a native wire-up would double-fire), merged into the
// user's own `hooks.json`/`cli-config.json` never clobbered. `lib/hosts/cursor.mjs`
// does not exist yet (t11 implements it), so every new symbol is reached via
// `await import(...)` inside each async test body (ADR-018) — a static import
// here would crash the whole file at module load before a single test ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function withEnv(home, fn) {
  const prev = {
    HOME: process.env.HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR,
  };
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CURSOR_CONFIG_DIR;
  return Promise.resolve(fn()).finally(() => {
    for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CURSOR_CONFIG_DIR']) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

// --- drift guard (C5c) ----------------------------------------------------------

test('ASTRO_HOOKS names exactly the events claude.registerHooks actually writes, and mapHookEvents accounts for every one of them', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'ac-cursor-drift-'));
  await withEnv(fakeHome, async () => {
    const claude = (await import('../lib/hosts/claude.mjs')).default;
    const { ASTRO_HOOKS, mapHookEvents } = await import('../lib/hosts/cursor.mjs');

    const claudeDir = join(fakeHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const home = join(fakeHome, '.astro', 'code');
    mkdirSync(home, { recursive: true });
    claude.registerHooks(claudeDir, home);

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    const scripts = ['astro-update.mjs', 'astro-principles.mjs', 'astro-precompact.mjs', 'astro-session-state.mjs'];
    const writtenEvents = Object.keys(settings.hooks || {}).filter((evt) =>
      (settings.hooks[evt] || []).some((e) =>
        (e.hooks || []).some((h) => typeof h.command === 'string' && scripts.some((s) => h.command.includes(s)))));

    const astroEvents = ASTRO_HOOKS.map((h) => h.event);
    assert.deepEqual(new Set(writtenEvents), new Set(astroEvents),
      'ASTRO_HOOKS must list exactly the events claude.registerHooks writes — a new Claude hook must never go unaccounted for');

    const { mapped, skipped } = mapHookEvents(astroEvents);
    assert.equal(mapped.length + skipped.length, astroEvents.length);
    for (const evt of astroEvents) {
      assert.ok(mapped.some((m) => m.claude === evt) || skipped.includes(evt), `${evt} neither mapped nor skipped`);
    }

    const fake = mapHookEvents(['Notification']);
    assert.deepEqual(fake.mapped, []);
    assert.deepEqual(fake.skipped, ['Notification']);
  });
});

// --- native branch, merge-safe, idempotent, then flip to import (C5, C5f, C6, C10b) ---

test('registerHooks: native merge with Claude absent, idempotent re-run, then flips to import once Claude appears', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'ac-cursor-native-'));
  await withEnv(fakeHome, async () => {
    const cursor = (await import('../lib/hosts/cursor.mjs')).default;

    const dir = join(fakeHome, '.cursor');
    mkdirSync(dir, { recursive: true });
    const home = join(fakeHome, '.astro', 'code');
    mkdirSync(home, { recursive: true });

    const userHooks = {
      version: 1,
      hooks: {
        stop: [{ command: 'echo user-stop' }],
        afterFileEdit: [{ command: 'echo user-edit' }],
      },
    };
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify(userHooks));
    const userConfig = {
      permissions: { allow: ['Shell(ls)'] },
      editor: { vimMode: true },
      statusLine: { type: 'command', command: 'echo user-status' },
    };
    writeFileSync(join(dir, 'cli-config.json'), JSON.stringify(userConfig));

    const report = cursor.registerHooks(dir, home);
    assert.equal(report.branch, 'native');
    assert.deepEqual(new Set(report.events), new Set(['sessionStart', 'preCompact', 'beforeSubmitPrompt', 'stop']));

    const hooksAfter = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8'));
    assert.equal(hooksAfter.version, 1, 'an existing version is kept');

    // the user's two entries survive unchanged (C10b: a wholesale-replace of `hooks` fails this)
    assert.ok(hooksAfter.hooks.stop.some((e) => e.command === 'echo user-stop'), 'user stop entry preserved');
    assert.deepEqual(hooksAfter.hooks.afterFileEdit, userHooks.hooks.afterFileEdit, 'user-only event untouched');

    // one astro entry per mapped event, naming an existing-path-shaped <home>/hooks/<script>
    const astroByEvent = {
      sessionStart: 'astro-update.mjs',
      preCompact: 'astro-precompact.mjs',
      beforeSubmitPrompt: 'astro-session-state.mjs',
      stop: 'astro-session-state.mjs',
    };
    for (const [evt, script] of Object.entries(astroByEvent)) {
      const entries = hooksAfter.hooks[evt] || [];
      const scriptPath = join(home, 'hooks', script);
      assert.ok(entries.some((e) => typeof e.command === 'string' && e.command.includes(scriptPath)),
        `${evt} missing an astro entry naming ${scriptPath}`);
    }

    const cfgAfter = JSON.parse(readFileSync(join(dir, 'cli-config.json'), 'utf8'));
    assert.deepEqual(cfgAfter.permissions, userConfig.permissions, 'unrelated user key preserved');
    assert.deepEqual(cfgAfter.editor, userConfig.editor, 'unrelated user key preserved');
    assert.ok(cfgAfter.statusLine.command.includes('astro-statusline.mjs'), 'statusLine composed with ours');

    const chain = JSON.parse(readFileSync(join(home, 'statusline-chain.json'), 'utf8'));
    assert.deepEqual(chain[dir], userConfig.statusLine, 'original statusLine stashed for restore, keyed by dir');

    // idempotent (C5f): a second run leaves both files byte-identical
    const hooksSnapshot = readFileSync(join(dir, 'hooks.json'), 'utf8');
    const cfgSnapshot = readFileSync(join(dir, 'cli-config.json'), 'utf8');
    const again = cursor.registerHooks(dir, home);
    assert.equal(again.branch, 'native');
    assert.equal(readFileSync(join(dir, 'hooks.json'), 'utf8'), hooksSnapshot, 'no duplicate astro entries, no reformat');
    assert.equal(readFileSync(join(dir, 'cli-config.json'), 'utf8'), cfgSnapshot, 'no duplicate astro entries, no reformat');

    // flip to import (C6): Claude Code appears
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    const flipped = cursor.registerHooks(dir, home);
    assert.equal(flipped.branch, 'import');

    const hooksFinal = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8'));
    assert.deepEqual(hooksFinal, userHooks, 'hooks.json holds exactly the two user entries again');

    const cfgFinal = JSON.parse(readFileSync(join(dir, 'cli-config.json'), 'utf8'));
    assert.deepEqual(cfgFinal.statusLine, userConfig.statusLine, "user's original statusLine restored");
    assert.deepEqual(cfgFinal.permissions, userConfig.permissions);
    assert.deepEqual(cfgFinal.editor, userConfig.editor);
  });
});

// --- fresh install, no pre-existing hooks.json (C5) ----------------------------

test('registerHooks on a brand-new hooks.json writes a required top-level "version": 1', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'ac-cursor-fresh-'));
  await withEnv(fakeHome, async () => {
    const cursor = (await import('../lib/hosts/cursor.mjs')).default;

    const dir = join(fakeHome, '.cursor');
    mkdirSync(dir, { recursive: true });
    const home = join(fakeHome, '.astro', 'code');
    mkdirSync(home, { recursive: true });

    const report = cursor.registerHooks(dir, home);
    assert.equal(report.branch, 'native');

    const hooksAfter = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8'));
    assert.equal(hooksAfter.version, 1, 'a freshly-written hooks.json must carry version: 1');
  });
});

// --- unparseable existing file: touch nothing (part of P7's three-way branch) ---

test('registerHooks leaves an unparseable hooks.json/cli-config.json completely untouched and reports branch:none', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'ac-cursor-bad-'));
  await withEnv(fakeHome, async () => {
    const cursor = (await import('../lib/hosts/cursor.mjs')).default;

    const dir = join(fakeHome, '.cursor');
    mkdirSync(dir, { recursive: true });
    const home = join(fakeHome, '.astro', 'code');
    mkdirSync(home, { recursive: true });

    writeFileSync(join(dir, 'hooks.json'), '{nope');
    const validConfig = JSON.stringify({ editor: { vimMode: true } });
    writeFileSync(join(dir, 'cli-config.json'), validConfig);

    const report = cursor.registerHooks(dir, home);
    assert.equal(report.branch, 'none');
    assert.ok(report.reason, 'reports why nothing was touched');

    assert.equal(readFileSync(join(dir, 'hooks.json'), 'utf8'), '{nope', 'left byte-for-byte untouched');
    assert.equal(readFileSync(join(dir, 'cli-config.json'), 'utf8'), validConfig, 'the sibling file is untouched too');
  });
});

// --- unregisterHooks (C9): removes only ours, restores the stash, safe on a missing dir ---

test('unregisterHooks removes only astro entries and restores the stashed statusLine; no-ops on a missing dir', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'ac-cursor-unreg-'));
  await withEnv(fakeHome, async () => {
    const cursor = (await import('../lib/hosts/cursor.mjs')).default;

    const dir = join(fakeHome, '.cursor');
    mkdirSync(dir, { recursive: true });
    const home = join(fakeHome, '.astro', 'code');
    mkdirSync(home, { recursive: true });

    const userHooks = {
      version: 1,
      hooks: {
        stop: [{ command: 'echo user-stop' }],
        afterFileEdit: [{ command: 'echo user-edit' }],
      },
    };
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify(userHooks));
    const userStatusLine = { type: 'command', command: 'echo user-status' };
    writeFileSync(join(dir, 'cli-config.json'), JSON.stringify({ permissions: { allow: ['Shell(ls)'] }, statusLine: userStatusLine }));

    cursor.registerHooks(dir, home); // native (Claude absent)
    cursor.unregisterHooks(dir, home);

    const hooksAfter = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8'));
    assert.deepEqual(hooksAfter.hooks.stop, userHooks.hooks.stop, "the user's stop entry survives; ours is gone");
    assert.deepEqual(hooksAfter.hooks.afterFileEdit, userHooks.hooks.afterFileEdit);
    for (const evt of ['sessionStart', 'preCompact', 'beforeSubmitPrompt']) {
      assert.ok(!hooksAfter.hooks[evt], `${evt} was astro-only, so removing our entry must drop the empty key`);
    }

    const cfgAfter = JSON.parse(readFileSync(join(dir, 'cli-config.json'), 'utf8'));
    assert.deepEqual(cfgAfter.statusLine, userStatusLine, "the user's original statusLine is restored");
    assert.deepEqual(cfgAfter.permissions, { allow: ['Shell(ls)'] });

    const missingDir = join(fakeHome, 'does-not-exist');
    assert.doesNotThrow(() => cursor.unregisterHooks(missingDir, home));
    assert.ok(!existsSync(missingDir), 'a missing config dir is never created by unregisterHooks');
  });
});
