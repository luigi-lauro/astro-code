// Reproduction + contract for fix 2026-10-01-phase-slug-unbounded-enametoolong
// (GitHub issue #107).
//
// `addPhase` built the phase slug from an unbounded `slugify(name)`, so a long title
// (a promoted backlog item, say) produced a directory name past the filesystem's
// 255-byte limit. And it wrote roadmap.json + ROADMAP.md BEFORE its mkdir, so the
// ENAMETOOLONG left a phase in the roadmap with no folder behind it.
//
// Two contracts: the slug is bounded on a word boundary the way fix ids are
// (`datedId` in lib/fixes.mjs), and a failed mkdir leaves the roadmap untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initPlanning } from '../lib/planning.mjs';
import { paths } from '../lib/paths.mjs';
import { readJSON } from '../lib/util.mjs';

const LONG = 'a very long title '.repeat(18).trim();

test('a long phase title is bounded on a word boundary and its folder is created', async () => {
  const { addPhase } = await import('../lib/roadmap.mjs');
  const root = mkdtempSync(join(tmpdir(), 'ac-slug-'));
  initPlanning(root, { name: 'repro' });
  const phase = await addPhase(root, { number: 1, name: LONG });
  assert.ok(phase.slug.length <= 3 + 40, `slug is ${phase.slug.length} chars`);
  assert.match(phase.slug, /^01-a-very-long-title-a-very-long(-[a-z]+)*$/);
  assert.doesNotMatch(phase.slug, /-$/);
  assert.equal(phase.name, LONG, 'the full title stays on the phase');
  assert.ok(existsSync(join(paths(root).phases, phase.slug)));
});

test('a failed mkdir leaves the roadmap untouched', async () => {
  const { addPhase } = await import('../lib/roadmap.mjs');
  const root = mkdtempSync(join(tmpdir(), 'ac-slug-'));
  initPlanning(root, { name: 'repro' });
  const p = paths(root);
  // A plain file where the folder must go makes mkdir fail regardless of the slug.
  mkdirSync(p.phases, { recursive: true });
  writeFileSync(join(p.phases, '01-blocked'), '');
  await assert.rejects(addPhase(root, { number: 1, name: 'blocked' }));
  const rm = readJSON(p.roadmap);
  assert.equal(rm.phases.length, 0, 'the phase must not be in roadmap.json');
});
