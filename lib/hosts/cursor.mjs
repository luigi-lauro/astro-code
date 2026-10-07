// Host adapter: Cursor (IDE agent + `cursor-agent` CLI).
//
// Verified against the shipped CLI bundle `2026.10.01-e373342` (linux-arm64,
// `--help` + a JS-bundle read with a fake HOME) — [src] below — cross-checked
// against cursor.com docs/changelog ([docs]) and user reports ([forum],
// snippets only). Cursor was NOT installed live for this research; see
// `.astrocode/phases/35-cursor-host-adapter/RESEARCH-cursor-cli.md` for the
// full spike and what is still unverified (exact JSON shape and exit codes
// on failure are read off the bundle, not a live run — settled in this
// phase's done bar, not here).
//
//   config dir     $CURSOR_CONFIG_DIR, else ~/.cursor
//   commands       ~/.cursor/commands/<name>.md — flat markdown, `description`
//                  frontmatter only (`allowed-tools` is Claude-only, dropped).
//                  Copied, not symlinked: this must work with Claude Code
//                  absent, or with Cursor's third-party (`.claude`) import
//                  turned off — a symlink into a source tree the user never
//                  installs from would leave Cursor with nothing. [src/docs]
//   agents         ~/.cursor/agents/<name>.md — `name`, `description`,
//                  `model: inherit`, `readonly: true` only for the read-only
//                  roles (derived from the source agent's `tools:`, never a
//                  hard-coded name list — see `isReadonly`). [src/docs]
//                  **Live check (phase 35) overturned the docs here:** the
//                  CLI's subagent loader reads only <workspace>/.cursor/agents
//                  (+ .claude/.grok agents with third-party import) — never
//                  ~/.cursor/agents — and the Task tool rejects any other
//                  `subagent_type` as an invalid enum. So these files are the
//                  agents' INSTRUCTIONS, not registered subagents: CURSOR_NOTE
//                  tells a command to run them in a built-in Task subagent
//                  (`explore` if readonly, else `generalPurpose`) with the
//                  file's text as the prompt. Project-level .cursor/agents
//                  files are deliberately not written (CONTEXT scope).
//   headless       `cursor-agent -p`. **Binary is `cursor-agent`, never
//                  `agent`**: the curl installer symlinks BOTH names, and on
//                  the dev Mac `agent` already resolves to astro-agent — the
//                  curl installer would silently steal it. Brew's
//                  `cursor-cli` cask installs only `cursor-agent`, so that is
//                  the only name this adapter ever probes or invokes. [src]
//   hangs          `-p` has a real history of not exiting (forum reports
//                  133109/150296/150246/164841); changelog claims fixes but
//                  this adapter was never run live against them. **Every
//                  caller of `execCommand` for this host MUST pass a
//                  `timeoutMs`** — the runner wiring that would enforce one
//                  automatically is a later phase, so this warning has to
//                  outlive this phase's own docs, not just its code.
//
// Stateless about HOME/env for the same reason as the Claude adapter: every
// function that needs it reads from `process.env`/`homedir()` at call time,
// never at module load — the install tests re-import with a cache-busting
// query to swap in a fake $HOME/PATH.
import { existsSync, readFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { parseFrontmatter, toMarkdown } from './render.mjs';
import { atomicWriteJSON } from '../util.mjs';
import { detect as claudeDetect } from './claude.mjs';

export const id = 'cursor';
export const label = 'Cursor';

/** Commands AND agents are flat markdown, copied — see the header note on why
 *  copy, not symlink. */
export const placement = { commands: 'commands', agents: 'agents', ext: '.md', mode: 'copy' };

export function baseConfigDir() {
  return process.env.CURSOR_CONFIG_DIR || join(homedir(), '.cursor');
}

/** Cursor has a single config dir — no profile fan-out like jean-claude. */
export function configTargets() {
  return new Map([[baseConfigDir(), 'base']]);
}

// The ONLY binary this adapter will ever probe or invoke. See the header note:
// a stub/real binary named `agent` must never satisfy detection, because on
// the dev Mac (and plausibly others) that name is already astro-agent's.
const BIN = 'cursor-agent';

function onPath(bin) {
  const dirs = String(process.env.PATH || '').split(delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? [bin, `${bin}.exe`, `${bin}.cmd`] : [bin];
  return dirs.some((d) => names.some((n) => existsSync(join(d, n))));
}

/**
 * Is Cursor present on this machine? True when its config dir exists, or
 * `cursor-agent` is reachable on PATH — matching how the other two adapters
 * detect an unconfigured-but-installed host. Never probes `agent`.
 */
export function detect() {
  return existsSync(baseConfigDir()) || onPath(BIN);
}

/**
 * Derive read-only from a `tools:` frontmatter value, never from a hard-coded
 * agent-name list — a future agent gains write access by listing a tool, not
 * by being added to a table here. True iff none of the mutating Claude tool
 * names are granted.
 */
export function isReadonly(toolsCsv) {
  const names = String(toolsCsv || '').split(',').map((s) => s.trim()).filter(Boolean);
  const mutating = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
  return !names.some((n) => mutating.includes(n));
}

/**
 * Prepended to every rendered command, mapping the Claude Code tool names the
 * command bodies were authored against onto their closest Cursor equivalent.
 * One source body for every host — nothing here rewrites the body itself.
 */
export const CURSOR_NOTE = `> **Running on Cursor.** These steps were written for Claude Code; map its tools like this:
> - **Workflow tool** — not available here. Take the next tier the step offers (subagents, else inline).
> - **Agent tool** — delegate to a Cursor Task subagent. astro agents are NOT subagent types here, so never pass \`astro-*\` as \`subagent_type\`: use \`explore\` when the agent's file (\`agents/<name>.md\` in the Cursor config dir, normally \`~/.cursor/agents/\`) has \`readonly: true\`, else \`generalPurpose\`, and make the subagent's prompt that file's full text followed by the task.
> - **AskUserQuestion** — ask in chat as a numbered list with the same options, then wait for the reply.

`;

/**
 * A command renders as one file: the source's `description` frontmatter
 * (only — `allowed-tools` is Claude-only and dropped), CURSOR_NOTE, then the
 * source body verbatim. `$ARGUMENTS` is left untouched; Cursor substitutes it.
 */
export function renderCommand(name, source) {
  const { frontmatter, body } = parseFrontmatter(source);
  const content = toMarkdown({ description: frontmatter.description }, CURSOR_NOTE + body);
  return [{ path: `${name}.md`, content }];
}

/**
 * An agent renders as one file: `name` (the file name), `description`,
 * `model: inherit`, then `readonly: true` only when `isReadonly` says so (the
 * key is omitted entirely otherwise — Cursor's own default is not read-only).
 * No Claude tier (opus/sonnet/haiku) is ever emitted.
 */
export function renderAgent(name, source) {
  const { frontmatter, body } = parseFrontmatter(source);
  const frontmatterOut = { name, description: frontmatter.description, model: 'inherit' };
  if (isReadonly(frontmatter.tools)) frontmatterOut.readonly = true;
  return [{ path: `${name}.md`, content: toMarkdown(frontmatterOut, body) }];
}

/**
 * The one-shot headless invocation, as argv. Verified against the bundle's
 * `--help` output, not a live run (see the header note).
 *
 * `-w` takes an OPTIONAL value, so it must sit right after `-p` and be
 * immediately followed by `--output-format` — put anywhere closer to the end
 * it risks swallowing the prompt as a worktree name instead of running one.
 * `--output-format json` is unconditional: `parseResult` always expects JSON.
 * `systemPrompt`/`tools`/`schemaFile`/`outFile`/`permissionMode`/`reasoning`
 * are accepted and silently ignored — no flag exists for any of them on this
 * host; reasoning depth lives in the model-id suffix instead (e.g.
 * `claude-opus-5-high`), not a separate knob.
 *
 * Returns argv rather than spawning, so it stays pure and the caller keeps
 * concurrency, cwd, timeout and abort.
 */
export function execCommand({
  prompt, model, cwd, worktree, sandbox,
  systemPrompt, tools, schemaFile, outFile, permissionMode, reasoning,
} = {}) {
  void systemPrompt; void tools; void schemaFile; void outFile; void permissionMode; void reasoning;
  const args = ['-p'];
  if (worktree) args.push('-w', ...(typeof worktree === 'string' ? [worktree] : []));
  args.push('--output-format', 'json', '--force', '--trust');
  if (cwd) args.push('--workspace', cwd);
  if (model) args.push('--model', model);
  if (sandbox) args.push('--sandbox', sandbox);
  if (prompt) args.push(prompt);
  return { command: BIN, args };
}

/** What this host can enforce itself, vs what the runner must arrange. */
export const capabilities = { worktree: true, outputSchema: false, reasoning: false };

/**
 * Pull the final reply out of `cursor-agent -p --output-format json` output.
 *
 * The whole stdout is one JSON object on success (`{type:"result", result,
 * is_error, …}`), but `stream-json`-shaped NDJSON is tolerated too — if the
 * whole text does not parse, the last parseable line is tried instead, since
 * that is where the terminal `result` event lands in a stream. Anything that
 * is not a well-formed, non-error `result` object with a string `result`
 * returns `null` — the runner treats that exactly like a failed exit.
 */
export function parseResult(stdout, task) {
  void task;
  const text = String(stdout ?? '');
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        obj = JSON.parse(line);
        break;
      } catch {
        // keep scanning backward for the last parseable line
      }
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type !== 'result') return null;
  if (obj.is_error === true) return null;
  if (typeof obj.result !== 'string') return null;
  return obj.result;
}

// --- hooks.json / cli-config.json wiring ----------------------------------------
// Cursor can import Claude Code's own hooks wholesale (its "third-party" import).
// When Claude Code is present on this machine, wiring our hooks natively into
// Cursor too would make astro-code's SessionStart banner / statusline fire
// twice per turn — once via Claude's settings.json, once via Cursor's own
// hooks.json. So the branch is re-decided on EVERY install/update, not cached:
// install Claude Code later and the next `ac install` silently flips Cursor
// from native hooks to riding Claude's import, and removing Claude flips it
// back. `detect` is imported from `./claude.mjs` rather than duplicated,
// so this adapter can never drift from what "Claude Code is present" means
// there.
//
// ASTRO_HOOKS mirrors, event-for-event, what `claude.registerHooks` actually
// writes (see `tests/cursor_hooks.test.mjs`'s drift guard) — a new Claude hook
// that forgets to show up here is caught by that test, not discovered later as
// a silent gap on Cursor. EVENT_MAP translates Claude Code's PascalCase event
// names to Cursor's own (`hooks.json` uses `sessionStart`, `preCompact`,
// `beforeSubmitPrompt`, `stop`); `mapHookEvents` is pure so the drift guard can
// exercise it directly, and so a Claude event with no Cursor equivalent is
// reported (`skipped`) rather than silently dropped.
export const ASTRO_HOOKS = [
  { event: 'SessionStart', script: 'astro-update.mjs' },
  { event: 'PreCompact', script: 'astro-precompact.mjs' },
  { event: 'UserPromptSubmit', script: 'astro-session-state.mjs', arg: 'prompt' },
  { event: 'Stop', script: 'astro-session-state.mjs', arg: 'stop' },
];

export const EVENT_MAP = {
  SessionStart: 'sessionStart',
  PreCompact: 'preCompact',
  UserPromptSubmit: 'beforeSubmitPrompt',
  Stop: 'stop',
};

/** Pure: splits Claude event names into Cursor-mapped ones and skipped ones. */
export function mapHookEvents(events) {
  const mapped = [];
  const skipped = [];
  for (const claude of events) {
    const cursor = EVENT_MAP[claude];
    if (cursor) mapped.push({ claude, cursor });
    else skipped.push(claude);
  }
  return { mapped, skipped };
}

// `astro-statusline.mjs` is named here rather than imported from claude.mjs
// (which does not export it) — this is the same filename/idiom it already
// uses, and the drift guard above is what keeps the two from silently diverging.
const STATUSLINE_HOOK = 'astro-statusline.mjs';
const chainFile = (home) => join(home, 'statusline-chain.json');

function readJsonSafe(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

// Write only when the serialized content actually changed, so a no-op
// `registerHooks` pass never reformats a file the user wrote by hand
// (C5f — idempotent re-install must be byte-identical).
function writeIfChanged(file, data) {
  const text = JSON.stringify(data, null, 2) + '\n';
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return;
  atomicWriteJSON(file, data);
}

// Drop every astro-owned entry from one config dir's hooks.json/cli-config.json
// and restore any stashed statusLine. Shared by `unregisterHooks` and by
// `registerHooks`' import branch (Claude appearing must cleanly hand the
// hooks back, not leave a native copy behind it).
function removeOurs(dir, home) {
  const hooksFile = join(dir, 'hooks.json');
  if (existsSync(hooksFile)) {
    const hooksData = readJsonSafe(hooksFile);
    if (hooksData !== null && hooksData.hooks) {
      for (const spec of ASTRO_HOOKS) {
        const evt = EVENT_MAP[spec.event];
        const scriptPath = join(home, 'hooks', spec.script);
        if (!hooksData.hooks[evt]) continue;
        hooksData.hooks[evt] = hooksData.hooks[evt].filter(
          (e) => !(typeof e.command === 'string' && e.command.includes(scriptPath)),
        );
        if (hooksData.hooks[evt].length === 0) delete hooksData.hooks[evt];
      }
      writeIfChanged(hooksFile, hooksData);
    }
  }
  const configFile = join(dir, 'cli-config.json');
  if (existsSync(configFile)) {
    const configData = readJsonSafe(configFile);
    if (configData !== null && configData.statusLine
        && typeof configData.statusLine.command === 'string'
        && configData.statusLine.command.includes(STATUSLINE_HOOK)) {
      const map = readJsonSafe(chainFile(home)) || {};
      if (map[dir]) configData.statusLine = map[dir];
      else delete configData.statusLine;
      writeIfChanged(configFile, configData);
    }
  }
}

/**
 * Wire astro-code's hooks + statusline into one Cursor config dir, additively
 * and reversibly — three-way branch:
 *  - Claude Code detected -> Cursor will import Claude's own hooks, so any
 *    native copy here is removed (double-firing is the risk, not a missing
 *    hook) and `{ branch: 'import' }` is returned.
 *  - `hooks.json`/`cli-config.json` present but not valid JSON -> nothing is
 *    touched, `{ branch: 'none', reason }` is returned.
 *  - otherwise -> merge ours into both files (never clobber the user's own
 *    entries/keys — see `tests/cursor_hooks.test.mjs`'s C10b mutation guard)
 *    and return `{ branch: 'native', events, statusLine: true, skipped }`.
 */
export function registerHooks(dir, home) {
  if (claudeDetect()) {
    removeOurs(dir, home);
    return { branch: 'import' };
  }

  const hooksFile = join(dir, 'hooks.json');
  const configFile = join(dir, 'cli-config.json');

  let hooksData = {};
  if (existsSync(hooksFile)) {
    hooksData = readJsonSafe(hooksFile);
    if (hooksData === null) return { branch: 'none', reason: 'hooks.json is not valid JSON' };
  }
  let configData = {};
  if (existsSync(configFile)) {
    configData = readJsonSafe(configFile);
    if (configData === null) return { branch: 'none', reason: 'cli-config.json is not valid JSON' };
  }

  const node = process.execPath;
  // Cursor requires a top-level "version": 1 in hooks.json; a fresh file (or
  // one pre-existing without it) gets it added, an existing value is kept.
  hooksData.version ??= 1;
  hooksData.hooks ??= {};
  const byEvent = new Map(ASTRO_HOOKS.map((h) => [h.event, h]));
  const { mapped, skipped } = mapHookEvents(ASTRO_HOOKS.map((h) => h.event));
  for (const { claude, cursor } of mapped) {
    const spec = byEvent.get(claude);
    const scriptPath = join(home, 'hooks', spec.script);
    const command = `"${node}" "${scriptPath}"${spec.arg ? ` ${spec.arg}` : ''}`;
    hooksData.hooks[cursor] ??= [];
    const alreadyOurs = hooksData.hooks[cursor].some(
      (e) => typeof e.command === 'string' && e.command.includes(scriptPath),
    );
    if (!alreadyOurs) hooksData.hooks[cursor].push({ command });
  }

  // Compose with any existing statusline instead of replacing it: stash the
  // original command keyed by dir (same chain file/idiom claude.mjs uses),
  // then point statusLine at our wrapper.
  const cur = configData.statusLine;
  const alreadyOurs = cur && typeof cur.command === 'string' && cur.command.includes(STATUSLINE_HOOK);
  if (!alreadyOurs) {
    if (cur && cur.command) {
      const map = readJsonSafe(chainFile(home)) || {};
      map[dir] = cur;
      atomicWriteJSON(chainFile(home), map);
    }
    configData.statusLine = {
      type: 'command',
      command: `"${node}" "${join(home, 'hooks', STATUSLINE_HOOK)}" "${dir}"`,
    };
  }

  writeIfChanged(hooksFile, hooksData);
  writeIfChanged(configFile, configData);

  return { branch: 'native', events: mapped.map((m) => m.cursor), statusLine: true, skipped };
}

/** Reverse `registerHooks` for one config dir: see `removeOurs`. No-op (and
 *  never creates `dir`) when the dir does not exist. */
export function unregisterHooks(dir, home) {
  if (!existsSync(dir)) return;
  removeOurs(dir, home);
}

export const cursorHost = {
  id, label, placement, detect, baseConfigDir, configTargets,
  renderCommand, renderAgent, execCommand, parseResult, capabilities,
  registerHooks, unregisterHooks,
};
export default cursorHost;
