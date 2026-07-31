# Night Plan

<!--
  This file is empty on purpose. Build tonight's queue by running Claude Code in this
  repo and using the /night-plan skill — it interviews you, checks each task is
  actually verifiable, and writes them here in the format below.

  You can also write tasks by hand. Copy the example, delete the comment markers.

  YOU own:    the task list, titles, acceptance criteria, verify, files_likely, notes.
  The RUNNER owns: status, commit, blocked_reason, cost_usd, attempts.
              Don't hand-edit those — they get rewritten during the run.

  ---------------------------------------------------------------------------
  FORMAT

  ## T001 — Short imperative title

  - status: pending
  - depends_on: —
  - verify: npm test -- path/to/relevant.test.ts
  - files_likely: src/thing.ts, src/thing.test.ts

  **Acceptance**
  - A specific, checkable statement about observable behaviour
  - Another one, including what must NOT change

  **Notes**
  Context the agent can't infer from the code: which existing pattern to follow,
  why the obvious approach is wrong, what you already tried.

  ## T002 — A task that builds on the first

  - status: pending
  - depends_on: T001
  - verify: npm test

  **Acceptance**
  - Something that is only true once T001 landed

  **Notes**
  If T001 is blocked, this is skipped automatically rather than being built on sand.

  ---------------------------------------------------------------------------
  TASK SIZING IS THE WHOLE GAME

  A good task is one commit's worth of work with a yes/no acceptance test.

  Every task needs a command that FAILS when the task isn't done. If you can't write
  one, it isn't a nightshift task — it's a research question. Do those yourself in
  the morning.

  Write acceptance criteria as observable behaviour, not implementation instructions.
  "Returns at most 20 items plus a total count" is checkable.
  "Use a LIMIT clause" is you doing the agent's job, badly, at 2am.

  Front-load what matters most. Runs hit caps; the tail of the queue is the part
  that doesn't happen.
-->
