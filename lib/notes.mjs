// The one rule for writing a durable note — a phase's (`ac phase note`) or a backlog
// item's (`ac backlog note`) — so the two cannot drift apart (issue #106).
//
// A note is where long-lived context accumulates: an owner's decision, an execution
// order, what another phase handed over. Several writers add to it over weeks, agents
// among them, and the natural call for "add this line" — `ac phase note 18 "<line>"` —
// used to replace the whole note silently. In one project that dropped a 6,890-character
// owner decision under a one-line addition.
//
// So a plain write no longer replaces a note it does not carry forward:
//   - `append`  adds the text on a new line under the existing note;
//   - `replace` overwrites it, deliberately;
//   - neither   writes only when there is no note yet, or the new text CONTAINS the old
//               one (an edit that keeps it, e.g. a read-modify-write); otherwise it is
//               refused, naming what would be dropped.
// Clearing (empty text, no flag) stays as documented: it cannot be mistaken for adding
// a line.

export const NOTE_SEPARATOR = '\n';

/**
 * The note to store, or an Error explaining why the write was refused.
 *
 * @param {string|undefined} current  the stored note
 * @param {string} text               the text the caller passed (trimmed here)
 * @param {{ append?: boolean, replace?: boolean, target?: string }} [opts]  `target` names
 *   the note in the refusal ("phase 18", "backlog 2026-09-30-x")
 * @returns {string|Error}  '' clears the note
 */
export function nextNote(current, text, { append = false, replace = false, target = 'this' } = {}) {
  const old = String(current ?? '').trim();
  const add = String(text ?? '').trim();
  if (append && replace) return new Error('--append and --replace are exclusive: pick one');
  if (append) {
    if (!add) return new Error('--append needs the text to add');
    return old ? `${old}${NOTE_SEPARATOR}${add}` : add;
  }
  if (replace || !add || !old || add.includes(old)) return add;
  return new Error(
    `${target} already has a ${old.length}-character note, and this would replace it ` +
    `(it does not contain it). Nothing was changed. Add to it with --append, or overwrite it ` +
    `with --replace.`,
  );
}
