---
name: backend-logging
description: Audit and fix a Python FastAPI backend module against the SuperStem/Fermi logging-platform standard. Use when asked to "check logs", "audit logging", "ensure proper logging", "add logging", or "clean up logs" on a backend module. This is the fermi-plugin copy of the project's logging standard — kept in sync with the global console-log skill and docs/logging-standard.md.
triggers:
  - check logs
  - audit logging
  - ensure proper logging
  - add logging
  - backend-logging
---

# Backend logging auditor

Audit a backend module for log coverage against **this project's logging platform**, then
report what's present, what's missing, and where the gaps are — and fix them.

> **Read Part 1 before auditing anything.** These rules are project-specific. Generic FastAPI
> logging advice produces wrong findings — the platform already supplies several things a
> generic audit would tell you to add by hand.
>
> This file mirrors the authoritative `console-log` skill and `docs/logging-standard.md`. If
> they disagree, they win — re-sync this file.

---

# Part 1 — How logging works in this project

## The services

| Service | Path | Monitoring package |
|---|---|---|
| Main backend (FastAPI + Celery) | `backend/` | `backend/app/core/monitoring/` |
| Euler tutor API | `euler-api/` | `euler-api/app/core/monitoring/` |

`euler-backend/` is the pre-migration copy of `euler-api` and is **not** live. Never audit or edit it.

## The one correct way to get a logger

```python
from app.core.monitoring import get_logger

logger = get_logger(__name__)
```

- Always `__name__`, never a hand-written string — the module path is how logs are filtered.
- Never `logging.getLogger(__name__)` in new code (works, but breaks greppability) — low severity.
- **Never `logging.basicConfig()`** — `setup_monitoring()` owns the root logger (high severity).
  One-shot CLIs under `app/scripts/**` are exempt.
- Never add your own handler; never touch the root logger; never `print()` in served code.

## Structured context is mandatory — `extra={...}`

The message is a **constant human-readable string**; every variable goes in `extra`. This is
the single most important convention.

```python
# WRONG — unqueryable, and every line is a distinct message string
logger.info(f"Listed {len(out)} courses for {section}")
# RIGHT
logger.info("Listed discover courses", extra={"section": section, "count": len(out)})
```

`%`-style is acceptable for simple interpolation (`logger.warning("Ping failed: %s", e)`), but
`extra` is preferred wherever the value is a field someone would filter on.

## What the platform already gives you — do NOT add these by hand (findings)

Every record automatically carries: `timestamp`, `level`, `logger`, `service`, `env`,
`version`, `request_id` (ContextVar via `RequestContextMiddleware`, propagated euler→backend
and into Celery), and ambient `user_id`. Adding any of these to `extra` is a finding.

Also automatic — never re-implement in a module:
- **HTTP access logging** (one record/request: method, route template, status, `duration_ms`).
  Do not add a "request received"/"request completed" pair to imitate it.
- **Request-id generation/propagation** — never generate a correlation id, thread it through
  signatures, or pass one to `apply_async`.
- **Secret redaction + field truncation** — a handler-level filter (see Security).

## Output format

`LOG_FORMAT=auto` → JSON when stdout is not a TTY (containers/CI), coloured text for a watching
developer. So: a log line is a **structured event, not a sentence** — short, stable messages;
no multi-line output, banners, or box-drawing; never `print()` in served code.

## Levels — project policy

| Level | Use for | Notes |
|---|---|---|
| `DEBUG` | cache miss, "falling through to DB", pre-call detail | off in deployed envs |
| `INFO` | normal flow worth seeing in prod: endpoint hit, work done, task queued, cache hit | the default |
| `WARNING` | expected/handled: 404, validation fail, degraded fallback, retry | **not** an error |
| `ERROR` / `exception` | unexpected failures needing a human | **auto-forwards to Sentry** |

**`logger.error` pages someone** — `LoggingIntegration(event_level=ERROR)` sends every `ERROR`
to Sentry. Using it for an expected condition is a finding (that's `WARNING`). Inside an
`except` where you want the traceback, use `logger.exception(...)` — never
`logger.error(..., exc_info=True)` by hand.

## Security — redaction is a net, not a licence

A `RedactionFilter` scrubs bearer tokens, JWTs, `sk-` keys, AWS keys, URL creds, and sensitive
`key=value` pairs, drops credential-named `extra` keys, and truncates past `LOG_MAX_FIELD_LEN`.
**Do not rely on it** — it is shape-based:
- Never log passwords, tokens, cookies, API keys, or full `Authorization` headers.
- Never log raw request bodies, or full LLM prompts/completions.
- Prefer `user_id` over email (emails are not redacted by default).
- Log `len(items)`, never the list; an S3 key, never the object.

## Cost — logs are billed and rate-limited

No logging inside a hot loop, per-chunk streaming/SSE handler, or per-row iteration — log the
batch with a count. Health-check paths are already excluded; don't log them.

## Twin-file rule (R-028)

`backend/app/core/monitoring/**` and `euler-api/app/core/monitoring/**` are registry-tracked
twins (**R-028** in `REDUNDANCY_REGISTRY.md`). If an audit changes the monitoring platform
itself, the identical change goes to both services in the same PR. Feature modules are not
twins — only the platform.

---

# Part 2 — The audit

## Step 1 — Read the target file

Read the full file. If no path was given, ask which module. Note the service (`backend/` vs
`euler-api/`) — rules are the same, but euler-api modules may use `SessionLogger` (Category 4).

## Step 2 — Run every category (note line numbers for passes and fails)

### Category 1 — Logger setup
- `from app.core.monitoring import get_logger` + `logger = get_logger(__name__)` at module level.
- **Fail on:** missing logger; `logging.getLogger` in new code (low); logger inside a function;
  any `logging.basicConfig()` (high); any added handler; any `print()` in served code (high).

### Category 2 — API entry logs (route handlers only)
- `INFO`, within the first few lines: the action + **identifying params only** in `extra`
  (id logged; a 500-item list logged as `len(...)`).
- **Fail on:** dumping the payload/body; re-implementing the access log (`"GET /api/x received"`).
- Do **not** flag a trivial pass-through that immediately delegates to a logged service fn — say so.

### Category 3 — API response logs (route handlers only)
- `INFO` before returning: outcome summary (counts, status, key ids); must not restate the entry log.
- **Cache-hit rule:** any early return from a Redis/cache hit must say so explicitly (else fail).
- The access log already records status/duration — Category 3 is about *what the handler did*.

### Category 4 — Service-layer logs (inflection points only, not every function)
| Situation | Level | Log |
|---|---|---|
| Cache hit | `INFO` | what found + key id |
| Cache miss → DB | `DEBUG` | falling through |
| DB query returns zero rows | `DEBUG` | what was queried |
| About to call external (S3, Redis, OpenRouter, yt-dlp, Mongo) | `DEBUG` | what + key param |
| External call failed | `WARNING`/`exception` | which service, which operation |
| Celery task dispatched | `INFO` | task name + queue + key arg |
| Long-running job state change | `INFO` | job id + state |

**Never flag:** pure internal functions (no I/O), simple mappers, Pydantic validators, or a
branchless function already covered by a logged caller.
**euler-api only:** a `SessionLogger` call satisfies the `extra` convention (it injects
`session_id`/`user`/`course_id`/`turn`).

### Category 5 — Error and exception logs
| Situation | Level | Form |
|---|---|---|
| Expected/handled (404, validation, known edge) | `WARNING` | `logger.warning("...", extra={...})` — no traceback |
| Unexpected (DB down, S3 failure, unknown exception) | `ERROR` | `logger.exception("...")` — **traceback included, auto-forwards to Sentry** |
| Re-raising | either | log first, then `raise` — never silently |

**Fail on:** any `except` with no log (bare `pass`/`raise`/silent `return` — swallowed = highest
severity); `logger.error` for an expected condition (it pages Sentry — should be `WARNING`);
`logger.warning` where a traceback was needed; `logger.error(..., exc_info=True)` instead of
`logger.exception`.

### Category 6 — Platform violations and log hygiene
Findings that are wrong *because of how this platform works*:
- Re-implementing what the platform supplies: hand-generated/threaded `request_id`;
  `timestamp`/`service`/`env` in `extra`; a hand-rolled request entry/exit pair imitating the access log.
- `print()` in served code, or a multi-line/banner message.
- f-string interpolation of values that belong in `extra`.
- Secrets, tokens, full request bodies, emails (where a `user_id` exists), or full LLM
  prompts/completions — in the message or `extra`.
- Unbounded values: a whole list/model/file's content.
- Logging inside a hot loop or per-chunk in a streaming handler.
- A message that changes shape per call (defeats grouping).

## Step 3 — Fix, then RE-AUDIT (the loop)

Fix each gap with minimal, targeted edits: existing logger variable; add the setup block only
if missing; constant message + `extra={...}`; Celery dispatch logs always include task name,
queue, and key arg; add nothing the platform already supplies (Category 6). Then **re-read and
re-audit**; repeat until every category passes or no safe improvement remains.
**If the module is under `app/core/monitoring/**`, stop** — that's platform code governed by
R-028; any change must be mirrored in the other service in the same PR.

## Step 4 — Report

```
## Logging Audit: <module path>   (service: backend | euler-api)   (pass N)

### ✅/❌ C1 Logger setup — get_logger import ✓ · get_logger(__name__) ✓
### ✅/❌ C2 API entry logs — endpoint() ✓/✗ entry log (extra)
### ✅/❌ C3 API response logs — endpoint() ✓/✗ · cache hit labelled ✓/✗
### ✅/❌ C4 Service-layer logs — Celery dispatch (task+queue+arg) ✓ · (or "nothing flagged")
### ✅/❌ C5 Error logs — except X ✓ warning · except Exception ✓ exception · swallowed ✗
### ✅/❌ C6 Platform violations — f-string→extra ✗ · logs request_id (already injected) ✗

### Summary — highest severity first
- swallowed exceptions & leaked secrets, then wrong levels, then missing coverage, then hygiene
```

## Modularity

Stack-scoped, not task-scoped: same behaviour invoked directly on a module, swept by
`workflows/audit-backend-logging.workflow.js`, or dropped into a future feature/debugging flow.
