---
description: Configure astro-code — which model runs each role and how hard it thinks, which extra MCP tools (e.g. lean-ctx) the agents may use, or what each statusline gauge shows
argument-hint: [models|tools|statusline]
allowed-tools: Bash, AskUserQuestion
---

Three things can be configured here:

- **models** — which model runs each role, and how hard it thinks (below, "Models").
- **tools** — which extra MCP tools astro-code's agents may use ("Agent tools").
- **statusline** — what each statusline gauge shows: bar, percent or both (last section,
  "Statusline gauges").

If `$ARGUMENTS` is `models`, `tools` or `statusline`, go straight to that section. Otherwise
ask with **AskUserQuestion** — header `Configure`, options **Models** (tier + reasoning per
role), **Agent tools** (extra MCP tools for the agents) and **Statusline** (bar / % per
gauge) — and follow the one picked.

# Models

Interactively configure the per-role **model tier** and **reasoning depth** in
`.astrocode/config.json`. They are independent levers and both move cost — a cheap
model at `xhigh` can outspend an expensive one at `low` — which is why a profile sets
the pair together.

**Do not confuse `reasoning` with a phase's `effort`.** `reasoning` is how hard one
agent thinks (`low|medium|high|xhigh|max`). `effort` (ADR-022, `ac phase effort`) is
how many verify→remediate cycles a phase may burn. Different dials, both about spend.

If there is no `.astrocode/` here, tell the user to run `/astro-new-project` first and stop.

## On Codex

Check this first. If you are running in **Codex CLI** (you are an OpenAI/Codex model, and
this command reached you as the `astro-config` skill), the tiers below do not apply.
`opus` and `sonnet` are Claude models. Codex has neither, and astro-code does not yet keep
per-role Codex models. On Codex every role runs on this session's model.

- **Never offer** `opus`, `sonnet` or the Balanced/Fast/Max profiles, and never suggest a
  Claude model, for any role.
- **Never run `ac config set models.<role>`** from Codex, with any model id, and never
  `ac models <profile>`. `.astrocode/config.json` is shared and committed, so a Codex
  model written there would be handed to every Claude teammate's subagents, whose host
  does not have it.
- **What you can do:** show `ac models`, and say in one line that model tiers apply only
  to Claude Code sessions, while here every role uses the session's model (pick it with
  Codex's own model setting). Reasoning depth is host-neutral, so offer that alone:
  `ac config set reasoning.<role> <low|medium|high|xhigh>`. Codex's ceiling is `xhigh`.
- If the user wants different Codex models per role, say in one line that this isn't
  supported yet, and offer to file it: `ac backlog add "Per-role Codex models"`.

Then stop: skip the Steps and Apply below.

## Steps

1. Show the current settings: `ac models` (prints both the tier and reasoning maps).
2. Ask the user how to set them with **AskUserQuestion** — start with a profile pick.
   The tier ladder is **opus → sonnet** for EVERY role. haiku is excluded everywhere,
   integrator included: ADR-035 reverted the ADR-027 carve-out after a haiku integrator
   ran a bare `git stash -u` in the shared working tree and destroyed a completed phase
   plan. Never offer haiku for any role.
   - **Balanced** (recommended): planner `opus`, researcher `sonnet`, executor
     `sonnet`, verifier `opus`, discover `sonnet`, integrator `sonnet`. The default
     daily-driver.
   - **Fast**: planner `sonnet`, researcher `sonnet`, executor `sonnet`, verifier
     `opus`, discover `sonnet`, integrator `sonnet`. Everything sonnet except the
     verify gate (kept opus so speed never costs correctness). Fastest sane setting.
   - **Max quality**: every role `opus`, except integrator which is `sonnet` — opus
     on a cherry-pick is waste. Slowest, best.
   - **Custom**: choose each role yourself.
3. If **Custom**, ask the tier for each role. There are 6 roles and AskUserQuestion
   allows ≤4 questions per call, so use **two calls**: first
   `[planner, researcher, executor, verifier]`, then `[discover, integrator]`. For
   every role, the options are: `opus`, `sonnet`, `inherit` (use the session model) —
   **never** offer haiku, for any role. For `integrator` do not offer `inherit` either,
   because unset floors to `sonnet` there rather than inheriting the session model (the
   one way it still differs from the others).

## Apply

For a named profile (Balanced/Fast/Max), apply the whole preset — tier AND reasoning —
in one command:
- `ac models balanced` | `ac models fast` | `ac models max`

For **Custom**, set each chosen role individually:
- a concrete tier → `ac config set models.<role> <tier>`
- a reasoning depth → `ac config set reasoning.<role> <low|medium|high|xhigh|max>`
- `inherit` → `ac config unset models.<role>` / `ac config unset reasoning.<role>`
  (the workflow then uses the host default)

Reasoning by profile: **max** spends `xhigh` on planner and verifier, **balanced** uses
`high` on those two and `medium` elsewhere, **fast** drops to `low` everywhere EXCEPT
the verify gate, which keeps `high` for the same reason it keeps opus — speed must never
silently cost correctness at the gate. `discover` and `integrator` stay `low` in every
profile: both are mechanical, and more thinking buys nothing.

Not every host honours every level. Codex's ceiling is `xhigh`, Pi's is `max`; asking
for more clamps to the host's ceiling rather than silently falling back to its default.

## Roles, for reference

- **planner** — synthesizes the PLAN.md (quality compounds across the phase)
- **researcher** — parallel investigation during planning
- **executor** — implements one task each during execution
- **verifier** — goal-backward verification (a false PASS is the costliest error)
- **discover** — mechanical task/dependency parsing before execution
- **integrator** — folds each parallel wave's worktree branches back onto the
  branch (mechanical git, run at `sonnet` like every other role — ADR-035; anything it cannot
  pick cleanly is preserved and re-run at the executor tier)

Finish by showing the result: `ac models`.

# Agent tools

Each astro agent has a fixed tool list that Claude Code enforces, so it cannot call an MCP
tool the session has (e.g. lean-ctx's cheap `ctx_read`) unless the user adds it. The
setting is **per user** — `~/.astro/config.json`, shared by every project on this machine —
and `ac agent-tools` is the only thing that writes it. **The user never types a tool name:
you list what this session actually has.**

1. **Show what is set:** `ac agent-tools --json` — `config` (what the user added),
   `agents` (what each agent gets now) and `agentNames` (the valid agent names).
2. **Find the MCP tools this session has.** Collect every tool name you can see that starts
   with `mcp__` — the ones loaded in your tool list AND the deferred ones listed by name only.
   Group them by server: the part between `mcp__` and the next `__`. Tools astro-code's
   agents already reach natively (plain file read/search) need nothing. If there are no MCP
   tools at all, say so in one line and stop.
3. **Ask which servers** with AskUserQuestion (`multiSelect: true`): one option per server,
   each described in a few words from its tool names (e.g. "lean-ctx — cheap file reads and
   search"). Recommend the ones that help an agent read or search code. At most 4 options;
   if there are more, offer the 4 most useful and let "Other" name the rest.
4. **Ask which of their tools**, per chosen server, with a recommendation of **read-only
   (Recommended)** — tools whose names read, get, list, search, query, find, view, tree,
   glob or grep — versus **all tools** versus **let me pick**. Read-only is the safe default:
   the verifier and researchers must never be able to change the tree through a side door,
   and a write tool is a deliberate choice for `astro-executor` only.
5. **Ask which agents** get them: **all agents (Recommended)** (`*`), **the read-side only**
   (`astro-researcher`, `astro-planner`, `astro-verifier`, `astro-criteria-author`,
   `astro-mapper`), or **let me pick** (from `agentNames`).
6. **Apply** — never edit the JSON yourself:
   - `ac agent-tools add <agent|*> <mcp__server__tool> …` — once per target agent (or `*`)
   - to take tools away: `ac agent-tools remove <agent|*> <tool> …`, or `ac agent-tools clear`
   `ac` validates every name, keeps the other keys in that file, and applies the change to the
   installed agents immediately. Relay its warnings; if it refuses, show why and stop.
7. **Finish** with `ac agent-tools` (the per-agent result) and one line: a Claude Code session
   already running keeps its old agent definitions — restart it to pick them up.

# Statusline gauges

The statusline draws four gauges: **ctx** (context fill), **5h** and **7d** (the rolling
quota windows) and **cap** (the gateway spend cap, when present). Each can show its **bar**,
its **percent**, or **both** (the default). The setting is **per user** —
`~/.astro/config.json` under `statusline`, shared by every project on this machine — and
`ac statusline gauges` is the only thing that writes it.

1. **Show what is set:** `ac statusline gauges`.
2. **Ask** with AskUserQuestion, one question per gauge (four questions, one call) — header
   the gauge name, options **Both**, **Percent**, **Bar**, with the current value marked.
   Say once that width still wins: on a line too narrow for bars every gauge shows its
   percent, so a gauge set to **Bar** never disappears.
3. **Apply** each changed gauge — never edit the JSON yourself:
   `ac statusline gauges <ctx|5h|7d|cap|all> <both|bar|percent>`. If every gauge gets the
   same mode, one `all` call does it. If `ac` refuses (e.g. the file is not valid JSON), show
   why and stop.
4. **Finish** with `ac statusline preview`, and one line: it takes effect on the next
   statusline repaint.
