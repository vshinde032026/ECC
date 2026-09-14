export const meta = {
  name: 'refactor-module',
  description:
    'Refactor one module (backend or frontend) unit by unit: map refactor targets, then for each unit run a bounded refactor -> review -> fix loop, then verify the whole module builds/tests green. Behavior-preserving. Drives ecc:* agents by reference.',
  phases: [
    { title: 'Map', detail: 'code-explorer lists refactor units in the module' },
    { title: 'Refactor', detail: 'per unit: simplify -> review -> fix, bounded passes' },
    { title: 'Verify', detail: 'build-error-resolver runs tests/build until green' }
  ]
};

// ---------------------------------------------------------------------------
// refactor-module — a fermi "loop" workflow.
//
// WHY THE LOOP LOGIC IS INLINE: the Claude Code Workflow tool runs scripts in a
// sandbox with no filesystem/module access, so a .workflow.js CANNOT
// `require()` a shared lib. The bounded refine loop therefore lives inline
// below. The reusable *pattern* is documented in ../loops/refactor-module.md.
//
// PORTABILITY: this drives ecc:* agents by reference (user's choice). It only
// runs in a repo where ECC is installed alongside fermi. In an ECC-less repo,
// swap the agentTypes for built-in ones (general-purpose) and carry conventions
// in the prompts.
//
// SAFETY: agents EDIT the real working tree. Run this on a scratch branch/worktree
// and review the resulting diff. Every loop here is bounded — nothing spins forever.
//
// Caller contract (args):
//   {
//     module:    string,                      // dir to refactor, e.g. "backend/app/services/foo"  (required)
//     stack:     "backend" | "frontend",      // selects language reviewer + test hint            (required)
//     maxUnits?: number,                      // cap on units refactored this run (default 8)
//     maxPasses?: number,                     // refactor->review->fix rounds per unit (default 3)
//     constraints?: string,                   // extra project guardrails appended to every prompt
//   }
//
// Returns:
//   { module, stack, unitsPlanned, unitsProcessed,
//     results: [{ path, kind, passes, clean, remaining }],
//     verify: { green, command, failures, fixed },
//     stats: { units, cleanUnits, dirtyUnits } }
// ---------------------------------------------------------------------------

// ---- input validation (fail closed) --------------------------------------
if (!args || typeof args !== 'object') throw new Error('refactor-module: args object required');
const module_ = typeof args.module === 'string' ? args.module.trim() : '';
if (!module_) throw new Error('refactor-module: args.module (path) is required');
const stack = args.stack === 'frontend' ? 'frontend' : args.stack === 'backend' ? 'backend' : null;
if (!stack) throw new Error('refactor-module: args.stack must be "backend" or "frontend"');
const maxUnits = boundInt(args.maxUnits, 1, 25, 8);
const maxPasses = boundInt(args.maxPasses, 1, 6, 3);
const extraConstraints = typeof args.constraints === 'string' ? args.constraints.trim() : '';

// ---- agents by stack ------------------------------------------------------
const LANGUAGE_REVIEWER = stack === 'backend' ? 'ecc:python-reviewer' : 'ecc:typescript-reviewer';
const TEST_HINT = stack === 'backend'
  ? 'Backend: run the module\'s pytest suite (pytest + pytest-asyncio). Tests need DATABASE_URL_SYNC set; never call paid AI APIs (mock with vcrpy/respx).'
  : 'Frontend: run `tsc --noEmit` and the vite build; run any component tests. Do not start dev servers.';

// ---- shared guardrails carried into every prompt (ecc:* agents are not
//      project-aware, so the conventions travel in the prompt text) ---------
const GUARDRAILS = [
  'Refactoring MUST be behavior-preserving: no API, schema, or output changes.',
  'NEVER touch paths listed in LEGACY_QUARANTINE.md (dead/quarantined code).',
  'If a file is in REDUNDANCY_REGISTRY.md, apply the identical change to every twin in the same pass.',
  'Backend: async SQLAlchemy 2.0 only; keep Routers -> Services -> Models layering; large text stays in S3, not Postgres.',
  'Frontend: server state via TanStack Query, client state via Zustand; keep dark mode default.',
  'Do not edit .env or secrets. Do not rename existing public/ dirs to match a route.',
  extraConstraints
].filter(Boolean).map(s => `- ${s}`).join('\n');

// ---- structured output schemas -------------------------------------------
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['units'],
  properties: {
    units: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'kind', 'issues'],
        properties: {
          path: { type: 'string' },
          kind: { type: 'string', enum: ['file', 'function', 'interface', 'component', 'util', 'other'] },
          issues: { type: 'array', items: { type: 'string' } },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] }
        }
      }
    }
  }
};

const EDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'changed', 'summary'],
  properties: {
    path: { type: 'string' },
    changed: { type: 'boolean' },
    summary: { type: 'string' },
    notes: { type: 'string' }
  }
};

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['clean', 'issues'],
  properties: {
    clean: { type: 'boolean' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'problem'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          problem: { type: 'string' },
          fix: { type: 'string' }
        }
      }
    }
  }
};

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['green'],
  properties: {
    green: { type: 'boolean' },
    command: { type: 'string' },
    failures: { type: 'array', items: { type: 'string' } },
    fixed: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' }
  }
};

// ---- prompts --------------------------------------------------------------
const mapPrompt = () =>
  `Analyze the module at \`${module_}\` (${stack}). List the concrete units worth refactoring — ` +
  `files, functions, interfaces, components, and utils — that have real quality issues ` +
  `(duplication, tangled responsibilities, dead params, weak types, poor naming, oversized units). ` +
  `Do NOT propose behavior changes. Read the code before listing. Return the units, most impactful first.\n\n` +
  `Project guardrails:\n${GUARDRAILS}`;

const refactorPrompt = (unit) =>
  `Refactor this unit in \`${module_}\` (${stack}), behavior-preserving:\n` +
  `- path: ${unit.path}\n- kind: ${unit.kind}\n- known issues: ${unit.issues.join('; ')}\n\n` +
  `Make the edits directly. Improve structure/naming/types without changing behavior or public interfaces.\n\n` +
  `Project guardrails:\n${GUARDRAILS}`;

const fixPrompt = (unit, issues) =>
  `Apply fixes to \`${unit.path}\` in \`${module_}\`. A reviewer found these issues — resolve each ` +
  `without changing behavior:\n${issues.map((i, n) => `${n + 1}. [${i.severity}] ${i.problem}${i.fix ? ` -> ${i.fix}` : ''}`).join('\n')}\n\n` +
  `Project guardrails:\n${GUARDRAILS}`;

const reviewPrompt = (unit) =>
  `Review the just-refactored unit \`${unit.path}\` in \`${module_}\` (${stack}). ` +
  `Confirm it is behavior-preserving and check for convention violations and remaining quality issues. ` +
  `Set clean=true only if there is nothing that must change. Report concrete, cited issues only.\n\n` +
  `Project guardrails:\n${GUARDRAILS}`;

const verifyPrompt = (processed) =>
  `The module \`${module_}\` (${stack}) was just refactored across these units:\n` +
  processed.map(r => `- ${r.path} (${r.clean ? 'clean' : 'has remaining issues'})`).join('\n') +
  `\n\nVerify it still builds and its tests pass. ${TEST_HINT} If something is broken by the refactor, ` +
  `fix it (behavior-preserving) and re-run until green or you hit a wall. Report the command, failures, and fixes.\n\n` +
  `Project guardrails:\n${GUARDRAILS}`;

// ==========================================================================
// Phase 1 — Map
// ==========================================================================
phase('Map');
log(`Mapping refactor units in ${module_} (${stack})`);
const plan = await agent(mapPrompt(), { agentType: 'ecc:code-explorer', phase: 'Map', label: `map:${module_}`, schema: PLAN_SCHEMA });
const units = (plan && Array.isArray(plan.units) ? plan.units : []).slice(0, maxUnits);
log(`${plan?.units?.length || 0} units found; refactoring up to ${units.length}`);

// ==========================================================================
// Phase 2 — Refactor each unit SEQUENTIALLY (parallel edits to one module
// would corrupt shared files). Each unit runs a bounded refactor->review->fix
// loop — the inline "refine-with-critic" pattern.
// ==========================================================================
phase('Refactor');
const results = [];
for (const unit of units) {
  await agent(refactorPrompt(unit), { agentType: 'ecc:code-simplifier', phase: 'Refactor', label: `refactor:${unit.path}`, schema: EDIT_SCHEMA });

  let review = await critique(unit);
  let pass = 1;
  while (!isClean(review) && pass < maxPasses) {
    await agent(fixPrompt(unit, review.issues), { agentType: 'ecc:code-simplifier', phase: 'Refactor', label: `fix:${unit.path}:p${pass}`, schema: EDIT_SCHEMA });
    review = await critique(unit);
    pass++;
  }
  const clean = isClean(review);
  results.push({ path: unit.path, kind: unit.kind, passes: pass, clean, remaining: clean ? [] : (review.issues || []) });
  log(`${unit.path}: ${clean ? 'clean' : 'still has issues'} after ${pass} pass(es)`);
}

// ==========================================================================
// Phase 3 — Verify the whole module builds/tests green
// ==========================================================================
phase('Verify');
let verify = { green: false, command: '', failures: [], fixed: [] };
if (results.length) {
  verify = await agent(verifyPrompt(results), { agentType: 'ecc:build-error-resolver', phase: 'Verify', label: `verify:${module_}`, schema: VERIFY_SCHEMA })
    || { green: false, command: '', failures: ['verifier returned null'], fixed: [] };
}

const cleanUnits = results.filter(r => r.clean).length;
return {
  module: module_,
  stack,
  unitsPlanned: plan?.units?.length || 0,
  unitsProcessed: results.length,
  results,
  verify,
  stats: { units: results.length, cleanUnits, dirtyUnits: results.length - cleanUnits }
};

// ---- inline helpers (the reusable loop primitives, kept in-script) --------
// critique runs the general reviewer + the stack language reviewer in parallel
// and merges their issues — a small "perspective-diverse critic".
async function critique(unit) {
  const reviews = await parallel([
    () => agent(reviewPrompt(unit), { agentType: 'ecc:code-reviewer', phase: 'Refactor', label: `review:${unit.path}`, schema: REVIEW_SCHEMA }),
    () => agent(reviewPrompt(unit), { agentType: LANGUAGE_REVIEWER, phase: 'Refactor', label: `review:${unit.path}:lang`, schema: REVIEW_SCHEMA })
  ]);
  const issues = reviews.filter(Boolean).flatMap(r => Array.isArray(r.issues) ? r.issues : []);
  const clean = reviews.filter(Boolean).every(r => r.clean === true) && issues.length === 0;
  return { clean, issues };
}

function isClean(review) {
  // clean when no blocking issues remain (advisory low/medium do not block)
  if (!review) return false;
  if (review.clean === true) return true;
  const blocking = (review.issues || []).filter(i => i.severity === 'critical' || i.severity === 'high');
  return blocking.length === 0;
}

function boundInt(n, lo, hi, dflt) {
  n = Number.isFinite(n) ? Math.floor(n) : dflt;
  return Math.max(lo, Math.min(hi, n));
}
