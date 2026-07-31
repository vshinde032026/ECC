export const meta = {
  name: 'audit-backend-logging',
  description:
    'Sweep the backend-logging auditor across a backend service — routes, service layer, agents, tasks, and external-system clients by default (scope: routes restricts to handlers). Per module runs a bounded audit -> fix -> re-audit loop until it conforms to the SuperStem/Fermi logging-platform standard (constant message + structured extra{}, platform-injected fields not hand-rolled, correct levels, errors routed to Sentry via logger.exception). Modules are independent files, so they run in parallel.',
  phases: [
    { title: 'Discover', detail: 'list route modules to audit (when a dir is given)' },
    { title: 'Audit', detail: 'per module: audit the logging against the 6 categories' },
    { title: 'Fix', detail: 'per module: fix gaps, then re-audit, bounded passes' }
  ]
};

// ---------------------------------------------------------------------------
// audit-backend-logging — a fermi logging sweep.
//
// Drives the fermi-logging-auditor agent (the modular unit that carries the
// backend-logging skill). The loop logic is inlined — the Workflow tool sandbox
// can't require() a shared lib.
//
// AGENT RESOLUTION: defaults to 'fermi:fermi-logging-auditor', which requires
// fermi to be installed as a plugin in the target repo. If it isn't, pass
// args.agentType: 'ecc:python-reviewer' (or 'general-purpose') — the logging
// standard rules are ALSO inlined in the prompts below, so a generic agent still
// works, just less specialized.
//
// PARALLEL IS SAFE HERE (unlike refactor-module): each module is a distinct
// file, so concurrent edits don't collide. refactor-module went sequential only
// because its units shared files within one module.
//
// SAFETY: the agent EDITS the working tree (adds/adjusts log statements only —
// behavior-preserving). Run on a scratch branch and review the diff.
//
// Caller contract (args) — provide modules OR dir:
//   {
//     modules?:   string[],  // explicit file paths to audit
//     dir?:       string,    // a dir (routers dir OR service root) to discover modules in
//     scope?:     string,    // 'service' (default): every module with logic worth logging —
//                            // routes, ws handlers, services, agents, tasks, external clients.
//                            // 'routes': FastAPI route/ws handler modules only.
//     agentType?: string,    // override the auditor agent (default 'fermi:fermi-logging-auditor')
//     maxPasses?: number,    // fix -> re-audit rounds per module (default 2)
//   }
//
// Returns:
//   { targets, agentType,
//     results: [{ module, clean, passes, remaining[] }],
//     stats: { clean, dirty } }
// ---------------------------------------------------------------------------

// the harness sometimes delivers args as a JSON-encoded string — accept both
if (typeof args === 'string') {
  try { args = JSON.parse(args); } catch (e) {
    throw new Error('audit-backend-logging: args must be a JSON OBJECT, e.g. {"dir":"euler-api/app"} — got a non-JSON string. Re-invoke Workflow with args as an object literal, not prose.');
  }
}
if (!args || typeof args !== 'object') throw new Error('audit-backend-logging: args object required');
const explicitModules = Array.isArray(args.modules) ? args.modules.filter(m => typeof m === 'string' && m.trim()) : [];
const dir = typeof args.dir === 'string' ? args.dir.trim() : '';
if (!explicitModules.length && !dir) throw new Error('audit-backend-logging: provide args.modules[] or args.dir');
const AGENT = typeof args.agentType === 'string' && args.agentType.trim() ? args.agentType.trim() : 'fermi:fermi-logging-auditor';
const maxPasses = boundInt(args.maxPasses, 1, 4, 2);
const scope = args.scope === 'routes' ? 'routes' : 'service';

// Logging-platform standard, inlined so a generic agent still behaves. Mirrors
// the backend-logging skill / console-log standard.
const STANDARD_RULES = [
  'Logger: `from app.core.monitoring import get_logger` then `logger = get_logger(__name__)`. Never logging.getLogger in new code, never basicConfig, never print() in served code.',
  'Structured context: message is a CONSTANT string; every variable goes in extra={...}. f-string interpolation of a field is a finding.',
  'Do NOT hand-roll platform-injected fields: request_id, service, env, version, timestamp, user_id, and the HTTP access log are automatic. Adding them (or a request received/completed pair) is a finding.',
  'Errors: expected/handled -> logger.warning (no traceback). Unexpected -> logger.exception (traceback INCLUDED; ERROR auto-forwards to Sentry). Never logger.error for an expected condition; never logger.error(..., exc_info=True) by hand. A swallowed except (no log) is the top finding.',
  'Levels: DEBUG (cache miss/pre-call, off in prod) · INFO (normal flow) · WARNING (expected problems) · ERROR/exception (unexpected, pages Sentry).',
  'Security/cost: never log secrets, tokens, Authorization headers, raw bodies, full LLM prompts/completions; prefer user_id over email; log len(), not the list. No logging in hot loops / per-chunk streaming.',
  'Celery dispatch logs include task name + queue + key arg. Cache-hit early returns must be logged as a cache hit.',
  'Behavior-preserving: add/adjust log statements only. Twin rule R-028: if the change is under app/core/monitoring/**, STOP (mirror across services in one PR). Respect LEGACY_QUARANTINE.md. Never touch euler-backend/ (dead copy).'
].map(s => `- ${s}`).join('\n');

// ---- schemas --------------------------------------------------------------
const DISCOVER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['modules'],
  properties: { modules: { type: 'array', items: { type: 'string' } } }
};
const GAP = {
  type: 'object', additionalProperties: false, required: ['category', 'issue'],
  properties: {
    category: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'integer' },
    issue: { type: 'string' }
  }
};
const AUDIT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['clean', 'gaps'],
  properties: {
    clean: { type: 'boolean' },
    categoriesPassing: { type: 'integer' },
    gaps: { type: 'array', items: GAP }
  }
};
const FIX_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['changed'],
  properties: {
    changed: { type: 'boolean' },
    summary: { type: 'string' }
  }
};

// ---- prompts --------------------------------------------------------------
const auditPrompt = (m) =>
  `Audit the logging in \`${m}\` against the backend-logging skill's six categories ` +
  `(1 logger setup, 2 API entry logs, 3 API response logs, 4 service-layer inflection points, ` +
  `5 error/exception logs, 6 platform violations & hygiene). ` +
  `Read the full file first. Do NOT edit in this step — just report. Categories 2 and 3 apply ` +
  `ONLY to files containing route/websocket handlers — for pure service/agent/task/client ` +
  `modules mark them N/A (passing) and audit categories 1, 4, 5, 6. Set clean=true only if every ` +
  `applicable category passes with no gaps. List each gap as category + file:line + issue.\n\n${STANDARD_RULES}`;

const fixPrompt = (m, gaps) =>
  `Fix the logging gaps in \`${m}\` with minimal, targeted edits (reuse the existing logger; add the ` +
  `setup block only if missing; constant message + extra={...}; do not rewrite surrounding logic). Gaps to resolve:\n` +
  (gaps || []).map((g, n) => `${n + 1}. [${g.category}] ${g.file || m}${g.line ? ':' + g.line : ''} — ${g.issue}`).join('\n') +
  `\n\n${STANDARD_RULES}`;

// ==========================================================================
// Phase 1 — Discover (only when a dir was given instead of explicit modules)
// ==========================================================================
let modules = explicitModules;
if (!modules.length) {
  phase('Discover');
  log(`Discovering ${scope === 'routes' ? 'route' : 'service-wide'} modules under ${dir}`);
  const discoverPrompt = scope === 'routes'
    ? `List the Python route/handler modules under \`${dir}\` — files containing FastAPI ` +
      `@router.get/post/put/delete/patch or websocket endpoints. Return their file paths only.`
    : `List EVERY Python module under \`${dir}\` that contains executable logic worth logging: ` +
      `route/websocket handlers, service-layer functions, agents, background/Celery tasks, ` +
      `streaming/session managers, and clients/helpers that call external systems (DB, Redis, S3, ` +
      `LLM APIs). EXCLUDE: tests, migrations, \`__init__.py\`, pure Pydantic schema/model files, ` +
      `config/constants-only files, and anything under \`app/core/monitoring/\` (platform code, ` +
      `R-028 — never audited by this sweep). Return file paths only.`;
  const found = await agent(
    discoverPrompt,
    { agentType: 'general-purpose', phase: 'Discover', label: `discover:${dir}`, schema: DISCOVER_SCHEMA }
  );
  modules = (found && Array.isArray(found.modules) ? found.modules : []).filter(Boolean);
  log(`Found ${modules.length} module(s)`);
}
if (!modules.length) return { targets: 0, agentType: AGENT, results: [], stats: { clean: 0, dirty: 0 } };

// ==========================================================================
// Phase 2/3 — per module: bounded audit -> fix -> re-audit loop, in parallel
// (distinct files, so concurrent edits are safe)
// ==========================================================================
phase('Audit');
const results = (await parallel(modules.map(m => () => auditModule(m)))).filter(Boolean);

const clean = results.filter(r => r.clean).length;
return {
  targets: modules.length,
  agentType: AGENT,
  results,
  stats: { clean, dirty: results.length - clean }
};

// ---- per-module loop ------------------------------------------------------
async function auditModule(m) {
  let audit = await agent(auditPrompt(m), { agentType: AGENT, phase: 'Audit', label: `audit:${m}`, schema: AUDIT_SCHEMA });
  if (!audit) return { module: m, clean: false, passes: 0, remaining: [{ category: 'meta', issue: 'auditor returned null' }] };
  let pass = 0;
  while (audit.clean !== true && pass < maxPasses) {
    await agent(fixPrompt(m, audit.gaps), { agentType: AGENT, phase: 'Fix', label: `fix:${m}:p${pass + 1}`, schema: FIX_SCHEMA });
    const re = await agent(auditPrompt(m), { agentType: AGENT, phase: 'Fix', label: `re-audit:${m}:p${pass + 1}`, schema: AUDIT_SCHEMA });
    if (re) audit = re;
    pass++;
  }
  return { module: m, clean: audit.clean === true, passes: pass, remaining: audit.clean === true ? [] : (audit.gaps || []) };
}

function boundInt(n, lo, hi, dflt) {
  n = Number.isFinite(n) ? Math.floor(n) : dflt;
  return Math.max(lo, Math.min(hi, n));
}
