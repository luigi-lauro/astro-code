// Regression guard for commands/astro-kit-source.md — pins the command contract (phase
// 106 d1, CONTEXT.md decision 3, PLAN.md §3) and the doc listings in astro-help.md /
// MANUAL.md, plus the `kit_test.py --live` documentation in astro-kit-test.md.
// Modeled on tests/kit_convert.test.mjs's shape: frontmatter is sliced out so assertions
// about argument-hint / allowed-tools are scoped to the header, not incidentally matched
// in the prose body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMMANDS = join(ROOT, 'commands');
const SOURCE_MD = join(COMMANDS, 'astro-kit-source.md');
const KIT_TEST_MD = join(COMMANDS, 'astro-kit-test.md');
const HELP_MD = join(COMMANDS, 'astro-help.md');
const MANUAL_MD = join(ROOT, 'MANUAL.md');

const src = readFileSync(SOURCE_MD, 'utf8');

/**
 * Slice out the YAML frontmatter block (between the two `---` fences) so
 * assertions about argument-hint / allowed-tools are scoped to the header,
 * not incidentally matched in the prose body.
 */
function extractFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, 'astro-kit-source.md must open with a --- frontmatter block');
  return match[1];
}

const frontmatter = extractFrontmatter(src);

// ── 1. Frontmatter: description + argument-hint are present ────────────────────────

test('astro-kit-source.md frontmatter declares a description and an argument-hint', () => {
  assert.match(
    frontmatter,
    /^description:\s*.+$/m,
    `frontmatter must declare a description — found:\n\n${frontmatter}`,
  );
  assert.match(
    frontmatter,
    /^argument-hint:\s*.+$/m,
    `frontmatter must declare an argument-hint — found:\n\n${frontmatter}`,
  );
});

// ── 2. Frontmatter: allowed-tools is exactly Bash, Read, AskUserQuestion ────────────

test('astro-kit-source.md frontmatter allowed-tools is Bash, Read, AskUserQuestion', () => {
  const toolsLine = frontmatter.match(/^allowed-tools:\s*(.+)$/m);
  assert.ok(toolsLine, `frontmatter must have an allowed-tools line — found:\n\n${frontmatter}`);
  const tools = toolsLine[1].split(',').map((t) => t.trim());
  assert.deepEqual(
    tools,
    ['Bash', 'Read', 'AskUserQuestion'],
    `allowed-tools must be exactly "Bash, Read, AskUserQuestion" — found: ${toolsLine[1]}`,
  );
});

// ── 3. Body: names kit_source.py with the local-copy-then-templates fallback ───────
//
// Same pattern as astro-kit-publish.md / astro-kit-test.md: prefer the kit's own
// tools/kit_source.py, fall back to $(ac path templates)/kit/tools/kit_source.py.

test('astro-kit-source.md names kit_source.py with the local-copy-then-templates fallback', () => {
  assert.match(src, /kit_source\.py/, 'body must name kit_source.py');
  assert.match(
    src,
    /\$\(ac path templates\)\/kit\/tools\/kit_source\.py/,
    'body must fall back to $(ac path templates)/kit/tools/kit_source.py',
  );
  assert.match(
    src,
    /tools\/kit_source\.py/,
    'body must prefer the kit\'s own local tools/kit_source.py copy',
  );
});

// ── 4. Body: documents --include / --exclude / --sample-values ─────────────────────

test('astro-kit-source.md documents --include, --exclude and --sample-values', () => {
  assert.match(src, /--include/, 'body must document --include');
  assert.match(src, /--exclude/, 'body must document --exclude');
  assert.match(src, /--sample-values/, 'body must document --sample-values');
});

// ── 5. Body: credentials come from env vars only, never a --password flag ──────────
//
// PLAN.md §3 — there is no password flag; credentials come from ASTRO_ADMIN_PASSWORD
// and, for one-off connections, ASTRO_SOURCE_<ID>_PASSWORD.

test('astro-kit-source.md says credentials come from env vars only, with no --password flag', () => {
  assert.match(src, /ASTRO_ADMIN_PASSWORD/, 'body must name ASTRO_ADMIN_PASSWORD');
  assert.match(src, /ASTRO_SOURCE_<ID>/, 'body must name the one-off ASTRO_SOURCE_<ID> env var prefix');
  assert.match(src, /_PASSWORD/, 'body must name the one-off _PASSWORD env var suffix');
  assert.ok(!/--password/.test(src), 'body must not contain a --password token');
});

// ── 6. Body: SOURCE.md is never rewritten; drift is flagged, not deleted ───────────

test('astro-kit-source.md says SOURCE.md is never rewritten and drift is flagged, not deleted', () => {
  assert.match(
    src,
    /SOURCE\.md[\s\S]{0,300}never\s+(?:be\s+)?(?:rewritten|touched)|never\s+(?:rewrite|touch)s?\s+SOURCE\.md/i,
    'body must say SOURCE.md is never rewritten/touched once it exists',
  );
  assert.match(src, /flag/i, 'body must say drift is flagged');
  assert.ok(
    !/drift is deleted|delete[sd]? (?:the )?(?:missing|removed|dropped)/i.test(src),
    'body must not say drift/missing objects are deleted',
  );
});

// ── 7. Body: tells the author to review sampled values before publishing ───────────

test('astro-kit-source.md tells the author to review sampled values before publishing', () => {
  assert.match(
    src,
    /review.{0,60}sampl|sampl.{0,60}review/is,
    'body must tell the author to review sampled values before publishing',
  );
  assert.match(src, /publish/i, 'the review instruction must be tied to publishing');
});

// ── 8. Docs: astro-help.md and MANUAL.md both list astro-kit-source ────────────────

test('astro-help.md lists astro-kit-source', () => {
  const helpSrc = readFileSync(HELP_MD, 'utf8');
  assert.match(
    helpSrc,
    /astro-kit-source/,
    'commands/astro-help.md must list astro-kit-source alongside the other kit commands',
  );
});

test('MANUAL.md lists astro-kit-source', () => {
  const manualSrc = readFileSync(MANUAL_MD, 'utf8');
  assert.match(
    manualSrc,
    /astro-kit-source/,
    'MANUAL.md must list astro-kit-source alongside the other kit commands',
  );
});

// ── 9. Docs: astro-kit-test.md documents --live and its env vars ───────────────────

test('astro-kit-test.md documents --live with its env vars', () => {
  const kitTestSrc = readFileSync(KIT_TEST_MD, 'utf8');
  assert.match(kitTestSrc, /--live/, 'astro-kit-test.md must document --live');
  assert.match(kitTestSrc, /ASTRO_BASE_URL/, 'astro-kit-test.md must name ASTRO_BASE_URL');
  assert.match(kitTestSrc, /ASTRO_ADMIN_EMAIL/, 'astro-kit-test.md must name ASTRO_ADMIN_EMAIL');
  assert.match(kitTestSrc, /ASTRO_ADMIN_PASSWORD/, 'astro-kit-test.md must name ASTRO_ADMIN_PASSWORD');
  assert.match(kitTestSrc, /ASTRO_SOURCE_<ID>/, 'astro-kit-test.md must name the one-off ASTRO_SOURCE_<ID> env var prefix');
  assert.match(kitTestSrc, /_PASSWORD/, 'astro-kit-test.md must name the one-off _PASSWORD env var suffix');
});
