// `ac fleet …` — connect this machine to an Astro Fleet so every Claude Code session on
// it shows up live in the fleet's Forge. The CLI half only: config, settings.json hook
// wiring, status. What runs inside the sessions (mapping, queue, flusher) lives in
// hooks/_astro-fleet.mjs, because it must run from ~/.astro/code/hooks with nothing
// else of astro-code loaded.
//
// The hook wiring is USER-level (every config dir lib/hosts/claude.mjs knows about),
// never per-repo, and it is additive and exactly reversible: `disconnect` must leave
// settings.json as it found it. Our entries carry HOOK_MARKER in their command, and
// that marker — not position, not path — is the only thing removal matches on, so a
// user hook that happens to sit in the same event array is never touched.
import { existsSync, readFileSync, copyFileSync, rmSync, realpathSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  DEFAULT_COLOR, HOOK_MARKER, fleetDir, fleetPaths, loadConfig, saveConfig, loadState,
  updateState, normalizeColor, validateUrl, redactToken, readQueue, postBatch,
} from '../hooks/_astro-fleet.mjs';

export const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Notification', 'Stop', 'SubagentStart', 'SubagentStop',
];
// UserPromptSubmit and Stop take no matcher; the rest match on tool, notification
// kind, session source or agent type — "*" means all of them.
const NO_MATCHER = new Set(['UserPromptSubmit', 'Stop']);
export const BACKUP_SUFFIX = '.bak-astro-fleet';
const HOOK_SCRIPTS = ['_astro-fleet.mjs', 'astro-fleet-hook.mjs', 'astro-fleet-flush.mjs'];

export function hookCommand(hooksDir, node = process.execPath) {
  return `"${node}" "${join(hooksDir, 'astro-fleet-hook.mjs')}" ${HOOK_MARKER}`;
}

const isOurs = (h) => h && typeof h.command === 'string' && h.command.includes(HOOK_MARKER);

// settings.json is often a symlink (dotfile managers, jean-claude); renaming a temp
// file over the LINK would silently replace it with a plain file. Write the target.
function settingsTarget(file) {
  try { return realpathSync(file); } catch { return file; }
}
function writeAtomic(file, text) {
  const real = settingsTarget(file);
  mkdirSync(dirname(real), { recursive: true });
  const tmp = `${real}.tmp-astro-fleet-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, real);
}

function readSettings(file) {
  if (!existsSync(file)) return { exists: false, data: {} };
  const raw = readFileSync(file, 'utf8');
  try {
    const data = raw.trim() ? JSON.parse(raw) : {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return { exists: true, raw, data };
  } catch (e) {
    return { exists: true, raw, error: `${file} is not valid JSON (${e.message}) — left untouched` };
  }
}

// Remove our hook objects from one event array; returns [array, removedAny]. A user who
// tucked their own hook into one of OUR entries keeps it — only the marked hook goes.
function stripOurs(entries) {
  let removed = false;
  const out = [];
  for (const e of entries || []) {
    if (!e || !Array.isArray(e.hooks) || !e.hooks.some(isOurs)) { out.push(e); continue; }
    removed = true;
    const rest = e.hooks.filter((h) => !isOurs(h));
    if (rest.length) out.push({ ...e, hooks: rest });
  }
  return [out, removed];
}

/**
 * Add our hook to every reported event in one config dir's settings.json. Idempotent:
 * our previous entries are replaced, never duplicated (re-running connect after an
 * `ac update` moved the script picks up the new path). Takes the one-time backup before
 * the first write, and refuses — rather than clobbers — a settings file it can't parse.
 */
export function registerFleetHooks(configDir, command) {
  const file = join(configDir, 'settings.json');
  const s = readSettings(file);
  if (s.error) return { ok: false, file, error: s.error };
  const backup = file + BACKUP_SUFFIX;
  if (s.exists && !existsSync(backup)) copyFileSync(settingsTarget(file), backup);
  const data = s.data;
  if (data.hooks != null && (typeof data.hooks !== 'object' || Array.isArray(data.hooks))) {
    return { ok: false, file, error: `${file} has a "hooks" value that is not an object — left untouched` };
  }
  data.hooks ??= {};
  for (const evt of HOOK_EVENTS) {
    const [kept] = stripOurs(Array.isArray(data.hooks[evt]) ? data.hooks[evt] : []);
    const entry = NO_MATCHER.has(evt) ? {} : { matcher: '*' };
    entry.hooks = [{ type: 'command', command, timeout: 10 }];
    data.hooks[evt] = [...kept, entry];
  }
  writeAtomic(file, JSON.stringify(data, null, 2) + '\n');
  return { ok: true, file };
}

/**
 * Remove exactly what registerFleetHooks added. When what remains equals the backup
 * taken before the first connect, the backup's BYTES are restored, so formatting and
 * key order come back too — "exactly as it was". Otherwise (the user edited settings
 * while connected) the stripped JSON is written. A settings.json that only existed
 * because connect created it is deleted again.
 */
export function unregisterFleetHooks(configDir) {
  const file = join(configDir, 'settings.json');
  const s = readSettings(file);
  if (!s.exists) return { ok: true, file, changed: false };
  if (s.error) return { ok: false, file, error: s.error };
  const data = s.data;
  let removed = false;
  if (data.hooks && typeof data.hooks === 'object') {
    for (const evt of Object.keys(data.hooks)) {
      if (!Array.isArray(data.hooks[evt])) continue;
      const [kept, r] = stripOurs(data.hooks[evt]);
      if (!r) continue;
      removed = true;
      if (kept.length) data.hooks[evt] = kept;
      else delete data.hooks[evt];
    }
    if (removed && Object.keys(data.hooks).length === 0) delete data.hooks;
  }
  if (!removed) return { ok: true, file, changed: false };
  const backup = file + BACKUP_SUFFIX;
  let original = null;
  try { original = readFileSync(backup, 'utf8'); } catch { /* connect created the file */ }
  if (original != null) {
    let parsed;
    try { parsed = original.trim() ? JSON.parse(original) : {}; } catch { parsed = undefined; }
    writeAtomic(file, isDeepStrictEqual(parsed, data) ? original : JSON.stringify(data, null, 2) + '\n');
  } else if (Object.keys(data).length === 0) {
    rmSync(settingsTarget(file), { force: true });
  } else {
    writeAtomic(file, JSON.stringify(data, null, 2) + '\n');
  }
  return { ok: true, file, changed: true };
}

export function hooksInstalled(configDir) {
  const s = readSettings(join(configDir, 'settings.json'));
  if (!s.exists || s.error) return false;
  return HOOK_EVENTS.every((evt) => (s.data.hooks?.[evt] || []).some((e) => (e?.hooks || []).some(isOurs)));
}

// Copy the three hook files into the astro home so the hook runs from a stable path
// even if astro-code was never `ac install`ed (`ac update` refreshes them later).
export function publishHookScripts(frameworkRoot, hooksDir) {
  mkdirSync(hooksDir, { recursive: true });
  for (const f of HOOK_SCRIPTS) copyFileSync(join(frameworkRoot, 'hooks', f), join(hooksDir, f));
}

/** One probe batch, a session that starts and ends at once: proves URL + token. */
export async function probe(cfg, { post = postBatch } = {}) {
  const sid = `ac-connect-probe-${randomBytes(6).toString('hex')}`;
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return post(cfg, [
    { type: 'session_start', session_id: sid, ts },
    { type: 'session_end', session_id: sid, ts },
  ]);
}

export function describeFailure(r) {
  if (r.status === 0) return `cannot reach the fleet (${r.error || 'network error'})`;
  if (r.status === 401) return 'HTTP 401 — token invalid or revoked';
  if (r.status === 403) return 'HTTP 403 — token not allowed';
  if (r.status === 404) return 'HTTP 404 — no ingest endpoint at that URL (is fleet phase 36 deployed?)';
  return `HTTP ${r.status}${r.text ? ` — ${String(r.text).slice(0, 200)}` : ''}`;
}

/**
 * `ac fleet connect`. Validates, probes, and only on a 2xx writes the config and wires
 * the hooks — a typo'd URL or a revoked token changes nothing on disk. Re-running
 * updates the config in place and clears a previous auth stop / back-off.
 */
export async function connect({ url, token, color, name, hideNames, frameworkRoot, hooksDir, configDirs, dir = fleetDir(), post = postBatch }) {
  const u = validateUrl(url);
  if (!u.ok) return { ok: false, error: u.error };
  if (!token || token === true) return { ok: false, error: 'missing --token (create one in the fleet admin → Sources)' };
  const prev = loadConfig(dir);
  let c = DEFAULT_COLOR;
  if (color != null) {
    c = normalizeColor(color);
    if (!c) return { ok: false, error: `invalid colour "${color}" — use #rrggbb` };
  } else if (prev?.color) {
    c = prev.color;
  }
  const cfg = {
    url: u.url,
    token: String(token),
    color: c,
    name: typeof name === 'string' ? name : (prev?.name ?? null),
    paused: false,
    hide_names: hideNames == null ? !!prev?.hide_names : !!hideNames,
  };
  const r = await probe(cfg, { post });
  if (!(r.status >= 200 && r.status < 300)) return { ok: false, error: describeFailure(r), status: r.status };

  saveConfig(cfg, dir);
  updateState(dir, (s) => {
    delete s.auth_failed;
    delete s.backoff_ms;
    delete s.backoff_until;
    delete s.last_error;
    s.last_success = Date.now();
    return s;
  });
  publishHookScripts(frameworkRoot, hooksDir);
  const command = hookCommand(hooksDir);
  const wired = configDirs.map((d) => registerFleetHooks(d, command));
  return { ok: true, config: cfg, wired };
}

export function disconnect({ configDirs, dir = fleetDir() }) {
  const unwired = configDirs.map((d) => unregisterFleetHooks(d));
  const p = fleetPaths(dir);
  for (const f of [p.config, p.queue, p.state, p.log, p.flushLock]) rmSync(f, { force: true });
  rmSync(p.lock, { recursive: true, force: true });
  return { unwired };
}

export function setPaused(paused, dir = fleetDir()) {
  const cfg = loadConfig(dir);
  if (!cfg) return { ok: false, error: 'not connected — run `ac fleet connect <url> --token <t>`' };
  cfg.paused = !!paused;
  saveConfig(cfg, dir);
  return { ok: true, config: cfg };
}

export function setColor(color, dir = fleetDir()) {
  const cfg = loadConfig(dir);
  if (!cfg) return { ok: false, error: 'not connected — run `ac fleet connect <url> --token <t>`' };
  const c = normalizeColor(color);
  if (!c) return { ok: false, error: `invalid colour "${color === true || color == null ? '' : color}" — use #rrggbb (quote it: a bare # starts a shell comment)` };
  cfg.color = c;
  saveConfig(cfg, dir);
  return { ok: true, config: cfg };
}

/** Everything `ac fleet status` shows. The token only ever leaves here redacted. */
export function status({ configDirs = [], dir = fleetDir() } = {}) {
  const cfg = loadConfig(dir);
  if (!cfg) return { connected: false };
  const p = fleetPaths(dir);
  const st = loadState(dir);
  let mode = null;
  try { mode = statSync(p.config).mode & 0o777; } catch { /* vanished */ }
  return {
    connected: true,
    url: cfg.url,
    token: redactToken(cfg.token),
    color: cfg.color,
    name: cfg.name ?? null,
    paused: !!cfg.paused,
    hide_names: !!cfg.hide_names,
    queue: readQueue(p.queue).length,
    last_success: st.last_success ? new Date(st.last_success).toISOString() : null,
    last_error: st.last_error ? { ...st.last_error, at: new Date(st.last_error.at).toISOString() } : null,
    stopped: !!st.auth_failed,
    backoff_until: st.backoff_until && st.backoff_until > Date.now() ? new Date(st.backoff_until).toISOString() : null,
    config_mode: mode == null ? null : `0${mode.toString(8)}`,
    hooks: configDirs.map((d) => ({ dir: d, installed: hooksInstalled(d) })),
  };
}
