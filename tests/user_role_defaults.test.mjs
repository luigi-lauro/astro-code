// #110 — per-role models and reasoning can be set once per USER in ~/.astro/config.json.
// Resolution per role: the project's .astrocode/config.json, then the user default, then
// the built-in default (unset).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withUserRoleDefaults, setUserRoleDefaults, userRoleDefaults } from '../lib/config.mjs';

const AC = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ac.mjs');

function env(home) {
  const e = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ASTRO_LOCAL_MODEL']) delete e[k];
  return e;
}
const ac = (args, cwd, home) => spawnSync(process.execPath, [AC, ...args], { cwd, encoding: 'utf8', env: env(home) });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'ac-userhome-'));
  const dir = mkdtempSync(join(tmpdir(), 'ac-userproj-'));
  const init = ac(['init', '--name', 'UserDefaults'], dir, home);
  assert.equal(init.status, 0, init.stderr);
  return { home, dir };
}
function writeUser(home, cfg) {
  mkdirSync(join(home, '.astro'), { recursive: true });
  writeFileSync(join(home, '.astro', 'config.json'), JSON.stringify(cfg));
}

test('per role: project wins, then user, then built-in — with the source of each', () => {
  const home = mkdtempSync(join(tmpdir(), 'ac-userhome-'));
  writeUser(home, { models: { verifier: 'opus', executor: 'sonnet' }, reasoning: { verifier: 'medium' } });
  const { cfg, sources } = withUserRoleDefaults({ models: { executor: 'opus' } }, home);
  assert.deepEqual(cfg.models, { verifier: 'opus', executor: 'opus' });
  assert.deepEqual(cfg.reasoning, { verifier: 'medium' });
  assert.deepEqual(sources.models, { verifier: 'user', executor: 'project' });
  assert.equal(sources.models.planner, undefined, 'a role in neither is built-in');
});

test('no or invalid user file changes nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'ac-userhome-'));
  assert.deepEqual(withUserRoleDefaults({ lean_execution: true }, home).cfg, { lean_execution: true });
  mkdirSync(join(home, '.astro'), { recursive: true });
  writeFileSync(join(home, '.astro', 'config.json'), '{not json');
  assert.deepEqual(userRoleDefaults(home), { models: {}, reasoning: {} });
});

test('a new project leaves the user\'s roles unset, so they inherit the user default live', () => {
  const home = mkdtempSync(join(tmpdir(), 'ac-userhome-'));
  writeUser(home, { reasoning: { verifier: 'medium' } });
  const dir = mkdtempSync(join(tmpdir(), 'ac-userproj-'));
  assert.equal(ac(['init', '--name', 'Seeded'], dir, home).status, 0);
  const proj = JSON.parse(readFileSync(join(dir, '.astrocode', 'config.json'), 'utf8'));
  assert.equal(proj.reasoning.verifier, undefined);
  assert.equal(proj.reasoning.planner, 'high', 'roles the user did not set keep the template value');
  writeUser(home, { reasoning: { verifier: 'low' } });
  assert.equal(JSON.parse(ac(['config', 'get', 'reasoning.verifier'], dir, home).stdout), 'low');
});

test('`ac config get models|reasoning` serves the user default for roles the project leaves unset', () => {
  const { home, dir } = fixture();
  assert.equal(ac(['config', 'unset', 'models.verifier'], dir, home).status, 0);
  assert.equal(ac(['config', 'unset', 'reasoning.verifier'], dir, home).status, 0);
  writeUser(home, { models: { verifier: 'sonnet' }, reasoning: { verifier: 'medium' } });
  assert.equal(JSON.parse(ac(['config', 'get', 'models.verifier'], dir, home).stdout), 'sonnet');
  assert.equal(JSON.parse(ac(['config', 'get', 'reasoning'], dir, home).stdout).verifier, 'medium');
  // a project value still wins
  assert.equal(ac(['config', 'set', 'models.verifier', 'opus'], dir, home).status, 0);
  assert.equal(JSON.parse(ac(['config', 'get', 'models.verifier'], dir, home).stdout), 'opus');
  const shown = JSON.parse(ac(['models'], dir, home).stdout);
  assert.equal(shown.sources.models.verifier, 'project');
  // the project file never receives the user default
  const proj = JSON.parse(readFileSync(join(dir, '.astrocode', 'config.json'), 'utf8'));
  assert.equal(proj.reasoning?.verifier, undefined);
});

test('`ac models <profile> --user` writes the user level only, keeping other keys', () => {
  const { home, dir } = fixture();
  writeUser(home, { agent_tools: { '*': ['mcp__x__y'] } });
  const r = ac(['models', 'fast', '--user'], dir, home);
  assert.equal(r.status, 0, r.stderr);
  const user = JSON.parse(readFileSync(join(home, '.astro', 'config.json'), 'utf8'));
  assert.deepEqual(user.agent_tools, { '*': ['mcp__x__y'] });
  assert.equal(user.models.planner, 'sonnet');
  assert.equal(user.reasoning.verifier, 'high');
  const before = readFileSync(join(dir, '.astrocode', 'config.json'), 'utf8');
  assert.equal(ac(['models', 'max', '--user'], dir, home).status, 0);
  assert.equal(readFileSync(join(dir, '.astrocode', 'config.json'), 'utf8'), before, 'the project config is untouched');
});

test('setUserRoleDefaults refuses a file that is not JSON', () => {
  const home = mkdtempSync(join(tmpdir(), 'ac-userhome-'));
  mkdirSync(join(home, '.astro'), { recursive: true });
  writeFileSync(join(home, '.astro', 'config.json'), '{oops');
  const res = setUserRoleDefaults({ home, models: { planner: 'opus' } });
  assert.equal(res.ok, false);
  assert.equal(readFileSync(join(home, '.astro', 'config.json'), 'utf8'), '{oops');
});
