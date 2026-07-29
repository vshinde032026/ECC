# fermi — roadmap

The build order is **bottom-up**: make the agents project-aware first, then learn to
orchestrate many of them. Each folder has its own `TODO.md` with the detailed checklist.

## Stage 1 — project-aware agents (START HERE)

> Goal: a "perfect agentic setup" for **one** repo, usable immediately, no workflows yet.

- [ ] Pick the first target repo to tailor to.
- [ ] Pick the daily-driver agent set to copy (suggested: `code-reviewer`,
      `code-explorer`, `architect`/`code-architect`, `planner`,
      `build-error-resolver`, and the language reviewer for the stack).
- [ ] Copy those agents from `../agents/` into [`agents/`](agents/TODO.txt).
- [ ] For each copied agent, hand-write a `## Project context` section (stack,
      structure, conventions, gotchas). Draft from reading the repo; review by hand.
- [ ] Verify agents load in a session and behave project-aware on a real task.

## Stage 2 — factor out shared context

> Trigger: a **second** repo needs tailoring and the `## Project context` blocks repeat.

- [ ] Lift the repeated context into [`context/`](context/TODO.md) profiles.
- [ ] Point agents at the profile instead of duplicating it inline.

## Stage 3 — orchestration (loops, workflows, graphs)

> Trigger: agents are project-aware and you want to run **many** of them together.

- [ ] Build the runners in [`lib/`](lib/TODO.md) (graph runner + loop runner).
- [ ] Add [`graphs/`](graphs/TODO.md) DAG definitions.
- [ ] Add [`loops/`](loops/TODO.md) iteration patterns.
- [ ] Add [`workflows/`](workflows/TODO.md) `.workflow.js` entry points.
- [ ] Add [`commands/`](commands/TODO.txt) `/fermi-*` triggers.
- [ ] Add [`tests/`](tests/TODO.md) for the runners.
- [ ] Declare `commands` (and any `skills`) in `.claude-plugin/plugin.json` as arrays.

## Stage 4 — split out & share

- [ ] `git subtree split` this `fermi/` folder into its own repo.
- [ ] Document the `git submodule add` flow for the team (already stubbed in README).
