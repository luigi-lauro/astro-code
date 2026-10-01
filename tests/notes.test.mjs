// #106 — `ac phase note` / `ac backlog note` replaced the whole note on every write, so
// "add this line to phase 18's note" silently dropped what was there (in one project, a
// 6,890-character owner decision under a one-line addition). Now a plain write that would
// drop an existing note is refused; `--append` adds a line, `--replace` overwrites on
// purpose. One rule for both (lib/notes.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { initPlanning } from '../lib/planning.mjs';
import { addPhase, loadRoadmap } from '../lib/roadmap.mjs';
import { nextNote } from '../lib/notes.mjs';

const AC = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ac.mjs');
const ac = (args, cwd) => spawnSync(process.execPath, [AC, ...args], { cwd, encoding: 'utf8' });

test('nextNote: append adds a line, replace overwrites, a plain write never drops a note', () => {
  assert.equal(nextNote(undefined, 'first'), 'first', 'no note yet: a plain write sets it');
  assert.equal(nextNote('first', 'second', { append: true }), 'first\nsecond');
  assert.equal(nextNote(undefined, 'only', { append: true }), 'only');
  assert.equal(nextNote('first', 'second', { replace: true }), 'second');
  assert.equal(nextNote('first', 'first, then more'), 'first, then more', 'an edit that keeps the note is a plain write');
  assert.equal(nextNote('first', ''), '', 'clearing stays as documented');

  const refused = nextNote('OWNER DECISION: run after phase 2', 'register: debt item X', { target: 'phase 1' });
  assert.ok(refused instanceof Error);
  assert.match(refused.message, /phase 1 already has a 33-character note/);
  assert.match(refused.message, /Nothing was changed/);
  assert.match(refused.message, /--append/);
  assert.match(refused.message, /--replace/);

  assert.match(nextNote('a', 'b', { append: true, replace: true }).message, /exclusive/);
  assert.match(nextNote('a', '  ', { append: true }).message, /needs the text/);
});

test('ac phase note: the issue\'s repro keeps the owner decision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ac-notes-'));
  initPlanning(root, { name: 'fixture' });
  await addPhase(root, { number: 1, name: 'first phase', milestone: 1 });

  assert.equal(ac(['phase', 'note', '1', 'OWNER DECISION: run after phase 2'], root).status, 0);
  const plain = ac(['phase', 'note', '1', 'register: debt item X filed here'], root);
  assert.notEqual(plain.status, 0, 'a plain write over an existing note is refused');
  assert.match(plain.stderr, /already has a 33-character note/);
  assert.equal(ac(['phase', 'note', '1'], root).stdout.trim(), 'OWNER DECISION: run after phase 2');

  // Both spellings of append read the same: the flag before or after the text.
  assert.equal(ac(['phase', 'note', '1', '--append', 'register: debt item X filed here'], root).status, 0);
  assert.equal(ac(['phase', 'note', '1', 'and one more line', '--append'], root).status, 0);
  assert.equal(loadRoadmap(root).phases[0].note,
    'OWNER DECISION: run after phase 2\nregister: debt item X filed here\nand one more line');

  assert.equal(ac(['phase', 'note', '1', '--replace', 'a fresh start'], root).status, 0);
  assert.equal(ac(['phase', 'note', '1'], root).stdout.trim(), 'a fresh start');

  assert.match(ac(['phase', 'note', '1', 'x', '--apend'], root).stderr, /unknown flag for `ac phase note`: --apend/);
  assert.equal(ac(['phase', 'note', '1', ''], root).status, 0, 'clearing stays as documented');
  assert.equal(loadRoadmap(root).phases[0].note, undefined);
});

test('ac backlog note: the same rule', () => {
  const root = mkdtempSync(join(tmpdir(), 'ac-notes-'));
  initPlanning(root, { name: 'fixture' });
  assert.equal(ac(['backlog', 'add', 'an idea', '--note', 'first note'], root).status, 0);
  const id = JSON.parse(ac(['backlog', 'list', '--json'], root).stdout)[0].id;

  const plain = ac(['backlog', 'note', id, 'second note'], root);
  assert.notEqual(plain.status, 0);
  assert.match(plain.stderr, new RegExp(`backlog ${id} already has a 10-character note`));
  assert.equal(ac(['backlog', 'note', id, '--append', 'second note'], root).status, 0);
  assert.equal(ac(['backlog', 'note', id], root).stdout.trim(), 'first note\nsecond note');
});
