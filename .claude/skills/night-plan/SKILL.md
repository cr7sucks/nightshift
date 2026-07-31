---
name: night-plan
description: Use before an unattended overnight run to turn project goals into a verified NIGHT_PLAN.md task queue. Interviews the human, sizes tasks to one commit each, and refuses to queue work that can't be automatically verified.
---

# Writing a night plan

Your job is to produce `NIGHT_PLAN.md`: an ordered queue of tasks an unattended agent
can work through overnight without a human present.

**The plan is where overnight runs are won or lost.** The runner's guardrails stop bad
work from being committed; they cannot turn a vague queue into good work. A night spent
on five well-specified tasks beats a night spent on twenty vague ones, every time.

Take 10 minutes on this. It's the human's last chance to steer.

## Process

### 1. Understand the project before asking anything

Read the README, the package/build config, the test setup, and recent git history.
Identify the actual verify commands — don't guess them, find them and confirm they exist.
Note the dominant patterns (how tests are written, how errors are handled, how modules
are structured) so tasks can point at them.

### 2. Interview the human — one question at a time

Ask, in roughly this order:

- What do you want to be true when you wake up?
- What's the current state — what's already working, what's half-built?
- What's off-limits tonight? (files, subsystems, anything mid-refactor)
- Are there decisions you'd rather make yourself than have an agent guess?
- Roughly how much are you willing to spend?

Push back on scope. "Finish the payments integration" is not a night plan. Find the
subset that's mechanical enough to run unattended.

### 3. Decompose into tasks

Each task must be:

- **One commit's worth of work.** If the diff would be hard to review in five minutes,
  split it.
- **Independently verifiable.** There must be a command that returns non-zero when the
  task isn't done. Usually a test — often a test the task itself has to write.
- **Self-contained.** Each task runs in a fresh session with no memory of the others.
  Everything needed must be in the task spec or discoverable in the repo.
- **Ordered by dependency,** using `depends_on`. If a foundation task is blocked, its
  dependents are skipped automatically instead of building on sand.

Front-load the tasks you most want done. Runs hit caps; the queue tail is the part that
doesn't happen.

### 4. Apply the verifiability test — this is the important one

For every task, ask: **what command fails if this isn't done?**

If there is no such command, the task does not belong in the queue. Choose one:

- **Reshape it** so there is one — most often "write a failing test for X, then make it
  pass" instead of "improve X".
- **Split it** — the mechanical half goes in the queue, the judgement half waits for the
  human.
- **Drop it** and tell the human it's morning work.

Tasks that fail this test and get queued anyway are how people wake up to a branch full
of confident-looking, unverified changes. Be strict here even when the human pushes.

### 5. Write the file

Follow `templates/NIGHT_PLAN.md` exactly — the runner parses this format:

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
Follow the cursor pattern already used in `src/api/users.ts` (lines 40-80).
Do not change the response envelope — three clients depend on its current shape.
```

Write acceptance criteria as **observable behaviour**, not implementation instructions.
"Returns at most 20 items plus a total count" is checkable. "Use a LIMIT clause" is you
doing the agent's job and being wrong about it at 2am.

Use **Notes** for what the agent cannot infer: which existing pattern to copy, why the
obvious approach is wrong, what you already tried and why it failed.

### 6. Hand back for approval

Show the human the queue and say plainly:

- how many tasks, and the rough order they'll run in
- which ones you're least confident about
- anything you dropped for being unverifiable, and why
- what to run next: `nightshift preflight`, then `nightshift run --dry-run`, then
  `nightshift run`

Do not start the run yourself. The human approves the queue and starts it.

## Anti-patterns

| In the queue | Why it fails overnight |
|---|---|
| "Refactor the auth module" | No definition of done. The agent will make *a* change and call it done. |
| "Improve performance" | Unverifiable without a benchmark. Add the benchmark as its own task first. |
| "Fix all the TODOs" | Unbounded, and TODOs usually encode decisions the human should make. |
| "Migrate to the new API" | Too big for one commit. Split per call site, one task each. |
| "Update the docs" | Nothing fails when it's done badly. Fine for humans, useless as a gate. |
| Tasks with no `depends_on` that clearly depend on each other | They'll run in a fresh session each and conflict. |
