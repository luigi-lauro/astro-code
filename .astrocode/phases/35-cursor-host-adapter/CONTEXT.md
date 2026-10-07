<!-- astro-discuss: captured -->
# Phase 35 — Cursor host adapter · CONTEXT

Goal: astro-code runs in Cursor (IDE agent and `cursor-agent` CLI) as a third host
alongside Claude Code and Codex, via one adapter `lib/hosts/cursor.mjs` registered in
`lib/hosts/index.mjs` `HOSTS`. Grounding research (read it first):
`RESEARCH-cursor-cli.md` in this directory — verified against CLI 2026.10.01.

## Decisions

1. **Placement — native `~/.cursor`.** Commands → `~/.cursor/commands/<name>.md` (flat
   markdown, `description` frontmatter, `allowed-tools` dropped, `$ARGUMENTS` left as-is —
   Cursor substitutes it). Agents → `~/.cursor/agents/<name>.md` with `name`,
   `description`, `model: inherit`, and `readonly: true` for the read-only roles
   (e.g. researcher, verifier, mapper; criteria-author grants Write so it is NOT read-only
   — derive from the source agent's tools, not a hard-coded list). Mode `copy`. Must work with Claude Code absent or Cursor's
   third-party import off. Base dir: `CURSOR_CONFIG_DIR`, else `~/.cursor`.
2. **Hooks — native only when Claude Code is absent, decided at install.** Every
   `ac install`/update: if the Claude host is NOT detected, write astro-code's entries
   into `~/.cursor/hooks.json` (`{"version":1,"hooks":{…}}`) and a `statusLine` in
   `~/.cursor/cli-config.json`; if Claude IS detected, remove astro-code's Cursor
   entries (Cursor imports the Claude hooks itself — native ones would double-fire).
   Merge, never clobber: both files may hold the user's own entries; only astro-code's
   own entries are added/removed, identified the same way the Claude adapter identifies
   its own. Install output states which branch was taken (and, when Claude is present,
   that Cursor runs the Claude hooks via import). Map each astro-code Claude hook event
   to its Cursor event (sessionStart, beforeSubmitPrompt, stop, …); an event with no
   Cursor equivalent is skipped and reported, never silently dropped.
3. **Execution — Cursor subagents, else inline.** No new orchestration. The existing
   command tiers stand: no Workflow tool on Cursor → the "Agent tool available" tier
   maps to Cursor's native subagents → floor is inline. `lib/hosts/runner.mjs` stays
   unwired to commands (out of scope).
   `execCommand` IS still implemented for contract completeness and the runner tests:
   `cursor-agent -p --output-format json --force --trust --workspace <cwd>
   [--model m] [-w name] <prompt>`; `capabilities = { worktree: true,
   outputSchema: false, reasoning: false }` (reasoning lives in model-id suffixes —
   not a separate knob in v1). Result = parsed `.result`; non-zero exit / no JSON →
   failure (falsy positional entry, per runner contract).
4. **Models — inherit in v1.** Agents use `model: inherit`. `/astro-config` must not
   offer Claude-only tiers when running on Cursor (mirror the v0.37.0 Codex fix).
   Per-role Cursor model mapping is deferred.
5. **Command bodies — unchanged + a short host note.** `renderCommand` prepends a brief
   Cursor note mapping Claude Code tool names: Workflow tool → unavailable (use the
   next tier); Agent tool → Cursor subagent (`subagent_type` = astro agent name);
   AskUserQuestion → ask in chat with the same numbered options. One source body for
   every host; no per-host rewriting.
6. **Detection.** Cursor present iff `CURSOR_CONFIG_DIR`/`~/.cursor` exists OR
   `cursor-agent` is on PATH. The binary `agent` is NEVER probed or invoked (on the dev
   Mac it is astro-agent; Cursor's curl installer would overwrite `~/.local/bin/agent`).
   A test asserts `execCommand().command === 'cursor-agent'`.

## Scope

In: `lib/hosts/cursor.mjs`, registration in `HOSTS`, install/uninstall wiring
(commands, agents, conditional hooks + statusline with merge-safe edits), `/astro-config`
host filtering, Cursor rows in docs that list hosts (AGENTS.md "Invoking the commands"
table + template, README/MANUAL host sections), tests mirroring the Codex ones
(`hosts.test.mjs`, `install.test.mjs` with fake HOME, `runner.test.mjs` argv shape).

Out (deferred, do not grow the phase): wiring runner.mjs into `/astro-execute`;
per-role Cursor model mapping / `--list-models` integration; transcript mining for
Cursor (`lib/transcripts.mjs`, `lib/mine.mjs`); project-level `.cursor/` files
(rules, mcp.json); Cursor cloud/background agents. Not folded in: debt
`2026-09-17-ac-install-uses-symlinksync…` (Windows symlink) and backlog items
`…stale-command…` and `…pi-as-a-first-class-host…` — user chose to leave them.

## Done bar (part of the phase, not optional)

Live check on the developer's Mac, required for verify AND accept:
1. Install via `brew install --cask cursor-cli` (only `cursor-agent`; never the curl
   installer — it replaces `~/.local/bin/agent`). Cursor.app optional for IDE check.
   Installing on the host needs the developer's go-ahead (host bridge rule).
2. `ac install` → files land in `~/.cursor/commands` + `~/.cursor/agents`; hook branch
   reported correctly (Claude Code IS installed there → no native hooks expected).
3. `cursor-agent -p "/astro-status"` in this repo prints status and exits 0.
4. One `cursor-agent -p` run that delegates to an astro subagent (e.g. astro-mapper,
   read-only) completes and exits — confirms subagent tier works and `-p` doesn't hang.
5. `astro-agent`'s `agent` binary still resolves to astro-agent afterwards.

## Open questions / assumptions (settle in the live check, not by guessing)
- Same-named agent in `~/.claude/agents` and `~/.cursor/agents`: does Cursor show one
  (override) or two? Commands are known to override by name; agents assumed to.
- `-p` clean exit on the installed version (historical hang reports; changelog says fixed).
- Whether Cursor's subagent tool honours `subagent_type` by agent name as assumed in
  the host note.
- Exact JSON result shape and exit codes on failure (from bundle read, not a live run).
