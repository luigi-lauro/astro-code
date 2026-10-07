# Changelog

Release notes in full live on the [GitHub releases page](https://github.com/uublive/astro-code/releases).

## v0.39.0

- Cursor is a supported host, alongside Claude Code and Codex. `ac install` puts the commands and agents in `~/.cursor` (honouring `$CURSOR_CONFIG_DIR`). It detects Cursor by its config folder or by `cursor-agent` on `PATH`, and never touches a binary named `agent`. Install Cursor's CLI with `brew install --cask cursor-cli`
- On Cursor, each command opens with a short note mapping Claude Code tools to Cursor's. Agents run in Cursor's built-in subagents (`explore` for read-only roles, `generalPurpose` for the rest), with the agent file as their instructions. Agents use the session's model, and `/astro-config` never offers Claude tiers
- When Claude Code is not installed, the hooks and status line are wired into Cursor's own `hooks.json` and `cli-config.json`, kept alongside your own entries. When Claude Code is installed, Cursor runs the Claude hooks itself, so astro-code wires none and they don't fire twice
- Codex skills are tagged `metadata.surfaces: codex`, so Cursor, which also reads `~/.codex/skills`, no longer lists every astro-code command twice
- Headless Cursor runs need a logged-in session: `cursor-agent` reads its login from the macOS keychain, which is locked over SSH. Without an API key (paid plans), run it from a local terminal

## v0.38.0

- Astro Fleet now receives outcomes as well as activity. It is told when a phase is verified, rejected or accepted, when a fix is accepted, and about every `git commit`, with who signed it and whether an accept was a first try. A fleet can then rank sessions by what they deliver

## v0.37.0

- Challenge mode: a thorough, opt-in interview for `/astro-new-project`, `/astro-adopt`, `/astro-discuss --challenge`, `/astro-autonomous --challenge` and the new `/astro-challenge`
- On Codex, `/astro-config` no longer offers Claude models, and never writes a model into the shared config

## v0.36.1

- `ac fleet connect` no longer leaves an 'unknown' bay in the Forge
