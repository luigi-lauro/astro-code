# Roadmap

**Milestone 10**

- [x] Phase 33 — Kit authoring guidance for data sources `complete` · planned
- [ ] Phase 34 — Challenge mode for new-project, adopt and discuss `pending` — _Opt-in 'challenge' interview: a thorough alternative to the quick interview. Offered as one opening question in /astro-new-project and /astro-adopt ('Quick interview, or challenge me?'), as /astro-discuss <n> --challenge, and possibly a standalone /astro-challenge "<idea>" for ideas not yet a phase (e.g. before promoting a backlog item).
Mechanics: model the idea as a decision tree; ask in rounds, each round = every question whose prerequisites are settled, numbered, each with a recommended answer; a question depending on one still open waits for a later round; recompute after each round; done only when no unsettled question remains and the user confirms shared understanding.
Facts vs decisions: anything discoverable (code, files, tools) is looked up by the agent (adopt: the mapper) without blocking unrelated questions; only decisions go to the user.
Open design points: rounds as numbered text vs AskUserQuestion (max 4 Qs, absent on Codex) and the commands.test reporting-slot bounds; capture every settled answer durably (PROJECT.md/REQ ids, CONTEXT.md, ac decision add for hard-to-reverse trade-offs) so it survives /clear; a round cap + checkpoint against runaway sessions; 'I don't know' / needs-a-prototype answers recorded as open questions with a suggested spike, not argued. Out of scope here: a project glossary (separate idea)._

<!-- generated from roadmap.json — edits here are overwritten; use `ac phase note <phase> "<text>"` -->
