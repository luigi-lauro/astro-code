# Phase 34 — acceptance (human UAT)

Install the branch first (`ac install` from this checkout). Every item runs in a scratch
directory unless it says otherwise. None of them should touch this repo's own `.astrocode/`.

- [ ] **The user can start a new project in challenge mode and lose at most one round to a
  `/clear`.**
  Precondition: an empty git repo with no `.astrocode/`. Run `/astro-new-project`, give a
  vague one-line idea. After the vision draft, one question offers "Challenge me"
  (first, recommended) or "Quick interview". Pick challenge: the app-shape question comes
  first, then each round arrives as ONE numbered text message (`Q1…Qn`), every question with
  a recommended answer, and "ok" is accepted. After round one, `.astrocode/PROJECT.md`
  already holds that round's answers. At the checkpoint pick "Capture now": the unanswered
  questions sit in PROJECT.md's `## Open questions` as open, not filled with a guess.

- [ ] **The user can adopt an existing codebase and be asked only about intent.**
  Precondition: an existing repo with code (a package manifest, source files, tests) and no
  `.astrocode/`. Run `/astro-adopt`: the fork shows "Quick interview" first and recommended.
  Pick challenge: no round asks about the stack, file layout or config the mapper already
  read; the questions cover vision, what's next, and which conventions are deliberate.

- [ ] **The user can challenge-discuss a phase and planning still sees it as discussed.**
  Precondition: an astro project with one pending phase that has no CONTEXT.md, and at least
  one open debt item or backlog item touching that phase. Run `/astro-discuss <n> --challenge`:
  the debt/backlog question comes first in round one, then numbered rounds. Answer "ok" to
  everything in one round: a one-line "You took all N recommendations…" nudge appears once,
  and never again in that session. On capture, CONTEXT.md line 1 is
  `<!-- astro-discuss: captured -->`, line 2 `<!-- astro-challenge: <real count> rounds -->`,
  and `ac phase context <n>` prints `ready`, `--author` prints `human`. Running plain
  `/astro-discuss` on another pending phase shows no challenge prompt at all.

- [ ] **The user can challenge a loose idea that isn't a phase, then promote it.**
  Precondition: an astro project whose backlog holds at least one unrelated open item. Run
  `/astro-challenge "<new idea>"` for two rounds, answering one question "I don't know".
  `ac backlog show <id>` shows both rounds in the note, the unknown listed as open, and at the
  end one offer to file the unknown as a backlog item. Re-run `/astro-challenge <that id>`:
  no second item is created, the note grows. `/astro-backlog-promote <id>` produces a phase
  whose CONTEXT.md carries those decisions and open questions.

- [ ] **The user can run `/astro-challenge` outside any project without side effects.**
  Precondition: a scratch directory that is not an astro project (no `.astrocode/`). The
  command says in one line that the conversation is the only record, runs the rounds, and
  leaves no `.astrocode/` behind.

- [ ] **The user can run autonomous with challenge and still answer the rounds themselves.**
  Precondition: an astro project with one pending, undiscussed phase. `/astro-autonomous <n>
  --challenge` runs the discuss step as numbered challenge rounds that the user answers, then
  plans and executes as usual. On a phase whose CONTEXT.md already reads `ready`, it says so
  in one line instead of re-discussing.

- [ ] **The user can find and use challenge mode on Codex.**
  Precondition: a machine with Codex installed (`~/.codex/` present) and astro-code installed
  from this branch. `$astro-challenge` is available, rounds are answerable as plain text, and
  the checkpoint arrives as a plain question. `ac help`, `/astro-help` and MANUAL.md all name
  `/astro-challenge` and the `--challenge` flags.
