// #93 — a user can let astro-code's agents call extra MCP tools (e.g. lean-ctx's read-only
// ctx_read/ctx_search/ctx_tree/ctx_glob) without a hand edit that the next `ac install` /
// `ac update` erases. The key lives in ~/.astro/config.json — per user, not per project,
// because the agents are installed once per machine and shared by every project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { readAgentTools, withExtraTools } from '../lib/agenttools.mjs';

const FRAMEWORK = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = readdirSync(join(FRAMEWORK, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
const LEAN = ['mcp__lean-ctx__ctx_read', 'mcp__lean-ctx__ctx_search'];

function home(config) {
  const h = mkdtempSync(join(tmpdir(), 'ac-agt-'));
  if (config !== undefined) {
    mkdirSync(join(h, '.astro'), { recursive: true });
    writeFileSync(join(h, '.astro', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return h;
}
const toolsLine = (text) => (text.match(/^tools:\s*(.*)$/m) || [])[1];

// ── the merge ────────────────────────────────────────────────────────────────

test('withExtraTools appends to the tools line, deduped, and touches nothing else', () => {
  const src = '---\nname: x\ndescription: d\ntools: Read, Grep\ncolor: cyan\n---\n\nBody tools: Read\n';
  const out = withExtraTools(src, ['mcp__a__b', 'Read', 'mcp__a__b']);
  assert.equal(toolsLine(out), 'Read, Grep, mcp__a__b');
  assert.equal(out.replace(/^tools:.*$/m, ''), src.replace(/^tools:.*$/m, ''), 'only the frontmatter tools line changes');
  assert.equal(withExtraTools(src, []), src, 'nothing to add → byte-identical');
});

// ── reading ~/.astro/config.json ─────────────────────────────────────────────

test('readAgentTools: `*` applies to every agent, a named agent adds its own', () => {
  const r = readAgentTools({ home: home({ agent_tools: { '*': LEAN, 'astro-executor': ['mcp__lean-ctx__ctx_edit'] } }), agents: AGENTS });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.forAgent('astro-verifier'), LEAN);
  assert.deepEqual(r.forAgent('astro-executor'), [...LEAN, 'mcp__lean-ctx__ctx_edit']);
});

test('readAgentTools: no file, no key, or an empty key adds nothing and says nothing', () => {
  for (const h of [home(), home({ astrokit: { token: 'x' } }), home({ agent_tools: {} })]) {
    const r = readAgentTools({ home: h, agents: AGENTS });
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.forAgent('astro-planner'), []);
  }
});

test('readAgentTools: only MCP tool names are accepted — a built-in like Write never widens a role', () => {
  const r = readAgentTools({ home: home({ agent_tools: { 'astro-verifier': ['Write', 'mcp__lean-ctx__ctx_read', 7, ''] } }), agents: AGENTS });
  assert.deepEqual(r.forAgent('astro-verifier'), ['mcp__lean-ctx__ctx_read']);
  assert.ok(r.warnings.some((w) => /"Write".*not an MCP tool/.test(w)), r.warnings.join('\n'));
  assert.equal(r.warnings.length, 3);
});

test('readAgentTools: an unknown agent, a non-list value or broken JSON is a warning, never a crash', () => {
  const r1 = readAgentTools({ home: home({ agent_tools: { 'astro-nope': LEAN, 'astro-planner': 'mcp__x__y' } }), agents: AGENTS });
  assert.ok(r1.warnings.some((w) => /astro-nope.*no such agent/.test(w)));
  assert.ok(r1.warnings.some((w) => /astro-planner.*must be a list/.test(w)));
  const r2 = readAgentTools({ home: home('{ not json'), agents: AGENTS });
  assert.ok(r2.warnings.some((w) => /config\.json.*not valid JSON/.test(w)));
  assert.deepEqual(r2.forAgent('astro-planner'), []);
});

// ── install / update keep it ─────────────────────────────────────────────────

function install(h) {
  const cfg = join(h, '.claude');
  mkdirSync(cfg, { recursive: true });
  return spawnSync(process.execPath, [join(FRAMEWORK, 'bin', 'ac.mjs'), 'install'], {
    cwd: h, encoding: 'utf8', env: { ...process.env, HOME: h, CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: join(h, 'no-codex') },
  });
}

test('ac install merges the tools into the installed agents, and a reinstall keeps them (no duplicates)', () => {
  const h = home({ agent_tools: { '*': LEAN } });
  const r = install(h);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`agent tools from ~/\\.astro/config\\.json: ${AGENTS.length} agent\\(s\\) extended`));
  const installed = readFileSync(join(h, '.astro', 'code', 'agents', 'astro-researcher.md'), 'utf8');
  assert.match(toolsLine(installed), /WebFetch, ToolSearch, mcp__lean-ctx__ctx_read, mcp__lean-ctx__ctx_search$/);
  // what Claude Code actually reads is the link in its agents dir
  const viaClaude = readFileSync(realpathSync(join(h, '.claude', 'agents', 'astro-researcher.md')), 'utf8');
  assert.equal(viaClaude, installed);

  assert.equal(install(h).status, 0);
  const again = readFileSync(join(h, '.astro', 'code', 'agents', 'astro-researcher.md'), 'utf8');
  assert.equal(again, installed, 'the second install produces the same file — survives, never doubles');
});

test('with no agent_tools the installed agents are the shipped files, byte for byte', () => {
  const h = home({ astrokit: { token: 'x' } });
  assert.equal(install(h).status, 0);
  for (const a of AGENTS) {
    assert.equal(readFileSync(join(h, '.astro', 'code', 'agents', `${a}.md`), 'utf8'), readFileSync(join(FRAMEWORK, 'agents', `${a}.md`), 'utf8'), a);
  }
});

test('ac install reports a bad entry and still installs', () => {
  const h = home({ agent_tools: { 'astro-verifier': ['Write'] } });
  const r = install(h);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /agent_tools.*"Write".*not an MCP tool/);
  assert.doesNotMatch(toolsLine(readFileSync(join(h, '.astro', 'code', 'agents', 'astro-verifier.md'), 'utf8')), /Write/);
});

test('a self-hosted config dir (agents/ IS the source) is named: agent_tools cannot reach it', () => {
  const h = home({ agent_tools: { '*': LEAN } });
  const cfg = join(h, '.claude');
  mkdirSync(cfg, { recursive: true });
  // the config dir's agents/ is the framework's own source dir — the sandbox bind-mount case
  spawnSync('ln', ['-s', join(FRAMEWORK, 'agents'), join(cfg, 'agents')]);
  const r = spawnSync(process.execPath, [join(FRAMEWORK, 'bin', 'ac.mjs'), 'install'], {
    cwd: h, encoding: 'utf8', env: { ...process.env, HOME: h, CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: join(h, 'no-codex') },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reads the agents from the source checkout itself — agent_tools does not apply there/);
  assert.doesNotMatch(toolsLine(readFileSync(join(FRAMEWORK, 'agents', 'astro-researcher.md'), 'utf8')), /mcp__/, 'the source is never edited');
});
