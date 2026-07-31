---
name: morning-report
description: Use the morning after a nightshift run to review the branch with a human — triage what landed, surface the agent's questions, and decide what to merge, redo, or drop.
---

# Reviewing a night run

The runner already wrote `NIGHT_REPORT.md` mechanically. Your job is the part it can't
do: **read the actual diff and tell the human what's really there.**

The report says what the runner observed. It does not say whether the code is any good.

## Process

### 1. Read the ground truth, not the summary

```bash
git log --oneline <base>..HEAD      # base commit is in NIGHT_REPORT.md
git diff <base>..HEAD --stat
```

Then read the actual diffs, commit by commit. The agent's own summaries are in the
report — treat them as claims to check, not as the record. Every commit passed the
verify gates, so you're not looking for "does it work." You're looking for:

- **Does it work for the right reason?** Tests can pass on a coincidence.
- **Did it weaken a test to make it pass?** Check test diffs with suspicion — a passing
  suite where an assertion got softer is the single most common way verified work is
  still bad work.
- **Does it fit the codebase?** Foreign-looking code is a maintenance cost the gates
  can't see.
- **Is anything scoped wider than its task?** Drift shows up as files nobody expected.

### 2. Lead with the questions

Blocked tasks with a `blocker_question` are the highest-value output of the night — the
agent hit a real decision and stopped instead of guessing. Put these first. Each one the
human answers in a sentence becomes a task for tonight's queue.

### 3. Triage the blocked tasks

For each, work out which it is:

- **Bad task spec** — acceptance criteria were ambiguous or wrong. Rewrite and requeue.
- **Genuine blocker** — needs the human's decision. Get the answer, requeue with it in
  Notes.
- **Real bug found** — the task was fine and it surfaced a pre-existing problem. That's
  a finding; log it.
- **Too big** — split it.

Note that blocked tasks left nothing on the branch. The runner reset them. There is no
half-finished work to clean up.

### 4. Give a verdict, not a summary

End with a clear recommendation:

- what to merge as-is
- what to merge after specific fixes (name them)
- what to throw away and why
- what tonight's queue should be

Say plainly if the night was unproductive. "Three of five landed but two of them are
thin" is more useful than a tidy recap. If the run stopped early, find out why in
`NIGHT_REPORT.md` — a budget cap and a circuit breaker mean very different things.

### 5. Offer to close the loop

Once the human decides, offer to:

- merge the branch (never do this unasked)
- write tonight's `NIGHT_PLAN.md` using the `night-plan` skill, seeded with the answers
  to the blocker questions and any tasks that need requeueing

## What to be suspicious of

- A task that passed with a suspiciously small diff
- New tests that assert almost nothing (`expect(result).toBeDefined()`)
- Existing assertions that got looser
- `any` types, swallowed exceptions, or `catch {}` blocks that appeared overnight
- Anything touching files that no task's `files_likely` predicted
- A task that "passed" because the relevant test never actually ran
