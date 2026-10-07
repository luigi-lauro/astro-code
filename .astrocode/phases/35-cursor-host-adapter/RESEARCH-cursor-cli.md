# Cursor CLI — host research (2026-10-07)

Pre-discuss spike for phase 35. Verified against the shipped CLI bundle
`2026.10.01-e373342` (linux-arm64, `--help` + JS bundle read with a fake HOME),
cursor.com docs/changelog, and user reports. Tags: **[src]** shipped bundle,
**[docs]** cursor.com docs/changelog, **[forum]** user reports (search snippets only).
Cursor is NOT installed on the dev Mac yet — nothing here was run live.

## 1. Binary and headless flags
- Curl installer symlinks BOTH `~/.local/bin/agent` (primary, `rm -f`s any existing
  one) and `~/.local/bin/cursor-agent` (legacy). Brew cask `cursor-cli` installs ONLY
  `cursor-agent`. [src]
- **On the dev Mac `/opt/homebrew/bin/agent` is astro-agent** → the adapter must
  invoke and detect `cursor-agent`, never `agent`. Install Cursor CLI via brew.
- Flags [src]: `-p/--print`, `--output-format text|json|stream-json`, `--model`,
  `--list-models`, `-f/--force` (`--yolo`), `--trust`, `--approve-mcps`,
  `--sandbox enabled|disabled`, `--workspace <path>`, `--add-dir`,
  `-w/--worktree [name]`, `--worktree-base`, `--skip-worktree-setup`, `--resume`,
  `--continue`, `--mode plan|ask`, `--api-key`.
- Without `--force`, `-p` only proposes edits [docs]. Untrusted workspace + headless
  fails without `--trust`/`--force` [docs, changelog Jan 2026].
- Exit: 0 success; any error → exit 1, message on stderr, **no JSON result**. [src]
- Parallel: separate processes, chat state keyed by md5(cwd) → looks safe [src];
  not officially stated.
- **Main risk: hangs.** Reports of `-p` finishing but not exiting (forum 133109,
  150296, 150246) and zero-output hangs on 2026.07.01 (164841). Changelog claims
  fixes for stdin-open blocking (Feb 2026) and stuck long sessions (v2026.07.13).
  Runner already uses `stdin: 'ignore'`; always pass `timeoutMs`.

## 2. Auth
- `cursor-agent login` (browser; `NO_OPEN_BROWSER=1` prints URL), `status`, `logout`.
- Headless: `CURSOR_API_KEY` env or `--api-key` (Dashboard → API Keys). [docs]
- Works on Hobby with small limits (medium confidence); Max-mode model ids require
  Max Mode (changelog v2026.07.20). No published rate limits.

## 3. Output
- `--output-format json` → one line:
  `{type:"result", subtype:"success", is_error, duration_ms, duration_api_ms, result,
  session_id, request_id, usage?}` [src+docs]. Read `.result`.
- `stream-json`: NDJSON events system/user/assistant/tool_call/result.
- **No JSON-schema enforcement flag.** → `outputSchema: false`, runner emulates.

## 4. Worktrees / isolation
- `-w [name]` → worktree at `~/.cursor/worktrees/<repo>/<name>` (not beside the repo);
  runs `.cursor/worktrees.json` setup scripts unless `--skip-worktree-setup`; only in
  trusted workspaces. [src, changelog Feb 2026]
- Sandbox: `--sandbox`, policy `~/.cursor/sandbox.json` / `.cursor/sandbox.json`.

## 5. Models
- Flat ids with effort baked in: `auto`, `gpt-5.2`, `claude-opus-5-high`,
  `gpt-5.3-codex-xhigh`. Claude models available (hidden by default). [docs]
- `--help` advertises bracket params `model[context=1m,effort=high]` but 2026.09.26
  rejects them ("Cannot use this model") [forum 159748, cyberuni/cyberlegion#72].
- → Discover ids via `cursor-agent --list-models`; reasoning = choose a suffixed id,
  not a separate knob.

## 6. Custom commands [src]
- Load order (later overrides same name): team → global → `<ws>/.claude/commands` →
  `<ws>/.cursor/commands` → `~/.claude/commands` → `~/.cursor/commands` → plugins → skills.
- **Cursor already reads astro-code's `~/.claude/commands`.**
- `$ARGUMENTS`, `$1`…`$99` substituted; else args appended. `/name args` expanded
  anywhere; skills invocable as `/skill` in `-p` (changelog May 2026).
- Frontmatter: `description`.

## 7. Rules
- `.cursor/rules/*.mdc` (`description`, `globs`, `alwaysApply`), nested dirs found.
- `AGENTS.md` root + nested; `CLAUDE.md`/`CLAUDE.local.md` when third-party import is
  on (default). [src+docs]

## 8. Subagents / skills
- Subagents: `.cursor/agents/*.md`, `~/.cursor/agents`, also `.claude/agents`.
  Frontmatter `name`, `description`, `model` (`inherit`|id), `readonly`,
  `is_background`. Run in IDE, CLI and cloud; `-p` waits for subagents
  (changelog v2026.08.11). [src+docs]
- Skills: `<dir>/SKILL.md` under `.cursor/skills`, `.agents/skills`, `~/.cursor/skills`,
  `~/.agents/skills`; also reads `.claude/skills`, `.codex/skills`. Frontmatter `name`,
  `description`, `paths`, `disable-model-invocation`, `user-invocable`, `metadata`.

## 9. Hooks / statusline
- `.cursor/hooks.json`, `~/.cursor/hooks.json`, enterprise
  `/Library/Application Support/Cursor/hooks.json`.
  Format `{"version":1,"hooks":{"<event>":[{"command":"..."}]}}`. [docs]
- Events: sessionStart, sessionEnd, preToolUse, postToolUse, postToolUseFailure,
  subagentStart/Stop, before/afterShellExecution, before/afterMCPExecution,
  beforeReadFile, afterFileEdit, beforeSubmitPrompt, preCompact, stop,
  afterAgentResponse, afterAgentThought, workspaceOpen.
- Stdin payload: `conversation_id`, `generation_id`, `model`, `hook_event_name`,
  `workspace_roots`, `transcript_path`; env `CURSOR_PROJECT_DIR` (+ `CLAUDE_PROJECT_DIR`).
- **Imports Claude Code hooks** from `.claude/settings*.json` and
  `~/.claude/settings.json` at lowest priority (8 events mapped; Bash→Shell,
  Edit→Write). → Native Cursor hooks would double-fire alongside imported ones.
- No trust-hash gate (unlike Codex). CLI runs hooks.
- Statusline: `statusLine` command in `~/.cursor/cli-config.json` (changelog Apr 2026),
  payload Claude-shaped (context_window, used_percentage, worktree, session_name).

## 10. MCP
- `.cursor/mcp.json`, `~/.cursor/mcp.json`; CLI loads both; `--approve-mcps` headless.

## 11. Transcripts
- `~/.cursor/projects/<slug>/agent-transcripts/*.jsonl` — "Claude Code-compatible
  JSONL" (changelog Feb 2026); slug = path, non-alnum → `-`, collapsed, trimmed.
- CLI chats: `~/.cursor/chats/<md5(abs cwd)>/<chatId>/store.db` (SQLite).
- IDE legacy: `~/Library/Application Support/Cursor/User/{global,workspace}Storage/state.vscdb`.
- `CURSOR_CONFIG_DIR`, `CURSOR_DATA_DIR` override `~/.cursor`.

## Adapter mapping (draft)
| Contract | Cursor |
|---|---|
| detect / baseConfigDir | `CURSOR_CONFIG_DIR` → `~/.cursor`, or `cursor-agent` on PATH. Never `agent`. |
| placement | commands → `~/.cursor/commands/*.md`, agents → `~/.cursor/agents/*.md` (or rely on `.claude` import — open decision) |
| renderCommand | markdown + `description`; drop `allowed-tools`; `$ARGUMENTS` native |
| renderAgent | `name`, `description`, `model: inherit`, `readonly: true` for read-only agents |
| registerHooks | `~/.cursor/hooks.json` v1 — but Claude hooks already imported → double-fire risk (open decision); statusline via `cli-config.json` |
| execCommand | `cursor-agent -p --output-format json --force --trust --workspace <cwd> [--model m] [-w name] <prompt>`; explicit `--sandbox`; `--approve-mcps` if MCP needed |
| capabilities | `worktree: true` (caveat: lives under `~/.cursor/worktrees`), `outputSchema: false`, `reasoning`: via model-id suffix only |
| transcripts | agent-transcripts JSONL first, store.db fallback |

## Still unverified (needs a live run on a machine with Cursor installed)
`--list-models` ids, real JSON shape and exit codes, whether `-p` exits cleanly,
duplicate-agent behaviour when the same name exists in `.claude/agents` and `.cursor/agents`.
