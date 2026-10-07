# Phase 35 — Cursor host adapter · ACCEPTANCE

Confirm on the developer's Mac. No app data model changes in this phase; the preconditions
below are machine/config state.

- [ ] **The user can install Cursor's CLI without losing astro-agent.**
  Precondition: astro-agent's `agent` resolves on PATH (note `command -v agent` first);
  `cursor-cli` not yet installed. After `brew install --cask cursor-cli`, `command -v cursor-agent`
  resolves and `command -v agent` still points at astro-agent (same path, its own help/version).

- [ ] **The user can run `ac install` and see Cursor wired next to Claude Code.**
  Precondition: Claude Code installed (`~/.claude` exists), `cursor-agent` installed, no
  astro-code entries in `~/.cursor/hooks.json` / `~/.cursor/cli-config.json`. Output lists
  Cursor with its command/agent counts and says hooks run via Claude Code import;
  `~/.cursor/commands` and `~/.cursor/agents` hold the `astro-*` set as plain files, and
  neither Cursor json file gained an astro-code entry.

- [ ] **The user can run `/astro-status` headlessly in Cursor.**
  Precondition: this repo with its `.astrocode/` state (milestone 11, phase 35) and the
  install above. `timeout 300 cursor-agent -p --trust "/astro-status"` prints the current
  milestone/phase and exits 0.

- [ ] **The user can have Cursor delegate to an astro subagent and get an answer back.**
  Precondition: same as above, `cursor-agent` logged in. A `timeout 600 cursor-agent -p --trust`
  prompt asking it to hand a read-only mapping question to `astro-mapper` returns an answer
  from that subagent and exits without hanging.

- [ ] **The user on Cursor is never offered Claude model tiers by `/astro-config`.**
  Precondition: a project whose `.astrocode/config.json` exists (this repo). Running
  `/astro-config` (models) in Cursor offers no opus/sonnet/haiku or profile, writes nothing to
  `models.*`, and says roles run on the Cursor session's model.

- [ ] **A user without Claude Code gets native hooks and keeps their own.**
  Precondition: a throwaway HOME holding only `.cursor/` with a user `hooks.json` entry and a
  user `cli-config.json` key (CRITERIA's fake-home recipe). `ac install` reports native hooks
  and adds astro-code's entries + status line beside the user's; `ac uninstall` then removes
  only astro-code's, leaving the user's entries, keys and any user command/agent files intact.

- [ ] *(Only if Cursor.app is installed)* **The user can type `/astro-` in Cursor's IDE agent
  chat and pick an astro command.** Precondition: the install above.
