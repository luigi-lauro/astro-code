#!/bin/sh
# Phase 35 C13(d) follow-up — does Cursor dispatch the INSTALLED custom subagent
# (~/.cursor/agents/astro-mapper.md), or only a generic subagent / the Codex skill copy?
# Run from a Terminal on the Mac. Output: live-check-2.log next to this script.
cd /Users/buu/Development/astro-code || exit 1
LOG=.astrocode/phases/35-cursor-host-adapter/live-check-2.log
t() { perl -e 'alarm shift; exec @ARGV' "$@"; }
{
  echo "== $(date)"
  echo "== C13d-1 which subagents and skills named astro-* can you see"
  t 300 cursor-agent -p --trust --output-format json \
    "Without running any tools, list every custom subagent type and every skill available to you whose name starts with astro-, and for each say where it was loaded from (file path) if you know."
  echo "exit=$?"
  echo "== C13d-2 dispatch the custom subagent by name"
  t 600 cursor-agent -p --trust --output-format json \
    "Delegate to the custom subagent named astro-mapper (subagent_type astro-mapper, defined in ~/.cursor/agents/astro-mapper.md) — do NOT use explore or a skill. Ask it to map lib/hosts/ in at most 5 lines. Then report the exact subagent_type you used and what it returned."
  echo "exit=$?"
  echo "== done $(date)"
} > "$LOG" 2>&1
echo "wrote $LOG"
