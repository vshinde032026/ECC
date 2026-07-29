# fermi

A project-aware agentic setup built on top of [ECC](../README.md).

fermi is **not an app** — it's a folder of instructions (agents, commands) and small
scripts (workflows, graph/loop runners) that a Claude Code session loads. The point:
take ECC's battle-tested agents as a base, then teach them **our** projects'
requirements, structure, and conventions so they behave like they've worked in our
repos for months.

## Status

**Stage 1 — scaffold only.** The folder structure and TODO files exist; no agents
have been copied or tuned yet. See [`TODO.md`](TODO.md) for the roadmap.

## How it's built (the mental model)

```
   what you type        /fermi-*                 -> commands/
          | launches
   the runnable script  *.workflow.js            -> workflows/
          | follows the shape of
   the plan             graphs (DAG) + loops     -> graphs/  loops/
          | spawns
   the workers          project-aware agents     -> agents/   <- Stage 1 starts here
          | sit on
   the foundation       ECC (untouched) + our project code
```

Everything points down into **agents**. Loops, workflows, and graphs are just ways of
arranging agents — they are only useful once the agents underneath understand the
project. So we build bottom-up: smart agents first, orchestration later.

## Folder map

| Folder | Stage | Purpose |
|--------|-------|---------|
| `agents/` | 1 | Project-aware agents (copies of ECC agents + a `## Project context` section). **The main folder you edit.** |
| `context/` | 2 | Shared per-project profiles, factored out once a second repo appears. |
| `workflows/` | 3 | `.workflow.js` scripts for the Claude Code Workflow tool. |
| `graphs/` | 3 | Declarative DAG definitions (nodes + `dependsOn`). |
| `loops/` | 3 | Reusable iteration patterns (loop-until-done, refine-with-critic, ...). |
| `lib/` | 3 | Shared JS helpers: the graph runner and loop runner. |
| `commands/` | 3 | `/fermi-*` slash commands that launch workflows. |
| `tests/` | 3 | Tests for the `lib/` runners. |

Each folder has its own TODO describing exactly what goes in it. Note: `agents/` and
`commands/` use `TODO.txt` (not `.md`) because Claude Code auto-loads every `.md` in
those two folders as a component — a stray markdown file there becomes a phantom agent
or command. The other folders use `TODO.md`.

## Consuming fermi from another repo

fermi is shared by **git submodule** (no marketplace needed). Once fermi is its own
repo (split out with `git subtree` when ready):

```bash
# from inside a target repo
git submodule add <fermi-repo-url> .claude/fermi
```

Claude Code picks up the plugin's `agents/` (and later `commands/`, `skills/`) by
convention. Teammates get the same setup by cloning the submodule — one source of truth.

> While fermi lives inside the ECC repo during authoring, treat this `fermi/` folder as
> if it were already standalone: self-contained, no edits to ECC's own files.

## Manifest notes

`.claude-plugin/plugin.json` intentionally omits `agents`, `commands`, `hooks`, and
`skills` fields for now:

- `agents/` is **auto-discovered** by convention — declaring it fails the validator.
- `commands`/`skills` are added (as arrays) only once those folders have real content.
- The standard `hooks/hooks.json` auto-loads; declaring it causes a duplicate error.

See [`../.claude-plugin/PLUGIN_SCHEMA_NOTES.md`](../.claude-plugin/PLUGIN_SCHEMA_NOTES.md).
