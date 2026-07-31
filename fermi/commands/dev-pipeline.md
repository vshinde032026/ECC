---
description: Run the graph-driven dev-workflow pipeline (study / bugfix / feature / closeout / closeout-deep). Usage /fermi:dev-pipeline <profile> [paths...] — gates halt back to you; see the dev-workflow skill for the full pipeline.
---

# Dev pipeline

Run the fermi dev-pipeline graph with: **$ARGUMENTS**

## Steps

1. **Parse the arguments.** First token is the profile: `study`, `bugfix`,
   `feature`, `closeout`, or `closeout-deep`. Remaining tokens are paths/context.
   Then assemble the args the selected nodes need (ask for what's missing
   rather than guessing — see the node-inputs table in
   `${CLAUDE_PLUGIN_ROOT}/graphs/dev-pipeline.md`):
   - `study` / `feature` / `bugfix` → `feature` (description), optionally
     `intakePath` (mind-dump md) and `scopeIn[]`.
   - `feature` also → `specPath` + `planPath`; `bugfix` → `planPath`
     (dated paths under `docs/superpowers/specs|plans/`, today's date).
   - `closeout` / `closeout-deep` → `backendModules[]` and/or
     `frontendModules[]` (the touched modules), plus `feature` for the docs
     node; optionally `planPath`.

2. **Safety gate.** Profiles that edit the tree (`closeout*`, resumed
   `feature`/`bugfix` past the code node) must run on a branch — check
   `git branch --show-current` and stop if on `main`/`master`. `study` is
   read-only and safe anywhere.

3. **Launch:**

   ```
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/dev-pipeline.workflow.js",
     args: { profile, ...gathered args }
   })
   ```

4. **On halt** (`status: 'halted'`): the pipeline reached a human gate. Present
   `results` so far and the `instruction` verbatim, run that step WITH the user
   (never auto-approve a gate), then re-invoke with the same `scriptPath` and
   the returned `resume` args merged into the original args.

5. **On complete:** present the per-node results (touchpoint table for study;
   layering/tests/logs/test-quality/docs stats for closeout) and remind the
   user to review `git diff` if anything edited the tree.
