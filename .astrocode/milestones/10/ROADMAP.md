# Roadmap

**Milestone 10**

- [ ] Phase 28 — Cross-host parity guard: each host declares what it provides, and a test fails when a command, agent or workflow depends on something a wired host cannot `pending`
- [ ] Phase 29 — Pi host adapter: prompt templates, agents, tool-name map, install, headless runs, verified on a real Pi install `pending` — _Prior research, not in repo: astro-code session 8b9eeb49 (2026-09-05 SDK spike; 2026-09-14 three-host design) and astro-fleet milestones/1 phase 01 notes/spike-pi.md (headless argv, models.json provider, exit codes). Consolidate into a research note here. Real install: Pi 0.86.1 on the Mac; its --thinking now has xhigh, so lib/reasoning.mjs pi map (xhigh->max) is stale._
- [ ] Phase 30 — Pi runtime extension: the Workflow surface, structured output and ask-the-user on Pi's SDK, so commands and workflows run unchanged `pending` — _Open decision from prior research: SDK extension re-implementing the Workflow surface (createAgentSession, per-session cwd, constrainedSampling for schema; model on examples/extensions/subagent) vs ac-owned orchestration via lib/hosts/runner.mjs + headless pi -p (also covers Codex). Settle in discuss._
- [ ] Phase 31 — Per-host model roles: map each role to a provider and model, with local-model limits reported `pending`
- [ ] Phase 32 — Pi session plumbing: status widget and session hooks, transcript-miner reader, Pi package `pending`
- [x] Phase 33 — Kit authoring guidance for data sources `complete`
- [x] Phase 34 — Challenge mode for new-project, adopt and discuss `complete` — _Opt-in 'challenge' interview: a thorough alternative to the quick interview. Offered as one opening question in /astro-new-project and /astro-adopt ('Quick interview, or challenge me?'), as /astro-discuss <n> --challenge, and possibly a standalone /astro-challenge "<idea>" for ideas not yet a phase (e.g. before promoting a backlog item).
Mechanics: model the idea as a decision tree; ask in rounds, each round = every question whose prerequisites are settled, numbered, each with a recommended answer; a question depending on one still open waits for a later round; recompute after each round; done only when no unsettled question remains and the user confirms shared understanding.
Facts vs decisions: anything discoverable (code, files, tools) is looked up by the agent (adopt: the mapper) without blocking unrelated questions; only decisions go to the user.
Open design points: rounds as numbered text vs AskUserQuestion (max 4 Qs, absent on Codex) and the commands.test reporting-slot bounds; capture every settled answer durably (PROJECT.md/REQ ids, CONTEXT.md, ac decision add for hard-to-reverse trade-offs) so it survives /clear; a round cap + checkpoint against runaway sessions; 'I don't know' / needs-a-prototype answers recorded as open questions with a suggested spike, not argued. Out of scope here: a project glossary (separate idea)._

<!-- generated from roadmap.json — edits here are overwritten; use `ac phase note <phase> "<text>"` -->
