#!/bin/sh
# Phase 35 C13 live check — run from a Terminal on the Mac (unlocked keychain), not over SSH.
# Writes everything to live-check.log next to this script.
cd /Users/buu/Development/astro-code || exit 1
LOG=.astrocode/phases/35-cursor-host-adapter/live-check.log
# macOS has no `timeout`; perl's alarm kills a hung `-p` run (the known Cursor risk).
t() { perl -e 'alarm shift; exec @ARGV' "$@"; }
{
  echo "== $(date)"
  echo "== which";        which -a agent cursor-agent; agent --version
  echo "== version";      cursor-agent --version
  echo "== status";       cursor-agent status
  echo "== models";       t 120 cursor-agent --list-models; echo "exit=$?"
  echo "== C13c /astro-status"
  t 300 cursor-agent -p --trust --output-format json "/astro-status"; echo "exit=$?"
  echo "== C13d subagent delegation (astro-mapper, read-only)"
  t 600 cursor-agent -p --trust --output-format json \
    "Use the astro-mapper subagent to map lib/hosts/ in at most 10 lines, then report what the subagent returned and confirm it ran as a subagent."
  echo "exit=$?"
  echo "== done $(date)"
} > "$LOG" 2>&1
echo "wrote $LOG"
