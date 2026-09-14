# Dev Workflow — Individual Contributor Feature Pipeline (fermi edition)

One pipeline lives in this skill. It takes a feature from "I have an idea and a
codebase" to "reviewed, planned, implemented code", with two review gates that
must pass before code is written.

Fermi runs this pipeline as a graph (`graphs/dev-pipeline.md`, executed by
`workflows/dev-pipeline.workflow.js` driving the `fermi-feature-dev` agent):
each phase is a node, profiles pick sub-graphs (`feature`, `bugfix` — no
spec/CEO gate, `closeout`, `study`), auto nodes run in parallel waves, and
every gate/manual node HALTS the workflow back to the main session. Human
decisions (intake, both review gates, code, SBET) never run inside a workflow.

```
MIND DUMP → INTAKE → STUDY → SPEC ─[CEO COUNCIL gate]→ PLAN ─[ENG REVIEW gate]→ CODE → CLOSE-OUT → SBET → ship
```

The usual entry point is a **mind-dump md file the user wrote**: their analysis
of what exists today, what they want, the end goal, and sometimes refactoring
ideas or LLD sketches. Phase 0 structures it; everything downstream stays
inside the scope it defines.

---

## Which Workflow?

```
┌──────────────────────────────────────────────────────────────────────┐
│ Starting state                          → Use this workflow          │
├──────────────────────────────────────────────────────────────────────┤
│ New feature / substantial change        → dev-workflow (this one)    │
│ Bug exists, root cause unknown          → debug-workflow A           │
│ Just wrote code, need to verify it      → debug-workflow B           │
│ Code is correct but slow                → debug-workflow C           │
│ Exploring a live system, capturing bugs → debug-workflow D           │
└──────────────────────────────────────────────────────────────────────┘
```

If unsure, ask the user. A "feature" that is really a fix for broken behavior
belongs in debug-workflow A, not here.

---

## Philosophy

1. **Understand before proposing.** Read the actual code on all three surfaces
   — frontend, backend, workers — before writing a word of spec. Specs written
   from memory of the codebase invent APIs that don't exist.
2. **Documents are the deliverables of the early phases.** The spec and the
   plan are repo artifacts with fixed locations, not chat messages. Each gate
   stamps its verdict INTO the document (Review Log), so a future session can
   resume from the artifact alone.
3. **Two gates, two questions.** The CEO council reviews the spec — is this the
   right thing to build, at the right scope? The eng review reviews the plan —
   is this the right way to build it? Never let one gate answer the other's
   question.
4. **Human checkpoints are mandatory.** Pause at every [HUMAN CHECKPOINT]. The
   user has context you don't — product intent, history, appetite.
5. **Spec ≠ plan.** The spec says WHAT and WHY (behavior, scope, acceptance
   criteria). The plan says HOW (files, tasks, migrations, tests). If you're
   naming file paths in the spec or debating goals in the plan, you're in the
   wrong document.
6. **No code before the plan is locked.** Prototype spikes are allowed during
   STUDY to answer feasibility questions, but they are throwaway — the real
   implementation starts only after the eng review gate passes.
7. **Scope is a ceiling, not a floor.** The scope fixed at intake (and refined
   at the gates) is the outer boundary of the work. Nothing outside it gets
   built, refactored "while we're here", or smuggled in as a plan task. Ideas
   that fall outside go into the spec's Out-of-scope Parking Lot, not into the
   work.
8. **Small product, small schema.** Prefer fewer Postgres tables. Extending an
   existing table — even with duplicated / denormalized data in it — beats
   creating a new one. See Shared Conventions → Schema preferences.
9. **Design before tasks.** The plan is an LLD document first and a task list
   second. Data flows, API surface, interfaces, and classes are designed — in
   that order — before any task is written. Strict SOLID and DRY, named
   design patterns where they apply, and separation of concerns for every
   piece, on both frontend and backend.

---

## Phases

### Phase 0: INTAKE — structure the mind dump [HUMAN CHECKPOINT]

Input: the user's md file (or pasted text) — a mind dump containing, in
whatever order: their analysis of what exists today, what they're looking for,
the end goal, and possibly refactoring ideas or LLD designs.

**Structure it into these sections** (this is a restructuring of THEIR
thoughts — preserve their intent and their words where possible; do not add
ideas of your own at this phase):

```markdown
## Structured intake
### Current state (as described)   ← their analysis; verified in Phase 1
### Desired outcome                ← what they're looking for
### End goal                       ← the finished-state definition
### Design ideas from the dump     ← their LLD / refactoring sketches, verbatim intent
### Constraints stated
### Ambiguities                    ← things the dump says unclearly or not at all
### SCOPE — in                     ← numbered list; this is the ceiling
### SCOPE — out                    ← adjacent things the dump implies but does not ask for
```

**Rules:**
- Append the structured intake to the user's own md file under a `---`
  divider (leave their original text untouched above it) — one artifact, and
  the spec later links to it.
- Everything in the dump lands in exactly one section — nothing dropped.
- Their LLD/refactoring ideas are captured as *candidate designs*: they carry
  into the plan phase as the default approach, and eng review (gate 2) is
  where they get validated — not silently replaced earlier.
- The SCOPE-in list is the contract. Downstream phases may *narrow* it (with
  the user) but never widen it without the user explicitly saying so.

**STOP and discuss with user:**
- Present the structured intake, especially SCOPE-in / SCOPE-out and the
  Ambiguities list
- Ask: "Did I read your dump right? Is this the scope?"
- Only proceed after the user confirms the scope

### Phase 1: STUDY

Goal: a touchpoint map of everything this feature will touch or imitate — and
a verification of the intake's "Current state" section against the actual
code. The user's analysis is the starting hypothesis, not established fact:
confirm each claim, and flag mismatches ("the dump says X reads from table T;
it actually goes through service S") back to the user rather than silently
correcting course. Study only what SCOPE-in touches.

**Ground in repo guardrails first:**
- Repo `CLAUDE.md` and the docs index (SuperStem: `docs-ai/00-INDEX.md`)
- **Feature docs: `docs/feature/<feature>/`** — the high-level feature spec
  and technical implementation plan for every feature this work touches or
  neighbors. These are the WHAT-exists-today record; read them before reading
  code. (Some features also have `docs/product/features/<feature>/` PRD/TRD —
  use the `superstem-docs` skill for those.)
- **Module `CLAUDE.md` files** — each touched module (e.g.
  `backend/app/<module>/CLAUDE.md`, `frontend/src/pages/<area>/CLAUDE.md`)
  carries architecture invariants ("never break these"). Read every one on
  the touchpoint map; the plan must not violate them.
- Dead-code registry (SuperStem: `LEGACY_QUARANTINE.md`) — never propose
  touching quarantined paths
- Duplicate-code registry (SuperStem: `REDUNDANCY_REGISTRY.md`) — if a
  touchpoint appears in an R-entry, every twin becomes a touchpoint too

**Sweep the three surfaces** (run the dev-pipeline workflow with
`profile: 'study'` — `Workflow({scriptPath:
"${CLAUDE_PLUGIN_ROOT}/workflows/dev-pipeline.workflow.js", args: {...}})`,
or the `/fermi:dev-pipeline study` command — three parallel `fermi-feature-dev`
sweeps returning a merged touchpoint map; or spawn parallel Explore /
code-explorer subagents manually. Either way you need conclusions, not file
dumps):
- **Frontend** — routes, pages/components, hooks, state (TanStack Query keys,
  Zustand stores), API client modules
- **Backend** — routers → services → models for the affected domain, auth
  requirements, Alembic migration state, S3/storage patterns
- **Workers** — Celery tasks, which queue (`default` vs `heavy`), beat
  schedules, task↔endpoint contracts

**Also capture:** the nearest adjacent feature (the pattern to imitate), and
conventions you must reuse (naming, error shapes, pagination, LLM routing —
SuperStem: all LLM calls go through OpenRouter via `catalog.py`).

**Output — touchpoint map table** (this seeds the spec's Current State
section):

```
| Surface  | File / module                        | Role today            | Likely change |
|----------|--------------------------------------|-----------------------|---------------|
| frontend | src/pages/TeacherLibrary.tsx         | lists cohort assets   | add tab       |
| backend  | app/teacher_tools/routers/cohorts.py | cohort CRUD           | new endpoint  |
| workers  | app/tasks/video_tasks.py             | heavy-queue rendering | new task      |
```

Feasibility unknowns (can the DB support X? does the API expose Y?) get
answered here — by reading code or a throwaway spike — not deferred into the
plan.

### Phase 2: SPEC [HUMAN CHECKPOINT]

Write the spec to `docs/superpowers/specs/YYYY-MM-DD-<feature>.md` (create the
directory if missing; use today's real date).

**Spec template:**

```markdown
# <Feature> — Spec
Status: DRAFT | CEO-REVIEWED | SUPERSEDED

## Problem
## Goals                  ← derived from intake Desired outcome / End goal
## Non-goals              ← seeded from intake SCOPE-out
## Users & stories
## Current state          ← touchpoint map from STUDY (verified, not as-dumped)
## Proposed behavior      ← user-visible behavior only, no file paths
## Acceptance criteria    ← numbered AC1..ACn, each independently checkable
## Design ideas carried   ← the user's LLD/refactoring sketches, for the plan phase
## Open questions
## Out-of-scope parking lot ← good ideas that exceed SCOPE-in; parked, not built
## Review log             ← appended by the gates, never edited retroactively
```

**Rules:**
- Every goal must trace to at least one acceptance criterion
- Every goal must trace back to the intake SCOPE-in list — a goal with no
  intake ancestor is scope creep; move it to the parking lot
- Non-goals are load-bearing — write the tempting adjacent scope you are
  explicitly NOT doing
- Open questions that block the CEO review must be flagged as such

**STOP and discuss with user:**
- Present a summary: problem, goals, AC count, and ALL open questions
- Ask: "Is this the feature you meant? Answers to the open questions?"
- Only proceed to the CEO council after user confirms the draft

### Phase 3: CEO COUNCIL REVIEW [HUMAN CHECKPOINT — gate 1]

Run the council on the SPEC (not the plan — it doesn't exist yet).

- Invoke gstack `/plan-ceo-review` with the spec doc as the subject.
- **Default mode: HOLD SCOPE** (or SCOPE REDUCTION). The scope was fixed at
  intake — the council's job here is rigor and cut candidates, not dreaming
  bigger. Expansion modes run only if the user explicitly asks to think
  bigger; anything expansive the council surfaces anyway goes to the spec's
  parking lot, not into Goals.
- The question at this gate: **right product, right scope?** Architecture
  objections raised here get parked for gate 2, noted in the Review Log.

**Fold the outcome back into the spec:**
- Update Goals / Non-goals / AC per the decisions
- Append to Review Log: date, mode chosen, decisions (one line each), parked
  items
- Set Status: `CEO-REVIEWED`
- If scope changed materially (new surface touched, new goal), loop back to
  Phase 1 for the NEW touchpoints only — don't re-study what didn't change

**STOP and discuss with user:** confirm the post-review spec is what they want
built. This sign-off freezes the WHAT.

### Phase 4: PLAN

Write the implementation plan to
`docs/superpowers/plans/YYYY-MM-DD-<feature>.md`, following
`superpowers:writing-plans` conventions (bite-sized tasks, exact file paths,
verification step per task).

**Design the LLD first, tasks second.** The task list is derived FROM the LLD
sections below — writing tasks before the design is done produces
file-shuffling, not engineering.

**Backend LLD — in this strict order:**

1. **Data flows.** For each user story: where data enters, which service owns
   each transformation, what persists where, what goes to workers, what
   returns. Draw the flow (request → router → service → data layer → response
   / task) before naming a single class.
2. **API design — audit existing APIs first.** List the existing endpoints in
   the touched domain. For each new need, decide in this order:
   (a) an existing endpoint already serves it →  reuse;
   (b) an existing endpoint generalizes cleanly (a param, a filter, a wider
   response shape) without breaking current callers → update/generalize it;
   (c) only then design a new endpoint. New endpoints follow the domain's
   existing conventions (paths, pagination, error shapes, auth deps). Record
   the (a)/(b)/(c) decision per endpoint in the plan.
3. **Interfaces.** From the data flows, define the contracts: service
   interfaces / protocols, Pydantic schemas, task signatures — names, methods,
   inputs, outputs. Depend on abstractions, not concretions (the D in SOLID).
4. **Implementation classes.** Only now name the concrete classes/modules that
   realize each interface, each with a single responsibility, slotted into
   router → service → data layer. Name the design pattern where one applies
   (strategy, factory, repository, observer…) — a named pattern is a design
   decision; an unnamed clever structure is a review question.

**Frontend LLD — same discipline:**

1. **Data flow first.** Which TanStack Query keys / Zustand slices own the
   state, what the API client calls, what invalidates what. No component
   design before the data flow is drawn.
2. **Component design — separation of concerns.** Container vs presentational
   split; hooks own logic, components own rendering. Each component clean and
   single-purpose; split into separate files when a component grows beyond one
   concern. Reuse existing shared components before creating new ones (same
   audit as APIs: reuse → generalize → new).
3. **Styling separated from markup.** Class strings live in a separate styles
   file or as named file-level constants — JSX references the constant name,
   not a wall of inline utility classes. One place to change a style, DRY
   across variants.

**SOLID + DRY are plan-checkable, not vibes:** every class in the LLD states
its one responsibility; duplicated logic across tasks means a shared
abstraction is missing — fix the design, don't copy the code. (DRY governs
CODE; data duplication in Postgres is separately allowed by Schema
preferences.)

**The plan must contain:**
- **AC coverage table** — every AC1..ACn maps to ≥1 task; a task with no AC is
  scope creep, an AC with no task is a hole
- **Task list** — per task: files to touch, what changes, how verified. Start
  from the spec's "Design ideas carried" — the user's LLD is the default
  design; deviate only with a stated reason, and put the deviation in front of
  eng review.
- **Layering** — every backend task slots its code into the module's
  router → service → data layer separation (thin routers: auth, parsing,
  response shaping; services: business logic; data layer: models/queries).
  A task that puts DB calls or business logic in a route handler is
  malformed. Respect each touched module's `CLAUDE.md` invariants.
- **Data changes** — Alembic migrations, backfills, and their rollback story.
  Follow Shared Conventions → Schema preferences: extend existing tables
  first; every NEW table needs a one-line justification for why no existing
  table could absorb it, and duplicated/denormalized data is an acceptable
  price to avoid a new table.
- **Worker changes** — queue assignment (`default` vs `heavy`), idempotency,
  retry behavior
- **Twin sync** — tasks touching REDUNDANCY_REGISTRY entries list every twin
  copy in the same task
- **Test plan** — unit + integration per surface; what is mocked (AI calls are
  ALWAYS mocked in tests)
- **Rollout** — feature flag / deploy order / stage-first, if user-facing

### Phase 5: ENG REVIEW [HUMAN CHECKPOINT — gate 2]

Run engineering review on the PLAN.

- Invoke gstack `/plan-eng-review` with the plan doc as the subject:
  architecture, data flow, edge cases, test coverage, performance.
- Bring the `plan-review` node's specialist findings (schema / security /
  type-design, in the workflow's `results['plan-review']`) to the table —
  they are annotations for this gate to judge, not pre-approved decisions.
- The LLD sections are the review's main course: data flows complete? API
  reuse/generalize/new decisions sound? interfaces coherent? classes
  single-responsibility? patterns appropriate (not pattern-soup)? frontend
  state/component/styling separation clean?
- Bring in the items parked at gate 1.
- The question at this gate: **will this design survive contact with the
  codebase?** Scope debates are out of order here — if the review invalidates
  the SPEC (not just the plan), go back to Phase 3; don't quietly patch the
  spec from inside the plan.

**Fold the outcome back into the plan:**
- Restructure tasks per the decisions; re-check the AC coverage table still
  holds
- Append Review Log (same format as the spec's)
- Mark the plan header `Status: LOCKED`

**STOP and discuss with user:** confirm the plan is locked and coding starts.

### Phase 6: CODE

- Isolate: feature branch / worktree (`superpowers:using-git-worktrees`).
  Never code on `main`.
- Execute the locked plan task-by-task via `superpowers:executing-plans` (or
  `superpowers:subagent-driven-development` for independent tasks), with
  test-driven development per task.
- **Validation loop:** for verifying just-written code against a running
  system, switch to debug-workflow B (define → smoke → variations →
  regression) — that skill owns the dev-loop discipline.
- **Plan drift rule:** if reality contradicts the plan twice in the same area,
  stop coding, amend the plan section, and re-run eng review on the CHANGED
  section only. Silent drift is how locked plans rot.

When all plan tasks are implemented and passing, do NOT go straight to review
or ship — Phase 7 is mandatory.

### Phase 7: CLOSE-OUT [HUMAN CHECKPOINT]

Fixed checklist, run in this order, all items on the touched modules only.
Items 1–5 are automated: run the dev-pipeline workflow
(`${CLAUDE_PLUGIN_ROOT}/workflows/dev-pipeline.workflow.js`, or
`/fermi:dev-pipeline closeout ...`) with `profile: 'closeout'` and the
touched module lists — layering runs first per
module; then unit-tests ∥ console-logs as parallel siblings (tests touch
`tests/**`, logging edits source — disjoint files; logging delegates to the
`audit-backend-logging` workflow); then test-quality (`fermi-code-reviewer`
independently judges the new tests' behavioral coverage — the test writer
never grades its own homework) ∥ docs (items 4–5). Use
`profile: 'closeout-deep'` on riskier changes to add the report-only
silent-failure and security hunts to the wave. Running interactively instead,
use the fallbacks named per item.

1. **Layering + LLD audit** — walk every new/changed file. Backend: routers
   hold no business logic or DB calls, services hold no HTTP concerns, data
   access lives in the models/data layer; the code matches the plan's
   interfaces and classes. Frontend: logic in hooks, rendering in components,
   style class strings in a styles file or named constants (no inline utility
   walls in JSX). Fix violations now, before tests lock them in.
2. **Unit tests** — per touched backend module: write new cases for the new
   code, update existing cases the change broke, chase corner cases (target
   100%, 90%+ acceptable). Interactive fallback: the global `/unit-tests`
   skill.
3. **Logging** — per touched backend module: clean-logs coverage on the new
   code paths per the fermi `backend-logging` skill (one-line errors saying
   WHAT failed and WHY, no tracebacks — Sentry keeps those). Interactive
   fallback: invoke the `fermi-logging-auditor` agent directly.
4. **Feature docs** — update `docs/feature/<feature>/` for every feature the
   work changed: the high-level spec reflects the new behavior, the technical
   implementation doc reflects the new design. Create the feature dir if this
   was a brand-new feature. (Features with `docs/product/features/<feature>/`:
   update via the `superstem-docs` skill's update mode.) Automated by the
   `docs` node.
5. **Module CLAUDE.md files** — update the `CLAUDE.md` inside each touched
   module: new invariants the change introduced, changed flows, anything the
   old guidance now gets wrong. If a substantial new module was created, give
   it a `CLAUDE.md` in the style of its siblings. Automated by the `docs`
   node alongside item 4.
6. **Scope re-check** — final diff against SCOPE-in; confirm the parking lot
   caught everything that leaked.

**STOP and present the close-out summary** (checklist with evidence: test
coverage numbers, docs touched, CLAUDE.md diffs). Then proceed to Phase 8 —
the feature is not shippable until it survives a live system test.

### Phase 8: SBET SYSTEM TEST [HUMAN CHECKPOINT]

Session-based exploratory test of the LIVE integrated system, adapted from
debug-workflow D (read that workflow's D-phases and Shared Tooling for the tap
/ ingest-server / checker mechanics). Difference from classic SBET: the agent
drives the flows; the user may drive too. Every implemented feature gets
tested against its functional doc.

**Step 1 — Boot the stack from `launch.json`.**
- Read `.vscode/launch.json` and `docker-compose.override.yml` in THIS
  worktree. Ports and URLs are worktree-specific — take every value from
  those files, never from memory or another worktree.
- Start infra first, per the launch config's own comments (e.g.
  `docker compose up postgres redis -d`, plus mongodb/qdrant if the configs
  name them).
- For each service the feature needs (backend, celery default/heavy, euler,
  frontend): reconstruct the exact shell command from its launch config —
  the config's `python` interpreter path, `module` + `args`, run from `cwd`,
  with `envFile` sourced and every key in the `env` block exported verbatim.
  Example translation:

  ```bash
  # from config "FastAPI Backend — :8021"
  cd <workspace>/backend && \
  DATABASE_URL="<env.DATABASE_URL>" DATABASE_URL_SYNC="<env.DATABASE_URL_SYNC>" \
  REDIS_URL="<env.REDIS_URL>" CELERY_BROKER_URL="<env.CELERY_BROKER_URL>" \
  CELERY_RESULT_BACKEND="<env.CELERY_RESULT_BACKEND>" \
  .venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8021 --reload
  ```

  Run each as a background shell. NEVER `docker compose up` the app services
  (data layer only). Apply pending Alembic migrations with the launch env's
  `DATABASE_URL_SYNC` before starting the backend.
- Verify each service: port listening (`lsof -i :<port>`), health endpoint
  responds, worker connected to broker (celery log line). Don't start driving
  flows against a half-up stack.

**Step 2 — Test accounts ready.**
Use the standard test accounts (see Shared Conventions → Test accounts). For
every role the scenarios need, verify login works via the real login endpoint
BEFORE driving any flow. If a password doesn't match, reset it in the DB to
the standard one — never create throwaway accounts or delete these. (SuperStem
gotcha: hash with raw `bcrypt.hashpw(pw, bcrypt.gensalt(rounds=12))` exactly
like `auth_service.hash_password` — NOT passlib — and pass the password via a
file, not inline shell, per repo CLAUDE.md.)

**Step 3 — Author the test-scenario doc [HUMAN CHECKPOINT].**
Before driving anything, write DETAILED end-to-end scenarios to
`docs/superpowers/sbet/YYYY-MM-DD-<feature>.md`. Derive them from the
`docs/feature/<feature>/` functional specs (updated in Phase 7 — they now
describe intended behavior) and the ACs. Scenario design rules:

- **Role matrix.** Every flow × every role that can touch or observe it —
  not just the role the feature is for. A review feature gets separate
  scenario sets for the reviewer profile AND the simple viewer profile.
- **Cross-role propagation.** When role A acts, write explicit scenarios for
  what roles B/C then see (e.g., reviewer reviews an item → is the reviewer's
  name visible to a normal viewer? should it be?). One scenario per
  observer role.
- **Permission negatives.** For each gated action, a scenario asserting the
  ungated roles CANNOT do or see it (blocked UI + blocked API, not just
  hidden button).
- **Concrete steps.** Each scenario: numbered steps ("login as
  `vaibhav.3@test.com` → open /wiki/x → …"), the expected result quoting the
  functional doc, and empty Verdict/Evidence columns to fill while driving.
- Plus the standard SBET variations on core flows (interrupt mid-flow,
  malformed input, idle-then-continue, unusually fast pace).

```markdown
| ID | Role(s)             | Scenario                         | Steps | Expected (per doc) | Verdict | Evidence |
| S1 | professor (v.2)     | submit review on article         | 1..n  | ...                |         |          |
| S2 | student (v.3)       | viewer sees reviewed badge       | 1..n  | ...                |         |          |
| S3 | student (v.3)       | reviewer NAME visible to viewer? | 1..n  | ...                |         |          |
| S4 | student (v.4)       | non-reviewer cannot submit       | 1..n  | ...                |         |          |
```

**STOP and present the scenario doc** — the user confirms coverage (roles,
cross-role cases, negatives) before any driving starts.

**Step 4 — SBET taps + watchers.**
Per debug-workflow D2 / Shared Tooling: start the ingest server, add
`#region agent log` taps tagged `TAP` at the main seam the flows cross (API
boundary, SSE publish, worker queue hand-off), and run a checker that appends
deduped violations to `ISSUES.md` (referential integrity, liveness gaps,
payloads that fail to parse, task fired-but-never-completed).

**Step 5 — Run every scenario in the real UI.**
Drive with `/browse` or the Playwright browser tools — whichever is quicker
for this app; pick one as primary and switch if it fights you. Known trap:
driver quirks masquerade as product bugs (e.g., a fill that doesn't update
React state) — before logging an input-related ❌, reproduce it with the
OTHER driver. Log in as the scenario's account, execute the numbered steps
exactly — click, type, upload, wait — and fill the Verdict/Evidence columns
in the scenario doc as you go: ✅ matches doc / ❌ deviates (what differed) /
⛔ blocked (by what), each with evidence (screenshot, tap log line, API
response, DB row). Cross-role scenarios mean actually re-logging-in as the
observer account and looking. Every deviation also lands in `ISSUES.md`.
Watch the service logs and tap stream while driving, not just the pixels.

**Step 6 — Triage [HUMAN CHECKPOINT].**
Walk `ISSUES.md` per debug-workflow D4: trivial fixes applied directly and
the scenario re-run; non-trivial issues get a diagnosis + proposed fix and
STOP for user discussion; an issue class firing 3+ times switches to
debug-workflow A on it.

**Step 7 — Cleanup + report.**
Remove all taps, stop the ingest server and every service shell started in
Step 1. The scenario doc (now with verdicts + evidence) and `ISSUES.md` ARE
the session record — they stay in `docs/superpowers/sbet/`. Present the final
scenario × verdict table, issues fixed vs open.

**Then finish:** `superpowers:requesting-code-review`, and the repo's ship
flow (`/ship` or PR to `main` — push only the feature branch; the user
merges).

---

## Iteration Rules

- **Gates run on documents, not vibes.** No spec file → no CEO review. No plan
  file → no eng review.
- **Scope guard at every phase.** Before finishing any phase, diff the work
  against SCOPE-in. Anything outside goes to the parking lot with a one-line
  note. "While we're here" refactors are outside scope unless the intake named
  them.
- **Max 2 loops per gate.** If a gate bounces the document twice, the problem
  is upstream — escalate to the user instead of a third rewrite.
- **Downstream edits never rewrite upstream verdicts.** Plan discoveries that
  change the spec go through gate 1 again (fast, scoped to the delta).
- **Resume from artifacts.** A new session picks up from the doc Status fields
  (`DRAFT` → Phase 2/3, `CEO-REVIEWED` → Phase 4/5, `LOCKED` → Phase 6/7/8).
- **Close-out is part of the work, not an epilogue.** "Implementation done"
  claims before the Phase 7 checklist has run are premature — tests, logs,
  feature docs, and module CLAUDE.md updates ship in the same PR as the code.
- **No ship without SBET.** Unit tests passing (Phase 7) is not the same as
  the live system matching the functional docs (Phase 8). The flow-verdict
  table is the shipping evidence.
- **Skipping gates requires an explicit user instruction**, recorded in the
  Review Log ("gate skipped per user, <date>").

---

## Shared Conventions

### Artifact locations

```
| Artifact | Path                                            | Gate that stamps it |
|----------|-------------------------------------------------|---------------------|
| Spec     | docs/superpowers/specs/YYYY-MM-DD-<feature>.md  | /plan-ceo-review    |
| Plan     | docs/superpowers/plans/YYYY-MM-DD-<feature>.md  | /plan-eng-review    |
```

(SuperStem convention; in a repo without `docs/superpowers/`, ask the user for
the docs home once and reuse it for both.)

### Review Log format (append-only, both docs)

```markdown
## Review log
- 2026-07-08 · CEO council (/plan-ceo-review) · mode: HOLD SCOPE ·
  decisions: dropped bulk-export (non-goal); AC7 added for empty state ·
  parked for eng: queue choice for renders
```

### Status field values

- Spec: `DRAFT` → `CEO-REVIEWED` → (`SUPERSEDED` if replaced)
- Plan: `DRAFT` → `LOCKED`

### Test accounts (SuperStem)

Standing accounts for SBET / manual testing. Password for ALL:
`Cool@123`. If login fails, UPDATE the password hash in the DB to this value
(raw bcrypt, password via file — see Step 2); never delete or replace these
accounts.

```
| Email               | Role               |
|---------------------|--------------------|
| vaibhav.1@test.com  | platform admin     |
| vaibhav.2@test.com  | platform professor |
| vaibhav.3@test.com  | student            |
| vaibhav.4@test.com  | student            |
```

Two student accounts exist deliberately — cross-role and viewer-vs-viewer
propagation scenarios need a second observer.

### Schema preferences (Postgres)

The product is small. Optimize the schema for fewer moving parts, not for
normal-form purity:

- **Fewer tables wins.** Default to extending an existing table (new columns,
  a `type`/`status` discriminator, a JSONB column for sparse or variant
  fields) over creating a new one.
- **Duplicate / denormalized data in one table is acceptable** when it avoids
  a new table or a join — repeat the parent's fields on the child rows rather
  than adding a lookup table.
- **A new table needs a stated justification** in the plan's Data changes
  section (e.g., genuinely different lifecycle, unbounded N:M, row count that
  would bloat the host table). "Cleaner modeling" is not a justification here.
- Junction tables for simple N:M with no payload are usually replaceable by an
  array column or JSONB on one side — prefer that at this product size.

---

## Quick Reference

**Start a session:**
```
$dev-workflow <path to mind-dump md>          # usual entry
$dev-workflow <feature description>           # no dump yet — agent asks for one
                                              # or drafts the intake from discussion
```

The agent enters at Phase 0 for new work, or resumes from the artifact Status
fields for in-flight work.

**Phase → artifact → gate:**

```
| Phase          | Deliverable                    | Exit condition            |
|----------------|--------------------------------|---------------------------|
| 0 INTAKE       | structured intake + SCOPE-in   | user confirms scope       |
| 1 STUDY        | touchpoint map, dump verified  | three surfaces swept      |
| 2 SPEC         | spec doc (DRAFT)               | user confirms draft       |
| 3 CEO COUNCIL  | spec doc (CEO-REVIEWED)        | user signs off WHAT       |
| 4 PLAN         | plan doc (DRAFT)               | AC coverage complete      |
| 5 ENG REVIEW   | plan doc (LOCKED)              | user signs off HOW        |
| 6 CODE         | implemented plan tasks         | all tasks pass            |
| 7 CLOSE-OUT    | dev-pipeline 'closeout' nodes  | user reviews summary      |
|                | (layering → tests ∥ logs →     |                           |
|                | test-quality ∥ docs; -deep     |                           |
|                | adds hunters) · scope re-check |                           |
| 8 SBET         | live stack from launch.json ·  | all scenarios ✅ vs docs, |
|                | scenario doc (role matrix,     | then code review + ship   |
|                | verdicts, evidence) · ISSUES.md|                           |
```
