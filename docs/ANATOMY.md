# Anatomy of a night run

Why each piece exists. Read this before trusting nightshift with a real project — the guardrails only help if you know what they do and don't cover.

## The one idea

**The agent proposes. The runner disposes.**

Every unsupervised-agent horror story reduces to the same thing: the agent was both the worker and the judge of its own work. nightshift splits those roles. The agent writes code and returns a claim. The runner independently re-runs your verify commands, and only the runner's result decides whether anything gets committed.

This is why a project with no tests gets almost no protection. The runner has nothing to check against. nightshift is exactly as trustworthy as your verify commands are strict.

## The loop, step by step

For each task, in order:

**1. Checkpoint.** Record `HEAD`. Snapshot size+mtime of every forbidden path that exists on disk.

**2. Invoke a fresh agent.** A new `claude -p` process per task — no `--resume`, no shared history:

```
claude -p "<task spec>"
  --output-format json
  --json-schema <task-result.schema.json>
  --permission-mode acceptEdits
  --max-budget-usd <per_task_budget_usd>
  --model <model> --fallback-model <fallback_model>
  --append-system-prompt <night-task/SKILL.md>
  --disallowedTools <denylist>
```

Fresh sessions are the fix for drift. A long-running session degrades as context fills; twenty short ones don't. The cost is that nothing carries over — which is why task specs must be self-contained and why `/night-plan` insists on acceptance criteria.

**3. Classify the outcome.** Four different things get four different responses:

- **Infrastructure failure** (CLI missing, unparseable output, or an error returned faster than `min_task_duration_sec`) → reset, leave the task **pending**, increment the infra counter. Not the task's fault; it stays runnable.
- **Agent error** → reset, mark blocked.
- **Agent returned `blocked`** → reset, mark blocked, capture the question. *This is a success state.*
- **Agent returned `done` or `partial`** → continue to the gates.

**4. Guard rails, in order.**
- Any changed path matching `forbidden_paths` → revert the whole task.
- Agent modified `NIGHT_PLAN.md` → revert just that file and log it. The queue isn't the agent's to rewrite.
- No file changes at all → blocked. "Done" with an empty diff is not done.

**5. The gate.** The runner runs the task's own `verify` command, then every command in `config.verify`, fail-fast. This is the only thing that decides done.

**6. Commit or revert.**
- Pass → `git add -A` and commit, subject `T003: title`, body carrying `nightshift-task` and `nightshift-verified` trailers.
- Fail → `git reset --hard <checkpoint>` + `git clean -fd`, mark blocked, record the failing output. If the agent had claimed `done`, that disagreement is called out in the log and the report.

**7. Check the caps.** Wall clock, total spend, consecutive failures, infra failures.

## Why `git clean -fd` and not `-fdx`

`-fd` removes untracked files but **not** gitignored ones. That's deliberate: `.nightshift/` holds the run logs, and they have to survive every reset — otherwise a failure would erase its own evidence.

The tradeoff: a gitignored file the agent creates survives a revert. It can't reach the branch (git won't commit it), but it can sit in your working directory. This is why forbidden paths get a size+mtime snapshot as well as a `git status` check — `.env` is gitignored in most real projects, so the status check alone would miss the exact case it most needs to catch.

## The circuit breaker

The failure that motivated this: a headless call with expired auth returns `is_error` in **38 milliseconds**. Without a breaker, a 40-task queue "fails" in under a minute, every task gets marked blocked, and you wake up to a queue that looks attempted but was never actually tried.

Two mechanisms:

- **`max_infra_failures`** (default 2) — infrastructure failures abort the run almost immediately.
- **`min_task_duration_sec`** (default 20) — *any* agent error returning faster than this is reclassified as infrastructure. Real work takes time. A fast failure is a system failure, not a task failure.

Tasks killed this way stay `pending`, not `blocked`. Fix auth, re-run, and the queue picks up exactly where it stopped.

## Dependencies and skipping

`depends_on` is checked at selection time: a task is only eligible when all its dependencies are `done`. When the run ends, anything still pending whose dependency ended non-`done` is marked `skipped`, transitively.

This matters more than it looks. Without it, a task whose foundation was never built runs anyway, against a codebase that doesn't have what it expects — and the resulting mess still passes tests, because it tests the wrong thing.

## Why blocking is a success state

The worst overnight outcome isn't a failed task. It's a **confident guess on an ambiguous requirement** — it looks like progress, passes the gates, and gets discovered a week later.

So `night-task` instructs the agent to stop and ask, and the result schema requires a specific `blocker_question`. The morning report leads with these. Each one you answer in a sentence becomes a well-specified task for the next night.

Three tasks done plus two sharp questions is a better night than five tasks done where two of them guessed.

## What isn't protected

Be clear-eyed about the boundaries:

- **Bad tests.** If the agent weakens an assertion to make a suite pass, the gates approve it. `/morning-report` tells you to check test diffs with suspicion for exactly this reason.
- **Correct-but-wrong code.** Passing tests aren't correctness. The gates catch regressions, not misunderstandings.
- **Gitignored side effects.** Covered for declared `forbidden_paths`, not in general.
- **Anything outside the repo.** Denied tools cover the common cases (`sudo`, `curl`, `rm -rf`, push, remotes), but `acceptEdits` permission mode is genuinely permissive within the working directory. Run overnight work on a machine and account you'd be comfortable handing to a competent but unsupervised contractor.

## Files

| Path | Owner | Purpose |
|---|---|---|
| `NIGHT_PLAN.md` | You write tasks, runner writes status | The queue |
| `nightshift.config.json` | You | Verify commands, caps, forbidden paths |
| `NIGHT_REPORT.md` | Runner | Regenerated each run |
| `.nightshift/runs/<id>/run.jsonl` | Runner | Event log |
| `.nightshift/runs/<id>/<T>.agent.json` | Runner | Raw envelope + verdict per task |
| `.nightshift/runs/<id>/<T>.verify.json` | Runner | Every gate's exit code and output |

When a night goes wrong, `run.jsonl` is the ground truth.
