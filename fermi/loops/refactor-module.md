# loop: refactor-module

A **loop** (refine-with-critic) packaged as a runnable **workflow**:
[`../workflows/refactor-module.workflow.js`](../workflows/refactor-module.workflow.js).

Loops can't run on their own — the Workflow tool executes `.workflow.js` files, and its
sandbox can't `require()` a shared lib. So the loop logic is **inline** in the workflow,
and this file documents the pattern so the next loop can copy it.

## What it does

Pick a module + stack, then:

1. **Map** — `ecc:code-explorer` lists refactor units (files / functions / interfaces /
   components / utils) that have real quality issues.
2. **Refactor** — for each unit, sequentially, the bounded loop:
   `ecc:code-simplifier` refactors → `ecc:code-reviewer` + language reviewer critique in
   parallel → if blocking issues remain, fix and re-review → repeat up to `maxPasses`.
3. **Verify** — `ecc:build-error-resolver` runs the module's tests/build and fixes
   refactor breakage until green.

Behavior-preserving throughout. Units are refactored **sequentially**, not in parallel —
concurrent edits to one module would corrupt shared files.

## Arguments

| arg | required | default | meaning |
|-----|----------|---------|---------|
| `module` | yes | — | dir to refactor, e.g. `backend/app/services/foo` |
| `stack` | yes | — | `backend` (python-reviewer, pytest) or `frontend` (typescript-reviewer, tsc/vite) |
| `maxUnits` | no | 8 | cap on units refactored per run |
| `maxPasses` | no | 3 | refactor→review→fix rounds per unit |
| `constraints` | no | — | extra project guardrails appended to every prompt |

## Run it

```jsonc
// from the main loop, on a scratch branch/worktree (agents edit the real tree):
Workflow({
  scriptPath: "fermi/workflows/refactor-module.workflow.js",
  args: { module: "backend/app/services/notes", stack: "backend", maxPasses: 3 }
})
```

Review the resulting diff before merging. Every loop is bounded — nothing spins forever.

## The reusable pattern (refine-with-critic)

Copy this shape into any new loop workflow:

```js
await agent(makePrompt(unit), { agentType: MAKER, schema: EDIT_SCHEMA });   // produce
let review = await critique(unit);                                          // assess
let pass = 1;
while (!isClean(review) && pass < maxPasses) {                              // bounded loop
  await agent(fixPrompt(unit, review.issues), { agentType: MAKER, schema: EDIT_SCHEMA });
  review = await critique(unit);
  pass++;
}
```

- **Always bound the loop** (`pass < maxPasses`) — never `while (true)` without a cap.
- **`isClean` decides what blocks** — here, only `critical`/`high` issues force another pass;
  `medium`/`low` are advisory.
- **`critique` can fan out** — this loop runs two reviewers in `parallel()` and merges issues
  (a perspective-diverse critic).

## Caveats

- **Drives `ecc:*` agents by reference** — only runs where ECC is installed alongside fermi.
  In an ECC-less repo, swap the `agentType`s for built-in ones and carry conventions in the
  prompts (the guardrail text is already inlined for exactly this reason).
- **Agents edit the working tree** — run on a throwaway branch and review the diff.
