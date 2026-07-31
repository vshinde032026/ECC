# graph: dev-pipeline

The dev-workflow feature pipeline as a reusable DAG, executed by
[`../workflows/dev-pipeline.workflow.js`](../workflows/dev-pipeline.workflow.js).
The graph is **inlined** in the workflow (the Workflow sandbox can't `require()`
this folder) — this file is the canonical map; keep the two in sync.

## The graph

```
                    ┌─────────┐
                    │  study  │ auto · feature-dev (STUDY) · 3 parallel sweeps
                    └────┬────┘
                    ┌────▼───────┐
                    │ spec-draft │ auto · feature-dev (DRAFT)
                    └────┬───────┘
                    ┌────▼─────┐
                    │ ceo-gate │ GATE · gstack /plan-ceo-review with the user
                    └────┬─────┘
                    ┌────▼───────┐
                    │ plan-draft │ auto · feature-dev (DRAFT)
                    └────┬───────┘  (also deps: study — holds in bugfix)
                    ┌────▼────────┐
                    │ plan-review │ auto · code-reviewer × 3 lenses in ∥:
                    └────┬────────┘  schema prefs · auth surface ·
                         │           interface/type design
                    ┌────▼─────┐
                    │ eng-gate │ GATE · gstack /plan-eng-review with the user,
                    └────┬─────┘  armed with results['plan-review'] findings
                    ┌────▼────┐
                    │  code   │ MANUAL · superpowers:executing-plans, main session
                    └────┬────┘
                    ┌────▼─────┐
                    │ layering │ auto · feature-dev · per touched module, ∥
                    └────┬─────┘
       ┌──────────┬──────┴────────┬──────────────────┐
 ┌─────▼──────┐ ┌─▼────────────┐ ┌▼────────────────┐ ┌▼─────────────┐
 │ unit-tests │ │ console-logs │ │ silent-failures │ │   security   │
 │ feature-dev│ │ (child wf:   │ │ code-reviewer   │ │ code-reviewer│
 │            │ │ audit-backend│ │ OPT-IN · report │ │ OPT-IN ·     │
 │            │ │ -logging)    │ │ only            │ │ report only  │
 └─────┬──────┘ └─┬────────────┘ └─────────────────┘ └──────────────┘
       │          │        one wave: tests edit tests/**, logging edits
       │          │        source, hunters only report — no collisions
 ┌─────▼────────┐ │ ┌──────────┐
 │ test-quality │ │ │   docs   │  second wave, also parallel: test-quality
 │ code-reviewer│ │ │ feature- │  (reads tests/) ∥ docs (edits docs/** +
 │              │ │ │ dev      │  module CLAUDE.md — close-out items 4-5);
 └─────┬────────┘ │ └──┬───────┘  docs deps: layering + unit-tests +
       │          └────┤          console-logs (the three EDITORS)
       └──────┬────────┘
         ┌────▼────┐
         │  sbet   │ MANUAL · Phase 8 live system test, main session
         └─────────┘
```

**Self-contained:** every auto node runs a fermi agent — `fermi-feature-dev`
for editing/drafting work, `fermi-code-reviewer` for every report-only node
(its toolset has no Edit, so read-only is structural). No dependency on the
ecc plugin; lens/hunt expertise is carried by the prompts.

## Node kinds

| Kind | Who runs it | Runner behavior |
|--------|-------------------------------|-----------------|
| auto | the node's specialist agent (see graph) or a child workflow | executed in parallel waves when deps are done |
| gate | the user + main session (gstack review skills) | workflow **halts**, returns the instruction + resume args |
| manual | main session (superpowers execution / SBET) | same halt behavior as a gate |

Human decisions never happen inside the workflow — a gate is a boundary where
control returns to the main session, and the run resumes with
`done: [...completed, '<gate>']` after the human step.

`args.agentType` is a global override that replaces **every** node's specialist
default (escape hatch when fermi isn't installed); the rules are also
inlined in the prompts, so a generic agent still works.

## Profiles (reusable sub-graphs)

Deps outside the selection count as satisfied, so any sub-graph runs standalone.

| Profile | Nodes | Use for |
|---------|-------|---------|
| `feature` | the whole default graph (hunters excluded) | new feature / substantial change |
| `bugfix` | study → plan-draft → plan-review → eng-gate → code → closeout tail | bug fixes: no spec, no CEO gate |
| `closeout` | layering → (unit-tests ∥ console-logs) → (test-quality ∥ docs) | code written, close-out sweep |
| `closeout-deep` | closeout + silent-failures + security in the wave | riskier changes (auth, input handling, error paths) |
| `study` | study | touchpoint map only |

Pass `nodes: [...]` instead of a profile for anything custom — e.g. drop
`eng-gate` from bugfix for a trivial fix, or run `console-logs` alone.

## Node inputs (workflow args)

| Node | Requires | Notes |
|------|----------|-------|
| study | `feature` | `intakePath` + `scopeIn[]` optional but recommended |
| spec-draft | `feature`, `specPath` | caller supplies the dated path (`Date` is banned in the sandbox) |
| plan-draft | `planPath` | uses `specPath` when present; falls back to `feature`/intake for bugfix |
| plan-review | `planPath` | read-only; findings land in `results['plan-review']` for the eng gate |
| layering | `backendModules[]` and/or `frontendModules[]` | edits the tree — feature branch only |
| unit-tests | `backendModules[]` | bounded loop, touches `tests/**` only |
| console-logs | `backendModules[]` | delegates to `audit-backend-logging` as a child workflow |
| silent-failures | modules (either list) | opt-in, report-only |
| security | modules (either list) | opt-in, report-only |
| test-quality | `backendModules[]` | read-only; independent behavioral-coverage verdict per module |
| docs | `feature` + modules (either list) | edits documentation only |

## Extending

Add a node = one entry in the workflow's `NODES` (id → `{kind, deps, phase}`),
an implementation function for `auto` nodes (or an `instruction` string for
gate/manual), its specialist `agentType` in the implementation, and membership
in whichever `PROFILES` should include it. Mirror the change here. Report-only
nodes may share a wave with one editor; two editors of the same files never
share a wave.
