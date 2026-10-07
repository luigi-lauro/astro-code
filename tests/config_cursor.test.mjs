// Phase 35 t6 — /astro-config must never walk a Cursor session through Claude's
// opus/sonnet tiers. Cursor commands open with the "Running on Cursor" note (the Cursor
// adapter's CURSOR_NOTE, P2) — that phrase is what this branch keys recognition on. Mirrors
// config_codex.test.mjs's shape, including the Codex branch's own narrowed recognition
// sentence so a GPT model running inside Cursor does not mistake itself for Codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'commands', 'astro-config.md'), 'utf8');
const models = (text) => text.slice(text.indexOf('# Models'), text.indexOf('# Agent tools') > 0 ? text.indexOf('# Agent tools') : undefined);
// The Cursor branch: from its heading to the next heading of the same or higher level.
function cursorBranch(text) {
  const m = /^(#{2,3}) On Cursor\b.*$/m.exec(models(text));
  if (!m) return null;
  const rest = models(text).slice(m.index + m[0].length);
  const end = rest.search(new RegExp(`^#{1,${m[1].length}} `, 'm'));
  return end < 0 ? rest : rest.slice(0, end);
}

test('/astro-config Models has a Cursor branch, before "On Codex" and before any tier is offered', () => {
  const sec = models(SRC);
  const branch = cursorBranch(SRC);
  assert.ok(branch, 'the Models section needs an "On Cursor" branch');
  assert.ok(sec.indexOf('On Cursor') < sec.indexOf('On Codex'), 'the Cursor branch must come before the Codex branch');
  assert.ok(sec.indexOf('On Cursor') < sec.indexOf('## Steps'), 'the host check must come before the Claude steps that offer opus/sonnet');
});

test('the Cursor branch is recognised by the "Running on Cursor" note', () => {
  const branch = cursorBranch(SRC) || '';
  assert.match(branch, /Running on Cursor/, 'recognition must key on the note the Cursor adapter prepends (P2)');
});

test('on Cursor it never offers Claude tiers and every role runs on the session model', () => {
  const branch = cursorBranch(SRC) || '';
  assert.match(branch, /never offer\*{0,2}\s*`?opus|do not offer\*{0,2}\s*`?opus/i, 'must forbid offering the Claude tiers');
  assert.match(branch, /session'?s? model|`inherit`/i, 'every role runs on the Cursor session model');
  assert.doesNotMatch(branch, /ac models (balanced|fast|max)/, 'a Claude profile must not be applied from the Cursor branch');
});

test('on Cursor it never writes a model id into the shared config', () => {
  const branch = cursorBranch(SRC) || '';
  assert.match(branch, /shared|committed|teammate/i, 'must say why: config.json is shared with Claude teammates');
  assert.match(branch, /never .*ac config set models\.|ac config set models\.\S* .*never/i, 'must forbid `ac config set models.<role>` on Cursor');
});

test('on Cursor reasoning depth is not applied (lives in the model id suffix) and per-role models are a backlog item', () => {
  const branch = cursorBranch(SRC) || '';
  assert.match(branch, /reasoning/i, 'must mention reasoning depth');
  assert.match(branch, /ac backlog add/, 'per-role Cursor models must be offered as a backlog item, not implemented inline');
});

test('the Codex branch recognition is narrowed so a Cursor session never mistakes itself for Codex', () => {
  const sec = models(SRC);
  const codexHeadingIdx = sec.indexOf('## On Codex');
  assert.ok(codexHeadingIdx >= 0, 'the Codex branch must still exist');
  const codexBranchText = sec.slice(codexHeadingIdx);
  assert.match(codexBranchText, /Running on Cursor/, 'the Codex recognition sentence must exclude the Cursor note');
});
