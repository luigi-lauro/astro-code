#!/usr/bin/env node
// Astro Fleet flusher — started DETACHED by astro-fleet-hook.mjs, never by Claude Code
// directly. Drains ~/.astro/fleet-queue.jsonl to the fleet in batches and exits when
// the queue is empty, the fleet asks it to back off, or the token is refused. A lock
// file (fleet-flush.lock, holding our pid) keeps it to one instance per machine; all
// the policy lives in flush() in _astro-fleet.mjs.
import { flush } from './_astro-fleet.mjs';

try { await flush(); } catch { /* detached: nobody to tell; status shows last_error */ }
process.exit(0);
