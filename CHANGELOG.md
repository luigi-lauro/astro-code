# Changelog

Release notes in full live on the [GitHub releases page](https://github.com/uublive/astro-code/releases).

## v0.40.2

- Cursor's slash menu shows each astro command's description again, instead of "Running on Cursor" for every command. The menu reads the first line of the command body, not the `description` frontmatter, so the description now leads the body, ahead of the Cursor host note. Claude Code and Codex commands are unchanged. Run `ac update` to rewrite `~/.cursor/commands`
- `astro-executor` asks Claude Code for the 1-hour prompt cache (`experimental: {cacheTtl: 1h}`). An executor often waits more than 5 minutes for a build or test run, so with the default 5-minute cache its next call wrote the whole prompt again. Measured over a week, the executor was the only astro agent where those rewrites cost more than the 1-hour premium, so the other agents keep the default. Codex and Cursor do not get the key

## v0.40.1

- Windows: `ac install` no longer stops with EPERM when `~/.claude` exists and Developer Mode is off. A file symlink Windows refuses is copied instead, so the Cursor commands get written too. Copies refresh on the next `ac install`/`ac update`, and uninstall removes them
- Cursor commands installed from a Windows clone keep their `description`: frontmatter with CRLF line endings is now read correctly. `.gitattributes` keeps `*.md` and `*.mjs` LF on new clones
- On Cursor, the host note tells the agent to run `astrocode` instead of `ac` in PowerShell, where `ac` is the built-in Add-Content alias

## v0.40.0

- The principles brief now reaches the model whole at every session start, `/clear` and compaction. Claude Code cuts a hook's context over 10,000 characters to a 2 KB preview, so a large brief is split across up to four SessionStart hooks, each under 9,500 characters. Hard rules then come without their why (`ac principles show <id>` has it), and anything that still does not fit is named in a closing `⚠ CUT` line. Set `"principles": { "sessionBrief": false }` in `~/.astro/config.json` to turn the brief off. Run `ac update` to register the new hooks
- Per-role models and reasoning can be set once for all your projects: `ac models <profile> --user` writes them to `~/.astro/config.json`. A project's own setting still wins per role; `ac models` shows where each value comes from. New projects follow your default; an existing project follows it for the roles you `ac config unset` there
- `/astro-status` no longer reports a healthy registry; it speaks up only when the registry needs action

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
