<!-- astro-discuss: captured -->
# Phase 34 — Challenge mode for new-project, adopt and discuss — CONTEXT

## Goal

An opt-in, thorough **challenge** interview, a stricter alternative to the quick interview.
It turns a loose idea into settled decisions plus explicitly open questions, and saves
every settled answer to disk as it goes. Name: "challenge" everywhere (commands, flags,
prompts, template, marker). astro-code's own design: no references to any outside source
or prior art, anywhere in shipped files.

## The method (one shared template)

- **D1 — One home.** The method lives in `templates/challenge.md`. Every entry point
  applies it in full, the same way `principle-capture.md` is applied today. Each entry
  point adds only its own destinations. A test pins that all four entry points reference
  the template; the method is not copied inline.
- **D2 — Decision tree, rounds.** Model the idea as a tree of decisions, each branching
  into the ones that depend on it. A round = every decision whose prerequisites are already
  settled (all unblocked questions, not a curated 2–4). A question that depends on one still
  open in the same round waits for a later round. After each round, recompute the
  unblocked set.
- **D3 — Round format: a numbered text message.** One message per round, `Q1…Qn`, each
  with a short title, the question and **a recommended answer**. The user replies freely,
  per number; "ok" accepts the recommendation. Works on Codex, which has no picker.
  `AskUserQuestion` is used only for the between-rounds checkpoint (D6) and the end-of-session
  backlog offer (D8), never to ask the round itself.
- **D4 — Facts vs decisions.** Anything discoverable (code, files, config, tools) is the
  agent's job and is never asked of the user. Small checks are read inline. A broad sweep
  goes to a read-only sub-agent (astro-mapper or Explore), and only the questions that
  depend on its result wait for the next round. The rest of the round is asked now.
  Decisions always go to the user.
- **D5 — Save after every round.** Each round's settled answers are written immediately to
  the entry point's real destination (below), so a `/clear` or crash mid-session loses one
  round at most. A settled answer that is hard to reverse, would surprise someone without
  context, and is a real trade-off → `ac decision add` (in a project). Everything else goes
  to the entry point's file.
- **D6 — Checkpoint every round.** After each round, one `AskUserQuestion`: "N questions
  still open — next round or capture now?" Capturing now records the remaining questions
  as **open**, never filled with the recommendation. The session also ends when no question
  is left and the user confirms the shared understanding. No hard round cap.
- **D7 — Rubber-stamp nudge.** After the first round where every answer was "ok", say once,
  in one line: "You took all N recommendations; any you'd actually push on?" Never repeated
  in a session. Accepting is still valid.
- **D8 — Unknowns.** "I don't know" or "I'd need to see it" answers are recorded as open
  questions, never assumed. At the end, one `AskUserQuestion` offers to file them as backlog
  items (prototype/spike ideas) via `ac backlog add`. No phase number is spent unasked.

## Entry points (all four in scope)

- **E1 — `/astro-new-project`.** One opening fork, after the vision draft and the
  principles call: "Quick interview, or challenge me?" Challenge is **recommended here**
  (shown first): the idea is at its vaguest. Destinations: PROJECT.md (vision, `REQ-` ids,
  constraints, a new **Open questions** section), CONVENTIONS.md, `ac decision add`. The
  existing app-shape/scaffold fork and Docker steps stay as they are; challenge replaces
  only the requirements/constraints interview.
- **E2 — `/astro-adopt`.** The same fork, with **quick recommended** (shown first): the code
  answers most of it. In challenge mode the mapper supplies the facts, and the questions
  cover intent only: vision, what's next, and which observed conventions are deliberate
  versus accidental. Same destinations as E1.
- **E3 — `/astro-discuss <n> --challenge`.** A flag only; a plain discuss doesn't prompt for
  challenge mode. Same CONTEXT.md output and same gate marker on line 1. Line 2 adds
  `<!-- astro-challenge: <rounds> rounds -->`. The discuss-gate regex, ADR-035/037 markers and
  `ac phase context` behaviour are untouched (a test pins that a CONTEXT.md with the line-2
  marker still reads `ready`/`human`). Debt (1b) and backlog (1c) riders still go first, in
  round one, as today. An agent answering on the operator's behalf never uses challenge mode.
- **E4 — standalone `/astro-challenge "<idea>"`.** For an idea that isn't a phase. Inside an
  astro project: create a backlog item (or, given an existing id, update it) and write each
  round's settled decisions plus open questions into its note (`ac backlog note --append`).
  `/astro-backlog-promote` then seeds them into the new phase's CONTEXT.md as it already
  does. Outside a project: the conversation is the only record, and the command says so in
  one line.
- **E5 — `/astro-autonomous <n> --challenge`** passes the flag through to its discuss step,
  still answered by the human. Without the flag, nothing changes.

## Out of scope / deferred

- A project glossary (separate idea).
- Any change to the quick interview's behaviour, the discuss gate, or the principle-capture step.
- New `ac` CLI verbs: everything goes through existing verbs (`backlog add/note`,
  `decision add`, `phase context`). Add one only if the planner finds a real gap.

## Constraints

- CONVENTIONS §Voice: every new reporting slot in the touched commands states a bound
  (one line / at most N lines / say nothing when…); `tests/commands.test.mjs` slot list
  extended for the new slots. The numbered round itself is an interview turn, not a report,
  but its framing lines (checkpoint, nudge, capture summary) are bounded.
- `/astro-help`, MANUAL (slash-command table and a short section) and the help listing
  cover `/astro-challenge` and the `--challenge` flags.
- Codex: the commands are rendered for Codex as-is; the method must not depend on
  `AskUserQuestion` for the round itself (D3), and the checkpoint falls back to a plain
  question there.

## Open for the planner

- The exact bound wording for the new slots, and whether the numbered round needs its own
  `commands.test` assertion (format: numbered, recommendation per question).
- How E4 names the backlog item when created from a challenge session (its title = the idea,
  trimmed to one line).
