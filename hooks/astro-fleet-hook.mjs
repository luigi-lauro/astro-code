#!/usr/bin/env node
// Astro Fleet reporting hook — wired by `ac fleet connect` to SessionStart/End,
// UserPromptSubmit, Pre/PostToolUse, Notification, Stop and SubagentStart/Stop in the
// user-level Claude Code settings, so it runs in EVERY session on the machine.
//
// Fire-and-forget, by contract: read stdin, map it to one activity event, append it to
// ~/.astro/fleet-queue.jsonl, start a detached flusher if none is running, exit 0. It
// never touches the network, never writes stdout (a UserPromptSubmit hook's stdout is
// injected into the model's context; a PreToolUse one can steer the tool call) and
// swallows every error — a broken fleet must never be a broken session.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const done = () => process.exit(0);
process.on('uncaughtException', done);
process.on('unhandledRejection', done);

// Drain stdin even when we will do nothing with it: exiting with a large PreToolUse
// payload still unread would hand Claude Code an EPIPE for no reason.
let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { /* no stdin */ }

try {
  const fleet = await import('./_astro-fleet.mjs');
  const dir = fleet.fleetDir();
  // Cheapest possible exit first: not connected, or paused → nothing to do at all.
  const cfg = fleet.loadConfig(dir);
  if (cfg && !cfg.paused) {
    let input = null;
    try { input = JSON.parse(raw); } catch { /* not JSON — ignored below */ }
    const r = fleet.enqueueHookEvent(input, { dir });
    if (r.queued && fleet.shouldSpawnFlusher(dir, { state: r.state })) {
      fleet.spawnFlusher(join(dirname(fileURLToPath(import.meta.url)), 'astro-fleet-flush.mjs'), dir);
    }
  }
} catch { /* never surface */ }
done();
