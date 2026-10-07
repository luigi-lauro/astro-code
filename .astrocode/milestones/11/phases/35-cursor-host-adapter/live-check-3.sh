#!/bin/sh
# Phase 35 C14(c) live check — after the fixes: no astro-* skills from ~/.codex/skills,
# and a delegation that follows the new host-note rule. Run from a Terminal on the Mac.
cd /Users/buu/Development/astro-code || exit 1
LOG=.astrocode/phases/35-cursor-host-adapter/live-check-3.log
t() { perl -e 'alarm shift; exec @ARGV' "$@"; }
{
  echo "== $(date)"
  echo "== codex skill tag";  sed -n 1,8p ~/.codex/skills/astro-mapper/SKILL.md
  echo "== C14c-1 astro-* skills and where they load from"
  t 300 cursor-agent -p --trust --output-format json \
    "Without running any tools, list every skill available to you whose name starts with astro-, with the file path it was loaded from. If there are none, say NONE."
  echo "exit=$?"
  echo "== C14c-2 /astro-status through the installed command (host note path)"
  t 300 cursor-agent -p --trust --output-format json "/astro-status"
  echo "exit=$?"
  echo "== C14c-3 delegation following the host note"
  t 600 cursor-agent -p --trust --output-format json \
    "Follow the 'Running on Cursor' note in ~/.cursor/commands/astro-status.md for the Agent tool: run the astro-mapper agent (~/.cursor/agents/astro-mapper.md) as a subagent to map lib/hosts/ in at most 5 lines. Report the subagent_type you used and what it returned."
  echo "exit=$?"
  echo "== done $(date)"
} > "$LOG" 2>&1
echo "wrote $LOG"
