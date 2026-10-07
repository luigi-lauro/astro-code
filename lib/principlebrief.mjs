// The scope matcher, selection and shortlist renderer (P2-P4, phase 25 CONTEXT D1/D2).
// Pure — no fs, no git: the caller (lib/retrieval.mjs) owns loading entries, stack
// detection and canon-clash reads, and hands this module plain data.
//
// ## Why AND across dimensions, OR within one (C1's mutation catcher)
//
// A matcher that treats "any tag overlaps anything" as in-scope drowns a task's
// shortlist in noise — an entry scoped to Python would show up on a Go task because
// it happened to also match on `work`. Every non-empty scope DIMENSION (stack, work,
// files) must independently match for the entry to be in scope; within one dimension,
// any overlap is enough (an entry scoped to `[node, go]` matches a Go task).
//
// ## Why an empty `--files` request means no file-scoped entry matches
//
// A file glob is a narrow claim ("this only applies to migrations/**") — matching it
// against nothing is optimistic, not safe. The absence of a files list is not "any
// file", it is "we don't know which files this task touches", so a file-scoped entry
// stays silent rather than guessing.
//
// ## Why rules bypass scope and the cap entirely
//
// `strength: 'rule'` means the developer already decided this always applies — the
// scope matcher exists to keep the noisy long tail (defaults) out of a task's face,
// not to filter the handful of things a developer already marked as non-negotiable.
//
// ## Why only `accepted` is ever served (ADR-058)
//
// A proposed/rejected/retired/superseded/merged entry has not (or no longer) been
// judged worth applying by a human; serving it in a shortlist would let an unreviewed
// or reverted judgement quietly govern an agent's behaviour.
//
// ## Why the cap is a count with a stated trailer
//
// A silently truncated list looks complete; `+N more — ac principles ask "…"` tells the
// reader there IS more and names the tool that finds it, rather than pretending the
// index is exhaustive.

/** Stage -> the `work` values it implies (P2); `--work` on the CLI overrides this. */
export const STAGE_WORK = {
  discuss: ['plan'],
  research: ['plan'],
  plan: ['plan'],
  execute: ['code', 'test'],
  heal: ['code', 'test'],
  remediate: ['code', 'test'],
  verify: ['review'],
  session: [],
  ask: [],
};

export function workForStage(stage) {
  if (!Object.prototype.hasOwnProperty.call(STAGE_WORK, stage)) {
    throw new Error(`unknown stage "${stage}" — valid stages: ${Object.keys(STAGE_WORK).join(', ')}`);
  }
  return STAGE_WORK[stage];
}

export const INDEX_MAX = 25;
export const INDEX_STATEMENT_MAX = 100;
export const STACK_TAGS_SHOWN = 8;

/** Split a glob into path segments, so `**` (any depth) can consume zero or more. */
function globSegments(pattern) {
  return pattern.split('/').filter((s) => s !== '');
}

function segmentToRegex(seg) {
  let out = '';
  for (const ch of seg) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

/**
 * Hand-rolled glob match (P3 — no `path.matchesGlob`, an experimental Node 22 API).
 * `**\/` and bare `**` match zero or more path segments; `*` matches within one
 * segment; `?` matches one non-`/` char; a pattern with no `/` also matches just the
 * basename (`*.test.mjs`); a trailing `/` matches everything under that directory.
 *
 * @param {string} pattern
 * @param {string} path
 * @returns {boolean}
 */
export function globMatch(pattern, path) {
  let pat = pattern;
  if (pat.endsWith('/')) pat += '**';
  const hasSlash = pat.includes('/');
  const target = path;
  const segs = globSegments(pat);
  const parts = segs.map((s) => (s === '**' ? '\u0000STAR\u0000' : segmentToRegex(s)));
  let body = '';
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '\u0000STAR\u0000') {
      // `**` = zero or more full segments (and the slashes between them).
      body += '(?:[^/]+/)*(?:[^/]+)?';
    } else {
      body += parts[i];
    }
    if (i < parts.length - 1) body += '/';
  }
  const re = new RegExp(`^${body}$`);
  if (re.test(target)) return true;
  if (!hasSlash) {
    const basename = target.split('/').pop();
    return re.test(basename);
  }
  return false;
}

/**
 * Is `entry` in scope for `ctx` (P3)? `strength: 'rule'` always is. Only
 * `status === 'accepted'` is ever considered scoped-in (ADR-058) — a non-accepted
 * entry always reports `match: false`.
 *
 * @param {object} entry
 * @param {{ stack?: string[], work?: string[], files?: string[] }} ctx
 * @returns {{ match: boolean, hits: { stack: boolean, work: boolean, files: boolean } }}
 */
export function inScope(entry, ctx = {}) {
  const stackCtx = ctx.stack || [];
  const workCtx = ctx.work || [];
  const filesCtx = ctx.files || [];
  const scopes = entry.scopes || { stack: [], files: [], work: [] };

  if (entry.strength === 'rule') {
    return { match: entry.status === 'accepted', hits: { stack: false, work: false, files: false } };
  }
  if (entry.status !== 'accepted') return { match: false, hits: { stack: false, work: false, files: false } };

  const stackHit = scopes.stack.length === 0 || scopes.stack.some((t) => stackCtx.includes(t));
  // An empty work REQUEST (session) matches any work; an empty ENTRY scope matches any request.
  const workHit = scopes.work.length === 0 || workCtx.length === 0 || scopes.work.some((w) => workCtx.includes(w));
  const filesHit = scopes.files.length === 0
    ? true
    : filesCtx.length > 0 && scopes.files.some((g) => filesCtx.some((f) => globMatch(g, f)));

  return { match: stackHit && workHit && filesHit, hits: { stack: stackHit, work: workHit, files: filesHit } };
}

/** Specificity rank for sort order: file hit > work hit > stack hit > universal. */
function specificity(entry, hits) {
  const scopes = entry.scopes || { stack: [], files: [], work: [] };
  if (scopes.files.length) return 0;
  if (scopes.work.length) return 1;
  if (scopes.stack.length) return 2;
  return 3;
}

function cutStatement(s) {
  const dot = s.indexOf('. ');
  if (dot !== -1 && dot + 1 <= INDEX_STATEMENT_MAX) return s.slice(0, dot + 1);
  if (s.length <= INDEX_STATEMENT_MAX) return s;
  return s.slice(0, INDEX_STATEMENT_MAX) + '…';
}

/**
 * Select what a shortlist serves (P4): every rule (in full, uncapped), and an index
 * of in-scope defaults capped at `INDEX_MAX`, sorted by specificity then id. Each
 * item's pre-computed `clash` (from lib/principlecanon.mjs, the caller's job) rides
 * through untouched.
 *
 * @param {object[]} entries
 * @param {{ stack?: string[], work?: string[], files?: string[] }} ctx
 * @param {{ rulesOnly?: boolean }} [opts]
 * @returns {{ rules: object[], index: object[], more: number, total: number }}
 */
export function selectBrief(entries, ctx = {}, { rulesOnly = false } = {}) {
  const rules = [];
  const defaults = [];
  for (const entry of entries) {
    const { match, hits } = inScope(entry, ctx);
    if (!match) continue;
    if (entry.strength === 'rule') {
      rules.push(entry);
    } else {
      defaults.push({ entry, hits });
    }
  }
  rules.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  defaults.sort((a, b) => {
    const sa = specificity(a.entry, a.hits);
    const sb = specificity(b.entry, b.hits);
    if (sa !== sb) return sa - sb;
    return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
  });

  const total = defaults.length;
  const shown = rulesOnly ? [] : defaults.slice(0, INDEX_MAX);
  const index = shown.map(({ entry }) => ({
    id: entry.id, kind: entry.kind, strength: entry.strength,
    statement: cutStatement(entry.statement), scopes: entry.scopes,
    clash: entry.clash || [],
  }));

  return {
    rules: rules.map((r) => ({
      id: r.id, kind: r.kind, strength: r.strength, statement: r.statement, why: r.why,
      clash: r.clash || [],
    })),
    index,
    more: Math.max(0, total - index.length),
    total,
  };
}

/** The tags-line source names — either manifest filenames, or `config override`. */
function sourceNames(ctx) {
  if (ctx.override) return 'config override';
  const names = (ctx.sources || []).map((s) => s.file);
  return names.length ? names.join(', ') : '(none detected)';
}

/**
 * Render a shortlist to text (P4). Empty when nothing is served — Voice: say
 * nothing when there is nothing.
 *
 * @param {{ rules: object[], index: object[], more: number, total: number }} brief
 * @param {{ stack?: string[], work?: string[], files?: string[], stage?: string, sources?: object[], override?: boolean }} ctx
 * @param {{ rulesOnly?: boolean }} [opts]
 * @returns {string}
 */
export function renderBrief(brief, ctx = {}, { rulesOnly = false } = {}) {
  if (brief.rules.length === 0 && brief.index.length === 0) return '';

  const lines = [];
  const stack = ctx.stack || [];
  const shownTags = stack.slice(0, STACK_TAGS_SHOWN);
  const extraTags = stack.length - shownTags.length;
  const tagsPart = stack.length
    ? `stack: ${shownTags.join(', ')}${extraTags > 0 ? ` +${extraTags}` : ''} (${sourceNames(ctx)})`
    : `stack: (none)`;
  const workPart = (ctx.work && ctx.work.length) ? `work: ${ctx.work.join(', ')}${ctx.stage ? ` (stage ${ctx.stage})` : ''}` : (ctx.stage ? `stage ${ctx.stage}` : '');
  const filesPart = (ctx.files && ctx.files.length) ? `files: ${ctx.files.join(', ')}` : '';
  lines.push(`• principles — ${[tagsPart, workPart, filesPart].filter(Boolean).join(' · ')}`);

  if (brief.rules.length) {
    lines.push('HARD RULES — apply always, in full:');
    for (const r of brief.rules) {
      lines.push(`- ${r.id}  ${r.kind}/rule`);
      lines.push(`  ${r.statement}`);
      if (r.why) lines.push(`  why: ${r.why}`);
      if (r.clash && r.clash.length) {
        lines.push(`  ⚠ canon may override: ${r.clash.map((c) => c.ref).join(', ')}`);
      }
    }
  }

  if (!rulesOnly) {
    if (brief.index.length) {
      lines.push('IN SCOPE — one line each; full text: ac principles show <id>');
      for (const item of brief.index) {
        const scopeParts = [];
        if (item.scopes.stack.length) scopeParts.push(item.scopes.stack.join(', '));
        if (item.scopes.work.length) scopeParts.push(item.scopes.work.join(', '));
        if (item.scopes.files.length) scopeParts.push(item.scopes.files.join(', '));
        const scopeStr = scopeParts.length ? `  [${scopeParts.join(' · ')}]` : '';
        const clashStr = item.clash.length ? `  ⚠ canon may override: ${item.clash.map((c) => c.ref).join(', ')}` : '';
        lines.push(`- ${item.id}  ${item.kind}/default  ${item.statement}${scopeStr}${clashStr}`);
      }
    }
    if (brief.more > 0) {
      lines.push(`• +${brief.more} more in scope — search: ac principles ask "<question>" · all: ac principles list`);
    }
    lines.push('• cite what you applied: ac principles cite <id>… --stage <stage> --by <role>');
  }

  return lines.join('\n');
}

// ── Session parts (#116) ─────────────────────────────────────────────────────────
//
// Claude Code keeps a hook's `additionalContext` whole only up to 10,000 characters;
// above that the model gets a ~2 KB preview and a file path. So the session brief is
// served as up to `parts` hook outputs of at most `max` characters each. While the full
// brief fits one part it is served as-is (whys included). Past that, hard rules lose
// their why (one `ac principles show <id>` away, said in part 1's first lines) and
// everything is packed in order, the same packing in every part. If even that does not
// fit, the last part says what was cut — never a silent truncation.

/** Characters one hook output may carry and still reach the model whole (cap is 10,000). */
export const BRIEF_PART_MAX = 9500;

// A continued part's first line, `• principles, continued (part K of N)`, fits in this.
const CONT_HEAD_RESERVE = 50;

function cutNotice(rules, index) {
  const what = [rules ? `${rules} hard rule${rules === 1 ? '' : 's'}` : '', index ? `${index} index line${index === 1 ? '' : 's'}` : '']
    .filter(Boolean).join(' and ');
  return `⚠ CUT: ${what} did not fit the session brief — read them with: ac principles brief${index ? '' : ' --rules-only'}`;
}

/**
 * Pack a shortlist into session parts.
 *
 * @param {{ rules: object[], index: object[], more: number, total: number }} brief
 * @param {object} ctx  as for renderBrief
 * @param {{ parts?: number, max?: number, rulesOnly?: boolean }} [opts]
 * @returns {{ parts: string[], delivered: { rules: string[], index: string[] } }}
 */
export function packBrief(brief, ctx = {}, { parts: maxParts = 4, max = BRIEF_PART_MAX, rulesOnly = false } = {}) {
  const full = renderBrief(brief, ctx, { rulesOnly });
  const all = { rules: brief.rules.map((r) => r.id), index: rulesOnly ? [] : brief.index.map((i) => i.id) };
  if (!full) return { parts: [], delivered: { rules: [], index: [] } };
  if (full.length <= max) return { parts: [full], delivered: all };

  // Blocks in order; `section` lets a continued part re-state which list it is in.
  const [head] = full.split('\n', 1);
  const blocks = [];
  for (const r of brief.rules) {
    const lines = [`- ${r.id}  ${r.kind}/rule`, `  ${r.statement}`];
    if (r.clash && r.clash.length) lines.push(`  ⚠ canon may override: ${r.clash.map((c) => c.ref).join(', ')}`);
    blocks.push({ section: 'rules', id: r.id, text: lines.join('\n') });
  }
  if (!rulesOnly) {
    // the index/footer lines exactly as renderBrief writes them
    const tail = full.split('\n');
    const at = tail.findIndex((l) => l.startsWith('IN SCOPE — '));
    const from = at === -1 ? tail.findIndex((l) => l.startsWith('• +') || l.startsWith('• cite ')) : at + 1;
    let i = 0;
    for (const line of from === -1 ? [] : tail.slice(from)) {
      const isItem = line.startsWith('- ');
      blocks.push({ section: isItem ? 'index' : 'footer', id: isItem ? brief.index[i++]?.id : undefined, text: line });
    }
  }
  const sectionHead = {
    rules: 'HARD RULES — apply always, in full (why: ac principles show <id>):',
    index: 'IN SCOPE — one line each; full text: ac principles show <id>',
    footer: '',
  };
  const firstHead = `${head}\n• session brief in ${maxParts} parts; hard rules are listed without their why — ac principles show <id> for it`;
  const budgetOf = (i) => max - (i === 0 ? firstHead.length + 1 : CONT_HEAD_RESERVE);
  const smallest = Math.min(budgetOf(0), budgetOf(1));
  const limit = (text) => (text.length > smallest - 200 ? `${text.slice(0, smallest - 260)}… (cut — full text: ac principles show <id>)` : text);

  const packed = [];
  let cur = null;
  for (const b of blocks) {
    const text = limit(b.text);
    const lead = !cur || cur.section !== b.section ? sectionHead[b.section] : '';
    const add = (lead ? lead + '\n' : '') + text;
    if (cur && cur.len + 1 + add.length > budgetOf(packed.length - 1)) cur = null;
    if (!cur) {
      cur = { blocks: [], lines: [], len: 0, section: null };
      packed.push(cur);
    }
    const leadNow = cur.section !== b.section ? sectionHead[b.section] : '';
    if (leadNow) { cur.lines.push(leadNow); cur.len += leadNow.length + 1; }
    cur.lines.push(text);
    cur.len += text.length + 1;
    cur.blocks.push(b);
    cur.section = b.section;
  }

  let kept = packed;
  if (packed.length > maxParts) {
    kept = packed.slice(0, maxParts);
    const last = kept[kept.length - 1];
    const dropped = packed.slice(maxParts).flatMap((p) => p.blocks);
    const notice = () => cutNotice(
      dropped.filter((b) => b.section === 'rules').length,
      dropped.filter((b) => b.section === 'index').length,
    );
    while (last.blocks.length && last.len + notice().length + 1 > budgetOf(kept.length - 1)) {
      dropped.unshift(last.blocks.pop());
      const removed = last.lines.pop();
      last.len -= removed.length + 1;
      // drop a section header left with nothing under it
      if (Object.values(sectionHead).includes(last.lines[last.lines.length - 1]) && last.lines[last.lines.length - 1]) {
        last.len -= last.lines.pop().length + 1;
      }
    }
    last.lines.push(notice());
  }

  const n = kept.length;
  const out = kept.map((p, i) => {
    const first = i === 0
      ? [head, `• session brief in ${n} parts; hard rules are listed without their why — ac principles show <id> for it`]
      : [`• principles, continued (part ${i + 1} of ${n})`];
    return [...first, ...p.lines].join('\n');
  });
  const delivered = { rules: [], index: [] };
  for (const p of kept) for (const b of p.blocks) if (b.id && (b.section === 'rules' || b.section === 'index')) delivered[b.section].push(b.id);
  return { parts: out, delivered };
}
