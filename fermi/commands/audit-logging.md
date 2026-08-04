---
description: Flow-based logging sweep — per router, backtrack every route through the service functions to the data layer, judge where logs are required along each chain, apply them per file, verify a sample of routes. Usage /fermi:audit-logging <service-root | router-file.py ...>
---

# Audit backend logging

Launch the fermi flow-based logging sweep on: **$ARGUMENTS**

How it works: **Map** entry points (routers + non-routed Celery tasks) → **Trace**
each entry's routes down through services to the data layer, read-only, judging
where logs are REQUIRED along each chain and what's redundant across layers →
**Apply** the merged per-file gap list (each file edited by exactly one agent) →
**Verify** by independently re-tracing a sample of routes.

## Steps

1. **Parse the arguments.**
   - A service root or directory → `dir: "<path>"` (e.g. `euler-api/app`) —
     entry points are discovered.
   - One or more `.py` paths → `modules: [...]` — treated as entry-point
     modules (router/task files) to trace; their chains are followed wherever
     they lead, so service files don't need listing.
   - No arguments → ask which service or routers to sweep; suggest what you
     can see (e.g. `backend/app`, `euler-api/app`).

2. **Safety gate.** Run `git branch --show-current`. If on `main`/`master`, STOP
   and tell the user to create a branch first — this sweep edits source files
   (log statements only, but it must be reviewable). Do not proceed on main.

3. **State the expected scale.** Count the router/task modules first and tell
   the user the agent estimate before launching: roughly **1 map + 1 trace
   agent per 3 entry modules + 1 apply agent per 8 gap-carrying files + up to
   3 verify agents** (a 14-router service ≈ 12 agents; a 96-router service
   ≈ 45–50). Over 30 entry modules, confirm before launching. Optional
   tuning: `"traceBatch": 1–6`, `"applyBatch": 3–15`, `"verify": "none"`.

4. **Launch** the Workflow tool. `args` MUST be a real JSON object — never a
   prose string, never pseudo-code. Correct calls look exactly like these:

   ```
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/audit-backend-logging.workflow.js",
     args: { "dir": "euler-api/app" }
   })
   ```

   ```
   args: { "modules": ["backend/app/routers/notebook.py", "backend/app/routers/courses.py"] }
   ```

   ```
   args: { "dir": "backend/app", "traceBatch": 2, "verify": "none" }
   ```

5. **When it completes, report:** the clean/dirty count, per-module verdicts,
   every `remaining[]` item (`file:line` + issue) that needs a human decision,
   and remind the user to review `git diff` before committing. If any touched
   file appears in `REDUNDANCY_REGISTRY.md`, call out its twins explicitly.
