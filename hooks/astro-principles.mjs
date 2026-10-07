#!/usr/bin/env node
// SessionStart hook — one part of the principles session brief (#116).
//
// Claude Code keeps a hook's `additionalContext` whole only up to 10,000 characters;
// above that the model gets a ~2 KB preview and a file path. So the brief is packed into
// BRIEF_PARTS parts (`ac principles brief --part K/N`) and each part rides its own
// SessionStart entry: astro-update.mjs serves part 1, this script serves part K given as
// its argument (`astro-principles.mjs 2/4`). A part with nothing in it writes nothing, so
// it adds no attachment. Fires on every source, clear and compact included — this is
// model context, not the visual banner. Strict no-op outside an astro-code project.
import { readFileSync } from 'node:fs';
import { findAstroRoot, principlesBrief, hookDirOf } from './_astro-ctx.mjs';

const part = process.argv[2];

let cwd = process.cwd();
try {
  const data = JSON.parse(readFileSync(0, 'utf8'));
  cwd = data?.cwd || data?.workspace?.current_dir || cwd;
} catch { /* no/!json stdin — fall back to process.cwd() */ }

try {
  const root = findAstroRoot(cwd);
  if (root && /^\d+\/\d+$/.test(part || '')) {
    const brief = principlesBrief(root, hookDirOf(import.meta.url), { stage: 'session', by: 'session', part });
    if (brief) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: brief } }));
  }
} catch { /* best-effort — never block a session start */ }

process.exit(0);
