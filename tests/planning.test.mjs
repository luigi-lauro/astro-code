// Unit tests for the discuss-gate classifier in lib/planning.mjs.
//
// Regression target: /astro-plan used to gate on mere PRESENCE of CONTEXT.md, so a
// hand-seeded stub (or a CONTEXT.md the planning side wrote itself) silently
// satisfied the gate and the discussion never happened. phaseContextStatus()
// distinguishes a genuine /astro-discuss capture (carries the provenance marker)
// from a stub, so the gate keys off substance, not existence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initPlanning, phaseContextStatus, classifyContext, contextAuthor, CONTEXT_MARKER } from '../lib/planning.mjs';
import { paths } from '../lib/paths.mjs';
import { readFileSync } from 'node:fs';

// Scaffold a throwaway project and return its root. initPlanning creates
// .astrocode/ with the phases/ dir so phaseContextStatus can resolve paths.
function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 'ac-planning-'));
  initPlanning(root, { name: 'oracle', vision: 'test' });
  return root;
}

// Write a phase's CONTEXT.md with arbitrary body (creates the phase dir).
function writeContext(root, slug, body) {
  const dir = join(paths(root).phases, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CONTEXT.md'), body);
}

test('phaseContextStatus: no CONTEXT.md → "missing"', () => {
  const root = scaffold();
  assert.equal(phaseContextStatus(root, '04-oracle'), 'missing');
});

test('phaseContextStatus: CONTEXT.md without the marker → "stub" (the seeded-placeholder bug)', () => {
  const root = scaffold();
  // Exactly the failure mode: a plausible-looking CONTEXT.md that was never discussed.
  writeContext(root, '04-oracle', '# Phase 04 context\n\nSome decisions go here.\n');
  assert.equal(phaseContextStatus(root, '04-oracle'), 'stub');
});

test('phaseContextStatus: CONTEXT.md with the provenance marker → "ready"', () => {
  const root = scaffold();
  writeContext(root, '04-oracle', `${CONTEXT_MARKER}\n\n# Phase 04 context\n\nDiscussed decisions.\n`);
  assert.equal(phaseContextStatus(root, '04-oracle'), 'ready');
});

test('phaseContextStatus: marker is whitespace-tolerant and case-insensitive', () => {
  const root = scaffold();
  writeContext(root, '04-oracle', '<!--   Astro-Discuss:   captured   -->\n\nbody\n');
  assert.equal(phaseContextStatus(root, '04-oracle'), 'ready');
});

test('phaseContextStatus: an empty CONTEXT.md is a "stub", not "ready"', () => {
  const root = scaffold();
  writeContext(root, '04-oracle', '');
  assert.equal(phaseContextStatus(root, '04-oracle'), 'stub');
});

// Phase 34 t3 (ADR-069) — the discuss gate is UNTOUCHED by challenge mode: the
// line-2 `<!-- astro-challenge: N rounds -->` marker is pure prose metadata to the
// gate, which keys off line 1 exactly as before. These characterization tests pin
// that fact first, so a future regex change that starts noticing (or rejecting) a
// second line goes red immediately.

test('phaseContextStatus/classifyContext: human marker on line 1 + a line-2 challenge marker → "ready"/"human"', () => {
  const root = scaffold();
  const body = `${CONTEXT_MARKER}\n<!-- astro-challenge: 3 rounds -->\n\n# Phase 04 context\n`;
  writeContext(root, '04-oracle', body);
  assert.equal(phaseContextStatus(root, '04-oracle'), 'ready');
  assert.deepEqual(classifyContext(body), { kind: 'human', author: null });
});

test('phaseContextStatus/classifyContext: agent marker on line 1 + a line-2 challenge marker → "ready"/agent name preserved', () => {
  const root = scaffold();
  const body = '<!-- astro-discuss: captured by agent: x -->\n<!-- astro-challenge: 3 rounds -->\n\nbody\n';
  writeContext(root, '04-oracle', body);
  assert.equal(phaseContextStatus(root, '04-oracle'), 'ready');
  assert.equal(contextAuthor(body), 'x');
});

test('phaseContextStatus/classifyContext: only the line-2 challenge marker, no discuss marker → "stub"/"stub" (no author)', () => {
  const root = scaffold();
  const body = '# Phase 04 context\n<!-- astro-challenge: 3 rounds -->\n\nbody\n';
  writeContext(root, '04-oracle', body);
  assert.equal(phaseContextStatus(root, '04-oracle'), 'stub');
  assert.deepEqual(classifyContext(body), { kind: 'stub', author: null });
  assert.equal(contextAuthor(body), null);
});

test('phaseContextStatus/classifyContext: plain line-1 marker with no line 2 is still "ready"/"human" (baseline, unaffected)', () => {
  const root = scaffold();
  const body = `${CONTEXT_MARKER}\n\n# Phase 04 context\n`;
  writeContext(root, '04-oracle', body);
  assert.equal(phaseContextStatus(root, '04-oracle'), 'ready');
  assert.deepEqual(classifyContext(body), { kind: 'human', author: null });
});

// Phase 19 t12 — a project scaffolded by `ac init` carries the lead-with-the-change
// rule on its own, without astro-code's own repository present to point back at.
// Assert against the GENERATED files (what initPlanning actually writes), not the
// templates directly — the templates are t2/t3's contract, this is the scaffold's.
test('initPlanning: the generated CONVENTIONS.md carries a filled-in Voice section', () => {
  const root = scaffold();
  const generated = readFileSync(paths(root).conventions, 'utf8');

  // P1 — the load-bearing sentence, byte-identical across every canon copy.
  assert.match(
    generated,
    /A report to a human \*\*leads with the change or the decision\*\* and keeps the evidence short\s*\nand beneath it\./
  );
  // P3 — the machine-read exemption, named explicitly.
  assert.match(generated, /`PLAN\.md`, `CRITERIA\.md`, and a verifier's\s+structured\s+return and log stay as dense as they need to be/);
  // A real heading with prose beneath it, not a bare stem or a placeholder.
  assert.match(generated, /## Voice\n\n\S/);
  assert.doesNotMatch(generated, /\{\{[A-Z_]+\}\}/);
});

test('initPlanning: the generated AGENTS.md names the free-form-narration rule as unenforced', () => {
  const root = scaffold();
  const generated = readFileSync(join(root, 'AGENTS.md'), 'utf8');

  assert.match(generated, /nothing checks it/);
});

test('initPlanning: neither generated file leans on astro-code\'s own repository paths', () => {
  const root = scaffold();
  const conventions = readFileSync(paths(root).conventions, 'utf8');
  const agentsMd = readFileSync(join(root, 'AGENTS.md'), 'utf8');

  // C6: the rule must be readable and obeyable with astro-code's own repo absent —
  // no pointer into paths that only exist inside astro-code's own checkout.
  for (const text of [conventions, agentsMd]) {
    assert.doesNotMatch(text, /tests\/commands\.test\.mjs/);
    assert.doesNotMatch(text, /\.astrocode\/phases\//);
  }
});
