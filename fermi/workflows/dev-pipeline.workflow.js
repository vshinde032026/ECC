export const meta = {
  name: 'dev-pipeline',
  description:
    'Graph-driven dev-workflow pipeline. Every phase is a node (auto | gate | manual) with dependsOn edges; a profile (feature / bugfix / closeout / study) selects which nodes run. Auto nodes execute in parallel waves; gate and manual nodes HALT the run and return resume instructions — human decisions never happen inside the workflow. unit-tests and console-logs are sibling nodes and run concurrently after layering.',
  phases: [
    { title: 'Study', detail: 'node study: 3 parallel surface sweeps -> touchpoint map' },
    { title: 'Spec draft', detail: 'node spec-draft: draft the spec doc (DRAFT status)' },
    { title: 'Plan draft', detail: 'node plan-draft: draft the LLD plan doc (DRAFT status)' },
    { title: 'Plan review', detail: 'node plan-review: schema/security/type-design specialists annotate the plan for the eng gate' },
    { title: 'Layering', detail: 'node layering: per-module LLD/layering audit -> fix' },
    { title: 'Unit tests', detail: 'node unit-tests: per-module bounded write -> run -> fix loop' },
    { title: 'Console logs', detail: 'node console-logs: clean-logs sweep via audit-backend-logging' },
    { title: 'Silent failures', detail: 'node silent-failures (opt-in): swallowed-error hunt, report-only' },
    { title: 'Security', detail: 'node security (opt-in): vulnerability review, report-only' },
    { title: 'Test quality', detail: 'node test-quality: independent behavioral-coverage check on the new tests' },
    { title: 'Docs', detail: 'node docs: feature docs + module CLAUDE.md updates' }
  ]
};

// ---------------------------------------------------------------------------
// dev-pipeline — the dev-workflow pipeline as a reusable GRAPH.
//
// Canonical graph doc: fermi/graphs/dev-pipeline.md (this file inlines it —
// the Workflow sandbox can't require() ../graphs/ or ../lib/).
//
//                        ┌─────────┐
//                        │  study  │ auto · fermi-feature-dev (STUDY)
//                        └────┬────┘
//                        ┌────▼───────┐
//                        │ spec-draft │ auto · fermi-feature-dev (DRAFT)
//                        └────┬───────┘
//                        ┌────▼─────┐
//                        │ ceo-gate │ GATE (halt: gstack /plan-ceo-review)
//                        └────┬─────┘
//                        ┌────▼───────┐
//                        │ plan-draft │ auto · fermi-feature-dev (DRAFT)
//                        └────┬───────┘
//                        ┌────▼────────┐
//                        │ plan-review │ auto · fermi-code-reviewer ∥ ×3
//                        └────┬────────┘  lenses (schema / security / type-design)
//                        ┌────▼─────┐
//                        │ eng-gate │ GATE (halt: gstack /plan-eng-review,
//                        └────┬─────┘   armed with plan-review findings)
//                        ┌────▼────┐
//                        │  code   │ MANUAL (halt: superpowers:executing-plans)
//                        └────┬────┘
//                        ┌────▼─────┐
//                        │ layering │ auto (per touched module, parallel)
//                        └────┬─────┘
//        ┌─────────────┬──────┴─────────┬─────────────────┐
//  ┌─────▼──────┐ ┌────▼─────────┐ ┌────▼────────────┐ ┌──▼───────────┐
//  │ unit-tests │ │ console-logs │ │ silent-failures │ │  security    │
//  └─────┬──────┘ └────┬─────────┘ │ (opt-in,        │ │  (opt-in,    │
//        │             │           │  report-only)   │ │ report-only) │
//        │             │           └─────────────────┘ └──────────────┘
//        │             │      one wave: tests edit tests/**, logging edits
//        │             │      source, hunters only report — no collisions
//  ┌─────▼─────────┐ ┌─▼──────┐   second wave, also parallel:
//  │ test-quality  │ │  docs  │   test-quality (fermi-code-reviewer, reads
//  └─────┬─────────┘ └─┬──────┘   tests/) ∥ docs (fermi-feature-dev, edits
//        └──────┬──────┘          docs/** + module CLAUDE.md — items 4-5)
//          ┌────▼────┐
//          │  sbet   │ MANUAL (halt: Phase 8 in main session)
//          └─────────┘
//
// PROFILES pick the sub-graph. Deps that fall outside the selection are
// treated as satisfied, so any suffix/subset of the pipeline is runnable:
//   feature       — the whole default graph (opt-in hunters excluded)
//   bugfix        — no spec, no CEO gate: study -> plan-draft -> plan-review
//                   -> eng-gate -> code -> closeout tail
//   closeout      — layering -> (unit-tests ∥ console-logs) -> test-quality -> docs
//   closeout-deep — closeout + silent-failures + security in the wave
//   study         — the study node alone
// Or pass args.nodes for an explicit selection (e.g. drop eng-gate for a
// trivial bugfix, or run console-logs alone).
//
// HALT/RESUME: the runner executes auto nodes wave by wave. On reaching a
// gate/manual node it RETURNS { halted, instruction, resume } — the main
// session does the human step, then re-invokes this workflow with
// resume.done (completed node list) to continue. Gates are boundaries where
// control goes back to the user, never agent self-approval.
//
// AGENT RESOLUTION — SELF-CONTAINED, fermi agents only (no ecc dependency):
// editing/drafting nodes (study, spec-draft, plan-draft, layering,
// unit-tests, docs) run fermi:fermi-feature-dev; every report-only node
// (plan-review lenses, test-quality, silent-failures, security) runs
// fermi:fermi-code-reviewer, whose toolset has no Edit — read-only is
// structural, not just prompted. Lens/hunt expertise is carried by the
// prompts. Passing args.agentType overrides EVERY node (escape hatch when
// fermi isn't installed — e.g. 'general-purpose').
//
// SAFETY: layering / unit-tests / console-logs EDIT the working tree. Run on
// the feature branch/worktree, never main, and review the diff.
//
// Caller contract (args):
//   {
//     profile?:  'feature' | 'bugfix' | 'closeout' | 'closeout-deep' | 'study',  // default 'feature'
//     nodes?:    string[],   // explicit node selection (overrides profile)
//     done?:     string[],   // nodes already completed (resume after a halt)
//     // node inputs (validated when the needing node runs):
//     feature?:         string,    // feature/bug description — study, spec-draft, plan-draft
//     intakePath?:      string,    // structured mind-dump md — study verifies its claims
//     scopeIn?:         string[],  // SCOPE-in items; sweeps stay inside them
//     specPath?:        string,    // spec doc path (caller supplies the dated path — Date is banned here)
//     planPath?:        string,    // plan doc path (same)
//     backendModules?:  string[],  // touched backend modules — layering, unit-tests, console-logs
//     frontendModules?: string[],  // touched frontend files/dirs — layering
//     serviceRoot?:     string,    // backend service package dir (e.g. "backend/app") — required
//                                  // by console-logs (census-driven child workflow)
//     pluginRoot?:      string,    // fermi plugin root — lets study agents run logging_census.py
//                                  // and is forwarded to the console-logs child
//     moduleBatch?:     number,    // modules per layering/quality/hunt agent (default 8, 3..15)
//     testBatch?:       number,    // modules per unit-test agent (default 4, 2..8)
//     maxPasses?:       number,    // INTERNAL fix/test rounds per module (default 2, clamped 1..4)
//     agentType?:       string,    // global override: replaces every node's specialist default
//     loggingWorkflowPath?: string // default 'fermi/workflows/audit-backend-logging.workflow.js'
//   }
//
// AGENT ECONOMICS (same lesson as the logging sweep): per-module nodes run ONE
// agent per BATCH of modules with any fix/test loop INSIDE the agent — never
// one agent per module per round. 10 touched modules ≈ 2 layering + 3 tests +
// 2 test-quality + census-driven logging child + 1 docs ≈ a dozen agents.
//
// Returns:
//   { status: 'halted' | 'complete', halted?, kind?, instruction?,
//     completed: string[], results: { <nodeId>: ... }, resume?: args-to-reinvoke }
// ---------------------------------------------------------------------------

// the harness sometimes delivers args as a JSON-encoded string — accept both
if (typeof args === 'string') {
  try { args = JSON.parse(args); } catch (e) {
    throw new Error('dev-pipeline: args must be a JSON OBJECT, e.g. {"profile":"study","feature":"..."} — got a non-JSON string. Re-invoke Workflow with args as an object literal, not prose.');
  }
}
if (!args || typeof args !== 'object') throw new Error('dev-pipeline: args object required');
const AGENT_OVERRIDE = str(args.agentType); // when set, replaces every node's default
function agentFor(dflt) { return AGENT_OVERRIDE || dflt; }
const FEATURE_DEV = 'fermi:fermi-feature-dev';    // editing/drafting nodes
const CODE_REVIEWER = 'fermi:fermi-code-reviewer'; // report-only nodes (toolset has no Edit)
const maxPasses = boundInt(args.maxPasses, 1, 4, 2);
const feature = str(args.feature);
const intakePath = str(args.intakePath);
const specPath = str(args.specPath);
const planPath = str(args.planPath);
const scopeIn = strList(args.scopeIn);
const backendModules = strList(args.backendModules);
const frontendModules = strList(args.frontendModules);
const loggingWorkflowPath = str(args.loggingWorkflowPath) || 'fermi/workflows/audit-backend-logging.workflow.js';
const serviceRoot = str(args.serviceRoot);
const pluginRoot = str(args.pluginRoot);
const moduleBatch = boundInt(args.moduleBatch, 3, 15, 8);
const testBatch = boundInt(args.testBatch, 2, 8, 4);

// ---- the graph (mirror of fermi/graphs/dev-pipeline.md) -------------------
const NODES = {
  'study':        { kind: 'auto',   deps: [],             phase: 'Study' },
  'spec-draft':   { kind: 'auto',   deps: ['study'],      phase: 'Spec draft' },
  'ceo-gate':     { kind: 'gate',   deps: ['spec-draft'],
    instruction: `Run gstack /plan-ceo-review with the user on the spec${specPath ? ` (\`${specPath}\`)` : ''} — default mode HOLD SCOPE. Fold decisions into Goals/Non-goals/AC, append the Review Log, set Status: CEO-REVIEWED. Then re-invoke this workflow with resume.done.` },
  // 'study' is a DIRECT dep of plan-draft (not just transitive via ceo-gate):
  // in the bugfix profile the spec/CEO branch is absent, and plan-draft must
  // still wait for the touchpoint map
  'plan-draft':   { kind: 'auto',   deps: ['ceo-gate', 'study'], phase: 'Plan draft' },
  'plan-review':  { kind: 'auto',   deps: ['plan-draft'], phase: 'Plan review' },
  'eng-gate':     { kind: 'gate',   deps: ['plan-review'],
    instruction: `Run gstack /plan-eng-review with the user on the plan${planPath ? ` (\`${planPath}\`)` : ''} — LLD sections are the main course, and bring the specialist findings in results['plan-review'] (schema / security / type-design) to the table. Fold decisions in, re-check AC coverage, append the Review Log, set Status: LOCKED. Then re-invoke with resume.done.` },
  'code':         { kind: 'manual', deps: ['eng-gate'],
    instruction: `Execute the LOCKED plan${planPath ? ` (\`${planPath}\`)` : ''} in the main session on a feature branch/worktree via superpowers:executing-plans (or subagent-driven-development), TDD per task. When all tasks pass, re-invoke with resume.done plus backendModules/frontendModules = the touched module lists.` },
  'layering':     { kind: 'auto',   deps: ['code'],       phase: 'Layering' },
  'unit-tests':   { kind: 'auto',   deps: ['layering'],   phase: 'Unit tests' },
  'console-logs': { kind: 'auto',   deps: ['layering'],   phase: 'Console logs' },
  'silent-failures': { kind: 'auto', deps: ['layering'],  phase: 'Silent failures' }, // opt-in, report-only
  'security':     { kind: 'auto',   deps: ['layering'],   phase: 'Security' },        // opt-in, report-only
  'test-quality': { kind: 'auto',   deps: ['unit-tests'], phase: 'Test quality' },
  // docs depends on the EDITORS (code must be final), not on test-quality —
  // docs edits docs/** and test-quality only reads, so the two share a wave
  'docs':         { kind: 'auto',   deps: ['layering', 'unit-tests', 'console-logs'], phase: 'Docs' },
  'sbet':         { kind: 'manual', deps: ['test-quality', 'docs'],
    instruction: 'Run Phase 8 SBET in the main session per the dev-workflow skill: boot the stack from launch.json, author the scenario doc (role matrix, negatives) with the user, drive every scenario live, triage ISSUES.md, then requesting-code-review + /ship.' }
};

const CLOSEOUT_TAIL = ['layering', 'unit-tests', 'console-logs', 'test-quality', 'docs'];
const PROFILES = {
  feature: ['study', 'spec-draft', 'ceo-gate', 'plan-draft', 'plan-review', 'eng-gate', 'code', ...CLOSEOUT_TAIL, 'sbet'],
  bugfix: ['study', 'plan-draft', 'plan-review', 'eng-gate', 'code', ...CLOSEOUT_TAIL],
  closeout: [...CLOSEOUT_TAIL],
  'closeout-deep': [...CLOSEOUT_TAIL, 'silent-failures', 'security'],
  study: ['study']
};

// ---- selection + resume state ---------------------------------------------
let selected = strList(args.nodes);
if (!selected.length) {
  const profile = str(args.profile) || 'feature';
  if (!PROFILES[profile]) throw new Error(`dev-pipeline: unknown profile '${profile}' (feature | bugfix | closeout | study)`);
  selected = PROFILES[profile];
}
const unknown = selected.filter(n => !NODES[n]);
if (unknown.length) throw new Error(`dev-pipeline: unknown node(s): ${unknown.join(', ')}`);
const done = new Set(strList(args.done).filter(n => NODES[n]));
const results = {};

// ==========================================================================
// node implementations (the runner loop is at the BOTTOM of the file — it
// must execute after every const above/below it is initialized)
// ==========================================================================
async function runNode(id) {
  if (id === 'study') return nodeStudy();
  if (id === 'spec-draft') return nodeSpecDraft();
  if (id === 'plan-draft') return nodePlanDraft();
  if (id === 'plan-review') return nodePlanReview();
  if (id === 'layering') return nodeLayering();
  if (id === 'unit-tests') return nodeUnitTests();
  if (id === 'console-logs') return nodeConsoleLogs();
  if (id === 'silent-failures') return nodeSilentFailures();
  if (id === 'security') return nodeSecurity();
  if (id === 'test-quality') return nodeTestQuality();
  if (id === 'docs') return nodeDocs();
  throw new Error(`dev-pipeline: no implementation for node '${id}'`);
}

// rules carried in every prompt so a generic agent still behaves
const LAYER_RULES = [
  'Backend layering: routers hold auth/parsing/response-shaping ONLY — no business logic, no DB calls.',
  'Services hold business logic, no HTTP concerns. Data access lives in the models/data layer.',
  'Frontend: logic in hooks, rendering in components; style class strings in a styles file or named',
  '  file-level constants — no inline utility walls in JSX.',
  'Fix violations with minimal, targeted edits — move code across layers, do not redesign it.',
  'Respect each touched module\'s own CLAUDE.md invariants, LEGACY_QUARANTINE.md, and',
  '  REDUNDANCY_REGISTRY.md (apply identical changes to every twin in the same pass).'
].map(s => `- ${s}`).join('\n');

const TEST_RULES = [
  'pytest, mirroring the module path under tests/. Target 100% coverage; 90%+ counts as success.',
  'Write new cases for the new code, update existing cases the change broke, chase corner cases.',
  'AI/LLM calls are ALWAYS mocked (all LLM traffic goes through OpenRouter via catalog.py).',
  'Mock S3 and external services. Never weaken an assertion or delete a failing test to go green.',
  'Run the tests with coverage and report the real numbers — no claims without a run.',
  'Only touch files under tests/ — source fixes belong to other nodes; report source bugs instead.'
].map(s => `- ${s}`).join('\n');

// ---- schemas --------------------------------------------------------------
const TOUCHPOINT = {
  type: 'object', additionalProperties: false, required: ['surface', 'file', 'roleToday', 'likelyChange'],
  properties: {
    surface: { type: 'string' }, file: { type: 'string' },
    roleToday: { type: 'string' }, likelyChange: { type: 'string' }
  }
};
const STUDY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['touchpoints', 'conventions', 'mismatches'],
  properties: {
    touchpoints: { type: 'array', items: TOUCHPOINT },
    conventions: { type: 'array', items: { type: 'string' } },
    adjacentFeature: { type: 'string' },
    mismatches: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['claim', 'reality'],
        properties: { claim: { type: 'string' }, reality: { type: 'string' } }
      }
    }
  }
};
const DRAFT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['path', 'summary', 'openQuestions'],
  properties: {
    path: { type: 'string' },
    summary: { type: 'string' },
    openQuestions: { type: 'array', items: { type: 'string' } }
  }
};
const LAYER_BATCH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['modules'],
  properties: {
    modules: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['module', 'violationsFound', 'violationsFixed'],
        properties: {
          module: { type: 'string' },
          violationsFound: { type: 'integer' }, violationsFixed: { type: 'integer' },
          remaining: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
};
const TEST_BATCH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['modules'],
  properties: {
    modules: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['module', 'pass', 'coverage'],
        properties: {
          module: { type: 'string' },
          pass: { type: 'boolean' }, coverage: { type: 'number' },
          remaining: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
};
const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['severity', 'issue'],
        properties: {
          severity: { type: 'string', enum: ['blocking', 'important', 'minor'] },
          area: { type: 'string' },
          issue: { type: 'string' },
          suggestion: { type: 'string' }
        }
      }
    }
  }
};
const QUALITY_BATCH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['modules'],
  properties: {
    modules: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['module', 'verdict', 'gaps'],
        properties: {
          module: { type: 'string' },
          verdict: { type: 'string', enum: ['strong', 'adequate', 'weak'] },
          gaps: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
};
const HUNT_BATCH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['modules'],
  properties: {
    modules: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['module', 'findings'],
        properties: {
          module: { type: 'string' },
          findings: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['severity', 'issue'],
              properties: {
                severity: { type: 'string', enum: ['blocking', 'important', 'minor'] },
                area: { type: 'string' },
                issue: { type: 'string' },
                suggestion: { type: 'string' }
              }
            }
          }
        }
      }
    }
  }
};
const DOCS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['updated', 'created'],
  properties: {
    updated: { type: 'array', items: { type: 'string' } },
    created: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' }
  }
};

// ---- study: 3 parallel read-only surface sweeps ---------------------------
async function nodeStudy() {
  need(feature, "node 'study' requires args.feature");
  const SURFACES = [
    { key: 'frontend', hint: 'routes, pages/components, hooks, state (TanStack Query keys, Zustand stores), API client modules under frontend/src' },
    { key: 'backend', hint: 'routers -> services -> models for the affected domain, auth requirements, Alembic migration state, S3/storage patterns under backend/app' },
    { key: 'workers', hint: 'Celery tasks, which queue (default vs heavy), beat schedules, task<->endpoint contracts under backend/app/tasks' }
  ];
  const prompt = (s) =>
    `STUDY mode, surface: ${s.key}. Feature: "${feature}".\n` +
    (scopeIn.length ? `SCOPE-in (study ONLY what these touch):\n${scopeIn.map((x, n) => `${n + 1}. ${x}`).join('\n')}\n` : '') +
    (intakePath
      ? `Read the intake at \`${intakePath}\` first; treat its "Current state" claims about this surface as hypotheses and verify each against the actual code — report mismatches as {claim, reality}, do not silently correct.\n`
      : 'No intake file provided — report an empty mismatches list.\n') +
    `DETERMINISTIC TOOLS FIRST, reading second: ` +
    (pluginRoot && (s.key === 'backend' || s.key === 'workers')
      ? `run \`python3 "${pluginRoot}/scripts/logging_census.py" <service root> --out /tmp/study-census.json\` — it gives you the full entry-point table (routers, Celery tasks, middleware, signals) and call chains for free; `
      : ``) +
    `use git grep with feature keywords to build a candidate file list, then READ ONLY the candidates — do not ` +
    `browse the tree file by file.\n` +
    `Sweep: ${s.hint}. Ground in the repo CLAUDE.md, docs/feature/<feature>/ docs, module CLAUDE.md files, ` +
    `LEGACY_QUARANTINE.md (never propose touching quarantined paths) and REDUNDANCY_REGISTRY.md ` +
    `(a touchpoint in an R-entry makes every twin a touchpoint too). ` +
    `Also name the nearest adjacent feature to imitate and the conventions to reuse. ` +
    `READ-ONLY — edit nothing. Return touchpoints as {surface: "${s.key}", file, roleToday, likelyChange}.`;

  const sweeps = (await parallel(SURFACES.map(s => () =>
    agent(prompt(s), { agentType: agentFor(FEATURE_DEV), phase: 'Study', label: `study:${s.key}`, schema: STUDY_SCHEMA })
  ))).filter(Boolean);
  if (sweeps.length < SURFACES.length) log(`WARNING: only ${sweeps.length}/${SURFACES.length} surface sweeps returned`);

  const touchpoints = sweeps.flatMap(r => r.touchpoints || []);
  return {
    touchpoints,
    conventions: [...new Set(sweeps.flatMap(r => r.conventions || []))],
    adjacentFeatures: [...new Set(sweeps.map(r => r.adjacentFeature).filter(Boolean))],
    mismatches: sweeps.flatMap(r => r.mismatches || []),
    markdownTable:
      '| Surface | File / module | Role today | Likely change |\n|---|---|---|---|\n' +
      touchpoints.map(t => `| ${t.surface} | ${t.file} | ${t.roleToday} | ${t.likelyChange} |`).join('\n')
  };
}

// ---- spec-draft: one agent writes the DRAFT spec doc ----------------------
async function nodeSpecDraft() {
  need(feature, "node 'spec-draft' requires args.feature");
  need(specPath, "node 'spec-draft' requires args.specPath (caller supplies the dated path)");
  const study = results['study'];
  return agent(
    `DRAFT mode: write the feature spec to \`${specPath}\` per the dev-workflow skill's spec template ` +
    `(Problem / Goals / Non-goals / Users & stories / Current state / Proposed behavior / Acceptance criteria ` +
    `AC1..ACn / Design ideas carried / Open questions / Out-of-scope parking lot / Review log). Status: DRAFT.\n` +
    `Feature: "${feature}".\n` +
    (intakePath ? `Ground Goals/Non-goals in the structured intake at \`${intakePath}\` — every goal must trace to SCOPE-in; anything without an intake ancestor goes to the parking lot.\n` : '') +
    (study ? `Current state section = this verified touchpoint map:\n${study.markdownTable}\n` +
      (study.mismatches.length ? `Intake mismatches to surface under Open questions:\n${study.mismatches.map(x => `- claim: ${x.claim} — reality: ${x.reality}`).join('\n')}\n` : '')
      : 'No study results in this run — read the touchpoint map from the intake/docs before writing Current state.\n') +
    `Spec says WHAT and WHY only — no file paths in Proposed behavior. Flag open questions that block CEO review. ` +
    `Return the path, a 3-sentence summary, and every open question.`,
    { agentType: agentFor(FEATURE_DEV), phase: 'Spec draft', label: 'spec-draft', schema: DRAFT_SCHEMA }
  );
}

// ---- plan-draft: one agent writes the DRAFT LLD plan doc ------------------
async function nodePlanDraft() {
  need(planPath, "node 'plan-draft' requires args.planPath (caller supplies the dated path)");
  return agent(
    `DRAFT mode: write the implementation plan to \`${planPath}\` per the dev-workflow skill's Phase 4 and ` +
    `superpowers:writing-plans conventions. Status: DRAFT.\n` +
    (specPath ? `The spec is at \`${specPath}\` — read it first; the plan realizes its ACs, nothing more.\n`
      : `No spec doc (bugfix profile) — plan against the feature description: "${feature}"${intakePath ? ` and the intake at \`${intakePath}\`` : ''}.\n`) +
    `LLD FIRST, tasks second. Backend order: data flows -> API design (reuse -> generalize -> new, decision recorded ` +
    `per endpoint) -> interfaces -> implementation classes (single responsibility, named patterns). Frontend: data flow ` +
    `-> component design (container/presentational, hooks own logic) -> styling separated from markup. ` +
    `Include: AC coverage table, task list (files + change + verification each), layering per module CLAUDE.md, ` +
    `data changes (extend tables first, new table needs justification, rollback story), worker changes (queue, ` +
    `idempotency, retries), twin sync per REDUNDANCY_REGISTRY.md, test plan (AI calls always mocked), rollout. ` +
    `Return the path, a 3-sentence summary, and open questions for eng review.`,
    { agentType: agentFor(FEATURE_DEV), phase: 'Plan draft', label: 'plan-draft', schema: DRAFT_SCHEMA }
  );
}

// ---- layering: BATCHED — one agent per group of modules -------------------
async function nodeLayering() {
  if (!backendModules.length && !frontendModules.length) {
    throw new Error("node 'layering' requires args.backendModules[] and/or args.frontendModules[]");
  }
  const layerBatchPrompt = (mods, surface, n, total) =>
    `CLOSE-OUT mode, check: layering (${surface} batch ${n + 1}/${total}). Audit and fix EACH of these ` +
    `modules, one at a time, completely:\n` +
    mods.map((m, i) => `${i + 1}. \`${m}\``).join('\n') +
    `\n\nFix violations with minimal edits.` +
    (planPath ? ` The LOCKED plan is at \`${planPath}\` — the code must match its LLD interfaces/classes; report drift in remaining[].` : '') +
    ` Return one entry per module: module (path as given), violationsFound, violationsFixed, remaining ` +
    `(items needing a human decision). Every listed module MUST appear in your answer.\n\n${LAYER_RULES}`;
  const jobs = [
    ...chunk(backendModules, moduleBatch).map((g, n, all) => ({ g, surface: 'backend', n, total: all.length })),
    ...chunk(frontendModules, moduleBatch).map((g, n, all) => ({ g, surface: 'frontend', n, total: all.length }))
  ];
  const out = (await parallel(jobs.map(j => () =>
    agent(layerBatchPrompt(j.g, j.surface, j.n, j.total), { agentType: agentFor(FEATURE_DEV), phase: 'Layering', label: `layer:${j.surface}:b${j.n + 1}`, schema: LAYER_BATCH_SCHEMA })
      .then(r => ({ surface: j.surface, expected: j.g, modules: (r && r.modules) || [] }))
  ))).filter(Boolean);
  const modules = accountBatch(out, 'layering');
  return { modules, fixed: modules.reduce((n, r) => n + (r.violationsFixed || 0), 0) };
}

// ---- unit-tests: BATCHED — pytest loop runs INSIDE the agent --------------
async function nodeUnitTests() {
  if (!backendModules.length) throw new Error("node 'unit-tests' requires args.backendModules[]");
  const groups = chunk(backendModules, testBatch);
  const testBatchPrompt = (mods, n) =>
    `CLOSE-OUT mode, check: unit-tests (batch ${n + 1}/${groups.length}). For EACH module below, one at a ` +
    `time: read the module and its existing tests, write/update cases, RUN pytest with coverage, and if not ` +
    `passing with >=90% coverage, fix the tests and re-run — up to ${maxPasses} rounds per module, looping ` +
    `YOURSELF (do not stop at one attempt). Then move to the next module.\n` +
    mods.map((m, i) => `${i + 1}. \`${m}\``).join('\n') +
    `\n\nReturn one entry per module: module, pass, coverage (the REAL numbers from your final run), ` +
    `remaining (uncovered/unfixable spots). Every listed module MUST appear.\n\n${TEST_RULES}`;
  const out = (await parallel(groups.map((g, n) => () =>
    agent(testBatchPrompt(g, n), { agentType: agentFor(FEATURE_DEV), phase: 'Unit tests', label: `tests:b${n + 1}`, schema: TEST_BATCH_SCHEMA })
      .then(r => ({ expected: g, modules: (r && r.modules) || [] }))
  ))).filter(Boolean);
  const modules = accountBatch(out, 'unit-tests');
  return {
    modules,
    passing: modules.filter(r => r.pass === true).length,
    coverageOk: modules.filter(r => Number.isFinite(r.coverage) && r.coverage >= 90).length
  };
}

// ---- console-logs: census-driven child workflow (v5 contract) -------------
async function nodeConsoleLogs() {
  if (!backendModules.length) throw new Error("node 'console-logs' requires args.backendModules[]");
  need(serviceRoot, "node 'console-logs' requires args.serviceRoot (backend service package dir, e.g. \"backend/app\")");
  // child expects entry paths relative to serviceRoot
  const prefix = serviceRoot.endsWith('/') ? serviceRoot : serviceRoot + '/';
  const entries = backendModules.map(m => m.startsWith(prefix) ? m.slice(prefix.length) : m);
  try {
    return await workflow({ scriptPath: loggingWorkflowPath }, { dir: serviceRoot, pluginRoot, entries, lanes: 'both' });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    log(`console-logs: child workflow failed (${msg}) — run audit-backend-logging manually`);
    return { error: msg };
  }
}

// ---- plan-review: 3 read-only specialists annotate the plan for eng-gate --
async function nodePlanReview() {
  const LENSES = [
    {
      key: 'schema',
      focus: 'the Data changes section: migrations, backfills, rollback story. Judge against the Schema preferences: ' +
        'fewer tables wins, extend existing tables first (columns / discriminators / JSONB), duplicated-denormalized ' +
        'data is acceptable to avoid a join, every NEW table needs a stated justification ("cleaner modeling" does not count). ' +
        'Also: index needs for the new query patterns, migration safety on a live DB.'
    },
    {
      key: 'security',
      focus: 'the API design and task list: auth dependencies on every new/changed endpoint, permission checks matching ' +
        'the roles in the spec, input validation at trust boundaries, injection/SSRF risk in anything touching user ' +
        'input or external calls, secrets handling. Flag any endpoint whose plan task does not name its auth dep.'
    },
    {
      key: 'type-design',
      focus: 'the Interfaces and Implementation classes sections: do the contracts (service interfaces, Pydantic schemas, ' +
        'task signatures) express their invariants, is each class single-responsibility, are abstractions depended on ' +
        'rather than concretions, is any named pattern appropriate rather than pattern-soup, do frontend state/component ' +
        'boundaries hold.'
    }
  ];
  const lensPrompt = (l) =>
    `READ-ONLY plan review, lens: ${l.key}. Read the implementation plan at \`${planPath}\`` +
    (specPath ? ` and its spec at \`${specPath}\`` : '') +
    `, plus any code you need for context. Do NOT edit anything — your findings go to the human eng review (gstack ` +
    `/plan-eng-review), which decides. Review ${l.focus}\n` +
    `Report findings as {severity: blocking|important|minor, area, issue, suggestion}. An empty findings list means ` +
    `this lens is clean — do not invent issues to look busy.`;

  const reviews = await parallel(LENSES.map(l => () =>
    agent(lensPrompt(l), { agentType: agentFor(CODE_REVIEWER), phase: 'Plan review', label: `plan-review:${l.key}`, schema: FINDINGS_SCHEMA })
      .then(r => ({ lens: l.key, findings: (r && r.findings) || [] }))
  ));
  const byLens = {};
  for (const r of reviews.filter(Boolean)) byLens[r.lens] = r.findings;
  const all = Object.values(byLens).flat();
  const blocking = all.filter(f => f.severity === 'blocking').length;
  log(`plan-review: ${all.length} finding(s), ${blocking} blocking`);
  return { byLens, total: all.length, blocking };
}

// ---- silent-failures / security: BATCHED report-only hunts ----------------
// (report-only ON PURPOSE: they share the wave with console-logs, which edits
// the same source files — reporters and one editor don't collide)
async function huntBatched(kind, phaseName, focus) {
  const targets = [...backendModules, ...frontendModules];
  const groups = chunk(targets, moduleBatch);
  const out = (await parallel(groups.map((g, n) => () =>
    agent(
      `READ-ONLY ${kind} review, batch ${n + 1}/${groups.length}. Review EACH module below, one at a time:\n` +
      g.map((m, i) => `${i + 1}. \`${m}\``).join('\n') +
      `\n\n${focus}\nDo NOT edit — findings go to the close-out summary for the human. Return one entry per ` +
      `module: module + findings ({severity, area, issue, suggestion}); findings: [] if clean. Every listed ` +
      `module MUST appear in your answer.`,
      { agentType: agentFor(CODE_REVIEWER), phase: phaseName, label: `${kind}:b${n + 1}`, schema: HUNT_BATCH_SCHEMA }
    ).then(r => ({ expected: g, modules: (r && r.modules) || [] }))
  ))).filter(Boolean);
  const modules = accountBatch(out, kind).map(m => ({ module: m.module, findings: m.findings || [] }));
  return { modules, total: modules.reduce((n, r) => n + r.findings.length, 0) };
}

async function nodeSilentFailures() {
  return huntBatched('silent-failures', 'Silent failures',
    'Hunt silent failures: swallowed exceptions (bare pass / bare raise with no log, caught-and-ignored), ' +
    'bad fallbacks that mask errors (defaulting on failure without signal), missing error propagation, ' +
    'promises/tasks whose failure nobody observes.');
}

async function nodeSecurity() {
  return huntBatched('security', 'Security',
    'Security review (recently changed code first): missing/weak auth on endpoints, unvalidated user input, ' +
    'injection (SQL/command/LaTeX), SSRF in outbound calls, secrets or credentials in code or logs, unsafe ' +
    'deserialization, permission checks that trust the client.');
}

// ---- test-quality: BATCHED independent check on the new tests -------------
async function nodeTestQuality() {
  const unit = results['unit-tests'];
  const groups = chunk(backendModules, Math.max(moduleBatch - 2, 3));
  const out = (await parallel(groups.map((g, n) => () =>
    agent(
      `READ-ONLY test-quality review, batch ${n + 1}/${groups.length}. For EACH module below, review the module ` +
      `and its tests under tests/:\n` +
      g.map((m, i) => {
        const rep = (unit && unit.modules || []).find(r => r.module === m);
        return `${i + 1}. \`${m}\` — test author's self-report: ${rep ? JSON.stringify(rep) : 'none'}`;
      }).join('\n') +
      `\n\nYou are the independent check — coverage % is NOT the question; behavioral coverage is. Judge: do the ` +
      `tests assert real behavior (not mock-echoes), would they catch the realistic bugs (wrong branch, off-by-one, ` +
      `error path, permission miss), are corner cases and failure paths exercised, is anything over-mocked to the ` +
      `point of testing nothing? Do NOT edit. Return one entry per module: module, verdict strong|adequate|weak, ` +
      `concrete gaps. Every listed module MUST appear in your answer.`,
      { agentType: agentFor(CODE_REVIEWER), phase: 'Test quality', label: `testq:b${n + 1}`, schema: QUALITY_BATCH_SCHEMA }
    ).then(r => ({ expected: g, modules: (r && r.modules) || [] }))
  ))).filter(Boolean);
  const modules = accountBatch(out, 'test-quality').map(m => ({ module: m.module, verdict: m.verdict || 'weak', gaps: m.gaps || [] }));
  return {
    modules,
    weak: modules.filter(r => r.verdict === 'weak').map(r => r.module),
    gaps: modules.reduce((n, r) => n + r.gaps.length, 0)
  };
}

// ---- docs: close-out items 4-5 — feature docs + module CLAUDE.md updates --
async function nodeDocs() {
  const mods = [...backendModules, ...frontendModules];
  return agent(
    `Update the documentation for the just-implemented feature "${feature}" (close-out items 4-5 of the dev-workflow skill). ` +
    `Touched modules: ${mods.map(m => `\`${m}\``).join(', ')}.` +
    (planPath ? ` The locked plan is at \`${planPath}\`` : '') + (specPath ? `; the spec is at \`${specPath}\`` : '') + `.\n` +
    `1. Feature docs: update \`docs/feature/<feature>/\` for every feature this work changed — the high-level spec ` +
    `reflects the new behavior, the technical doc reflects the new design. Create the feature dir if this is a ` +
    `brand-new feature (imitate a sibling feature's doc structure).\n` +
    `2. Module CLAUDE.md files: update the CLAUDE.md inside each touched module — new invariants, changed flows, ` +
    `anything the old guidance now gets wrong. A substantial new module gets a CLAUDE.md in the style of its siblings.\n` +
    `Edit DOCUMENTATION ONLY — never source code or tests. Describe what the code now does (read it), not what the ` +
    `plan hoped. Return the doc paths you updated and created.`,
    { agentType: agentFor(FEATURE_DEV), phase: 'Docs', label: 'docs', schema: DOCS_SCHEMA }
  );
}

// ---- helpers --------------------------------------------------------------
function str(v) { return typeof v === 'string' ? v.trim() : ''; }
function strList(v) { return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) : []; }
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
// flatten batch results, filling in explicit placeholders for modules a batch
// agent failed to report (no silent drops)
function accountBatch(out, label) {
  const reported = new Map();
  for (const b of out) for (const m of b.modules) if (m && m.module) reported.set(m.module, m);
  const all = [];
  for (const b of out) {
    for (const expected of b.expected) {
      if (reported.has(expected)) {
        const m = reported.get(expected);
        if (!all.includes(m)) all.push(m);
      } else {
        log(`WARNING: ${label}: no verdict for ${expected} from its batch agent`);
        all.push({ module: expected, remaining: [`no verdict from batch agent`], findings: [], gaps: ['no verdict from batch agent'], verdict: 'weak', pass: false, coverage: 0, violationsFound: 0, violationsFixed: 0 });
      }
    }
  }
  return all;
}
function need(v, msg) { if (!v) throw new Error(`dev-pipeline: ${msg}`); }

// validate a node's inputs BEFORE it enters a parallel wave — thunks that
// throw inside parallel() resolve to null, which would swallow the error
function validateNode(id) {
  if (id === 'study') need(feature, "node 'study' requires args.feature");
  if (id === 'spec-draft') {
    need(feature, "node 'spec-draft' requires args.feature");
    need(specPath, "node 'spec-draft' requires args.specPath (caller supplies the dated path)");
  }
  if (id === 'plan-draft') need(planPath, "node 'plan-draft' requires args.planPath (caller supplies the dated path)");
  if (id === 'plan-review') need(planPath, "node 'plan-review' requires args.planPath");
  if ((id === 'layering' || id === 'silent-failures' || id === 'security') && !backendModules.length && !frontendModules.length) {
    throw new Error(`dev-pipeline: node '${id}' requires args.backendModules[] and/or args.frontendModules[]`);
  }
  if ((id === 'unit-tests' || id === 'console-logs' || id === 'test-quality') && !backendModules.length) {
    throw new Error(`dev-pipeline: node '${id}' requires args.backendModules[]`);
  }
  if (id === 'console-logs') {
    need(serviceRoot, "node 'console-logs' requires args.serviceRoot (backend service package dir, e.g. \"backend/app\")");
  }
  if (id === 'docs') {
    need(feature, "node 'docs' requires args.feature (names the docs/feature/<feature>/ dir)");
    if (!backendModules.length && !frontendModules.length) {
      throw new Error("dev-pipeline: node 'docs' requires args.backendModules[] and/or args.frontendModules[]");
    }
  }
}
function boundInt(n, lo, hi, dflt) {
  n = Number.isFinite(n) ? Math.floor(n) : dflt;
  return Math.max(lo, Math.min(hi, n));
}

// ==========================================================================
// the runner: parallel waves of ready auto nodes; halt on gate/manual.
// Deps outside the selection count as satisfied (any sub-graph is runnable).
// ==========================================================================
for (;;) {
  const pending = selected.filter(n => !done.has(n));
  if (!pending.length) {
    return { status: 'complete', completed: [...done], results };
  }
  const ready = pending.filter(n => NODES[n].deps.every(d => !selected.includes(d) || done.has(d)));
  if (!ready.length) throw new Error(`dev-pipeline: no runnable node — cycle or bad selection among: ${pending.join(', ')}`);

  const autoReady = ready.filter(n => NODES[n].kind === 'auto');
  if (autoReady.length) {
    autoReady.forEach(validateNode);
    log(`Wave: ${autoReady.join(' + ')}`);
    const waveResults = await parallel(autoReady.map(n => () => runNode(n)));
    autoReady.forEach((n, i) => {
      if (waveResults[i] == null) log(`WARNING: node '${n}' returned no result`);
      results[n] = waveResults[i];
      done.add(n);
    });
    continue;
  }

  // only gate/manual nodes are ready -> halt and hand control back
  const haltNode = ready[0];
  return {
    status: 'halted',
    halted: haltNode,
    kind: NODES[haltNode].kind,
    instruction: NODES[haltNode].instruction,
    completed: [...done],
    results,
    resume: { nodes: selected, done: [...done, haltNode] }
  };
}
