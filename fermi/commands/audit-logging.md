---
description: Sweep the backend-logging auditor over a backend service or module set — audit → fix → re-audit per module until logs conform to the SuperStem/Fermi logging standard. Covers routes AND services/agents/tasks by default. Usage /fermi:audit-logging <service-root | dir | file.py ...> [routes] [maxPasses]
---

# Audit backend logging

Launch the fermi logging sweep on: **$ARGUMENTS**

## Steps

1. **Parse the arguments.**
   - A path ending in `.py` (one or more) → pass as `modules: [...]`.
   - A directory path → pass as `dir: "<path>"`. A service root (e.g. `euler-api`
     or `euler-api/app`) is valid — discovery finds every module with logic worth
     logging: routes, websocket handlers, service layer, agents, Celery tasks,
     external-system clients. Tests/schemas/config/`__init__` are excluded.
   - The bare word `routes` → pass `scope: "routes"` (route/ws handler modules only).
   - A bare integer (1–4) anywhere → `maxPasses` (default 2).
   - No arguments → ask which service or files to audit; suggest what you can
     see (e.g. `backend/app`, `euler-api/app`).

2. **Safety gate.** Run `git branch --show-current`. If on `main`/`master`, STOP
   and tell the user to create a branch first — this sweep edits source files
   (log statements only, but it must be reviewable). Do not proceed on main.

3. **Warn on big sweeps.** If a `dir` was given, count its `.py` files first;
   over 30, tell the user the expected scale (roughly 3–5 agent runs per file)
   and confirm before launching.

4. **Launch** the Workflow tool. `args` MUST be a real JSON object — never a
   prose string, never pseudo-code. Correct calls look exactly like these:

   ```
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/audit-backend-logging.workflow.js",
     args: { "dir": "euler-api/app" }
   })
   ```

   ```
   args: { "modules": ["backend/app/routers/notebook.py"], "maxPasses": 3 }
   ```

   ```
   args: { "dir": "backend/app", "scope": "routes" }
   ```

5. **When it completes, report:** the clean/dirty count, per-module verdicts,
   every `remaining[]` item (`file:line` + issue) that needs a human decision,
   and remind the user to review `git diff` before committing. If any touched
   file appears in `REDUNDANCY_REGISTRY.md`, call out its twins explicitly.
