# Reproduction

Test: `tests/phase_slug_bound.test.mjs`
Run: `node --test tests/phase_slug_bound.test.mjs`

Observed before the fix (both cases fail):

1. `a long phase title is bounded…` — `addPhase` throws
   `ENAMETOOLONG: name too long, mkdir '…/.astrocode/phases/01-a-very-long-title-a-very-long-title-…'`
   (a 326-character slug from an 18× repeated title).
2. `a failed mkdir leaves the roadmap untouched` — with a plain file blocking the phase
   folder, `addPhase` rejects but `roadmap.json` already holds the phase:
   `AssertionError: the phase must not be in roadmap.json`.

# Diagnosis

Symptom: a half-created phase (in roadmap.json/ROADMAP.md, no folder, backlog item still open).

Cause, two defects in `addPhase` (lib/roadmap.mjs):
- the slug is `slugify(name)` with no length bound, so the folder name can exceed the
  filesystem's 255-byte component limit;
- roadmap.json and ROADMAP.md are written before `mkdirSync`, so any mkdir failure
  leaves the roadmap describing a phase that does not exist on disk.

Ruled out: `promote` in bin/ac.mjs claiming the registry number first is ordering by
design (the number must be granted before it is used); once addPhase cannot fail on the
slug length, that path no longer burns numbers for this reason. Existing phases are
unaffected: the slug is stored in roadmap.json and every lookup matches on the stored
value, never re-derives it.
