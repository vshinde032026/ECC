# context/ — TODO (Stage 2, not yet)

Shared per-project profiles. **Empty on purpose until a second repo needs tailoring.**

## Why this folder exists

In Stage 1, each agent carries its own `## Project context` inline. That is fine for one
repo. The moment a **second** repo appears, that block starts repeating across every
agent — change a convention and you edit it in six places.

Stage 2 fixes that: lift the shared knowledge into one profile per project here, and have
agents reference it instead of duplicating it.

## Planned shape

```
context/
  superstem.md      # stack, structure, conventions, glossary, gotchas
  study-tools.md
  <project>.md
```

An agent then references a profile rather than inlining it:

```markdown
## Project context
See `../context/superstem.md`. Highlights for review: async SQLAlchemy only,
LaTeX inputs are untrusted, every endpoint goes through `require_user`.
```

## Checklist (do NOT start until Stage 2 is triggered)

- [ ] Confirm a second repo actually needs tailoring (YAGNI gate).
- [ ] Extract the common `## Project context` content from Stage 1 agents into `<project>.md`.
- [ ] Replace inline blocks with a reference + a short per-agent highlights line.
- [ ] Verify agents still behave correctly after the refactor.
