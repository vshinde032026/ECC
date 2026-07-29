# StudyTools v2 — project profile

> Canonical project context for fermi agents. Derived from the repo's `CLAUDE.md`,
> `ARCHITECTURE_V2.md`, and `AGENTS.md` (study-tools-v2, read 2026-07-28).
> When a convention here conflicts with the repo's own `CLAUDE.md`, the repo wins —
> update this file to match.

## What it is

**SuperStem** (also branded **Capacity** / **myprofessor.live**, and increasingly the
**fermi.ai** envs) — an AI-powered STEM EdTech platform: study tools, AI tutors, five
wikis, a problem-solving workbench, a teacher authoring kit, and a video LMS.

A React 19 SPA backed by **four backend services**: Main Backend, Euler Backend,
CopilotKit, Live Tutorial.

## Repo & worktrees

Developed across multiple git worktrees under `study-tools-v2-wk/` (e.g. `study-tools-v2`,
`study-tools-v2-worktree-1`, `study-tools-v2-worktree-2`, feature PR trees). All share one
`CLAUDE.md` and conventions. **Each worktree gets its own isolated Docker DB + Redis** with
auto-allocated ports via `docker-compose.override.yml`.

## Project structure

- `backend/` — FastAPI app, Python 3.12+
- `frontend/` — React 19 SPA (Vite + TypeScript + Tailwind)
- `docker/` — Compose, Nginx, Dockerfiles
- `scripts/` — deployment + utility scripts
- `docs/`, `docs-ai/`, `context/` — architecture, design specs, PRD, setup. Docs entry
  point: `docs-ai/00-INDEX.md`
- `openspec/` — change proposals / specs (see Guardrails)

## Backend conventions

- **FastAPI + async SQLAlchemy 2.0.** Always async sessions — never sync in app code.
- **Layered:** Routers → Services → Models. Keep business logic in services.
- **PostgreSQL** via async SQLAlchemy; **Alembic** for migrations.
- **Celery + Redis**, two queues: `default` (light) and `heavy` (AI/video). Tasks should
  not fail silently — record failures (a known fragility, see below).
- **File storage: AWS S3.** NEVER store large text (LaTeX, transcripts, OCR dumps) in
  Postgres — store an S3 key. Prefer one canonical S3-key builder over inline key strings.
- **Auth: JWT (python-jose).** 15-min access token. Sliding sessions: 14d idle TTL,
  re-stamped on refresh, 90d absolute cap (`SESSION_IDLE_TTL_DAYS` /
  `SESSION_ABSOLUTE_TTL_DAYS`). Invariants in `backend/app/security/auth/CLAUDE.md`.
  **Password hashing uses raw `bcrypt`, NOT passlib** (passlib's probe trips a
  "72 bytes" error on bcrypt 4.x). Use `bcrypt.hashpw(pw, bcrypt.gensalt(rounds=12))`
  as in `app/services/auth_service.py:hash_password`.

## Frontend conventions

- **React 19 + Vite + TypeScript.**
- **Styling: Tailwind CSS + shadcn/ui.**
- **State: TanStack Query for server state, Zustand for client state.** Don't put server
  data in Zustand or duplicate query cache in client stores.
- **Math: KaTeX** for rendering, **CodeMirror 6** for LaTeX editing.
- **Dark mode is the default**; light mode is a toggle.

## AI / LLM conventions

- Models: **Claude Sonnet (default), Opus (premium), Haiku (compact).** Track cost per call.
- **Never hit paid AI APIs in CI/tests** — mock with vcrpy / respx.

## LaTeX safety (trust boundary — user/AI-authored LaTeX is untrusted)

- NEVER allow `\write18`, `\input`, `\include`, `\immediate\write`, or shell escape in
  user/AI LaTeX.
- Compile with **tectonic** in a sandboxed Docker container, `--untrusted` flag.
- 30-second compile timeout, 512 MB memory limit. **Sanitize before every compile.**

## Testing

- **pytest + pytest-asyncio.** Mock AI APIs (vcrpy/respx). Never call paid APIs in CI.
- Local data layer: `docker compose up postgres redis -d`; everything else runs natively
  via VSCode launch configs (which inject `DATABASE_URL_SYNC` / `REDIS_URL`). **Never**
  start backend services with `docker compose up` — use the launch configs.

## Guardrails (hard rules)

- **LEGACY_QUARANTINE.md — DO NOT read, edit, import, or "fix"** quarantined paths. They
  are dead code, also denied in `.claude/settings.json`. If a task seems to need them,
  STOP and ask a human.
- **REDUNDANCY_REGISTRY.md — sync twins.** Before editing any file, check the registry.
  If the file is in an R-entry, apply the identical change to every copy in that entry in
  the SAME PR. Do not refactor/merge duplicates unless explicitly asked.
- **OpenSpec** — for planning/proposals/new capabilities/architecture shifts, open
  `openspec/AGENTS.md` for the authoritative spec workflow before coding.
- **developer-workflow skill** is the single lifecycle entry point for feature work
  (spec → implement → validate → review → remediate → ship).
- **Code review** — read `code_review.md` and apply it to the full diff against the branch
  the work started from.

## Git & deploy workflow (fermi ECS flow)

- **Branch off `beta`; open PRs into `stage`.** Promotion flows `stage → beta`. Push to
  `dev` for long-running/bake testing. Every push to `dev`/`beta`/`stage` auto-deploys
  that env (`dev`/`beta`/`stage.fermi.ai`).
- **Don't push to `main`** or branch feature work off it; don't force-push shared branches.
- **Never commit `.env` or secrets** — config lives in AWS Secrets Manager
  (`superstem/<env>/app-env`).
- Deploys are **never triggered by hand**; CI builds + deploys on push.

## Deployed topology (AWS ECS Fargate, us-east-2)

Each env (`dev`/`beta`/`stage`) is a separate Fargate cluster running the same 8 services:
`core-api`, `workers`, `euler-api`, `euler-worker`, `euler-v2-api`, `live-tutorial`,
`edge`, `qdrant` — each with its own private RDS (`fermi_<env>`). Frontend is static on
**S3 + CloudFront**; MongoDB is a **shared Atlas** cluster; images in **us-east-1 ECR**.
A legacy single-EC2 docker-compose stack still serves `*.superstem.ai` (deploys `main`).

## Data location rule

Crawler output, scraped corpora, large generated content, and "data lake" folders default
to the **EC2 stage box**, NOT the local tree. Local repo holds only code, configs, schemas,
tests, small manifests (<10MB), and docs. Reference EC2 paths via env var (e.g.
`EXAM_PREP_DATA_ROOT`); never hardcode `/Users/...` paths.

## Known gotchas

- **Asset path collision:** never name a `frontend/public/<X>/` dir the same as a React
  Router route — Vite copies it to `dist/<X>/` and nginx serves it as a 403 directory
  listing, breaking the SPA fallback. Use a non-route name (`public/study-assets/`).
- **Dist mount staleness (legacy EC2):** after a build that adds a new `dist/` dir, the
  nginx container bind mount can hold a stale view — restart nginx to remount.

## Known fragilities (reviewers/architects: watch these)

From `ARCHITECTURE_V2.md` — pre-existing weak spots, not yet all fixed:
- Migrations historically not run automatically in deploy → `UndefinedTable` crashes.
- Celery task failures can be silent (no retry, no DB record) → users stuck on "generating".
- Frontend bundle has been monolithic (limited lazy-loading).
- S3 keys constructed inline in multiple places with drifting patterns.
