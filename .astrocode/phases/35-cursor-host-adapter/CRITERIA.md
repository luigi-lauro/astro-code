# Phase 35 — Cursor host adapter · CRITERIA

Pre-registered, plan-blind success bar. Derived from the phase goal, CONTEXT.md decisions
1-6 + done bar, and canon (ADR-001, ADR-070). Every criterion must pass independently.

**Sandbox recipe used below ("fake-home install").** Every install/uninstall observation
runs against a throwaway HOME so the real machine is never touched and no real host leaks
into detection:

```
T=$(mktemp -d); NODEBIN=$(dirname "$(command -v node)")
run() { env -u CLAUDE_CONFIG_DIR -u CODEX_HOME -u CURSOR_CONFIG_DIR \
  HOME="$T" PATH="$EXTRA_PATH:$NODEBIN:/usr/bin:/bin" \
  node /Users/buu/Development/astro-code/bin/ac.mjs "$@"; }
```

"Cursor present" = `mkdir -p $T/.cursor` (or a stub `cursor-agent` on `EXTRA_PATH`);
"Claude present" = `mkdir -p $T/.claude`. `EXTRA_PATH` is a temp dir holding only the stubs
a criterion names. No real `cursor-agent`, `codex`, `claude` or `agent` may be on that PATH.
(C2 is the one case that sets `CURSOR_CONFIG_DIR` instead of unsetting it.)

### C1 — On a machine where only Cursor is present, `ac install` delivers the full astro command and agent set to Cursor's own config dir as standalone files
- **Observe:** fake-home install with only `$T/.cursor` present; `run install` exits 0 and its
  output names Cursor as a wired host. Then, in a second fresh fake home with only
  `$T2/.claude` present, run the same install and list the command and agent names Claude
  received. Compare: the set of `astro-*` command names under `$T/.cursor/commands/` and agent
  names under `$T/.cursor/agents/` equals the Claude set (name for name). Every installed
  Cursor command/agent is a regular file, not a symlink (`find $T/.cursor -type l` under those
  dirs is empty), and reads correctly on its own. No `$T/.claude` or `$T/.codex` dir is created
  by the install.
- **Fails if:** install exits non-zero or reports "no host detected"; any command or agent
  the Claude install gets is missing (or misnamed) on Cursor; files are symlinks (CONTEXT
  decision 1: copy, so Cursor works with its third-party import off and Claude absent);
  Cursor files land somewhere other than its config dir; the install creates a Claude/Codex
  config dir that was not there.

### C2 — `CURSOR_CONFIG_DIR` relocates every Cursor artifact
- **Observe:** fake-home install with `CURSOR_CONFIG_DIR=$T/alt-cursor` set (dir created), no
  `$T/.cursor`, no Claude. Commands, agents, `hooks.json` and `cli-config.json` (C5) all
  appear under `$T/alt-cursor/`; `$T/.cursor` does not exist afterwards.
- **Fails if:** anything is written to `$T/.cursor` while the variable is set, or the
  variable is ignored and Cursor is reported as not detected.

### C3 — Installed Cursor commands are each command's unchanged source body behind a short Cursor host note, in Cursor's format
- **Observe:** after C1's install, for every installed Cursor command: (a) its frontmatter
  carries a `description` equal to the source command's description and no `allowed-tools`
  key; (b) the source command's body (everything after its frontmatter) appears verbatim and
  contiguously in the installed file, with `$ARGUMENTS` occurrences left literally as
  `$ARGUMENTS`; (c) the text between the frontmatter and that body is a short note that tells
  the model, for each Claude-only tool, what to do on Cursor: the Workflow tool is unavailable
  (fall to the next tier), the Agent tool maps to a Cursor subagent addressed by the astro
  agent name, and AskUserQuestion becomes asking in chat with the same numbered options.
  Also install into a Claude-only and a Codex-present fake home and confirm their installed
  commands carry no Cursor note.
- **Fails if:** any body is rewritten, truncated or substituted per host (ADR-070); `$ARGUMENTS`
  is expanded, renamed or stripped; `allowed-tools` survives; the note is missing, omits one
  of the three tool mappings, or leaks into Claude/Codex output.

### C4 — Installed Cursor agents inherit the session model and are read-only exactly when the source agent cannot write
- **Observe:** for every agent under `/Users/buu/Development/astro-code/agents/`, read its
  source `tools` line and classify it write-capable if it grants any file-writing/editing tool
  (Write, Edit, MultiEdit, NotebookEdit or equivalent), else read-only. In the C1 install,
  each Cursor agent's frontmatter has `name` = the agent name, a non-empty `description`,
  `model: inherit`, and `readonly: true` iff the source is read-only (researchers, verifier
  and mapper must come out read-only; executor and criteria-author — which grants `Write`
  to produce CRITERIA.md — must not). Then copy the repo
  to a temp dir, add `Write` to a read-only agent's tools there, install from the copy into a
  fresh fake home, and confirm that agent is no longer `readonly: true`.
- **Fails if:** any agent names a Claude tier (opus/sonnet/haiku) or a concrete model; a
  write-capable agent is marked read-only or a read-only one is not; the readonly flag is
  driven by a hard-coded name list (the mutated copy still comes out read-only).

### C5 — With Claude Code absent, install wires astro-code's hooks and status line natively into Cursor, merged with the user's own entries and accounting for every hook event
- **Observe:** fake home with only `$T/.cursor`, pre-seeded with a user `hooks.json`
  (`{"version":1,"hooks":{"stop":[{"command":"echo user-stop"}],"afterFileEdit":[{"command":"echo user-edit"}]}}`)
  and a user `cli-config.json` containing unrelated keys (e.g. `{"permissions":{"allow":["Shell(ls)"]},"editor":{"vimMode":true}}`).
  `run install`. Then: (a) `hooks.json` is valid JSON with `version: 1`, the two user entries
  are still present unchanged, and astro-code entries were added; (b) `cli-config.json` still
  holds the user keys deep-equal and now has a `statusLine` whose command runs under the fake
  HOME and exits 0 printing a line; (c) separately do a Claude-only fake-home install and
  collect the set of Claude hook events astro-code registers in `settings.json`; every one of
  those events is either present (mapped to a Cursor event name) in `hooks.json` or named as
  skipped in the install output — none unaccounted for; (d) every astro-code hook command in
  `hooks.json` points at a script that exists and, run with `{}` on stdin under the fake
  HOME, exits 0 within 10s; (e) the install output states the native-hooks branch was taken;
  (f) running `run install` a second time leaves both files byte-identical to after the first.
- **Fails if:** user hooks or user config keys are lost or altered; astro entries duplicate on
  re-install; a Claude hook event silently disappears; a hook/statusline command points at a
  missing path or crashes; the output does not say which branch was taken.

### C6 — With Claude Code present, install leaves Cursor without native astro-code hooks (removing any it wrote earlier) and says Cursor runs the Claude hooks via import
- **Observe:** continue from C5's fake home (native entries present, user entries present),
  then `mkdir -p $T/.claude` and `run install` again. Afterwards `hooks.json` contains exactly
  the two user entries and no astro-code entry; `cli-config.json` holds the user keys and no
  astro-code `statusLine`; Claude's `settings.json` in `$T/.claude` received astro-code's
  hooks; Cursor commands and agents are still installed; the install output states the
  import branch (Cursor runs the Claude hooks via its import). Also from a fresh fake home with
  both `.claude` and `.cursor` and no prior Cursor files, the install wires both hosts in one
  run and creates no astro-code entries in Cursor's hook/config files.
- **Fails if:** astro-code's native Cursor hooks or status line remain (would double-fire with
  the imported Claude hooks); the user's entries are removed; Claude wiring regresses; the
  output does not report the branch.

### C7 — Cursor detection is config-dir-or-`cursor-agent`, and the binary named `agent` is never probed or run
- **Observe:** put a stub `agent` on `EXTRA_PATH` that appends to `$T/agent-ran` and exits 0.
  (a) Fake home with no `.cursor`, no `CURSOR_CONFIG_DIR`, no `cursor-agent`: `run install`
  does not wire Cursor and creates no `$T/.cursor`. (b) Same, plus a stub `cursor-agent` on
  `EXTRA_PATH` (no `.cursor`): install wires Cursor. (c) With only `$T/.cursor`: wires Cursor.
  After all three plus `run uninstall`, and after the full test suite (C10) run with the same
  `EXTRA_PATH` prepended, `$T/agent-ran` does not exist. Also: the Cursor host's headless
  invocation (C8) names `cursor-agent` as its command, never `agent`.
- **Fails if:** Cursor is wired with neither signal present; a `cursor-agent`-only machine is
  not detected; anything ever executes `agent` (would hit astro-agent / a binary Cursor's curl
  installer overwrites).

### C8 — The Cursor host can run one headless agent through the existing runner with correct argv and positional failure semantics
- **Observe:** a `node --input-type=module -e` script that looks up the `cursor` host in the
  host registry and calls the runner's wave function with an injected spawn function that
  records `{command,args,cwd}` and replies per task. Tasks: (1) `{prompt:'hi', cwd:'/tmp/w', json:true, model:'m1', worktree:true}`
  replying exit 0 with stdout `{"type":"result","result":"done-1"}`; (2) same without
  model/worktree replying exit 1; (3) replying exit 0 with stdout `not json` and `json:true`.
  Assert: command is `cursor-agent`; argv contains print mode (`-p`), `--output-format json`,
  `--force`, `--trust`, the model (`--model m1`) only when given, a worktree flag only when
  asked, the prompt as the final positional argument, and the run is pointed at `/tmp/w`
  (via `--workspace /tmp/w` and/or spawn cwd); result 1 is truthy and yields `done-1` as the
  reply text; results 2 and 3 are falsy holes at their positions; the host reports
  `capabilities` with worktree true, outputSchema false, reasoning false.
- **Fails if:** the command is `agent` or anything else; required flags missing or the prompt
  not last; a model/worktree flag appears when not requested; a non-zero exit or non-JSON
  reply is reported as success; results are reordered or the batch rejects.

### C9 — `ac uninstall` removes astro-code from Cursor and only astro-code
- **Observe:** from C5's fake home (Claude absent, native entries + user entries), add a user
  command `$T/.cursor/commands/my-cmd.md` and user agent `$T/.cursor/agents/my-agent.md`,
  then `run uninstall`. Afterwards no `astro-*` command or agent remains under `$T/.cursor`;
  `my-cmd.md`, `my-agent.md`, the two user hooks and the user `cli-config.json` keys survive
  unchanged; no astro-code hook or `statusLine` remains; `$T/.cursor` itself still exists.
- **Fails if:** astro-code files or hook/statusline entries linger (they would point at the
  deleted astro home and fail every session); any user file/entry is deleted or rewritten;
  the Cursor dir is removed.

### C10 — The test suite is green and actually guards the Cursor adapter
- **Observe:** `cd /Users/buu/Development/astro-code && node --test tests/` exits 0 with zero
  failures. Then mutation checks in a temp copy of the repo (never the real tree): (a) make the
  Cursor headless command `agent` instead of `cursor-agent` → the suite fails; (b) make
  Cursor's install overwrite `hooks.json` with only astro entries (dropping user entries) →
  the suite fails; (c) remove Cursor from the host registry → the suite fails.
- **Fails if:** any test fails on the real tree, or any of the three mutations leaves the
  suite green (Cursor behavior untested, contrary to CONTEXT decision 6 and scope).

### C11 — `/astro-config` running on Cursor never offers or writes Claude model tiers
- **Observe:** read the `astro-config` command as installed for Cursor (C1). Following its
  instructions as a Cursor session: the reader is told how to recognise it is on Cursor, is
  offered no opus/sonnet/haiku tier or Claude profile, is told never to run
  `ac config set models.<role>` or `ac models <profile>` from Cursor (shared committed
  config), and is told roles run on the Cursor session's model (inherit). The Codex-specific
  guidance still reads correctly for Codex.
- **Fails if:** a Cursor session following the command could be offered or write a Claude
  tier, or the Cursor case is indistinguishable from Claude in the instructions.

### C12 — A reader of astro-code's host documentation can invoke it on Cursor
- **Observe:** inspect the host/invocation tables and host sections in
  `/Users/buu/Development/astro-code/AGENTS.md`, the AGENTS.md a generated project receives
  (produce it by running `ac init` in a temp git repo under a fake HOME and read the result),
  `README.md` and the manual. Each lists Cursor (IDE agent and `cursor-agent` CLI) with how
  commands are invoked there and how to get astro-code installed for it (`ac install` with
  Cursor present); none tells the reader to install via Cursor's curl installer or to run a
  binary named `agent`.
- **Fails if:** any host table still lists only Claude Code and Codex, a generated project's
  AGENTS.md lacks Cursor, or docs give an invocation that contradicts C3/C7.

### C13 — Live on the developer's Mac: real `cursor-agent` runs astro-code headlessly, delegates to an astro subagent, and leaves astro-agent's `agent` intact
- **Observe:** via the host bridge from `/Users/buu/Development/astro-code` (installing
  cursor-cli requires the developer's go-ahead; if it is not installed, this criterion cannot
  pass): (a) `host command -v cursor-agent` resolves (brew cask), and `host ac install` output
  lists Cursor and reports the Claude-present/import hook branch; (b) `host ls ~/.cursor/commands ~/.cursor/agents`
  shows the astro set; (c) `host 'timeout 300 cursor-agent -p --trust "/astro-status"'` exits
  0 and prints the current milestone/phase status; (d) one `host 'timeout 600 cursor-agent -p --trust "<prompt asking it to delegate a read-only mapping question to the astro-mapper subagent>"'`
  exits 0 with an answer attributable to the subagent run, without hanging; (e) `host command -v agent`
  still resolves to astro-agent's binary (same path/target as before), and its version/help
  output identifies astro-agent, not Cursor.
- **Fails if:** cursor-agent is absent or was installed via the curl installer; `/astro-status`
  is not recognised, errors or hangs; delegation fails, hangs past the timeout, or never
  reaches the subagent; `agent` now resolves to Cursor's binary; the hook branch is
  misreported.
