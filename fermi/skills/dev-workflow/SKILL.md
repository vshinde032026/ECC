---
name: dev-workflow
description: End-to-end feature pipeline for an individual contributor on StudyTools v2 (SuperStem/Capacity). Input is usually a mind-dump md file (current-state analysis, desired outcome, end goal, maybe LLD sketches); output is reviewed, planned, implemented, tested code. Use when asked to "here's my mind dump", "build feature X", "spec this out and build it", "start dev workflow", "new feature end to end". NOT for bug investigation, perf work, or verifying just-written code — use debug-workflow for those.
triggers:
  - mind dump
  - build feature
  - spec this out and build it
  - start dev workflow
  - new feature end to end
  - dev-workflow
---

# Dev Workflow (fermi edition)

Structured end-to-end workflow for an individual contributor shipping a feature:

```
MIND DUMP → INTAKE → STUDY → SPEC ─[CEO COUNCIL gate]→ PLAN ─[ENG REVIEW gate]→ CODE → CLOSE-OUT → SBET → ship
```

Before advising, running commands, or editing files for this workflow, read
`references/workflow.md` and follow it as the primary workflow for this skill.
Adapted for StudyTools v2 (SuperStem/Capacity) from the global `dev-workflow` skill.

## Fermi machinery (agent + graph + workflow)

The pipeline is decomposed into reusable unit blocks; the human gates are never automated:

- **`agents/fermi-feature-dev.md`** — the modular unit carrying this skill. Executes ONE
  bounded assignment per invocation: study a surface, draft a spec/plan doc, implement a
  locked-plan task with TDD, or run a close-out check on a module. It never crosses a
  human gate on its own.
- **`graphs/dev-pipeline.md`** — the pipeline as a DAG: every phase is a node
  (`auto` | `gate` | `manual`) with `deps`; profiles select reusable sub-graphs
  (`feature` = full pipeline, `bugfix` = no spec/CEO gate, `closeout` = tail only,
  `closeout-deep` = tail + hunters, `study` = map only). Self-contained: every auto
  node runs a fermi agent — `fermi-feature-dev` for editing/drafting nodes (study,
  spec-draft, plan-draft, layering, unit-tests, docs), `fermi-code-reviewer` for every
  report-only node (plan-review's schema/security/type-design lenses, test-quality,
  the opt-in hunters) — its toolset has no Edit, so read-only is structural.
  `unit-tests` ∥ `console-logs` (∥ opt-in hunters) share a wave after `layering`;
  `test-quality` ∥ `docs` share the next.
- **`workflows/dev-pipeline.workflow.js`** — the runner. Executes ready `auto` nodes in
  parallel waves; on reaching a `gate`/`manual` node it HALTS and returns the human-step
  instruction plus resume args (`done: [...]`). The main session runs the gate with the
  user, then re-invokes to continue. `plan-review` pre-chews the eng gate with read-only
  specialist findings; the `console-logs` node delegates to the `audit-backend-logging`
  workflow (which drives `fermi-logging-auditor` + the `backend-logging` skill) as a
  child; the `docs` node automates close-out items 4–5 (feature docs + module
  CLAUDE.md).

## External dependencies (assumed installed, not vendored)

This skill deliberately delegates to plugins that are always present in our setups —
do not inline or copy their skills into fermi:

- **gstack**: `/plan-ceo-review` (spec gate), `/plan-eng-review` (plan gate),
  `/browse` (SBET driving).
- **superpowers**: `writing-plans`, `executing-plans`, `subagent-driven-development`,
  `using-git-worktrees`, `requesting-code-review`, `test-driven-development`.

## Related skills

- Bug with unknown root cause, latency work, or validating just-written code →
  `debug-workflow` — Workflows A/B/C/D there. Phase 8 (SBET) here borrows its
  tap/ingest/checker tooling from debug-workflow D.
- Logging close-out → fermi `backend-logging` skill / `audit-backend-logging` workflow.
