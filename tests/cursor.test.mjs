// Host adapter: Cursor (IDE agent + `cursor-agent` CLI) — core adapter tests.
//
// RED per ADR-018: `lib/hosts/cursor.mjs` does not exist yet (t10/t11 add it).
// Every test reaches it via `await import(...)` inside an async body so a
// missing export fails only that test, not the whole file at module load.
// Env-touching tests save/restore PATH/HOME/CURSOR_CONFIG_DIR so no test
// leaks state into another, and none of them may see a real `cursor-agent`
// or `agent` on this machine's PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRAMEWORK = join(dirname(fileURLToPath(import.meta.url)), '..');
const readCommand = (n) => readFileSync(join(FRAMEWORK, 'commands', `${n}.md`), 'utf8');
const readAgent = (n) => readFileSync(join(FRAMEWORK, 'agents', `${n}.md`), 'utf8');
const commandNames = () => readdirSync(join(FRAMEWORK, 'commands')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
const agentNames = () => readdirSync(join(FRAMEWORK, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));

function withEnv(vars, fn) {
  const keys = Object.keys(vars);
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  for (const k of keys) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

function stubDir(names) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-cursor-bin-'));
  for (const name of names) {
    const file = join(dir, name);
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o755);
  }
  return dir;
}

// --- commands (C3) --------------------------------------------------------------

test('every shipped command renders on Cursor as one file, note + verbatim body', async () => {
  const { default: cursor, CURSOR_NOTE } = await import('../lib/hosts/cursor.mjs');
  for (const name of commandNames()) {
    const source = readCommand(name);
    const files = cursor.renderCommand(name, source);
    assert.equal(files.length, 1, `${name}: Cursor commands are a single file`);
    const [file] = files;
    assert.equal(file.path, `${name}.md`);

    const fmEnd = source.indexOf('\n---', 3);
    const sourceBody = source.slice(fmEnd + 4).replace(/^\r?\n/, '');
    const descMatch = /^description:\s*(.*)$/m.exec(source.slice(0, fmEnd));
    const sourceDescription = descMatch ? descMatch[1].trim() : undefined;

    const outFmEnd = file.content.indexOf('\n---', 3);
    const outFrontmatter = file.content.slice(0, outFmEnd);
    assert.match(outFrontmatter, new RegExp(`description:\\s*${sourceDescription.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
      `${name}: description must survive unchanged`);
    assert.doesNotMatch(outFrontmatter, /allowed-tools/, `${name}: allowed-tools is Claude-only`);

    const idx = file.content.indexOf(sourceBody);
    assert.ok(idx !== -1 && idx > outFmEnd, `${name}: source body must appear verbatim and contiguously`);
    assert.equal(file.content.slice(idx), sourceBody, `${name}: nothing may follow the body but itself`);

    const between = file.content.slice(outFmEnd + 4, idx).replace(/^\r?\n/, '');
    const lead = sourceDescription ? `${sourceDescription}\n\n` : '';
    assert.equal(between, lead + CURSOR_NOTE, `${name}: the menu reads the first body line, so the description leads and CURSOR_NOTE follows`);
    assert.match(CURSOR_NOTE, /Workflow/);
    assert.match(CURSOR_NOTE, /Agent tool/);
    assert.match(CURSOR_NOTE, /subagent/);
    // Live check: the CLI's Task tool rejects any subagent_type outside its
    // built-in enum, so the note must route to explore/generalPurpose with the
    // agent file as the prompt — never tell the model to pass astro-* by name.
    assert.match(CURSOR_NOTE, /`explore`/);
    assert.match(CURSOR_NOTE, /`generalPurpose`/);
    assert.match(CURSOR_NOTE, /readonly: true/);
    assert.match(CURSOR_NOTE, /never pass `astro-\*` as `subagent_type`/);
    assert.match(CURSOR_NOTE, /AskUserQuestion/);
    assert.match(CURSOR_NOTE, /numbered/);

    const sourceArgCount = (source.match(/\$ARGUMENTS/g) || []).length;
    const outArgCount = (file.content.match(/\$ARGUMENTS/g) || []).length;
    assert.equal(outArgCount, sourceArgCount, `${name}: $ARGUMENTS count must be preserved`);
  }
});

// --- agents (C4) -----------------------------------------------------------------

test('every shipped agent renders with name/description/model: inherit and derived readonly', async () => {
  const { default: cursor, isReadonly } = await import('../lib/hosts/cursor.mjs');
  const expectReadonly = {
    'astro-researcher': true,
    'astro-verifier': true,
    'astro-mapper': true,
    'astro-executor': false,
    'astro-planner': false,
    'astro-criteria-author': false, // criteria-author keeps write access because it writes CRITERIA.md itself
  };
  for (const name of agentNames()) {
    const source = readAgent(name);
    const files = cursor.renderAgent(name, source);
    assert.equal(files.length, 1, `${name}: Cursor agents are a single file`);
    const content = files[0].content;
    const fmEnd = content.indexOf('\n---', 3);
    const frontmatter = content.slice(0, fmEnd);
    assert.match(frontmatter, new RegExp(`name:\\s*${name}$`, 'm'));
    assert.match(frontmatter, /description:\s*\S+/);
    assert.match(frontmatter, /model:\s*inherit/);
    assert.doesNotMatch(frontmatter, /\b(opus|sonnet|haiku)\b/);

    const toolsLine = /^tools:\s*(.*)$/m.exec(source)[1];
    const expected = isReadonly(toolsLine);
    if (name in expectReadonly) assert.equal(expected, expectReadonly[name], `${name}: pinned readonly expectation`);
    if (expected) assert.match(frontmatter, /readonly:\s*true/, `${name}: readonly must be present when derived true`);
    else assert.doesNotMatch(frontmatter, /readonly:/, `${name}: readonly key omitted when not read-only`);
  }
});

test('readonly is derived from tools, never a hard-coded name list', async () => {
  const { default: cursor, isReadonly } = await import('../lib/hosts/cursor.mjs');

  // mapper + Write → no longer read-only
  const mapperSrc = readAgent('astro-mapper');
  const mutatedMapper = mapperSrc.replace(/^tools:\s*(.*)$/m, (m, p1) => `tools: ${p1}, Write`);
  assert.ok(!isReadonly(/^tools:\s*(.*)$/m.exec(mutatedMapper)[1]));
  const mapperFiles = cursor.renderAgent('astro-mapper', mutatedMapper);
  assert.doesNotMatch(mapperFiles[0].content, /readonly:\s*true/, 'mapper + Write must not render readonly');

  // criteria-author minus Write → becomes read-only (proves derivation, not a list)
  const authorSrc = readAgent('astro-criteria-author');
  const mutatedAuthor = authorSrc.replace(/^tools:\s*(.*)$/m, (m, p1) =>
    `tools: ${p1.split(',').map((s) => s.trim()).filter((t) => t !== 'Write').join(', ')}`);
  assert.ok(isReadonly(/^tools:\s*(.*)$/m.exec(mutatedAuthor)[1]));
  const authorFiles = cursor.renderAgent('astro-criteria-author', mutatedAuthor);
  assert.match(authorFiles[0].content, /readonly:\s*true/, 'criteria-author minus Write must render readonly');
});

// --- execCommand (C7/C8) ----------------------------------------------------------

test('execCommand names cursor-agent and builds the documented argv, prompt last', async () => {
  const { default: cursor } = await import('../lib/hosts/cursor.mjs');
  const { command, args } = cursor.execCommand({
    prompt: 'hi', cwd: '/tmp/w', model: 'm1', worktree: true, sandbox: 'enabled',
  });
  assert.equal(command, 'cursor-agent');
  assert.ok(args.includes('-p'));
  assert.deepEqual(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2),
    ['--output-format', 'json']);
  assert.ok(args.includes('--force'));
  assert.ok(args.includes('--trust'));
  assert.deepEqual(args.slice(args.indexOf('--workspace'), args.indexOf('--workspace') + 2),
    ['--workspace', '/tmp/w']);
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'm1']);
  assert.ok(args.includes('-w'));
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2),
    ['--sandbox', 'enabled']);
  assert.equal(args[args.length - 1], 'hi', 'the prompt is the trailing positional');
  assert.notEqual(args[args.length - 2], '-w', '-w must never be the token right before the prompt');
});

test('execCommand omits optional flags that were not asked for', async () => {
  const { default: cursor } = await import('../lib/hosts/cursor.mjs');
  const { args } = cursor.execCommand({ prompt: 'x' });
  for (const flag of ['--model', '-w', '--workspace', '--sandbox']) {
    assert.ok(!args.includes(flag), `${flag} must not appear unrequested`);
  }
  assert.equal(args[args.length - 1], 'x');
});

test('capabilities match worktree true, outputSchema false, reasoning false', async () => {
  const { default: cursor } = await import('../lib/hosts/cursor.mjs');
  assert.deepEqual(cursor.capabilities, { worktree: true, outputSchema: false, reasoning: false });
});

// --- parseResult (P6) -------------------------------------------------------------

test('parseResult extracts .result from a single JSON object', async () => {
  const { default: cursor } = await import('../lib/hosts/cursor.mjs');
  assert.equal(cursor.parseResult('{"type":"result","result":"done-1"}', {}), 'done-1');
});

test('parseResult reads the last parseable line of a JSONL stream', async () => {
  const { default: cursor } = await import('../lib/hosts/cursor.mjs');
  const stream = [
    '{"type":"system"}',
    '{"type":"assistant","message":"thinking"}',
    '{"type":"result","result":"done-2"}',
  ].join('\n');
  assert.equal(cursor.parseResult(stream, {}), 'done-2');
});

test('parseResult returns null for non-JSON, empty, error or non-result output', async () => {
  const { default: cursor } = await import('../lib/hosts/cursor.mjs');
  assert.equal(cursor.parseResult('not json', {}), null);
  assert.equal(cursor.parseResult('', {}), null);
  assert.equal(cursor.parseResult('{"type":"result","result":"x","is_error":true}', {}), null);
  assert.equal(cursor.parseResult('{"type":"system","foo":"bar"}', {}), null);
});

// --- detect / configTargets (C2/C7) -----------------------------------------------

test('detect is false with neither config dir nor cursor-agent on PATH', async () => {
  const { default: cursor } = await import('../lib/hosts/cursor.mjs');
  const emptyDir = mkdtempSync(join(tmpdir(), 'ac-cursor-empty-'));
  const fakeHome = mkdtempSync(join(tmpdir(), 'ac-cursor-home-'));
  await withEnv({ HOME: fakeHome, CURSOR_CONFIG_DIR: undefined, PATH: emptyDir }, () => {
    assert.equal(cursor.detect(), false);
  });
});

test('detect is true when cursor-agent is on PATH', async () => {
  const { default: cursor } = await import('../lib/hosts/cursor.mjs');
  const fakeHome = mkdtempSync(join(tmpdir(), 'ac-cursor-home-'));
  const dir = stubDir(['cursor-agent']);
  await withEnv({ HOME: fakeHome, CURSOR_CONFIG_DIR: undefined, PATH: dir }, () => {
    assert.equal(cursor.detect(), true);
  });
});

test('detect never probes or trusts a binary named agent', async () => {
  const { default: cursor } = await import('../lib/hosts/cursor.mjs');
  const fakeHome = mkdtempSync(join(tmpdir(), 'ac-cursor-home-'));
  const dir = stubDir(['agent']);
  await withEnv({ HOME: fakeHome, CURSOR_CONFIG_DIR: undefined, PATH: dir }, () => {
    assert.equal(cursor.detect(), false, 'a stub named agent alone must never satisfy detection');
  });
});

test('CURSOR_CONFIG_DIR relocates detection and configTargets', async () => {
  const { default: cursor } = await import('../lib/hosts/cursor.mjs');
  const fakeHome = mkdtempSync(join(tmpdir(), 'ac-cursor-home-'));
  const alt = mkdtempSync(join(tmpdir(), 'ac-cursor-alt-'));
  const emptyDir = mkdtempSync(join(tmpdir(), 'ac-cursor-empty-'));
  await withEnv({ HOME: fakeHome, CURSOR_CONFIG_DIR: alt, PATH: emptyDir }, () => {
    assert.equal(cursor.detect(), true);
    const targets = cursor.configTargets();
    assert.equal(targets.size, 1);
    assert.ok(targets.has(alt), 'configTargets must contain exactly the CURSOR_CONFIG_DIR path');
  });
});

test('id, label and placement match the plan', async () => {
  const { default: cursor } = await import('../lib/hosts/cursor.mjs');
  assert.equal(cursor.id, 'cursor');
  assert.equal(cursor.label, 'Cursor');
  assert.deepEqual(cursor.placement, { commands: 'commands', agents: 'agents', ext: '.md', mode: 'copy' });
});
