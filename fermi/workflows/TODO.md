# workflows/ — TODO

## Built

- ✅ **refactor-module.workflow.js** — Map (code-explorer) → Refactor per unit with a
  bounded refine-with-critic loop (code-simplifier + reviewers) → Verify (build-error-resolver).
  Self-contained (loop inlined — the Workflow sandbox can't import `../lib/`). Parses clean,
  plugin validates. Docs: [`../loops/refactor-module.md`](../loops/refactor-module.md).


`.workflow.js` scripts for the Claude Code Workflow tool — the **runnable** entry points
that spawn many project-aware agents deterministically. A workflow reads a graph from
`../graphs/`, applies loops from `../loops/`, and orchestrates the agents.

Reference implementation to copy the shape from:
[`../../workflows/orch-review.workflow.js`](../../workflows/orch-review.workflow.js).

## Anatomy

```js
export const meta = {
  name: "fermi-review",
  description: "Fan out project-aware reviewers, then verify findings.",
  phases: [{ title: "Review" }, { title: "Verify" }],
};

const findings = await parallel(reviewers.map(r => () =>
  agent(r.prompt, { schema: FINDINGS, phase: "Review" })
));
// dedup, then verify each blocking finding...
```

## Checklist

- [ ] First workflow — likely `fermi-review` (fan-out review) or `fermi-feature` (build).
- [ ] Wire it to a graph in `../graphs/` and, where useful, a loop from `../loops/`.
- [ ] Use `schema:` for structured agent output (validated, no manual parsing).
- [ ] Fail closed on invalid input (mirror `orch-review`'s gate behavior).
- [ ] Add a matching `../commands/` trigger so a human can launch it.
- [ ] Document the args contract and the return shape at the top of the file.
