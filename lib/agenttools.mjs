// #93 — extra tools for astro-code's agents, set once per USER.
//
// Every shipped agent declares a fixed `tools:` allow-list, and Claude Code enforces it: an
// astro agent can never call an MCP tool astro-code did not list (e.g. lean-ctx's read-only
// ctx_read/ctx_search/ctx_tree/ctx_glob). Editing the installed agent file by hand does not
// last — `ac install` / `ac update` copy the shipped agents over it.
//
// So the extension lives in `~/.astro/config.json`, under `agent_tools`, and is merged into
// the `tools:` line every time the agents are installed:
//
//   { "agent_tools": { "*": ["mcp__<server>__<tool>"], "astro-executor": ["mcp__<server>__<tool>"] } }
//
// The engine names no server here (ADR-030): it passes through whatever the user lists.
//
// Per USER, not per project: the agents are installed once per machine and shared by every
// project, so there is no single project whose config install could read. The file sits
// outside ~/.astro/code, so install, update and uninstall never touch it.
//
// Only MCP tool names (`mcp__<server>` or `mcp__<server>__<tool>`) are accepted: this widens
// what a role can reach through a server the user installed, never the built-in permissions
// a role was designed with — the verifier cannot be handed `Write` this way. A bad entry is
// a warning and is skipped; it never fails an install.
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const MCP_TOOL = /^mcp__[A-Za-z0-9_.-]+(__[A-Za-z0-9_.*-]+)?$/;

/**
 * Read and validate `agent_tools` from `<home>/.astro/config.json`.
 *
 * @param {{ home?: string, agents?: string[] }} [opts]  `agents`: the shipped agent names,
 *   to name an entry for an agent that does not exist
 * @returns {{ forAgent: (name: string) => string[], warnings: string[], configured: boolean }}
 */
export function readAgentTools({ home = homedir(), agents = [] } = {}) {
  const warnings = [];
  const byAgent = new Map();
  const empty = { forAgent: () => [], warnings, configured: false };
  const file = join(home, '.astro', 'config.json');
  if (!existsSync(file)) return empty;
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    warnings.push(`~/.astro/config.json is not valid JSON — agent_tools ignored`);
    return empty;
  }
  const raw = cfg && cfg.agent_tools;
  if (raw == null) return empty;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('agent_tools must be an object of agent name → list of MCP tools — ignored');
    return empty;
  }
  const known = new Set(agents);
  for (const [agent, list] of Object.entries(raw)) {
    if (agent !== '*' && known.size && !known.has(agent)) {
      warnings.push(`agent_tools: "${agent}" — no such agent (known: ${[...known].join(', ')}, or "*")`);
      continue;
    }
    if (!Array.isArray(list)) {
      warnings.push(`agent_tools: "${agent}" must be a list of MCP tool names`);
      continue;
    }
    const ok = [];
    for (const t of list) {
      if (typeof t !== 'string' || !MCP_TOOL.test(t)) {
        warnings.push(`agent_tools: ${JSON.stringify(t)} for "${agent}" is not an MCP tool (mcp__<server>__<tool>) — skipped`);
        continue;
      }
      ok.push(t);
    }
    byAgent.set(agent, ok);
  }
  const forAgent = (name) => [...new Set([...(byAgent.get('*') || []), ...(byAgent.get(name) || [])])];
  return { forAgent, warnings, configured: true };
}

/**
 * Append `extra` to an agent file's frontmatter `tools:` line, deduped, preserving order.
 * Everything else — other keys, the body — is left byte-identical, and nothing to add
 * returns the source unchanged.
 */
export function withExtraTools(source, extra) {
  if (!extra || !extra.length) return source;
  const src = String(source);
  if (!src.startsWith('---')) return src;
  const end = src.indexOf('\n---', 3);
  if (end === -1) return src;
  const head = src.slice(0, end);
  const m = head.match(/^tools:[ \t]*(.*)$/m);
  if (!m) return src;
  const current = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  const merged = [...current];
  for (const t of extra) if (!merged.includes(t)) merged.push(t);
  if (merged.length === current.length) return src;
  const line = `tools: ${merged.join(', ')}`;
  return head.replace(/^tools:[ \t]*.*$/m, line) + src.slice(end);
}

/**
 * Change `agent_tools` in `<home>/.astro/config.json` — the only writer of that key, so a
 * user never hand-edits JSON. The file is shared (it can hold other tools' settings and
 * tokens), so every other key is preserved, the write is atomic, and a file that is not
 * valid JSON is REFUSED rather than overwritten. Names are validated before anything is
 * written: an MCP tool name, and an agent that exists (or `*`).
 *
 * @param {{ home?: string, agents: string[], op: 'add'|'remove'|'clear', target?: string, tools?: string[] }} a
 * @returns {{ ok: true, config: object } | { ok: false, error: string }}
 */
export function updateAgentTools({ home = homedir(), agents, op, target, tools = [] }) {
  if (target != null && target !== '*' && !agents.includes(target)) {
    return { ok: false, error: `no such agent: ${target} — use one of ${agents.join(', ')}, or "*" for every agent` };
  }
  for (const t of tools) {
    if (!MCP_TOOL.test(t)) return { ok: false, error: `"${t}" is not an MCP tool (mcp__<server>__<tool>) — nothing was changed` };
  }
  const file = join(home, '.astro', 'config.json');
  let cfg = {};
  if (existsSync(file)) {
    try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch {
      return { ok: false, error: `${file} is not valid JSON — fix it first; nothing was changed` };
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      return { ok: false, error: `${file} is not a JSON object — fix it first; nothing was changed` };
    }
  }
  const current = cfg.agent_tools && typeof cfg.agent_tools === 'object' && !Array.isArray(cfg.agent_tools) ? { ...cfg.agent_tools } : {};
  if (op === 'add') {
    const list = Array.isArray(current[target]) ? [...current[target]] : [];
    for (const t of tools) if (!list.includes(t)) list.push(t);
    current[target] = list;
  } else if (op === 'remove') {
    const list = (Array.isArray(current[target]) ? current[target] : []).filter((t) => !tools.includes(t));
    if (list.length) current[target] = list; else delete current[target];
  } else if (op === 'clear') {
    if (target == null) for (const k of Object.keys(current)) delete current[k];
    else delete current[target];
  } else {
    return { ok: false, error: `unknown operation: ${op}` };
  }
  if (Object.keys(current).length) cfg.agent_tools = current; else delete cfg.agent_tools;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  renameSync(tmp, file);
  return { ok: true, config: cfg.agent_tools || {} };
}
