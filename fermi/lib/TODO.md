# lib/ — TODO (Stage 3, not yet)

Shared JS helpers. **Empty — and possibly not needed for Workflow-tool loops.**

## Important finding (2026-07-28)

The Claude Code **Workflow tool runs `.workflow.js` scripts in a sandbox with no
filesystem/module access** — a workflow CANNOT `require()` anything in this folder. So the
loop/graph logic must live **inline** in each workflow script (see
`../workflows/refactor-module.workflow.js`, which inlines its refine-with-critic loop).

This `lib/` is therefore only useful for a **non-Workflow-tool runner** (e.g. a plain Node
script driving agents via the Agent SDK). Build it only if we go that route. Until then,
the reusable patterns are documented copy-paste snippets in `../loops/`, not imported code.

These are the reusable engines. Everything in `graphs/`, `loops/`, and `workflows/`
builds on what lives here. Built on the Claude Code Workflow tool primitives
(`agent()`, `parallel()`, `pipeline()`), so we get concurrency capping,
structured-output validation, and resumability for free.

## Planned modules

### `graph-runner.js`
Takes a declarative DAG (nodes with `dependsOn`) and executes it: topological sort,
run independent nodes with `parallel()`, thread each node's result to its dependents.

```js
// runGraph(graph, { agentFor }) -> { [nodeId]: result }
// graph: { scan: { run }, impl: { dependsOn: ["scan"], run }, ... }
```

### `loop-runner.js`
Reusable iteration patterns so workflows don't hand-roll `while` loops each time:
- `loopUntil(fn, done, { max })` — repeat until `done(result)` or `max` reached.
- `refineWithCritic(make, critique, fix, { max })` — draft -> critique -> fix cycle.
- `pollUntil(check, { intervalMs, max })` — poll external state.
- `boundedRetry(fn, { attempts })` — retry with a hard cap.

## Checklist

- [ ] `graph-runner.js` with topological execution + parallel independent nodes.
- [ ] `loop-runner.js` with the four patterns above.
- [ ] Cycle detection in the graph runner (fail closed on a bad DAG).
- [ ] Each helper has a matching test in `../tests/` (see node.md rules: new `lib/`
      code requires a matching test).
- [ ] Keep modules small and single-purpose (CommonJS, per repo rules).
