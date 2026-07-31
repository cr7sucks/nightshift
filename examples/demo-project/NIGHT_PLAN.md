# Night Plan — demo

<!--
  This queue is seeded to exercise every path through the runner.

  The `dryrun:` field steers the stub agent during `--dry-run` so you can watch all
  five outcomes without spending anything. It is ignored during a real run, where
  these are all genuine tasks an agent can actually do.

  Expected dry-run outcome:
    T001 done      — happy path, commits
    T002 blocked   — agent escalates a decision instead of guessing
    T003 skipped   — its dependency (T002) never completed
    T004 blocked   — agent claimed done, the runner's verify gate disagreed, reverted
    T005 done      — recovery after failures; consecutive-failure counter resets
    T006 blocked   — touched a forbidden path, whole task reverted
-->

## T001 — Add removeItem() to the cart module

- status: pending
- depends_on: —
- verify: npm test
- files_likely: src/cart.js, test/cart.test.js
- dryrun: ok

**Acceptance**
- `removeItem(cart, sku)` removes the matching line entirely and returns the cart
- Removing a sku that isn't present leaves the cart unchanged and does not throw
- New tests cover both cases
- All existing tests still pass

**Notes**
Match the style of the existing exports in `src/cart.js` — plain functions taking the
cart as the first argument and returning it, no classes.

## T002 — Decide and document how negative quantities are handled

- status: pending
- depends_on: —
- verify: npm test
- files_likely: src/cart.js
- dryrun: blocked

**Acceptance**
- `addItem` has a defined, tested behaviour for `qty` less than 1

**Notes**
There are three defensible answers here and they are not equivalent: throw a TypeError,
clamp silently to 1, or treat a negative qty as a removal. Which one is right depends on
how the caller uses it, which isn't in this repo. This is a genuine product decision —
escalate it rather than picking one.

## T003 — Enforce the quantity rule decided in T002

- status: pending
- depends_on: T002
- verify: npm test
- files_likely: src/cart.js, test/cart.test.js
- dryrun: ok

**Acceptance**
- The behaviour decided in T002 is implemented and covered by tests

**Notes**
Deliberately depends on T002. If T002 is unresolved this is skipped rather than run
against a guess — that's the point.

## T004 — Add applyDiscount() for percentage codes

- status: pending
- depends_on: —
- verify: npm test
- files_likely: src/cart.js, test/cart.test.js
- dryrun: fail_verify

**Acceptance**
- `applyDiscount(cart, 'SAVE10')` reduces `total(cart)` by exactly 10%
- An unknown code throws
- Discounts do not mutate the underlying item prices
- New tests cover all three

**Notes**
Keep the code table a module-level constant for now; wiring it to a data source is a
separate task.

## T005 — Add itemCount() returning total units in the cart

- status: pending
- depends_on: —
- verify: npm test
- files_likely: src/cart.js, test/cart.test.js
- dryrun: ok

**Acceptance**
- `itemCount(cart)` returns the sum of every line's `qty`, not the number of lines
- An empty cart returns 0
- Tests cover an empty cart and a cart with multiple lines of differing quantity

## T006 — Add a formatMoney() helper

- status: pending
- depends_on: —
- verify: npm test
- files_likely: src/cart.js, test/cart.test.js
- dryrun: forbidden

**Acceptance**
- `formatMoney(30)` returns `"$30.00"`
- Rounds to exactly two decimal places
- Tests cover a whole number, a value needing rounding, and zero
