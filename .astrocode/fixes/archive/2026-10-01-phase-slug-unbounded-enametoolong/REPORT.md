# ac backlog promote / ac phase add: a long title claims the number and writes the roadmap, then fails at mkdir (ENAMETOOLONG)

(GitHub issue #107, verbatim)

`ac backlog promote` (and `ac phase add`, which goes through the same `addPhase`) with a long title fails at `mkdir` after it has already claimed the phase number and written the roadmap. The result is a half-created phase: it is in `roadmap.json` and `ROADMAP.md`, it has no folder, and the backlog item stays `open`.

**Reproduction** (astro-code 0.33.0, `main` at c657c4d; a throwaway folder, no guards or hooks):

```sh
git init --bare remote.git && git init proj && cd proj
git commit --allow-empty -m init && git remote add origin ../remote.git && git push origin HEAD
ac init --name repro && ac registry init
ac backlog add "$(printf 'a very long title %.0s' $(seq 18))"
ac backlog promote <the id it printed>
```

Output:

```
✖ ENAMETOOLONG: name too long, mkdir '.../.astrocode/phases/01-a-very-long-title-a-very-long-title-a-…'
  phase 1 was already claimed on astro-registry and stays claimed — it will not be handed out again. Your roadmap and the registry disagree; run `ac registry show` to compare.
```

After the failure:
- `roadmap.json` has phase 1 with a 326-character slug;
- `.astrocode/phases/` is empty;
- the backlog item's status is still `open`.

**Cause.** `slugify` in `lib/roadmap.mjs` has no length limit. Fix ids already have one: `datedId` in `lib/fixes.mjs` takes `maxSlug = 40` and cuts at a word boundary. `addPhase` then writes `roadmap.json` and `ROADMAP.md` (lines 273–275) before its `mkdirSync`. `promote` in `bin/ac.mjs` claims the number on the registry first, so a failure there leaves all three places out of step.

**Suggested fix** (a few lines):
- Bound the phase slug the way `datedId` bounds fix ids.
- Create the folder before writing the roadmap, so a failed `mkdir` leaves the roadmap untouched.

Found in a real project, where a 470-character title burned a phase number that then had to be retired by hand.

