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
   - A service root → `dir: "<path>"` (e.g. `euler-api/app`) — required.
   - One or more `.py` paths → additionally pass `entries: [...]` to restrict
     the judgment lane to those entry modules.
   - The bare word `mechanical` or `judgment` → `lanes` (default `both`).
     `mechanical` = lint-fix only (prints, getLogger, swallowed excepts,
     f-string logs) — the cheap first pass; `judgment` = flow tracing only.
   - ALWAYS pass `"pluginRoot": "${CLAUDE_PLUGIN_ROOT}"` so agents can run
     the census script.
   - No arguments → ask which service to sweep; suggest what you can see
     (e.g. `backend/app`, `euler-api/app`).

2. **Safety gate.** Run `git branch --show-current`. If on `main`/`master`, STOP
   and tell the user to create a branch first — this sweep edits source files
   (log statements only, but it must be reviewable). Do not proceed on main.

3. **State the expected scale.** Run the census yourself first for exact
   numbers: `python3 ${CLAUDE_PLUGIN_ROOT}/scripts/logging_census.py <dir>`
   (seconds, free) — it prints entry-point and violation counts. Estimate:
   **1 census + (judgment lane: 1 trace agent per 3 entry modules) + 1 apply
   agent per 8 files + ≤4 verify agents**. On a big service recommend the
   two-pass order: `mechanical` lane first (cheap, fixes the bulk), then
   `judgment` per domain via `entries: [...]`. Over 30 entry modules in the
   judgment lane, confirm before launching. Tuning: `"traceBatch": 1–6`,
   `"applyBatch": 3–15`, `"verify": "none"`.

4. **Launch** the Workflow tool. `args` MUST be a real JSON object — never a
   prose string, never pseudo-code. Correct calls look exactly like these:

   ```
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/audit-backend-logging.workflow.js",
     args: { "dir": "euler-api/app", "pluginRoot": "${CLAUDE_PLUGIN_ROOT}" }
   })
   ```

   ```
   args: { "dir": "backend/app", "pluginRoot": "${CLAUDE_PLUGIN_ROOT}", "lanes": "mechanical" }
   ```

   ```
   args: { "dir": "backend/app", "pluginRoot": "${CLAUDE_PLUGIN_ROOT}", "lanes": "judgment",
           "entries": ["routers/notebook.py", "routers/courses.py"] }
   ```

5. **When it completes, report:** the clean/dirty count, per-module verdicts,
   every `remaining[]` item (`file:line` + issue) that needs a human decision,
   and remind the user to review `git diff` before committing. If any touched
   file appears in `REDUNDANCY_REGISTRY.md`, call out its twins explicitly.
