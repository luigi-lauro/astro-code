// Fix 2026-10-02-codex-astro-config-offers-claude-models.
//
// On Codex, /astro-config walked the user through `opus`/`sonnet` tiers: the Models
// section only knew Claude's ladder, so the Codex model offered Claude models and had to
// be argued out of it. Worse than the friction, the obvious "fix" a user reaches for —
// typing a Codex model id into a role — writes it into `.astrocode/config.json`, which is
// SHARED and committed: every Claude teammate's subagents would then be launched with a
// model their host does not have. The command must branch on the host before step 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCommand } from '../lib/hosts/codex.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'commands', 'astro-config.md'), 'utf8');
const models = (text) => text.slice(text.indexOf('# Models'), text.indexOf('# Agent tools') > 0 ? text.indexOf('# Agent tools') : undefined);
// The Codex branch: from its heading to the next heading of the same or higher level.
function codexBranch(text) {
  const m = /^(#{2,3}) On Codex\b.*$/m.exec(models(text));
  if (!m) return null;
  const rest = models(text).slice(m.index + m[0].length);
  const end = rest.search(new RegExp(`^#{1,${m[1].length}} `, 'm'));
  return end < 0 ? rest : rest.slice(0, end);
}

test('/astro-config Models has a Codex branch, reached before any tier is offered', () => {
  const sec = models(SRC);
  const branch = codexBranch(SRC);
  assert.ok(branch, 'the Models section needs an "On Codex" branch');
  assert.ok(sec.indexOf('On Codex') < sec.indexOf('## Steps'), 'the host check must come before the Claude steps that offer opus/sonnet');
});

test('on Codex it never offers Claude tiers and every role runs on the session model', () => {
  const branch = codexBranch(SRC) || '';
  assert.match(branch, /never offer\*{0,2}\s*`?opus|do not offer\*{0,2}\s*`?opus/i, 'must forbid offering the Claude tiers');
  assert.match(branch, /session'?s? model|`inherit`/i, 'every role runs on the Codex session model');
  assert.doesNotMatch(branch, /ac models (balanced|fast|max)/, 'a Claude profile must not be applied from the Codex branch');
});

test('on Codex it never writes a model id into the shared config', () => {
  const branch = codexBranch(SRC) || '';
  assert.match(branch, /shared|committed|teammate/i, 'must say why: config.json is shared with Claude users');
  assert.match(branch, /never .*ac config set models\.|ac config set models\.\S* .*never/i, 'must forbid `ac config set models.<role>` on Codex');
});

test('the Codex-rendered skill carries the Codex branch', () => {
  const [skill] = renderCommand('astro-config', SRC);
  assert.ok(codexBranch(skill.content), 'the rendered SKILL.md must still contain the branch');
});
