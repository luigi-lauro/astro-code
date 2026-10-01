# Reproduction

Test: `tests/execute_blocked_dependency.test.mjs`
Run: `node --test tests/execute_blocked_dependency.test.mjs`

The script is driven end to end with recording stubs (same recipe as
tests/workflows.test.mjs). A per-task executor for a "blocked" id reports `commit: null`.

Observed before the fix:

- lean batch (batch commits only t1, t2 blocked):
  dispatched `['exec:batch', 'exec:t2', 'exec:t3']`, expected `['exec:batch', 'exec:t2']`
- sequential per-task loop (chain t1..t4, t2 blocked):
  dispatched `['exec:t1', 'exec:t2', 'exec:t3', 'exec:t4']`, expected `['exec:t1', 'exec:t2']`
- no `blocked` field in the result; `executed` counted attempts.

# Diagnosis

Symptom: a dependent executor starts on top of a predecessor that stopped BLOCKED; `executed`
says every task ran; only the completeness audit catches it afterwards.

Cause: the on-branch executor (`runOnBranch`) had no schema — it returned prose, so the
script had no signal whether a task committed. Neither the batch recovery loop nor the
sequential wave loop could check `depends_on` against outcomes, and both pushed every
non-null reply into `results` (hence `executed` = attempts). `buildWaves` ordering is
correct; it is a scheduling-time view and cannot know about run-time failures.

Fix: the on-branch executor reports `{ summary, branch, commit }` (EXEC_SCHEMA, as the
parallel executors already do); a single gate skips a task whose dependency did not land
this run (transitively, since a skipped task is itself not landed), records it under
`blocked` with the reason, and only landed tasks enter `results`. A declared commit-free
task (`no_commit`) lands by returning at all. The batch prompt also tells the batch
executor not to build dependents of a task it could not commit.

Ruled out / out of scope: the parallel worktree path. Its executors already report
branch/commit and the integrator (#21) and heal ladder own what happens to a wave that
did not land; its on-branch fallback re-run goes through the same gate.
