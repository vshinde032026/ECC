# workflows/ — TODO

## Built

- ✅ **dev-pipeline.workflow.js** — the dev-workflow pipeline as a graph runner. Nodes
  are unit blocks with `deps`, self-contained on fermi agents: `fermi-feature-dev` for
  editing/drafting nodes, `fermi-code-reviewer` for every report-only node (plan-review
  lenses, test-quality, opt-in silent-failure + security hunters). Profiles pick
  sub-graphs (`feature`, `bugfix` — no spec/CEO gate, `closeout`, `closeout-deep`,
  `study`). Auto nodes run in parallel waves; gate/manual nodes HALT with resume
  instructions — humans keep the gates. `console-logs` delegates to
  `audit-backend-logging` as a child workflow. Graph doc:
  [`../graphs/dev-pipeline.md`](../graphs/dev-pipeline.md). Pairs with the `dev-workflow`
  skill + agent.
- ✅ **audit-backend-logging.workflow.js** — sweeps `fermi-logging-auditor` across FastAPI
  route modules; per module a bounded audit → fix → re-audit loop to conform to the
  SuperStem/Fermi logging-platform standard (constant message + `extra{}`, platform-injected
  fields not hand-rolled, errors to Sentry via `logger.exception`). Modules run in parallel
  (distinct files). Pairs with the `backend-logging` skill + agent.
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
