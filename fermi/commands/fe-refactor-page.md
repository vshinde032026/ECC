---
description: Refactor ONE page module under frontend/src/pages/ onto the Fermi frontend architecture, then prove it did not change visually against stage.fermi.ai. Usage /fermi:fe-refactor-page <page> [profile] — gates halt back to you. Graph: graphs/fe-refactor-page.md.
---

# Frontend page refactor

Run the fermi fe-refactor-page graph with: **$ARGUMENTS**

## Steps

1. **Parse the arguments.** The first token is the page key — a bare directory
   name under `frontend/src/pages/` (`library`, `wiki`, `exam-prep`), never a
   path. A second token, if present, is the profile:

   | Profile | Does |
   |---|---|
   | `page` (default) | the full loop, two human gates |
   | `study` | analyse only — read-only, safe anywhere |
   | `plan` | analyse and plan, stop before editing |
   | `build` | resume after a plan was approved (pilot, then fan-out) |
   | `parity` | re-run just the visual before/after loop |

   If no page key is given, do NOT guess one. Read
   `docs/fe-cleanup/REGISTRY.md`, show the user the queue with its sizes, and
   ask which page. If the module is very large (`courses` at 407 files, `admin`
   at 141), say so and propose splitting it by route group with `subpass` —
   one sub-pass is still a full loop with its own baseline and its own gates.

2. **Preflight — check, do not assume.** Each of these has a specific failure
   the workflow cannot recover from on its own:

   - The repo carries `docs/fe-cleanup/PROCESS.md` and
     `frontend/e2e/fe-parity/`. Without them the workflow references files that
     do not exist. If missing, stop and say so.
   - `frontend/src/pages/<page>/` exists.
   - Not on `main`/`master` for any profile that edits (`page`, `build`,
     `parity`). Check `git branch --show-current`. `study` and `plan` are
     read-only and safe anywhere.
   - `frontend/.env.parity` exists with `FE_PARITY_EMAIL` and
     `FE_PARITY_PASSWORD` — needed by `baseline` and `parity`. It is gitignored;
     `frontend/.env.parity.example` documents it. **Never write credentials into
     a tracked file, and never pass them as workflow args.**
   - For `page`, `build` or `parity`: the local stack is running (`make debug`
     from the repo root, Vite on the port in `frontend/.env.local`). If it is on
     a port other than 5190, set `PARITY_LOCAL_URL` in `.env.parity`.
   - `origin/stage` is fetched locally — every ratchet compares against it.

3. **Launch.** `args` MUST be a real JSON object — never a prose string. A
   correct call looks exactly like this:

   ```
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/fe-refactor-page.workflow.js",
     args: { "page": "library", "profile": "page" }
   })
   ```

   Optional keys, all bounded, pass only when the default is wrong:
   `subpass` (label for a route-group split), `maxAgents` (60 — the hard spawn
   budget for the run), `maxUnits` (10), `batchSize` (6 units per implement
   agent), `maxPasses` (3), `maxGateRounds` (3), `maxParityRounds` (4),
   `maxDiffPct` (0.1), `baseRef` (`origin/stage`), `tokenFloor` (60000 — stop
   before any wave or batch when fewer tokens remain), `constraints` (extra
   guardrails, appended to every prompt). `batchSize` is the FIRST batch only;
   batches escalate 1x / 2x / 4x.

   **Pilot first.** After the plan gate, ONE unit is migrated alone and writes
   `PLAYBOOK.md`; the fan-out refuses to start without it. If the pilot reports
   blockers, stop and take them to the user — the plan is wrong, and that is the
   cheapest moment to learn it.

   **Cost.** A 10-unit page costs about 24 agents when batches come back clean
   and about 38 when every batch needs the full `maxPasses`, split across the two
   invocations either side of `plan-gate`. Fan-outs are fixed width and do not
   grow with the page. Never quote a one-agent-per-file estimate — `implement`
   batches ~6 units into one agent.

4. **On halt** (`status: 'halted'`): the run reached a gate. Present the
   completed `results` and the `instruction` **verbatim**, do the step WITH the
   user, then re-invoke with the same `scriptPath` and the returned `resume`
   args. **Never approve a gate yourself.**

   - `plan-gate` — walk `docs/fe-cleanup/pages/<page>/02-plan.md` with the user
     alongside the three lenses in `results['plan-review']`. Give the promotion
     audit real weight: a "move to shared" backed by fewer than two real
     consumers is the failure this workflow is least able to catch alone, and
     `results['plan-draft'].underCitedPromotions` lists the ones it spotted.
   - `ship-gate` — `git diff` for the moves, `03-parity.md` for the visual
     evidence, `REGISTRY.md` for ratchet movement. Check
     `results['parity-verdict']`: `pass: false`, or any entry under
     `regressions` or `unexplained`, means NOT ready — regardless of what the
     parity node reported about itself. PR target is `stage`.
   - `kind: 'blocked'` — `frame` found a quarantined path or a `backbone/` twin.
     That is a human decision, not something to route around.
   - `kind: 'budget'` — the run hit `maxAgents` OR the token floor. `spend`
     carries `tokensRemaining` and `tokenFloor`; say which ceiling bound.
     Show the user the `spend`
     breakdown before doing anything else, then let THEM choose: raise
     `maxAgents`, or lower `maxUnits` / `maxPasses` to fit the work into the
     budget. Do not silently raise it yourself — the budget exists because they
     asked for one.

5. **On complete:** report per node — routes captured, findings per lens, units
   moved and how many batches needed fix passes, which ratchets moved and by how
   much, and the final parity table. Always report `spend.total` against
   `spend.budget` with the `byKind` breakdown, so cost is visible rather than
   inferred. Remind the user to review `git diff` if anything edited the tree.

## What this is not for

New features, bug fixes, or intentional redesigns. This loop is behaviour- and
pixel-preserving by construction: a visual change makes the parity gate fail,
which is the point. Use the `dev-pipeline` workflow for feature work.
