# execute-phase dispatches a task whose dependency just reported BLOCKED, and counts it as executed

(GitHub issue #100, verbatim)

## Summary

`execute-phase.mjs` dispatches a task whose dependency has just reported BLOCKED (returned with no commit). The dependent executor is started anyway and the run reports every task as `executed`; only the completeness audit afterwards notices the missing commits.

Seen on `main` @ `ea7da32` (v0.33.0), in both the lean batch path and the sequential wave loop.

## Reproduction (clean fixture: no `.claude/`, no hooks, `use_worktrees: false`)

A fresh repo with `ac` initialised, one milestone, one phase with three chained tasks:

- `t1` creates `a.txt` (no dependencies)
- `t2` creates `b.txt` **only if a file `OWNER-OK` exists; otherwise it reports BLOCKED and commits nothing** (`depends_on: [t1]`); `OWNER-OK` does not exist
- `t3` creates `c.txt` (`depends_on: [t2]`)

Run:

```js
Workflow({ scriptPath: "<astro-code>/workflows/execute-phase.mjs",
  args: { root: "<fixture>", phase: "01-three-chained-files", effort: "light",
          useWorktrees: false, leanExecution: true, strategy: "sequential",
          models: { executor: "sonnet", discover: "sonnet", verifier: "sonnet", integrator: "sonnet" },
          reasoning: { executor: "low", discover: "low", verifier: "low", integrator: "low" } } })
```

## Observed

`journal.jsonl` start order: `exec:batch` → `exec:t2 Create b.txt (gated on OWNER-OK)` → **`exec:t3 Create c.txt`** → `stamp-audit`.

- The batch committed only `t1`; the recovery then re-ran the missing tasks one by one, and `exec:t3` was started after `exec:t2` had returned without a commit.
- The t3 executor itself refused to create `c.txt` (the `SYNC_WORKTREE` guidance says to make no commit when a promised dependency is absent), so no damage landed here. The defect is the dispatch: a less careful executor, or a task whose dependency is only a precondition rather than a file, will do the work on top of a blocked predecessor.
- The returned object says `"executed": 3`, although two of the three tasks produced nothing; the run then stops with `stoppedReason: "integration-failed"` from the completeness audit, which names t2 and t3 as having no stamped commit.
- Final branch: only `(phase 01 t1)`.

We hit the same pattern in a real project: a wave task was dispatched after two tasks it depended on had both reported BLOCKED at an owner-approval stop point; we stopped the run by hand before it changed anything.

## Where

- Lean batch recovery, `workflows/execute-phase.mjs:1362-1371`: `missingFromBatch(ordered, committed)` returns every uncommitted task in plan order, and the loop runs `runOnBranch(t)` for each without checking whether a task's `depends_on` includes an id that just failed to commit.
- Sequential wave loop, `workflows/execute-phase.mjs:1384-1388`: same shape — `runOnBranch(t)` per task in the wave, no check of the earlier waves' outcomes.
- `buildWaves` (`:337`) orders by `depends_on`, which is correct for scheduling, but nothing re-checks the dependency at dispatch time once a predecessor has not committed.
- `results.push(r2)` / `results.push(out)` (`:1370`, `:1387`) push the reply of an attempted task, so `executed` counts attempts, not commits.

## Suggested fix

At dispatch time (both loops), skip a task whose `depends_on` contains an id with no stamped commit in this run, record it as `skipped` with the blocking id (e.g. `{ id: "t3", reason: "dependency t2 did not commit" }`), and propagate transitively. Optionally, make `executed` count committed tasks only, or report attempted and committed separately. The batch prompt (`:1239-1281`) could also tell the batch executor to stop a task's dependents when it reports that task BLOCKED.

Happy to open a PR with a test if that shape suits you.

