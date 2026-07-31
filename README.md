# nightshift

**Make real progress on a big project while you sleep.**

You have a large codebase and a long backlog. You want to point Claude Code at it before bed and wake up to work that's actually done. The obvious version of this — leave a session open with "keep going until it's finished" — fails for boring, repeatable reasons.

nightshift is the boring, repeatable fix.

```bash
# Evening — 10 minutes, interactive
claude          # then use /night-plan to build tonight's queue

# Bedtime
node nightshift.mjs run

# Morning
cat NIGHT_REPORT.md
```

You wake up to one branch of small, individually-verified commits, a report of what landed and what didn't, and a short list of questions the agent refused to guess at.

---

## The thesis

**The value isn't an agent that runs all night. It's the guardrails that make an all-night run trustworthy.**

An unsupervised agent's failure modes are well known and every one of them has a mechanical fix. That's all this repo is — the fixes, wired together.

| What goes wrong overnight | What nightshift does about it |
|---|---|
| Agent says "done." It isn't. | **The runner re-runs your verify commands itself.** The agent's self-report is a hint, never the gate. Claimed-done-but-red gets reverted and flagged. |
| One broken task poisons everything after it | Every task is checkpointed. Failure = `git reset --hard` to the checkpoint. **Every commit on the branch is green.** |
| Quality decays as context fills up | **Fresh session per task.** No accumulated context, no drift. The queue file is the only thing that crosses task boundaries. |
| Cost runs away while you sleep | Per-task budget, total budget, and a wall-clock deadline. All hard caps. |
| Auth expires at 1am → 40 tasks "fail" in 40 seconds | **Circuit breaker.** Failures that return implausibly fast are treated as infrastructure, not task failures. The run stops and the queue stays re-runnable. |
| Agent does something destructive | Denied tools (no push, no remote, no `rm -rf`, no `sudo`), a forbidden-paths list, work on a throwaway branch, and **nothing is ever pushed**. |
| You wake up to one unreviewable 4000-line diff | One commit per task, tasks sized to one commit, per-task diffstat in the report. |
| Agent guesses on a decision it should have escalated | Blocking is a **success** state with a required question. You get "should null customer_ids be excluded or bucketed?" instead of a silent wrong answer. |
| Agent rewrites its own queue to make life easier | The agent can't write `NIGHT_PLAN.md`. The runner owns every status field and reverts attempts to edit it. |

The circuit breaker row is not hypothetical. It exists because during development a headless call with stale auth returned `is_error` in **38 milliseconds** — fast enough to burn an entire night's queue before anything else noticed.

---

## Try it in 10 minutes, without spending anything

```bash
git clone https://github.com/cr7sucks/nightshift.git
cd nightshift
node bin/nightshift.mjs demo
node bin/nightshift.mjs run --dry-run --cwd nightshift-demo
```

The demo is a real git repo with a real test suite and a six-task queue seeded to hit every outcome: a task that lands, one where the agent escalates a decision, one skipped because its dependency didn't finish, one where the agent claims success and the verify gate catches it, and one that touches a forbidden path. `--dry-run` stubs every agent call, so the whole loop runs for **$0**.

Then check the invariant yourself:

```bash
cd nightshift-demo
git log --oneline main..HEAD     # small, per-task commits
git log --oneline main           # untouched
```

Drop `--dry-run` to watch a real agent do the same six tasks.

---

## Install into your project

```bash
git clone https://github.com/cr7sucks/nightshift.git
cd nightshift
./install.sh /path/to/your-project
```

That vendors a single zero-dependency file (`nightshift.mjs`) into your repo, installs the three skills, and writes a starter config. Nothing to `npm install`, ever.

Then edit `nightshift.config.json` so the verify commands are **your** project's:

```json
{
  "verify": {
    "typecheck": "npm run typecheck",
    "test": "npm test",
    "build": "npm run build"
  },
  "caps": {
    "wall_clock_hours": 8,
    "total_budget_usd": 40,
    "per_task_budget_usd": 3,
    "max_consecutive_failures": 3
  }
}
```

**These commands are the whole safety model.** nightshift is exactly as trustworthy as they are strict. A project with no tests gets no protection — the runner has nothing to check the agent against.

---

## The three skills

| Skill | When | What it does |
|---|---|---|
| `/night-plan` | Evening | Interviews you, then writes `NIGHT_PLAN.md`. Refuses to queue work that can't be automatically verified. |
| `night-task` | Automatic | The worker contract. Loaded by the runner as the system prompt for every task. |
| `/morning-report` | Morning | Reads the actual diff with you and gives a verdict — not a recap. |

`/night-plan` is where the leverage is. The runner's guardrails stop bad work from being committed; they can't turn a vague queue into good work. Ten minutes there beats an hour of morning cleanup.

---

## Writing a good queue

Every task needs a command that **fails when the task isn't done**. That's the bar. If you can't write one, it isn't a nightshift task.

```markdown
## T003 — Add pagination to GET /api/orders

- status: pending
- depends_on: T001
- verify: npm test -- orders
- files_likely: src/api/orders.ts, src/api/orders.test.ts

**Acceptance**
- `GET /api/orders?page=2&limit=20` returns at most 20 items plus a `total` count
- Requests with no page/limit behave exactly as before (no breaking change)
- New tests cover page 1, a middle page, and past-the-end

**Notes**
Follow the cursor pattern already used in `src/api/users.ts`.
Do not change the response envelope — three clients depend on its shape.
```

| Don't queue | Why it fails overnight |
|---|---|
| "Refactor the auth module" | No definition of done. The agent makes *a* change and calls it done. |
| "Improve performance" | Unverifiable. Add the benchmark as its own task first. |
| "Fix all the TODOs" | Unbounded, and TODOs usually encode decisions you should make. |
| "Migrate to the new API" | Too big for one commit. Split it per call site. |
| "Update the docs" | Nothing fails when it's done badly. |

Write acceptance criteria as observable behaviour, not implementation instructions. "Returns at most 20 items plus a total" is checkable. "Use a LIMIT clause" is you doing the agent's job, badly, at 2am.

---

## Commands

```bash
node nightshift.mjs preflight     # safety checks only, changes nothing
node nightshift.mjs run --dry-run # full loop, stubbed agent, $0
node nightshift.mjs run           # the real thing
node nightshift.mjs status        # current queue state
node nightshift.mjs demo          # create the sandbox project
```

Exit codes: `0` everything landed · `1` refused to start · `2` finished with blocked tasks · `3` a cap or the circuit breaker stopped the run early.

## Preflight refuses to start when

- the working tree is dirty (your changes would get swept into agent commits)
- **the baseline is red** — if tests already fail, every task tonight gets blamed for it
- the agent is unreachable (auth check runs *before* the queue, not during it)
- a task has no acceptance criteria, or `depends_on` points at a task that doesn't exist
- the config has no verify commands at all

Nothing is modified when preflight fails.

---

## What it deliberately doesn't do

- **Never pushes.** No remotes, no PRs, no CI triggers. Work stays local on a branch.
- **Never touches your base branch.** It checks out a new one and reports the exact diff command.
- **Never merges.** Reviewing and merging is yours.
- **Doesn't retry failed tasks.** A task that failed once usually needs a better spec, not another attempt at the same words.
- **Doesn't resume a crashed run.** Blocked and completed tasks are recorded in the plan file, so re-running picks up what's still pending.

## Requirements

Node 18+ · git · Claude Code CLI, logged in. No npm dependencies.

## Docs

- [ANATOMY.md](docs/ANATOMY.md) — how the loop works and why each guardrail exists
- [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — when a night goes wrong

## License

MIT
