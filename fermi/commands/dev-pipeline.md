---
description: Run the graph-driven dev-workflow pipeline (study / bugfix / feature / closeout / closeout-deep). Usage /fermi:dev-pipeline <profile> [paths...] — gates halt back to you; see the dev-workflow skill for the full pipeline.
---

# Dev pipeline

Run the fermi dev-pipeline graph with: **$ARGUMENTS**

## Steps

1. **Parse the arguments.** If the first token is a profile (`study`, `bugfix`,
   `feature`, `closeout`, `closeout-deep`), use it; remaining tokens are
   paths/context. **Otherwise treat the whole input as free text and ROUTE it**
   per the Right-sizing table in the `dev-workflow` skill (mind dump → feature;
   supplied spec → custom nodes entering at plan-draft; known-cause bug →
   bugfix; unknown-cause bug → debug-workflow first; trivial fix → no pipeline,
   just fix it; written code → closeout; understanding only → study). State
   the chosen route and why in ONE line, get a yes, then proceed. Never
   escalate a small ask into the full pipeline. Then assemble the args the
   selected nodes need (ask for what's missing rather than guessing — see the
   node-inputs table in `${CLAUDE_PLUGIN_ROOT}/graphs/dev-pipeline.md`):
   - `study` / `feature` / `bugfix` → `feature` (description), optionally
     `intakePath` (mind-dump md) and `scopeIn[]`.
   - `feature` also → `specPath` + `planPath`; `bugfix` → `planPath`
     (dated paths under `docs/superpowers/specs|plans/`, today's date).
   - `closeout` / `closeout-deep` → `backendModules[]` and/or
     `frontendModules[]` (the touched modules), `serviceRoot` (the backend
     package dir, e.g. `"backend/app"` — the console-logs node's census needs
     it), plus `feature` for the docs node; optionally `planPath`.
   - ALWAYS pass `"pluginRoot": "${CLAUDE_PLUGIN_ROOT}"` — study agents use it
     to run the census script and the console-logs child workflow requires it.
   - Per-module nodes run BATCHED (one agent per ~8 modules, loops inside the
     agent) — never quote a one-agent-per-file estimate.

2. **Safety gate.** Profiles that edit the tree (`closeout*`, resumed
   `feature`/`bugfix` past the code node) must run on a branch — check
   `git branch --show-current` and stop if on `main`/`master`. `study` is
   read-only and safe anywhere.

3. **Launch.** `args` MUST be a real JSON object — never a prose string, never
   pseudo-code. A correct call looks exactly like this (with your values):

   ```
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/dev-pipeline.workflow.js",
     args: {
       "profile": "feature",
       "feature": "adaptive-bitrate video delivery",
       "intakePath": "docs/mind-dumps/2026-07-31-abr.md",
       "scopeIn": ["ladder generation in the video pipeline", "player quality selector"],
       "specPath": "docs/superpowers/specs/2026-07-31-abr.md",
       "planPath": "docs/superpowers/plans/2026-07-31-abr.md"
     }
   })
   ```

   Include only the keys the selected nodes need (closeout runs need
   `"backendModules": [...]` / `"frontendModules": [...]` instead of the
   spec/plan paths).

4. **On halt** (`status: 'halted'`): the pipeline reached a human gate. Present
   `results` so far and the `instruction` verbatim, run that step WITH the user
   (never auto-approve a gate), then re-invoke with the same `scriptPath` and
   the returned `resume` args merged into the original args.

5. **On complete:** present the per-node results (touchpoint table for study;
   layering/tests/logs/test-quality/docs stats for closeout) and remind the
   user to review `git diff` if anything edited the tree.
