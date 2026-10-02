# Phase 34 — Challenge mode for new-project, adopt and discuss — PLAN

Goal: an opt-in, thorough **challenge** interview — one shared method in
`templates/challenge.md`, applied by `/astro-new-project` and `/astro-adopt` (opening fork),
`/astro-discuss <n> --challenge`, `/astro-autonomous <n> --challenge` (pass-through) and a
standalone `/astro-challenge` — that turns a loose idea into settled decisions saved after
every round plus explicitly open questions. Bar: CRITERIA.md C1–C15.

Canon in force: ADR-069 (this method), ADR-035/037 (discuss-gate markers — untouched),
ADR-055 + CONVENTIONS §Voice (every new reporting slot states a bound), ADR-056 (backlog is
the home for unknowns), ADR-030 (prose layer only, no `lib/` change). No new `ac` verb: the
planner found no gap — `backlog add/show/note --append/promote`, `decision add`,
`principles ask`, `phase context` cover every write.

## Decisions this plan pins (open-for-planner items and research risks)

- **P1 — Per-round discuss writes carry no gate marker.** In `/astro-discuss --challenge`
  each round's settled answers are written to CONTEXT.md immediately, but WITHOUT the line-1
  discuss marker and the line-2 challenge marker; both are stamped only at capture, line 2
  carrying the real round count. A session that dies mid-way leaves a `stub` (the plan gate
  still asks for a discussion) and a rerun of `/astro-discuss <n> --challenge` reads the
  file back and continues. The gate's code is never touched.
- **P2 — Standalone dispatch is explicit, never a silent fuzzy match.** `/astro-challenge
  <arg>`: if `ac backlog show <arg>` resolves AND `<arg>` equals the item's exact id, update
  that item. If it resolves only by a fuzzy match (id fragment / title word), show the
  matched title in one line and ask one `AskUserQuestion` — "challenge this item, or file a
  new idea?" — before round one. Otherwise `ac backlog add "<idea trimmed to one line>"`
  (title = the idea, first line, trimmed). An existing id never spawns a second item.
- **P3 — Round records are plain markdown, appended only.** Each round is appended to the
  backlog note with `ac backlog note <id> "<record>" --append`, the record opening with a
  plain `Round N` heading, then `Settled:` and `Open:` lists. Never an HTML comment
  (`promotionContext` strips comments, so they would vanish on promotion), never a
  non-`--append` write to an in-progress challenge note.
- **P4 — Cycle escape hatch.** If a round would unblock nothing while questions remain, two
  open questions depend on each other: merge them into one question rather than stall.
- **P5 — Broad sweeps reuse what the entry point already has.** `/astro-adopt` challenge
  mode reuses the step-2 astro-mapper report; it never re-spawns the mapper per round. A new
  read-only sweep is only for a gap that report does not cover.
- **P6 — `ac decision add` text is a clean one-line paraphrase** (`--why` likewise), never a
  pasted multi-line user answer.
- **P7 — new-project's app-shape fork stays its own question.** In challenge mode the
  existing step-4 app-shape/scaffold fork (and its two follow-ups) is asked as written,
  immediately before round one, and its answers count as settled in the tree (never re-asked
  as a round question). Everything from step 4's canon push / decision recording / container
  scaffold onward runs unchanged.
- **P8 — adopt has no principles call on `main`, and the quick path keeps it that way.** The
  adopt fork sits after step 3's vision draft, before step 3's confirmation questions (a
  forward reference, the precedent is discuss 1c's "reading order is not the order the user
  experiences"). The challenge branch makes its one `ac principles ask` before round one —
  the shared method says "if the entry point has not already made its one principles call,
  make one" — so quick-path text in adopt is byte-unchanged.
- **P9 — `/astro-autonomous --challenge` on an already-`ready` phase does not re-discuss.**
  It says so in one line and points at `/astro-discuss <n> --challenge` to redo it
  explicitly; it never overwrites a captured CONTEXT.md.
- **P10 — The numbered round gets its own format assertion** (Q-numbered, a recommended
  answer per question, "ok" accepts, never asked through `AskUserQuestion`), in the new
  `tests/challenge.test.mjs`.
- **P11 — Slot bound wording** (CONVENTIONS §Voice / BOUND_RE vocabulary): checkpoint "one
  question, in one line"; nudge "once, in one line"; capture summary "in one line, naming
  rounds, settled and open counts and where they were saved"; backlog offer "say nothing
  when there are no unknowns"; outside-project notice "in one line"; autonomous
  already-discussed notice "in one line"; agent-refusal notice "in one line".

**Test strategy (ADR-018, stated explicitly):** the discuss-gate matrix (t3) is a
characterization test written FIRST — `lib/planning.mjs` is untouched by design, so it is
green on arrival and pins the behaviour before any prose changes (risk 7). Every prose
guard (t11, t12) is **test-after by choice**: it asserts on command/template text that only
exists once the prose tasks land — the same choice `tests/principle_capture.test.mjs`
made. No test statically imports a symbol that does not exist (t3 imports only existing
exports: `phaseContextStatus`, `classifyContext`, `contextAuthor`).

**Wave-green notes (ADR-020):** nothing is deleted or renamed. `tests/contracts.test.mjs`
fails on any `/astro-<name>` reference in `commands/`, README or MANUAL without a matching
command file — so ONLY t6 (which creates `commands/astro-challenge.md`) and t10 (which
depends on t6) may write `/astro-challenge` into those files; t4, t7, t8, t9 must not.
`templates/` and `bin/ac.mjs` are not scanned. Every `ac …` in a code span of a command must
be a real subcommand (same file) — only existing verbs are used.

**Shipped-text rule for every task (C15):** present the method as astro-code's own — no
outside source, author, product, survey/requirements-engineering term or prior art, anywhere
in `commands/`, `templates/`, `MANUAL.md`, `bin/`.

## Tasks

### t1 — Write the shared challenge method `templates/challenge.md`
- **id:** t1
- **file:** templates/challenge.md
- **depends_on:** []
- **what:** New file, shaped like `templates/principle-capture.md`: a header HTML comment
  saying this is the ONLY place the challenge method is stated in full, that callers load it
  as `` `$(ac path templates)/challenge.md` `` and apply it in full, adding only their own
  destinations/round-one riders/fact sources, and never restate it. Then numbered,
  operational sections (no graph-theory jargon, no outside references):
  1. **Before round one** — read the entry point's ground; if the entry point has not
     already made its one principles call, make one `ac principles ask "<question built
     from the idea>"` (P8); a decision a principle settled is stated in one line, not asked.
     List the decisions the idea needs and, for each, which other decisions it depends on.
  2. **Facts are looked up, never asked (D4)** — anything discoverable from code, files,
     config or tools is the agent's job. Small checks: read inline. A broad sweep: a
     read-only sub-agent (astro-mapper or Explore), reusing any report the entry point
     already holds (P5); only the questions that depend on its result wait for the next
     round, the rest are asked now. Decisions always go to the user.
  3. **A round (D2/D3)** — every decision whose prerequisites are settled, no cap and no
     curated subset; a question depending on one still open waits; recompute after every
     round; cycle escape hatch (P4). One plain text message numbered `Q1 … Qn`, each with a
     short title, the question and a **recommended answer**; the user replies freely per
     number and "ok" accepts the recommendation. Never ask the round through
     `AskUserQuestion` or any picker (works on hosts with no picker). Include a short
     format example. The round is an interview turn, not a report.
  4. **Save after every round (D5)** — before the checkpoint, write the round's settled
     answers to the entry point's destination, so a `/clear` or crash loses at most one
     round. Hard to reverse + would surprise someone without context + a real trade-off →
     `ac decision add "<choice>" --why "<why>"` (inside a project only; one-line paraphrase,
     P6). Everything else → the entry point's file. Open questions are written as open.
  5. **Checkpoint every round (D6)** — exactly one `AskUserQuestion`, verbatim
     "N questions still open — next round or capture now?" (options "Next round",
     recommended while questions remain / "Capture now"); where no picker exists ask the
     same one-line plain question. "Capture now" records every remaining question as
     **open, never filled with its recommendation**. The session also ends when no question
     is left and the user confirms the shared understanding. No hard round cap.
  6. **Rubber-stamp nudge (D7)** — after the first round where every answer was "ok", say
     once, in one line, verbatim "You took all N recommendations; any you'd actually push
     on?" Never repeated in the session; accepting stays valid; it never blocks the
     checkpoint.
  7. **Unknowns (D8)** — "I don't know" / "I'd need to see it" are recorded as open
     questions, never assumed. At the end, inside a project, one `AskUserQuestion` offers to
     file them as backlog items (prototype/spike ideas) via `ac backlog add "<question>"`;
     say nothing when there are no unknowns. Never claim a phase number (no `ac phase add`,
     no `ac backlog promote`) unless the user asks.
  8. **Capture summary** — in one line, naming rounds, settled and open counts and where
     they were saved.
  Each reporting slot states its bound per P11. Keep the file self-contained and short.

### t2 — Give PROJECT.md a place for open questions
- **id:** t2
- **file:** templates/PROJECT.md
- **depends_on:** []
- **what:** Add an `## Open questions` section (after `## Constraints`, before
  `## Out of scope`) with a one-line HTML comment: questions a challenge session left open —
  recorded as open, never filled with a guess — plus an empty `-` bullet. `ac init` already
  copies this template, so both quick and challenge paths get the section (C11). Run
  `node --test tests/cli.test.mjs tests/planning.test.mjs`.

### t3 — Pin the discuss gate against the line-2 challenge marker (characterization, first)
- **id:** t3
- **file:** tests/planning.test.mjs
- **depends_on:** []
- **what:** Add four tests reusing the file's `writeContext` helper and the existing
  exports (`phaseContextStatus`, `classifyContext`/`contextAuthor` from
  `lib/planning.mjs` — add them to the existing import; all already exist): (a) line 1
  `<!-- astro-discuss: captured -->`, line 2 `<!-- astro-challenge: 3 rounds -->` →
  `ready` and kind `human`; (b) line 1 `<!-- astro-discuss: captured by agent: x -->`,
  line 2 challenge marker → `ready` and agent `x`; (c) only the challenge marker → not
  `ready` (`stub`) and kind `stub` (`--author` prints `none`); (d) plain line-1 marker, no
  line 2 → `ready`/`human`. Sentence-form names that read as the spec; a comment explains
  this pins ADR-069's "the gate is untouched" so a regex change that rejects a second line
  goes red. Do NOT touch `lib/planning.mjs`. Run `node --test tests/planning.test.mjs`.

### t4 — `/astro-autonomous --challenge` pass-through
- **id:** t4
- **file:** commands/astro-autonomous.md
- **depends_on:** []
- **what:** Frontmatter `argument-hint: <phase number or slug> [--fast] [--challenge]`. Add
  a second pass-through paragraph right after the `--fast` one, modelled on it: with
  `--challenge`, the discuss step runs `/astro-discuss <number> --challenge` — numbered text
  rounds the human answers, never the agent; when `ac phase context` already prints
  `ready`, say so in one line and point at `/astro-discuss <number> --challenge` to redo it,
  never re-discussing on its own (P9). Without the flag nothing changes. Leave step 1 and
  every other line byte-unchanged (C10). Must not mention `/astro-challenge`.

### t5 — `ac help` names the challenge surface
- **id:** t5
- **file:** bin/ac.mjs
- **depends_on:** []
- **what:** In the `HELP` constant, after the `ac logo` line, add a short two-space-indented
  trailer (NOT starting with `  ac `, and continuation lines indented fewer than 10 spaces so
  `verbHelp` never attaches it to `ac logo`) naming the slash commands for challenge mode:
  `/astro-challenge "<idea>|<backlog id>"`, `/astro-discuss <n> --challenge`,
  `/astro-autonomous <n> --challenge`, plus "`/astro-help` lists every slash command". No
  new verb, no new case arm. Run `node --test tests/cli.test.mjs tests/brand.test.mjs
  tests/flow_cli.test.mjs`.

### t6 — Standalone `/astro-challenge` command
- **id:** t6
- **file:** commands/astro-challenge.md
- **depends_on:** [t1]
- **what:** New command. Frontmatter: `description` (challenge an idea that isn't a phase
  yet — numbered rounds, every round saved), `argument-hint: "<idea>" | <backlog id>`,
  `allowed-tools: Bash, Read, Grep, Glob, Agent, AskUserQuestion`. Numbered steps:
  1. **Where the record lives.** Outside an astro project (no `.astrocode/` — `ac status`
     says so): say in one line that this conversation is the only record, then run the
     method with no writes at all — never `ac init`, never `.astrocode/`, no
     `ac decision add`, no backlog offer.
  2. **Pick the item (P2).** Exact id → update it; fuzzy match → one line naming the matched
     title + one `AskUserQuestion` (this item / a new idea); otherwise
     `ac backlog add "<idea trimmed to one line>"` and read the id it prints.
  3. **Run the method.** Load and apply `` `$(ac path templates)/challenge.md` `` in full.
     Destination: after every round, `ac backlog note <id> "<round record>" --append` in the
     P3 format; never `--replace` or a bare note write during a session. Hard-to-reverse
     choices follow the method's `ac decision add` rule.
  4. **Report and hand off** — in one line: the item id, rounds, open count, and that
     `/astro-backlog-promote <id>` seeds this note into a phase's CONTEXT.md (still needing
     `/astro-discuss <n>`, optionally `--challenge`). No phase number is spent here.
  State only destinations/dispatch — never restate round mechanics (no Q-format, checkpoint
  wording, nudge wording). Every reporting slot states its bound (P11).

### t7 — `/astro-discuss <n> --challenge`
- **id:** t7
- **file:** commands/astro-discuss.md
- **depends_on:** [t1]
- **what:** Frontmatter `argument-hint: <phase number or slug> [--challenge]`. Add ONE new,
  clearly gated step — `3b. **Challenge mode — only with `--challenge`.**` — between step 3
  and step 4, and change no existing line (C9: the plain path is byte-unchanged; every
  existing SLOTS anchor in `tests/commands.test.mjs` — `1b. **Check the debt register`,
  `2. **Map the gray areas.`, `3. **Discuss in rounds`, `4. **Capture.`,
  `5. **Promote firm choices.`, `5b. **Propose what the answers settled.`,
  `6. Clear the live status`, `Keep it conversational` — must stay verbatim). The block says:
  strip `--challenge` from `$ARGUMENTS` to get the phase; a plain discuss never offers
  challenge mode; with the flag, steps 2–3 are replaced by loading and applying
  `` `$(ac path templates)/challenge.md` `` in full; the 1b debt and 1c backlog riders are
  still asked first, in round one, exactly as those steps state, before the first numbered
  round; destination is this phase's CONTEXT.md, written after every round WITHOUT markers
  (P1) and re-read on a rerun; at capture, line 1 is the unchanged discuss marker and line 2
  is `<!-- astro-challenge: <rounds> rounds -->` with the real number of rounds asked —
  never folded into line 1, never hard-coded; steps 4–6 then run as written (5b's
  principle capture included). An agent answering on the operator's behalf (one that would
  write the `captured by agent:` marker) never uses challenge mode: it says so in one line
  and runs the plain flow. Capture report stays bounded (one line). Never restate the round
  mechanics; must not mention `/astro-challenge`.

### t8 — `/astro-new-project` quick-vs-challenge fork
- **id:** t8
- **file:** commands/astro-new-project.md
- **depends_on:** [t1, t2]
- **what:** Insert a new step `3b. **Quick interview, or challenge me?**` between step 3 and
  step 4; change no existing line (C11: `git diff main` touches no quick-path step). One
  `AskUserQuestion`, asked once, after the vision draft and the principles call: options
  **"Challenge me"** first, marked recommended here (the idea is at its vaguest), then
  **"Quick interview"**. Quick → step 4 exactly as written. Challenge → ask step 4's
  app-shape fork and its two follow-ups first, as written there (P7), then load and apply
  `` `$(ac path templates)/challenge.md` `` in full in place of step 4's requirements/
  constraints interview only. Destinations, written after every round: `.astrocode/PROJECT.md`
  (vision, stable `REQ-` ids, constraints, the `## Open questions` section from t2),
  `.astrocode/CONVENTIONS.md`, and the method's `ac decision add` rule. Then continue step 4
  from its canon push onward (container scaffold, Docker probe, contract copy) unchanged, and
  steps 5–6 unchanged. Bounded framing per P11; never restate the round mechanics; must not
  mention `/astro-challenge`.

### t9 — `/astro-adopt` quick-vs-challenge fork
- **id:** t9
- **file:** commands/astro-adopt.md
- **depends_on:** [t1, t2]
- **what:** Insert a new step `3b. **Quick interview, or challenge me?**` between step 3 and
  step 4; change no existing line. The block says (P8): ask it as soon as step 3's drafts
  exist — after the vision draft, before step 3's confirmation questions — one
  `AskUserQuestion`, options **"Quick interview"** first, marked recommended here (the code
  answers most of it), then **"Challenge me"**. Quick → step 3's confirmation as written.
  Challenge → step 3's confirmation questions are not asked; load and apply
  `` `$(ac path templates)/challenge.md` `` in full, where the step-2 astro-mapper report is
  the fact source (reused, never re-spawned per round — P5) and the questions cover intent
  only: the vision, what's next, and which observed conventions are deliberate versus
  accidental — never a fact the map already holds (stack, layout, config). Destinations
  after every round: same as new-project (PROJECT.md incl. `## Open questions`,
  CONVENTIONS.md, `ac decision add`). Steps 4–8 then run unchanged. Bounded framing per P11;
  never restate the round mechanics; must not mention `/astro-challenge`.

### t10 — Document the surface in `/astro-help` and MANUAL
- **id:** t10
- **file:** commands/astro-help.md, MANUAL.md
- **depends_on:** [t4, t6, t7]
- **what:** `astro-help.md`: under "Capture without planning" add a one-line
  `/astro-challenge "<idea>"` entry (rounds saved into a backlog item; promote it later);
  in "The loop" extend the discuss and autonomous lines with their `--challenge` flag in the
  file's one-line style; in "Set up & navigate" note that new-project/adopt open with a
  quick-vs-challenge fork. `MANUAL.md`: add rows to the `### Slash commands` table for
  `/astro-challenge "<idea>"`, `/astro-discuss <phase> --challenge`,
  `/astro-autonomous <phase> --challenge` (aligned with the table), and a short
  `### Challenge mode` section under `## The loop` (after "Discuss before planning"): what it
  is, the four entry points and the pass-through, that every round is saved, the line-2
  marker, the Codex note (rounds are plain text; the checkpoint becomes a plain question),
  and a pointer to `templates/challenge.md` as the one home of the method — no restated
  mechanics, no outside references. Run `node --test tests/contracts.test.mjs
  tests/kit_convert.test.mjs tests/kit_source_command.test.mjs`.

### t11 — Prose guard + CLI round-trip for challenge mode (test-after)
- **id:** t11
- **file:** tests/challenge.test.mjs
- **depends_on:** [t1, t2, t4, t5, t6, t7, t8, t9, t10]
- **what:** New file, shaped like `tests/principle_capture.test.mjs` (readFileSync, scoped
  slices, failure messages quoting what is missing and naming the command). Test-after by
  choice (see Test strategy). Cover:
  1. **The method is stated once (C3/C4/C6/C7/P10):** `templates/challenge.md` states
     every-unblocked-decision rounds with no cap, dependents wait, Q-numbered round with a
     recommended answer per question, "ok" accepts the recommendation, the round is never
     asked via `AskUserQuestion`, facts looked up never asked + read-only sub-agent,
     save after every round + the `ac decision add` rule, the checkpoint line verbatim + a
     plain-question fallback, capture-now leaves questions open (never the recommendation),
     no round cap, the nudge line verbatim + never repeated, unknowns kept open + the
     `ac backlog add` offer, no phase number claimed.
  2. **Single source (C2):** `POINTER = '$(ac path templates)/challenge.md'` appears in each
     of `astro-new-project.md`, `astro-adopt.md`, `astro-discuss.md`, `astro-challenge.md`;
     the failure names every command missing it. None of those four nor
     `astro-autonomous.md` restates the method: the verbatim checkpoint and nudge lines and a
     `Q1` round format appear in none of them.
  3. **Entry points (C9–C12):** discuss — `[--challenge]` in argument-hint, the line-2 marker
     text `<!-- astro-challenge: <rounds> rounds -->`, riders first in round one, agent never
     uses challenge mode; autonomous — `--challenge` in argument-hint and passes
     `/astro-discuss <number> --challenge`; new-project — challenge option before quick and
     marked recommended inside the 3b block; adopt — quick before challenge and recommended,
     intent-only questions, mapper report reused; astro-challenge — `ac backlog add`,
     `--append`, no `--replace`, outside-project one-line notice.
  4. **CLI round-trip (C5/C12):** in a scratch project (`mkdtempSync`, `git init`,
     `ac init`, plus a local bare remote/registry following `tests/backlog_cli.test.mjs`'s
     setup if promotion needs one): `ac backlog add "<idea>"`, two
     `ac backlog note <id> "Round N …" --append` calls, `ac backlog show <id>` holds both
     rounds; `ac decision add "<x>" --why "<y>"` exits 0; `ac backlog promote <id>` writes a
     CONTEXT.md holding both rounds and `ac phase context <n>` still reads `stub`.
  5. **Shipped + discoverable (C2/C13):** `ac install` into a throwaway HOME with Claude and
     Codex targets (follow `tests/install.test.mjs`'s isolated-HOME + `CODEX_HOME` pattern)
     publishes `templates/challenge.md` under the astro home and an `astro-challenge` skill
     for Codex; `ac help` stdout names `/astro-challenge` and `--challenge`;
     `commands/astro-help.md` and `MANUAL.md` list `/astro-challenge` and `--challenge`;
     `templates/PROJECT.md` has `## Open questions`.
  Then run the whole suite `node --test tests/` — exit 0 (C1); this is the phase's final
  gate.

### t12 — Extend the Voice slot guard to the new reporting slots (test-after)
- **id:** t12
- **file:** tests/commands.test.mjs
- **depends_on:** [t1, t4, t6, t7, t8, t9]
- **what:** Extend `LOOP_COMMAND_SRC` with `astro-challenge.md`, `astro-new-project.md`,
  `astro-adopt.md`, `astro-autonomous.md`, plus a keyed entry for `templates/challenge.md`
  read from the templates dir (a sibling read, not via `cmd()`); widen the test's comment
  to say which files are covered now (do NOT widen `BOUND_RE` — C2 of phase 19: only the
  docs may turn a slot green). Add `SLOTS` rows, anchored on the real text the prose tasks
  landed, for: discuss `3b` challenge block (capture/agent-refusal line); new-project and
  adopt `3b` fork blocks; astro-challenge steps 1 (outside-project notice), 2 (fuzzy-match
  line) and 4 (report); autonomous `--challenge` pass-through (already-discussed line);
  template checkpoint, nudge, unknowns/backlog offer and capture summary. Read every new
  file end to end so no slot is skipped. Prove the guard bites: locally strip the bound from
  the discuss `3b` slot, see the test fail naming that slot, restore. Run
  `node --test tests/commands.test.mjs`.

## Wave shape

- Wave 1 (parallel): t1, t2, t3, t4, t5
- Wave 2 (parallel): t6, t7, t8, t9
- Wave 3 (parallel): t10, t12
- Wave 4: t11 (final gate — full suite)
