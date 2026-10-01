// What each statusline gauge shows — its bar, its percent, or both — set once per USER.
//
// The statusline is installed once per machine and draws every project, so the setting
// lives beside `agent_tools` in `~/.astro/config.json`, outside ~/.astro/code where
// install, update and uninstall never reach:
//
//   { "statusline": { "gauges": { "5h": "percent", "7d": "percent" } } }
//
// The hook reads it (`readGaugeModes` in hooks/_astro-ctx.mjs — hooks cannot import lib,
// so the reader and the gauge/mode names live there and this file imports them back,
// ADR-046). This is the only writer, so nobody hand-edits the JSON. `both` is the default
// and is stored as an ABSENT key, so a file never fills up with defaults.
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { GAUGES, GAUGE_MODES, readGaugeModes } from '../hooks/_astro-ctx.mjs';

export { GAUGES, GAUGE_MODES, readGaugeModes };

/**
 * Set one gauge's mode, or every gauge's (`all`). The file is shared (it can hold other
 * tools' settings), so every other key is preserved, the write is atomic, and a file that
 * is not valid JSON is REFUSED rather than overwritten.
 *
 * @param {{ home?: string, gauge: string, mode: string }} a
 * @returns {{ ok: true, gauges: Record<string, string> } | { ok: false, error: string }}
 */
export function setGaugeMode({ home = homedir(), gauge, mode }) {
  if (gauge !== 'all' && !GAUGES.includes(gauge)) {
    return { ok: false, error: `no such gauge: ${gauge} — use one of ${GAUGES.join(', ')}, or all` };
  }
  if (!GAUGE_MODES.includes(mode)) {
    return { ok: false, error: `no such mode: ${mode} — use one of ${GAUGE_MODES.join(', ')}` };
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
  const sl = cfg.statusline && typeof cfg.statusline === 'object' && !Array.isArray(cfg.statusline) ? { ...cfg.statusline } : {};
  const current = sl.gauges && typeof sl.gauges === 'object' && !Array.isArray(sl.gauges) ? { ...sl.gauges } : {};
  for (const g of gauge === 'all' ? GAUGES : [gauge]) {
    if (mode === 'both') delete current[g]; else current[g] = mode;
  }
  if (Object.keys(current).length) sl.gauges = current; else delete sl.gauges;
  if (Object.keys(sl).length) cfg.statusline = sl; else delete cfg.statusline;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  renameSync(tmp, file);
  return { ok: true, gauges: readGaugeModes(home) };
}
