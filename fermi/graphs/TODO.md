# graphs/ — TODO (Stage 3, not yet)

Declarative DAG definitions. A graph is **data**: nodes are agent steps, edges are
`dependsOn`. It says *what* to do and in *what order* — nothing about how to run it.
The `../lib/graph-runner.js` reads a graph and does the actual running (parallelizing
independent nodes automatically).

Graph = the map. Workflow = the vehicle that drives the map.

## Planned shape

```js
// graphs/feature-build.graph.js
module.exports = {
  scan:   { run: "Map the module and its dependencies" },
  tests:  { dependsOn: ["scan"],          run: "Write failing tests" },
  impl:   { dependsOn: ["scan"],          run: "Implement to pass tests" },
  verify: { dependsOn: ["tests", "impl"], run: "Run tests and report" },
};
// scan runs first; tests + impl run in parallel; verify waits for both.
```

## Checklist

- [ ] Define the graph schema (node id -> `{ dependsOn?, run, agent? }`).
- [ ] First real graph — likely `feature-build` or `review-fan-out`.
- [ ] Each node names which project-aware agent runs it (defaults to a generic type
      when self-contained, per the "self-contained fermi" decision).
- [ ] Keep graphs declarative — no control flow here; that lives in `../loops/` and the runner.
