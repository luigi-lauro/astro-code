# Phase 34 — Challenge mode — CRITERIA

> Pre-registered, plan-blind. Derived from the phase goal, CONTEXT.md (D1–D8, E1–E5,
> constraints) and canon (ADR-030, ADR-035/037, ADR-055, ADR-056, ADR-069, CONVENTIONS §Voice).
> This phase is mostly prose-layer (commands + a shared template), so most `Observe:` steps are
> "read the shipped instruction an agent will actually receive and confirm it produces the
> behavior". Where a behavior is mechanically drivable (the gate, the CLI verbs the method
> names, install, the test suite) the criterion drives it instead of reading it.
> "Shipped" = what `ac install` into a scratch HOME publishes, not only the repo source.

### C1 — The whole suite is green and nothing outside this phase regressed
- **Observe:** from the repo root run `node --test tests/` (or `npm test` if it is defined).
  Exit 0, zero failing tests, and the count of executed tests is not lower than on `main`
  (`git stash`-free check: run the same command in a `git worktree add <tmp> main` checkout and
  compare the pass counts).
- **Fails if:** any test fails, the suite fails to load, or tests were deleted/skipped so the
  executed count dropped below `main`'s.

### C2 — The challenge method lives in exactly one place, and every entry point applies it rather than restating it
- **Observe:** install into a scratch home (`HOME=$(mktemp -d) node bin/ac.mjs install`, plus
  whatever host flag is needed so both Claude Code and Codex targets are written), then resolve
  the templates dir the commands use (e.g. `HOME=<same> node bin/ac.mjs path templates`). The
  shared challenge method is present there, non-empty. Read the installed `/astro-new-project`,
  `/astro-adopt`, `/astro-discuss` and `/astro-challenge` commands: each directs the agent to
  load and apply that one shared method in full at a path that resolves in the installed layout,
  and adds only its own destinations/entry-specific rules. None of them restates the round
  mechanics (unblocked-set rounds, recommendation per question, per-round save, checkpoint,
  rubber-stamp nudge, unknowns-kept-open) in its own words. Then prove the guard is real: in a
  scratch copy of the repo, remove the method reference from ONE of the four entry points and run
  the command-doc test file — it must fail, naming that command; restore and it passes.
- **Fails if:** the method is copied inline into any entry point; an entry point references a
  path that does not exist after install; the template is not shipped by install; or no test
  fails when an entry point stops referencing the shared method.

### C3 — A round asks every unblocked decision at once, as one numbered text message with a recommendation per question
- **Observe:** read the shipped shared method. An agent following it literally must: model the
  idea as a dependency tree of decisions; put in each round ALL decisions whose prerequisites are
  settled (no fixed small cap such as 2–4); hold back a question whose prerequisite is still open
  in the same round and recompute the unblocked set after each round; emit the round as a single
  plain-text message numbered Q1…Qn, each with a short title, the question and a recommended
  answer; accept free per-number replies where "ok" means take the recommendation; and never use
  `AskUserQuestion` (or any picker) to ask the round itself.
- **Fails if:** rounds are capped or curated to a small subset; dependent questions are asked
  before their prerequisite is settled; any question lacks a recommended answer; the round is
  asked through `AskUserQuestion`/a picker (which would break on Codex and cap at 4); or "ok" is
  not defined as accepting the recommendation.

### C4 — Facts are looked up, never asked; only decisions reach the user
- **Observe:** read the shipped shared method (and the adopt entry point's challenge branch).
  Anything discoverable from code, files, config or tools is the agent's job: small checks are
  read inline, a broad sweep goes to a read-only sub-agent, and only the questions that depend on
  that sweep wait a round while the rest of the round is asked now. In `/astro-adopt` challenge
  mode the mapper supplies the facts and the questions cover intent only (vision, what's next,
  which observed conventions are deliberate vs accidental).
- **Fails if:** the method permits asking the user something the repo could answer (stack,
  file layout, existing config); a broad sweep blocks the whole round instead of only its
  dependents; the sweep agent is not read-only; or adopt's challenge round asks about facts the
  mapper already produced.

### C5 — Every round's settled answers are on disk before the next round starts, at the entry point's real destination
- **Observe:** read the shipped method and each entry point. After every round (not at session
  end) settled answers are written: hard-to-reverse / surprising / genuine trade-off answers via
  `ac decision add` (inside a project), everything else to the entry point's file — PROJECT.md
  (vision, `REQ-` ids, constraints, an Open questions section) and CONVENTIONS.md for
  new-project/adopt; CONTEXT.md for discuss; the backlog item's note for standalone challenge.
  Then, in a scratch astro project (`git init` + `node bin/ac.mjs init`, with a local bare remote
  if the registry requires one), execute every `ac …` invocation the challenge instructions
  prescribe, with the flags they prescribe: each one is accepted by the CLI (exit 0, no
  unknown-flag/usage error).
- **Fails if:** saving is deferred to the end of the session (a `/clear` mid-session would lose
  more than one round); a destination is missing for any entry point; or any `ac` invocation the
  instructions prescribe is rejected by the CLI (an invented verb or flag — CONTEXT forbids new
  verbs absent a real gap).

### C6 — Every round ends in a checkpoint; capturing early leaves the rest explicitly open; unknowns are never assumed
- **Observe:** read the shipped method. After each round there is exactly one checkpoint asking
  "N questions still open — next round or capture now?" (via `AskUserQuestion` on Claude Code, a
  plain question where no picker exists). Choosing capture records every remaining question as
  OPEN, not filled with its recommendation. The session also ends when nothing is left and the
  user confirms the shared understanding; there is no hard round cap. "I don't know" / "I'd need
  to see it" answers are recorded as open questions. At the end, one offer files the unknowns as
  backlog items via `ac backlog add`; no phase number is claimed unless the user asks.
- **Fails if:** capture-now fills open questions with the recommendation; an "I don't know" is
  turned into an assumed decision; a fixed round limit ends the session; the checkpoint requires
  a picker with no plain-question fallback; or ending a session claims a phase number unasked.

### C7 — The rubber-stamp nudge fires once, after the first all-"ok" round, and never again
- **Observe:** read the shipped method. After the first round in which every answer was "ok",
  the agent says once, in one line, that the user took all N recommendations and asks whether any
  is worth pushing on; it is not repeated later in the same session, and accepting remains valid.
- **Fails if:** the nudge is absent, can repeat in a session, fires on a round with any
  non-"ok" answer, or blocks progress until the user changes an answer.

### C8 — The discuss gate is untouched: a challenge-discussed CONTEXT.md still reads as discussed, with the same provenance
- **Observe:** in a scratch astro project with a phase added, write that phase's CONTEXT.md four
  ways and run `node bin/ac.mjs phase context <n>` and `node bin/ac.mjs phase context <n> --author`
  each time: (a) line 1 `<!-- astro-discuss: captured -->`, line 2
  `<!-- astro-challenge: 3 rounds -->` → `ready` / `human`; (b) line 1 the agent form
  `<!-- astro-discuss: captured by agent: x -->`, line 2 the challenge marker → `ready` /
  `agent x`; (c) only the challenge marker, no discuss marker → NOT `ready`, `--author` → `none`;
  (d) a plain line-1 marker with no line 2 → `ready` / `human` (unchanged from `main`). Also confirm
  the test suite contains a case that fails if (a) stops reading `ready`/`human` (mutate a scratch
  copy of the gate to reject a second line and watch a test fail).
- **Fails if:** any of (a)–(d) deviates; the challenge marker is folded into line 1; the gate
  regex/ADR-035/037 behaviour changed; or no test pins case (a).

### C9 — `/astro-discuss <n> --challenge` runs the method; plain `/astro-discuss <n>` behaves exactly as before
- **Observe:** read the shipped `/astro-discuss`. Without the flag there is no challenge prompt
  or fork, and the quick discussion flow is behaviourally the same as on `main`
  (`git diff main -- commands/astro-discuss.md` shows no change to the plain path's steps). With
  `--challenge`, it applies the shared method, writes CONTEXT.md with the unchanged line-1 discuss
  marker and a line-2 `<!-- astro-challenge: <rounds> rounds -->` carrying the real round count,
  still puts the debt and backlog riders first in round one, and an agent answering on the
  operator's behalf does not use challenge mode.
- **Fails if:** a plain discuss prompts for or drifts into challenge mode; the challenge output
  omits/misplaces either marker or hard-codes the round count; the debt/backlog riders are dropped
  or moved out of round one; or an agent-authored discussion can run challenge mode.

### C10 — `/astro-autonomous <n> --challenge` hands the flag to its discuss step, still answered by the human; without the flag nothing changes
- **Observe:** read the shipped `/astro-autonomous`. With `--challenge`, its discuss step runs
  `/astro-discuss <n> --challenge` (the human answers the rounds, the agent does not). Without the
  flag, `git diff main -- commands/astro-autonomous.md` shows the flagless path unchanged.
- **Fails if:** the flag is swallowed, triggers an agent-answered challenge, or alters the
  flagless autonomous run.

### C11 — `/astro-new-project` and `/astro-adopt` open with a quick-vs-challenge fork, recommended the right way round, replacing only the requirements interview
- **Observe:** read both shipped commands. After the vision draft and the principles call, each
  asks once "Quick interview, or challenge me?". New-project lists challenge first as the
  recommended option; adopt lists quick first as recommended. Choosing challenge replaces only the
  requirements/constraints interview: the app-shape/scaffold fork and the Docker steps are still
  reached and unchanged, and choosing quick runs the existing interview unchanged
  (`git diff main` on those commands touches no quick-path step). PROJECT.md produced by either
  path has a place for open questions (inspect the template/scaffold `ac init` or the command
  writes, in a scratch project).
- **Fails if:** the fork is missing, asked at a different point, or recommends the wrong option
  for either command; challenge mode skips the scaffold/Docker steps; the quick interview's
  behaviour changed; or a challenge session has nowhere in PROJECT.md to record open questions.

### C12 — Standalone `/astro-challenge "<idea>"` keeps its record in a backlog item that promotion carries into a phase
- **Observe:** in a scratch astro project, perform exactly the CLI steps the shipped
  `/astro-challenge` prescribes for a two-round session on a new idea: the item is created with
  the idea as a one-line title, then each round's settled decisions and open questions are
  appended to its note. `node bin/ac.mjs backlog show <id>` shows BOTH rounds' content (the
  second append did not overwrite the first). Repeat with an existing backlog id: no second item
  is created, the existing one's note grows. Then follow the shipped `/astro-backlog-promote` flow
  for that item: the new phase's CONTEXT.md contains those decisions and open questions. Also
  read the outside-a-project branch: it states in one line that the conversation is the only
  record and writes no `.astrocode/`.
- **Fails if:** a round's content is lost or overwritten; an existing id spawns a duplicate item;
  the content does not survive promotion into CONTEXT.md; a phase number is spent by the
  challenge itself; or outside a project it errors, creates project state, or stays silent about
  where the record lives.

### C13 — The challenge surface is discoverable and works on Codex
- **Observe:** `node bin/ac.mjs help` and the shipped `/astro-help` list `/astro-challenge` and
  the `--challenge` flags of discuss and autonomous; MANUAL.md has them in the slash-command table
  plus a short section. Install into a scratch HOME with the Codex target: an `astro-challenge`
  skill is published, it and the other three entry points resolve the shared method there, and
  nothing in the round path depends on `AskUserQuestion` (the checkpoint/backlog offer fall back to
  a plain question).
- **Fails if:** any of help, `/astro-help` or MANUAL omits the command or flags; Codex install
  does not publish the command or cannot reach the method; or a Codex user would be unable to
  answer a round without a picker.

### C14 — New reporting slots are bounded and the guard test enforces it
- **Observe:** read the shipped commands and method: every new human-facing framing line
  (checkpoint, nudge, capture summary, outside-project notice, end-of-session backlog offer)
  states how much it may emit or when it emits nothing (CONVENTIONS §Voice). The numbered round
  itself is an interview turn, not a report. Then in a scratch copy, strip the bound from one new
  slot in a touched loop command (e.g. the discuss challenge capture summary) and run
  `node --test tests/commands.test.mjs`: it fails naming that slot.
- **Fails if:** a new slot has no bound/silence rule, or removing one leaves the guard test green.

### C15 — Shipped files present the method as astro-code's own
- **Observe:** inspect every file this phase added or changed under `commands/`, `templates/`,
  `agents/`, `MANUAL.md`, `README*` (`git diff main --name-only`, then read them). No shipped file
  attributes the challenge method to, names, or links an outside source, author, product or prior
  art.
- **Fails if:** any shipped file credits or references an external origin for the method.
