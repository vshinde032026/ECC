---
description: Sweep the backend-logging auditor over FastAPI route modules — audit → fix → re-audit per module until logs conform to the SuperStem/Fermi logging standard. Usage /fermi:audit-logging <routers-dir | file.py ...> [maxPasses]
---

# Audit backend logging

Launch the fermi logging sweep on: **$ARGUMENTS**

## Steps

1. **Parse the arguments.**
   - A path ending in `.py` (one or more) → pass as `modules: [...]`.
   - A directory path → pass as `dir: "<path>"` (the workflow discovers route files in it).
   - A bare integer (1–4) anywhere → `maxPasses` (default 2).
   - No arguments → ask which routers directory or files to audit; suggest the
     repo's routers dirs you can see (e.g. `backend/app/routers`,
     `euler-backend/app/api/routes`).

2. **Safety gate.** Run `git branch --show-current`. If on `main`/`master`, STOP
   and tell the user to create a branch first — this sweep edits source files
   (log statements only, but it must be reviewable). Do not proceed on main.

3. **Warn on big sweeps.** If a `dir` was given, count its `.py` files first;
   over 30, tell the user the expected scale (roughly 3–5 agent runs per file)
   and confirm before launching.

4. **Launch** the Workflow tool:

   ```
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/audit-backend-logging.workflow.js",
     args: { dir | modules, maxPasses }
   })
   ```

5. **When it completes, report:** the clean/dirty count, per-module verdicts,
   every `remaining[]` item (`file:line` + issue) that needs a human decision,
   and remind the user to review `git diff` before committing. If any touched
   file appears in `REDUNDANCY_REGISTRY.md`, call out its twins explicitly.
