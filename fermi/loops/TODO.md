# loops/ — TODO

## Built

- ✅ **refactor-module** — see [`refactor-module.md`](refactor-module.md) +
  [`../workflows/refactor-module.workflow.js`](../workflows/refactor-module.workflow.js).
  Refine-with-critic loop: refactor a module unit by unit (simplify → review → fix, bounded
  passes), then verify. Drives `ecc:*` agents.


Reusable iteration patterns — the "keep going until it's right" primitive. A loop repeats
an agent pass until a condition holds. The generic mechanics live in
`../lib/loop-runner.js`; this folder holds named, ready-to-use configurations of them.

## Patterns

- **loop-until-done** — repeat a pass until the result reports completion (or a max).
- **refine-with-critic** — draft, then critique -> fix -> re-critique until clean.
- **poll-until** — re-check external state on an interval until a condition (CI, deploy).
- **bounded-retry** — retry a flaky step with a hard attempt cap.

## Example (what a workflow consumes)

```js
const { refineWithCritic } = require("../lib/loop-runner");
const final = await refineWithCritic(
  () => agent("Write the function"),
  (draft) => agent(`Find problems in: ${draft}`, { schema: CRITIQUE }),
  (issues) => agent(`Fix these: ${issues}`),
  { max: 3 }
);
```

## Checklist

- [ ] Confirm the four patterns cover our real needs before adding more (YAGNI).
- [ ] Each pattern has a hard iteration cap — never an unbounded loop.
- [ ] Each pattern is covered by a test in `../tests/`.
- [ ] Document, per pattern, what "done" means and what happens when the cap is hit.
