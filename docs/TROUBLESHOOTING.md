# When a night goes wrong

Start with the event log — it's the ground truth, not the report:

```bash
cat .nightshift/runs/<latest>/run.jsonl | jq .        # jq optional
cat .nightshift/runs/<latest>/T003.verify.json        # exact gate output
cat .nightshift/runs/<latest>/T003.agent.json         # raw envelope + verdict
```

---

## "Nothing happened. Every task is still pending."

Look for `infra_failure` in `run.jsonl`. The circuit breaker stopped the run — almost always expired auth.

```bash
claude -p "hi"          # re-login if this fails
node nightshift.mjs run # queue picks up where it stopped
```

Tasks killed by the breaker stay `pending` on purpose. Nothing was wasted.

## "It refused to start"

Preflight is strict by design and changes nothing when it fails.

| Message | Fix |
|---|---|
| working tree is dirty | Commit or stash. Otherwise your changes get swept into the agent's commits. |
| baseline is red | Fix the failing test first. Starting from red makes every result unattributable. |
| agent unreachable | `claude -p "hi"` and re-login. |
| no acceptance criteria | Every task needs a definition of done. |
| depends_on unknown task | Typo in a task id. |
| verify is empty | With no gates the runner can't check anything. Add at least a test command. |

To start from a knowingly-red baseline (rare, and you lose attribution), set `"baseline_must_pass": false`.

## "Everything got blocked"

Read the `blocked_reason` for each in `NIGHT_PLAN.md`, then match the pattern:

**All blocked on the same gate** → that gate is broken or too slow, not the tasks. Run it by hand on a clean checkout. If it timed out, raise `verify_timeout_sec`.

**All blocked with "agent made no file changes"** → the task specs are too vague to act on, or the work is already done.

**Mixed `blocker_question`s** → good night, actually. The agent hit real ambiguity and asked. Answer them, put the answers in each task's **Notes**, requeue.

**"agent claimed done but verification disagreed"** → the gate did its job. Check `<task>.verify.json` for what actually failed. Usually the acceptance criteria and the verify command are testing different things.

## "It stopped after three tasks"

Check the report's "Run stopped early" banner:

- **budget cap** → raise `caps.total_budget_usd`, or lower `per_task_budget_usd` so more tasks fit.
- **wall-clock cap** → raise `caps.wall_clock_hours`, or put fewer, better tasks in the queue.
- **consecutive failures** → the queue has a systemic problem. Don't just raise the cap; find out why three in a row failed.

## "The work landed but it's bad"

The gates verify, they don't review. Expect this occasionally and look for:

- **Weakened tests.** `git diff main..HEAD -- '*test*'` — an assertion that got looser is the most common way verified work is still bad work.
- **Vacuous new tests.** `expect(result).toBeDefined()` passes and proves nothing.
- **Swallowed errors.** New `catch {}` or `any` types.
- **Scope drift.** Files no task's `files_likely` predicted.

Fix by tightening acceptance criteria, not by adding rules to the agent prompt. "New tests cover page 1, a middle page, and past-the-end" produces better work than "write good tests."

## "It edited something it shouldn't have"

Add it to `forbidden_paths`. Touching one reverts the entire task.

```json
"forbidden_paths": [".env", ".env.*", "secrets/", ".github/workflows/", "migrations/"]
```

Note the gitignored-file caveat in [ANATOMY.md](ANATOMY.md) — declared forbidden paths are checked by size+mtime as well as git status, but a gitignored file created outside that list survives a revert.

## "Tasks conflict with each other"

Two tasks touching the same function, each in a fresh session with no knowledge of the other. Use `depends_on` to serialize them, or merge them into one task.

## "The run is too expensive"

Order of effect:

1. `caps.per_task_budget_usd` — the single most effective lever.
2. `"model": "sonnet"` for mechanical queues. Reserve opus for tasks needing real judgement.
3. Tighter task specs. Vague tasks cost more because the agent explores instead of executing.
4. `files_likely` on every task — it cuts search time directly.

Every run reports actual spend per task in `NIGHT_REPORT.md`. Use real numbers, not guesses.

## "Can I run it on a schedule?"

You can, but preflight will refuse if the tree is dirty or the baseline is red — which is the correct behaviour and means a cron job will silently no-op some nights. Check the exit code:

`0` all landed · `1` refused to start · `2` finished with blocked tasks · `3` stopped early by a cap

## Starting over

```bash
git checkout main
git branch -D nightshift/<date>     # discard the night entirely
git checkout main -- NIGHT_PLAN.md  # reset every status to pending
```

Run logs in `.nightshift/` are untracked and survive. Delete them when you want.
