# Plan — phase 35: Cursor host adapter

Obeys `.astrocode/CONVENTIONS.md` (Node ≥22 ESM, zero deps, named exports + the adapter's
closing `export const cursorHost = {…}; export default cursorHost;` pattern that `claude.mjs`/
`codex.mjs` already use, `node:test` per `lib/` change, real fs in tests, load-bearing comment
voice, `✓`/`•`/`⚠` glyphs), `.astrocode/DECISIONS.in-force.md` (ADR-001 zero deps, ADR-018
red-test imports, ADR-020 wave-green, ADR-021 CRITERIA.md is the bar, ADR-070 one command
source + a prepended host note), this phase's `CONTEXT.md` (decisions 1–6, scope, done bar)
and `RESEARCH-cursor-cli.md`, and aims at every criterion in `CRITERIA.md` (C1–C13).
Principles brief (`--stage plan --by planner`): nothing in scope.

## Decisions this plan pins

- **P1 — readonly is derived, and C4 has an internal conflict (flagged, not papered over).**
  `isReadonly(toolsCsv)`: `true` iff the source `tools:` line grants none of `Write`, `Edit`,
  `MultiEdit`, `NotebookEdit`. This is exactly C4's stated rule and passes its mutation check.
  Result on the shipped agents: researcher, verifier, mapper → `readonly: true`; executor,
  planner → not; **criteria-author → NOT readonly**, because `agents/astro-criteria-author.md`
  declares `tools: Read, Write, Grep, Glob` and must write `CRITERIA.md` itself. C4's
  parenthetical (and CONTEXT decision 1's list) name criteria-author as read-only; that
  contradicts the rule both of them also state ("derive from the source agent's tools, not a
  hard-coded list"). Derivation wins: a readonly criteria-author on Cursor could not write its
  only output. Tests pin criteria-author → not readonly with this reason in the test name; the
  verifier/human should resolve the C4 parenthetical (amend the criterion), not the code.
- **P2 — the Cursor host note (ADR-070), exact lead line.** `renderCommand` emits
  `---\ndescription: <source description>\n---\n<NOTE>\n\n<source body verbatim>`. Only
  `description` is kept (`allowed-tools`, `argument-hint` and anything else dropped — Cursor
  documents `description` only). `NOTE` is an exported constant `CURSOR_NOTE`:
  ```
  > **Running on Cursor.** These steps were written for Claude Code; map its tools like this:
  > - **Workflow tool** — not available here. Take the next tier the step offers (subagents, else inline).
  > - **Agent tool** — delegate to a Cursor subagent; pass the astro agent's name (e.g. `astro-researcher`) as `subagent_type`.
  > - **AskUserQuestion** — ask in chat as a numbered list with the same options, then wait for the reply.
  ```
  The phrase `Running on Cursor` is the hook `/astro-config`'s Cursor branch keys on (t6).
  `$ARGUMENTS` is never touched (Cursor substitutes it).
- **P3 — agents.** `renderAgent` → one file `<name>.md`, frontmatter in this order: `name`,
  `description`, `model: inherit`, then `readonly: true` only when P1 says so (key omitted
  otherwise); body verbatim. No Claude tier ever appears.
- **P4 — detection, binary pinned.** `const BIN = 'cursor-agent'; // NEVER 'agent' — CONTEXT §6:
  on the dev Mac `agent` is astro-agent and Cursor's curl installer overwrites ~/.local/bin/agent`.
  `baseConfigDir()` = `CURSOR_CONFIG_DIR` else `~/.cursor` (read at call time). `detect()` =
  `existsSync(baseConfigDir()) || onPath(BIN)`, where `onPath` splits `process.env.PATH` on
  `path.delimiter` and `existsSync(join(d, BIN))` (plus `.exe`/`.cmd` on win32) — sync, no
  subprocess, same cost envelope as the other two adapters. `configTargets()` = the single base
  dir. `placement = { commands: 'commands', agents: 'agents', ext: '.md', mode: 'copy' }`,
  `id: 'cursor'`, `label: 'Cursor'`.
- **P5 — `execCommand` argv (pure, never spawns).** Always:
  `['-p', ...(worktree ? ['-w', ...(typeof worktree === 'string' ? [worktree] : [])] : []),
  '--output-format', 'json', '--force', '--trust', ...(cwd ? ['--workspace', cwd] : []),
  ...(model ? ['--model', model] : []), ...(sandbox ? ['--sandbox', sandbox] : []), prompt]`,
  `command: BIN`. `-w` takes an OPTIONAL value, so it sits right after `-p` and is always
  followed by `--output-format` — it must never be the token before the prompt or it would
  swallow the prompt as a worktree name. JSON output is unconditional (P6 parses it).
  `systemPrompt`/`tools`/`schemaFile`/`outFile`/`permissionMode`/`reasoning` are accepted and
  ignored with a comment each (no flag exists; reasoning lives in model-id suffixes).
  `capabilities = { worktree: true, outputSchema: false, reasoning: false }`. No `cursor` entry
  is added to `TOOL_MAP` or `REASONING_MAP` (pass-through is the intended behaviour).
- **P6 — result parsing via an optional adapter hook in the runner.** New optional contract
  member `parseResult(stdout, task)` → reply value, or `null`/`undefined` meaning "failed". In
  `runWave`, on exit 0 a host that has `parseResult` gets it called (inside the existing try, so
  a throw is a hole); a nullish return makes the task a falsy positional hole exactly like a
  non-zero exit. Hosts without it keep today's `readResult` path byte-for-byte (Claude/Codex
  untouched). Cursor's `parseResult`: parse the whole stdout, else the last parseable line; it
  must be an object with `type === 'result'`, `is_error !== true` and a string `result` →
  return that string; anything else → `null`.
- **P7 — hooks (decision 2).** `cursor.mjs` exports `ASTRO_HOOKS` (the astro-code entries
  `claude.mjs` registers: `{event:'SessionStart',script:'astro-update.mjs'}`,
  `{event:'PreCompact',script:'astro-precompact.mjs'}`,
  `{event:'UserPromptSubmit',script:'astro-session-state.mjs',arg:'prompt'}`,
  `{event:'Stop',script:'astro-session-state.mjs',arg:'stop'}`), `EVENT_MAP`
  (`SessionStart→sessionStart`, `PreCompact→preCompact`, `UserPromptSubmit→beforeSubmitPrompt`,
  `Stop→stop`) and pure `mapHookEvents(events)` → `{ mapped:[{claude,cursor}], skipped:[claude] }`.
  A test (t2) asserts `ASTRO_HOOKS`' event set equals the events `claude.registerHooks` actually
  writes, so a new Claude hook can never silently go unaccounted for on Cursor.
  `registerHooks(dir, home)`:
  - Claude detected (`detect` imported from `./claude.mjs`, evaluated at call time) → remove
    astro-code's Cursor entries + statusLine (same code as `unregisterHooks`) and return
    `{ branch: 'import' }`.
  - else merge into `<dir>/hooks.json` (`{"version":1,"hooks":{<event>:[{"command":…}]}}`, keep
    an existing `version`) one entry per mapped hook, command
    `"<process.execPath>" "<home>/hooks/<script>"[ <arg>]`; ours = an entry whose `command`
    includes the script filename (the Claude adapter's `hasCommand` idea, flat Cursor shape);
    already-ours → left alone. `<dir>/cli-config.json` gets
    `statusLine: { type: 'command', command: "<node>" "<home>/hooks/astro-statusline.mjs" "<dir>" }`;
    a pre-existing foreign `statusLine` is stashed in `<home>/statusline-chain.json` keyed by
    `dir` (the same chain file/idiom Claude uses; `astro-statusline.mjs` already reads
    `chain[argv[2]]`). Returns `{ branch: 'native', events: [cursor names], statusLine: true,
    skipped: [claude names] }`.
  - Either file present but unparseable → touch nothing, return `{ branch: 'none', reason }`.
  - Writes use `atomicWriteJSON` from `lib/util.mjs` (not claude.mjs's plain `writeFileSync`),
    and a file is written ONLY when its content changed — a no-op pass never reformats the
    user's file, and a re-install is byte-identical (C5f).
  `unregisterHooks(dir, home)`: drop ours from every event list (delete an event key only if
  our removal emptied it), restore the stashed statusLine or delete ours; missing dir/files →
  no-op, never creates `dir`.
- **P8 — install plumbing needs no change.** `lib/install.mjs` already routes copy-mode hosts
  through `publishCopyHost`, stores `registerHooks`' return in `targets[].hooks`, and
  uninstalls every `HOSTS` member (prune `astro-*` in `commands/` + `agents/`, then
  `unregisterHooks`). Executors must not edit it; if a task finds it must, that is a plan bug
  to report, not a silent file overflow.
- **P9 — install/update report (decision 2).** `bin/ac.mjs` keeps `', update banner+statusline'`
  for a boolean `true`, and for an object report prints `hooks: native (<events>) + statusline`,
  `hooks: via Claude Code import — Cursor runs the Claude Code hooks`, or
  `⚠ hooks not wired — <reason>`; each skipped event prints its own
  `⚠ <label>: no equivalent for Claude hook <Event> — skipped`. Both `ac install` and
  `ac update` print it (update today prints one summary line; add the per-target hook line for
  object reports).
- **P10 — tests never depend on the machine.** Once Cursor is registered, an existing test that
  installs with the real `PATH` would wire Cursor on any machine with `cursor-agent` installed
  (the dev Mac after the done bar — brew puts it in the same dir as `node`). t13 pins
  `CURSOR_CONFIG_DIR` unset and a `PATH` with no `cursor-agent` in every install-running test.
  New integration tests spawn `process.execPath` directly with `PATH=<stub dir>:/usr/bin:/bin`
  and a clean env (no `...process.env`), so neither `node`'s dir nor a real `agent`/
  `cursor-agent` is ever reachable.
- **Test strategy (stated per ADR-018).** Test-first for the adapter and the install behaviour:
  t1/t2 are RED and reach `lib/hosts/cursor.mjs` (and `claude.mjs`) ONLY via
  `await import(...)` inside async test bodies; t3 is RED and subprocess-only (imports nothing
  new). t4, t5, t6, t7 are test-in-task. t12 is **test-after by choice** (depends on t10): it
  pins C8's end-to-end runner shape for an adapter that already exists.

## Tasks

### t1 — RED: Cursor adapter core tests
- **file:** `tests/cursor.test.mjs` (new)
- **depends_on:** —
- Every test: `const cursor = (await import('../lib/hosts/cursor.mjs')).default` (and named
  exports the same way). Real `commands/*.md`/`agents/*.md` read from disk like
  `hosts.test.mjs` does.
- Commands (C3): for EVERY shipped command — exactly one file `<name>.md`; frontmatter
  `description` equals the source's; no `allowed-tools`; the source body (after its
  frontmatter) appears verbatim and contiguously; the text between frontmatter and body is
  `CURSOR_NOTE` (P2) and contains `Workflow`, `Agent tool` + `subagent`, `AskUserQuestion` +
  `numbered`; the count of literal `$ARGUMENTS` equals the source's.
- Agents (C4): for every shipped agent — `name` = file name, non-empty `description`,
  `model: inherit`, no `opus|sonnet|haiku`; `readonly: true` iff `isReadonly(tools)`; pin
  researcher/verifier/mapper → readonly, executor/planner → not, and
  "criteria-author keeps write access because it writes CRITERIA.md itself" → not (P1).
  Mutations on in-memory sources: mapper + `, Write` → not readonly; criteria-author minus
  `Write` → readonly (proves no name list).
- `execCommand` (C7/C8): `command === 'cursor-agent'` (literal); with
  `{prompt:'hi',cwd:'/tmp/w',model:'m1',worktree:true,sandbox:'enabled'}` argv contains `-p`,
  `--output-format json`, `--force`, `--trust`, `--workspace /tmp/w`, `--model m1`, `-w`,
  `--sandbox enabled`, prompt last; the token before the prompt is never `-w`; with only
  `{prompt:'x'}` there is no `--model`, `-w`, `--workspace`; `capabilities` deep-equals P5.
- `parseResult` (P6): `{"type":"result","result":"done-1"}` → `'done-1'`; a JSONL stream whose
  last line is the result → its `.result`; `not json`, `''`, `is_error:true`, a non-result
  object → `null`.
- `detect`/`configTargets` (C2/C7), env saved/restored around each: temp HOME, no
  `CURSOR_CONFIG_DIR`, `PATH` = empty temp dir → `false`; `PATH` = dir with a stub
  `cursor-agent` → `true`; dir holding ONLY a stub `agent` → `false`; `CURSOR_CONFIG_DIR` set to
  an existing dir → `true` and `configTargets()` has exactly that dir. `id`/`label`/`placement`
  equal P4.

### t2 — RED: Cursor hook wiring tests
- **file:** `tests/cursor_hooks.test.mjs` (new)
- **depends_on:** —
- `await import('../lib/hosts/cursor.mjs')` and `await import('../lib/hosts/claude.mjs')`
  inside async bodies; temp HOME (`process.env.HOME`, `CLAUDE_CONFIG_DIR`/`CURSOR_CONFIG_DIR`
  deleted, restored in `finally`); `home` = a temp astro home.
- Drift guard (C5c): `claude.registerHooks(tmpClaudeDir, home)`; the set of `settings.json`
  hook events whose commands reference an astro hook script equals the set of
  `ASTRO_HOOKS` events; `mapHookEvents` maps each of them or lists it in `skipped`; a fake
  `Notification` event lands in `skipped`.
- Native branch (Claude absent), pre-seeded user `hooks.json`
  (`stop` + `afterFileEdit` user entries) and `cli-config.json`
  (`permissions`, `editor` keys, plus a user `statusLine`): report
  `branch:'native'`, `events` = the four Cursor names; `version: 1` kept; user entries
  deep-equal; one astro entry per mapped event whose command names an existing-path-shaped
  `<home>/hooks/<script>`; user keys deep-equal; `statusLine.command` includes
  `astro-statusline.mjs`; the user statusLine is in `statusline-chain.json` under `dir`.
- Idempotent (C5f): second `registerHooks` → both files byte-identical to after the first.
- Flip to import (C6): `mkdir HOME/.claude`, `registerHooks` again → `branch:'import'`;
  `hooks.json` contains exactly the two user entries; `cli-config.json` has the user keys and
  the user's ORIGINAL statusLine restored.
- Unparseable: `hooks.json` = `{nope` → `branch:'none'`, both files byte-identical before/after.
- `unregisterHooks` (C9): from native state removes only ours, restores the user statusLine,
  keeps the user entries; on a non-existent `dir` it does not create it and does not throw.
- Mutation-shaped guard (C10b): after register, the user's two entries are still present
  (written so that an implementation replacing `hooks` wholesale fails).

### t3 — RED: install/uninstall integration on fake homes (subprocess only)
- **file:** `tests/install_cursor.test.mjs` (new)
- **depends_on:** —
- Helper `run(T, args, { extra = [], env = {} })` =
  `spawnSync(process.execPath, [bin/ac.mjs, ...args], { env: { HOME: T, PATH: [stubDir, '/usr/bin', '/bin'].join(':'), ...env }, encoding: 'utf8', timeout: 60000 })`
  — a CLEAN env (P10). Stubs: `cursor-agent` and `agent` are `#!/bin/sh` scripts that append to
  `$T/<name>-ran`; every test asserts neither marker exists at the end (C7).
- C1: only `$T/.cursor` → exit 0, stdout names `Cursor`; `astro-*` names in
  `.cursor/commands`/`.cursor/agents` equal the `commands/*.md`/`agents/*.md` source names; no
  symlinks there; no `$T/.claude`, no `$T/.codex`.
- C2: `CURSOR_CONFIG_DIR=$T/alt-cursor` (created), no `.cursor` → commands, agents,
  `hooks.json`, `cli-config.json` under `alt-cursor`; `$T/.cursor` absent.
- C3 (install level): installed `astro-plan.md` starts with frontmatter, contains
  `Running on Cursor`, contains the source body verbatim; a Claude-only home's
  `.claude/commands/astro-plan.md` does not contain `Running on Cursor`.
- C5: seeded files as in CRITERIA C5 → (a) user hook entries intact + astro entries added,
  (b) user keys deep-equal + `statusLine` whose command, run via `sh -c` with
  `HOME=$T`, input `{}`, timeout 10s, exits 0 and prints a non-empty line, (d) every astro hook
  command in `hooks.json` run the same way exits 0 within 10s, (e) stdout matches
  `/Cursor.*hooks: native/`, (f) second install → both files byte-identical.
- C6: continue from C5's home, `mkdir .claude`, install → `hooks.json` exactly the two user
  entries, no astro `statusLine`, `.claude/settings.json` holds astro hooks, Cursor commands/
  agents still present, stdout matches `/Cursor.*via Claude Code import/`. Fresh home with
  both `.claude` and `.cursor` → both wired, no astro entry in any Cursor json file (absent
  files are fine).
- C7: (a) neither signal → no `$T/.cursor` and stdout has no `Cursor →` line; (b) stub
  `cursor-agent` on PATH only → Cursor wired into `$T/.cursor`; (c) `.cursor` only → wired.
- C9: from C5's native state add `.cursor/commands/my-cmd.md`, `.cursor/agents/my-agent.md`,
  `run uninstall` → no `astro-*` left under `.cursor`, user files byte-identical, user hook
  entries + config keys intact, no astro hook/statusLine, `$T/.cursor` exists.

### t4 — Runner: optional `parseResult` adapter hook
- **file:** `lib/hosts/runner.mjs`, `tests/runner.test.mjs`
- **depends_on:** —
- Implement P6 in `runWave` (call `host.parseResult` only on exit 0, inside the existing
  `try`; nullish → `null` hole; `onProgress` end event gets `ok:false` and an
  `error` of `unparseable result`). Extend the module header's failure-semantics note.
  Test-in-task with a fake host object (no Cursor import): nullish parse → hole at its index;
  value → `result`; not called on non-zero exit; a throwing `parseResult` → hole, batch
  resolves; a host without the hook keeps the raw-text fallback (existing tests stay as is).

### t5 — `ac install` / `ac update` report the Cursor hook branch
- **file:** `bin/ac.mjs`
- **depends_on:** —
- Implement P9 with one small helper used by both the `install` and `update` cases. Boolean
  `t.hooks` output is unchanged (Claude/Codex lines identical). Covered by t3's stdout
  assertions (test-after via t3, by choice — the helper is formatting only).
  `node --test tests/cli.test.mjs tests/install.test.mjs` stays green.

### t6 — `/astro-config` never offers Claude tiers on Cursor
- **file:** `commands/astro-config.md`, `tests/config_cursor.test.mjs` (new)
- **depends_on:** —
- Add `## On Cursor` inside `# Models`, BEFORE `## On Codex`. Recognition: this command opened
  with the **Running on Cursor** note (the Cursor adapter prepends it), i.e. you are Cursor's
  IDE agent or `cursor-agent`. Rules mirror the Codex branch: never offer `opus`/`sonnet`/
  haiku or the Balanced/Fast/Max profiles; never run `ac config set models.<role>` or
  `ac models <profile>` (shared committed config); roles run on the Cursor session's model
  (agents are installed `model: inherit`; choose it with Cursor's model picker /
  `cursor-agent --model`); reasoning depth on Cursor lives in the model id suffix, so
  `reasoning.<role>` is not applied there in v1 — say so in one line; per-role Cursor models →
  offer `ac backlog add "Per-role Cursor models"`; then stop. Narrow the Codex branch's
  recognition sentence so a GPT model inside Cursor does not take it (e.g. "…and this command
  did not open with the Running on Cursor note"), keeping every phrase
  `tests/config_codex.test.mjs` matches.
- Test-in-task (source-only, mirrors `config_codex.test.mjs`): branch exists, sits before
  `## On Codex` and `## Steps`; mentions `Running on Cursor`; forbids offering opus; forbids
  `ac config set models.`; names the session model / `inherit`; contains no
  `ac models (balanced|fast|max)`. `node --test tests/config_codex.test.mjs tests/commands.test.mjs tests/config_cursor.test.mjs` green.

### t7 — AGENTS.md (repo + generated) lists Cursor
- **file:** `AGENTS.md`, `templates/AGENTS.md`, `tests/agentsmd.test.mjs`
- **depends_on:** —
- Add a row to both "Invoking the commands" tables:
  `| Cursor (IDE agent, \`cursor-agent\` CLI) | \`/astro-status\`, \`/astro-plan 3\`; headless \`cursor-agent -p "/astro-status"\` — installed to \`~/.cursor\` by \`ac install\` when Cursor is present |`.
  Never mention the curl installer or a binary named `agent`. Extend the existing
  `agentsmd.test.mjs` content test: the written block names `Cursor` and `cursor-agent`, and
  does not match `/\bagent -p\b|curl .*cursor/`.

### t8 — README lists Cursor
- **file:** `README.md`
- **depends_on:** —
- Line ~19: "Works with **Claude Code**, **Codex CLI** and **Cursor** (IDE agent and
  `cursor-agent` CLI) from one install…". Near line ~66: one sentence — on Cursor the same
  `/astro-plan 1` works; install Cursor's CLI with `brew install --cask cursor-cli` (gives
  `cursor-agent`) and re-run `ac install`.

### t9 — MANUAL + ARCHITECTURE describe the Cursor host
- **file:** `MANUAL.md`, `ARCHITECTURE.md`
- **depends_on:** —
- MANUAL host table (~line 45): `| **Cursor** | commands \`~/.cursor/commands/\`, agents \`~/.cursor/agents/\` (\`$CURSOR_CONFIG_DIR\` honoured) | \`/astro-plan 3\` |`.
  New `### Using it on Cursor` after "Using it on Codex": detection (config dir or
  `cursor-agent` on PATH; install the CLI via `brew install --cask cursor-cli`, NOT the curl
  installer — it replaces `~/.local/bin/agent`); commands carry a short host note (no Workflow
  tool → subagents → inline); agents run on the session model, read-only roles derived from
  their tools; hooks + status line native only when Claude Code is absent, otherwise Cursor
  runs the Claude Code hooks via its import (install output says which); headless
  `cursor-agent -p --trust "/astro-status"`. Touch the other two-host sentences (~474, ~587,
  ~756) only where they enumerate hosts. `ARCHITECTURE.md` line 4: three hosts.

### t10 — `lib/hosts/cursor.mjs`: identity, detection, rendering, headless invocation
- **file:** `lib/hosts/cursor.mjs` (new)
- **depends_on:** t1
- Implement P2–P6 (`id`, `label`, `placement`, `baseConfigDir`, `configTargets`, `detect`,
  `isReadonly`, `CURSOR_NOTE`, `renderCommand`, `renderAgent`, `execCommand`, `parseResult`,
  `capabilities`) reusing `parseFrontmatter`/`toMarkdown` from `./render.mjs`. Stateless about
  HOME/env (read at call time). Temporarily `registerHooks: () => false`,
  `unregisterHooks: () => {}` in the `cursorHost` object (t11 replaces them; the module is not
  registered yet, so nothing calls them).
- Header comment in the house voice: what is verified (`[src]` bundle 2026.10.01) vs `[docs]`
  vs still unverified (cite `RESEARCH-cursor-cli.md`); why `cursor-agent` and never `agent`;
  the `-p` hang history and that **every caller of `execCommand` for this host MUST pass
  `timeoutMs`** (runner wiring is a later phase — the warning must outlive this phase's docs);
  why commands are copied not symlinked (Claude absent / third-party import off); why `-w`
  never precedes the prompt.
- `node --test tests/cursor.test.mjs tests/hosts.test.mjs` → green.

### t11 — `lib/hosts/cursor.mjs`: conditional native hooks + status line
- **file:** `lib/hosts/cursor.mjs`
- **depends_on:** t2, t10
- Implement P7 (`ASTRO_HOOKS`, `EVENT_MAP`, `mapHookEvents`, `registerHooks`,
  `unregisterHooks`) with `atomicWriteJSON` from `../util.mjs` and `detect` from
  `./claude.mjs`; wire both into `cursorHost`. Comment the branch: why native hooks would
  double-fire next to Cursor's Claude import, why the choice is re-made on every install,
  why only-on-change writes.
- `node --test tests/cursor_hooks.test.mjs tests/cursor.test.mjs` → green.

### t12 — Runner end-to-end for Cursor (C8) + hang path (test-after)
- **file:** `tests/runner.test.mjs`
- **depends_on:** t4, t10
- `const cursor = (await import('../lib/hosts/cursor.mjs')).default` inside the tests. C8 as
  written: three tasks through `runWave` with an injected spawn recording
  `{command,args,cwd}` → command `cursor-agent`; `-p`, `--output-format json`, `--force`,
  `--trust` present; `--model m1` and `-w` only on task 1; prompt last; spawn `cwd === '/tmp/w'`;
  result 1 `ok` with `result === 'done-1'`; results 2 (exit 1) and 3 (`not json`) are `null`
  at their indices; batch resolves. Hang: `runWave` with the cursor host, `defaultSpawn`
  wrapped to run `process.execPath -e "setInterval(()=>{},1e3)"` instead of the argv,
  `timeoutMs: 300` → resolves within 5s to `[null]`.

### t13 — Register Cursor in `HOSTS`, make the suite machine-independent, final gate
- **file:** `lib/hosts/index.mjs`, `tests/hosts.test.mjs`, `tests/install.test.mjs`,
  `tests/hooks-update.test.mjs`, `tests/challenge.test.mjs`, `tests/agent_tools.test.mjs`
- **depends_on:** t3, t5, t6, t7, t8, t9, t11, t12
- `import cursorHost from './cursor.mjs'`; `HOSTS = [claudeHost, codexHost, cursorHost]`.
  Update the header: three hosts wired (Pi researched); `registerHooks` may return a report
  object (P7/P9); optional `parseResult` (P6). In the same commit (ADR-020 — registering breaks
  `hosts.test.mjs`' `['claude','codex']` assertion and makes install outcomes machine-dependent):
  the registry test asserts `['claude','codex','cursor']`; every install-running test pins
  `CURSOR_CONFIG_DIR` unset and a `PATH` without `cursor-agent` (in-process: set
  `process.env.PATH` to an empty temp dir inside the env scope; spawned: `PATH='/usr/bin:/bin'`,
  run via `process.execPath`) — P10.
- **Gate (this task is the phase's last commit):**
  1. `node --test tests/` → 0 failures (t3's RED file now green).
  2. Same run with `PATH=<dir holding stub cursor-agent + stub agent that writes a marker>:$PATH`
     and `CURSOR_CONFIG_DIR` unset → 0 failures, marker absent (C7, C10).
  3. C10 mutations, each in a fresh temp copy of the repo (`cp -a`, never the real tree):
     (a) `BIN = 'agent'`, (b) `registerHooks` writes `hooks` with only astro entries,
     (c) Cursor removed from `HOSTS` → the suite FAILS each time.
  4. CRITERIA's fake-home recipe by hand for C1/C2/C5/C6/C7/C9 (on a Mac, drop `$NODEBIN`
     from PATH and call node by absolute path — brew puts `cursor-agent` and astro-agent's
     `agent` beside `node`).
  5. If `cursor-agent` is already on the host's PATH: `host node scripts/smoke-hosts.mjs cursor`
     (one "PONG" turn) — otherwise leave it to the done bar below. Never install anything.
- Any failure found here is fixed in the owning file only if that file is in this task's list;
  otherwise stop and report it.

## Wave shape

| wave | tasks |
| --- | --- |
| 1 | t1, t2, t3, t4, t5, t6, t7, t8, t9 |
| 2 | t10 |
| 3 | t11, t12 |
| 4 | t13 |

Rule checks:
- **Test-first.** t1, t2, t3 are RED with empty `depends_on`; t10←t1, t11←t2, t13 makes t3
  green. t1/t2 reach every new symbol via `await import(...)` in async bodies (no static
  import of `cursor.mjs`); t3 is subprocess-only. t4/t6/t7 are test-in-task; t5 is covered by
  t3; t12 is test-after by explicit choice.
- **Wave-green.** No deletion or rename anywhere. The one consumer-breaking edit —
  registering Cursor in `HOSTS` — carries the registry assertion and the machine-independence
  fixes in the same task (t13). `cursor.mjs` is unregistered until t13, so t10/t11 cannot
  change install behaviour. t4's hook is optional (Claude/Codex untouched); t5 keeps the
  boolean output identical.
- **One owner per wave per file.** `lib/hosts/cursor.mjs`: t10 → t11. `tests/runner.test.mjs`:
  t4 → t12. Every other file has exactly one owning task (`bin/ac.mjs` t5,
  `commands/astro-config.md` t6, `AGENTS.md`/`templates/AGENTS.md`/`tests/agentsmd.test.mjs` t7,
  `README.md` t8, `MANUAL.md`/`ARCHITECTURE.md` t9, `lib/hosts/runner.mjs` t4,
  `lib/hosts/index.mjs` + the five existing test files t13). `lib/install.mjs` is owned by no
  task (P8).
- **Every task declares its files and lands a stamped commit.** The gate is folded into t13;
  no task is `commits: none`.

## Done bar — live check on the developer's Mac (verify AND accept; not an executor task)

Needs the developer's explicit go-ahead to `brew install --cask cursor-cli` on the host (host
bridge rule); no executor installs anything. Then, from `/Users/buu/Development/astro-code`:
`host command -v cursor-agent` and `host command -v agent` (record the latter BEFORE install);
`host ac install` (lists Cursor, reports `via Claude Code import`); `host ls ~/.cursor/commands
~/.cursor/agents`; `host node scripts/smoke-hosts.mjs cursor` (exercises P5/P6 against the real
binary — the JSON shape is otherwise only read off the bundle); `host 'timeout 300 cursor-agent
-p --trust "/astro-status"'`; `host 'timeout 600 cursor-agent -p --trust "<delegate a read-only
mapping question to the astro-mapper subagent>"'`; `host command -v agent` again (unchanged,
astro-agent). Settle there, not by guessing: same-named agent in `~/.claude/agents` and
`~/.cursor/agents` (one or two?), `subagent_type` by name, `-p` clean exit, whether
`readonly: true` blocks the verifier's/mapper's shell use, whether Cursor's import reads a
non-default Claude config dir (jean-claude / `CLAUDE_CONFIG_DIR`) — if not, the import branch
leaves such a machine hook-less and that is a follow-up, not a silent assumption.
