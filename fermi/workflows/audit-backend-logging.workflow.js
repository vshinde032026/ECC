export const meta = {
  name: 'audit-backend-logging',
  description:
    'Batched logging sweep across a backend service (routes, service layer, agents, tasks, external clients by default; scope: routes restricts to handlers). ONE auditor agent per BATCH of files runs the audit -> fix -> re-audit loop internally per file against the SuperStem/Fermi logging-platform standard; a small independent read-only sample verifies the fixes. ~1 agent per 8 files, not 5 agents per file.',
  phases: [
    { title: 'Discover', detail: 'list modules + grep-triage likely-dirty ones (when a dir is given)' },
    { title: 'Fix', detail: 'one auditor agent per batch — internal audit -> fix -> re-audit per file' },
    { title: 'Verify', detail: 'independent read-only spot-check of a sample of the results' }
  ]
};

// ---------------------------------------------------------------------------
// audit-backend-logging — a fermi logging sweep, BATCHED (v2).
//
// v1 spawned audit/fix/re-audit as SEPARATE agents per file — ~5 agents/file,
// ~500 agents on a 100-module service. v2 fixes the economics:
//
//   Discover  1 agent    lists modules AND grep-flags likely-dirty ones
//   Fix       ~N/batch   ONE fermi-logging-auditor agent per batch of files
//             agents     (default 8/batch); the agent runs the skill's own
//                        audit -> fix -> re-audit loop INTERNALLY per file,
//                        reading the standard once and amortizing context
//   Verify    <=3 agents independent READ-ONLY re-audit of a ~10% sample;
//                        disputes are reported, not silently re-run
//
//   100 files ~= 1 + 13 + 3 = 17 agents (vs ~500 in v1).
//
// The fermi-logging-auditor agent already carries the fix loop in its own
// definition — v1 wastefully re-implemented that loop with separate agents.
//
// AGENT RESOLUTION: defaults to 'fermi:fermi-logging-auditor'. Pass
// args.agentType: 'general-purpose' if fermi isn't installed — the logging
// standard is ALSO inlined in the prompts, so a generic agent still works.
//
// PARALLEL IS SAFE: batches are disjoint file sets; files within a batch are
// handled sequentially inside one agent. Verify agents are read-only.
//
// SAFETY: batch agents EDIT the working tree (log statements only —
// behavior-preserving). Run on a scratch branch and review the diff.
//
// Caller contract (args) — provide modules OR dir. args MUST be a JSON object:
//   {
//     modules?:   string[],  // explicit file paths to audit
//     dir?:       string,    // a dir (routers dir OR service root) to discover modules in
//     scope?:     string,    // 'service' (default): every module with logic worth logging.
//                            // 'routes': FastAPI route/ws handler modules only.
//     batchSize?: number,    // files per fix agent (default 8, clamped 3..15)
//     maxPasses?: number,    // internal fix -> re-audit rounds per file (default 2, clamped 1..4)
//     verify?:    string,    // 'sample' (default): ~10% independent spot-check; 'none': skip
//     agentType?: string,    // override the auditor agent (default 'fermi:fermi-logging-auditor')
//   }
//
// Returns:
//   { targets, batches, agentType,
//     results: [{ module, clean, changed, remaining[] }],
//     stats: { clean, dirty, changed },
//     verification: { mode, sampled, agreed, disputes: [{module, gaps}] } }
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
const batchSize = boundInt(args.batchSize, 3, 15, 8);
const maxPasses = boundInt(args.maxPasses, 1, 4, 2);
const verifyMode = args.verify === 'none' ? 'none' : 'sample';
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

const CATEGORY_NOTE =
  'Categories 2 and 3 (API entry/response logs) apply ONLY to files containing route/websocket ' +
  'handlers — for pure service/agent/task/client modules mark them N/A (passing) and audit ' +
  'categories 1, 4, 5, 6.';

// ---- schemas --------------------------------------------------------------
const DISCOVER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['modules'],
  properties: {
    modules: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['path'],
        properties: {
          path: { type: 'string' },
          signals: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
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
const BATCH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['files'],
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['module', 'clean', 'changed'],
        properties: {
          module: { type: 'string' },
          clean: { type: 'boolean' },
          changed: { type: 'boolean' },
          remaining: { type: 'array', items: GAP }
        }
      }
    }
  }
};
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['files'],
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['module', 'clean'],
        properties: {
          module: { type: 'string' },
          clean: { type: 'boolean' },
          gaps: { type: 'array', items: GAP }
        }
      }
    }
  }
};

// ==========================================================================
// Phase 1 — Discover + triage (only when a dir was given)
// ==========================================================================
let moduleInfos = explicitModules.map(p => ({ path: p, signals: [] }));
if (!moduleInfos.length) {
  phase('Discover');
  log(`Discovering ${scope === 'routes' ? 'route' : 'service-wide'} modules under ${dir}`);
  const listRule = scope === 'routes'
    ? `files containing FastAPI @router.get/post/put/delete/patch or websocket endpoints`
    : `every module with executable logic worth logging: route/websocket handlers, service-layer ` +
      `functions, agents, background/Celery tasks, streaming/session managers, and clients/helpers ` +
      `that call external systems (DB, Redis, S3, LLM APIs). EXCLUDE: tests, migrations, ` +
      `\`__init__.py\`, pure Pydantic schema/model files, config/constants-only files, and anything ` +
      `under \`app/core/monitoring/\` (platform code, R-028 — never audited by this sweep)`;
  const found = await agent(
    `Two jobs, one pass, for the Python modules under \`${dir}\`.\n` +
    `1. LIST ${listRule}.\n` +
    `2. TRIAGE each listed file with grep (do NOT read files fully): note which of these signals it ` +
    `has — "print(", "logging.getLogger", "basicConfig", "except-no-log" (except: followed by ` +
    `pass/bare raise/return with no logger call), "exc_info=True", "no-logger" (no logger/get_logger ` +
    `anywhere), "fstring-log" (logger.* call with an f-string). Return signals: [] for a file with ` +
    `none. Signals are triage hints, not verdicts — do not exclude a file for having none.`,
    { agentType: 'general-purpose', phase: 'Discover', label: `discover:${dir}`, schema: DISCOVER_SCHEMA }
  );
  moduleInfos = (found && Array.isArray(found.modules) ? found.modules : [])
    .filter(m => m && typeof m.path === 'string' && m.path.trim())
    .map(m => ({ path: m.path, signals: Array.isArray(m.signals) ? m.signals : [] }));
  log(`Found ${moduleInfos.length} module(s), ${moduleInfos.filter(m => m.signals.length).length} with dirty signals`);
}
if (!moduleInfos.length) {
  return { targets: 0, batches: 0, agentType: AGENT, results: [], stats: { clean: 0, dirty: 0, changed: 0 }, verification: { mode: verifyMode, sampled: 0, agreed: 0, disputes: [] } };
}

// ==========================================================================
// Phase 2 — Fix: one auditor agent per batch, dirtiest files first
// ==========================================================================
moduleInfos.sort((a, b) => b.signals.length - a.signals.length);
const batches = [];
for (let i = 0; i < moduleInfos.length; i += batchSize) batches.push(moduleInfos.slice(i, i + batchSize));

phase('Fix');
log(`${moduleInfos.length} file(s) in ${batches.length} batch(es) of <=${batchSize} — one agent per batch`);

const batchPrompt = (batch, n) =>
  `You are auditing and FIXING the logging in the following ${batch.length} backend file(s) — this is ` +
  `batch ${n + 1}/${batches.length} of a service sweep. Process the files ONE AT A TIME, completely:\n` +
  batch.map((m, i) => `${i + 1}. \`${m.path}\`${m.signals.length ? `  (triage signals: ${m.signals.join(', ')})` : ''}`).join('\n') +
  `\n\nFor EACH file, run the full loop from the backend-logging skill: read the file completely; audit ` +
  `all six categories (1 logger setup, 2 API entry logs, 3 API response logs, 4 service-layer inflection ` +
  `points, 5 error/exception logs, 6 platform violations & hygiene); fix every gap with minimal, targeted ` +
  `edits (reuse the existing logger; constant message + extra={...}; do not rewrite surrounding logic); ` +
  `re-read and re-audit; repeat up to ${maxPasses} fix rounds or until clean. Then move to the next file. ` +
  `${CATEGORY_NOTE}\n` +
  `Triage signals are hints from grep — trust your own read over them, in both directions.\n` +
  `Return one entry per file: module (the path as given), clean (true only if every applicable category ` +
  `passes after your fixes), changed (did you edit it), remaining (gaps you could not safely fix, as ` +
  `category + file:line + issue). Every listed file MUST appear in your answer.\n\n${STANDARD_RULES}`;

const batchResults = (await parallel(batches.map((b, n) => () =>
  agent(batchPrompt(b, n), { agentType: AGENT, phase: 'Fix', label: `fix-batch:${n + 1}`, schema: BATCH_SCHEMA })
    .then(r => ({ batch: n, files: (r && Array.isArray(r.files) ? r.files : []) }))
))).filter(Boolean);

// flatten + account for files an agent failed to report (no silent gaps)
const reported = new Map();
for (const br of batchResults) for (const f of br.files) if (f && f.module) reported.set(f.module, f);
const results = moduleInfos.map(m =>
  reported.get(m.path) ||
  { module: m.path, clean: false, changed: false, remaining: [{ category: 'meta', issue: 'batch agent returned no verdict for this file' }] }
);
const unreported = results.filter(r => r.remaining && r.remaining.some(g => g.category === 'meta')).length;
if (unreported) log(`WARNING: ${unreported} file(s) got no verdict from their batch agent`);

// ==========================================================================
// Phase 3 — Verify: independent read-only spot-check of a sample
// ==========================================================================
let verification = { mode: verifyMode, sampled: 0, agreed: 0, disputes: [] };
if (verifyMode === 'sample' && results.length) {
  phase('Verify');
  // deterministic sample (no Math.random in the sandbox): every k-th file the
  // batch agents called clean-or-changed, ~10%, min 2, max 18, <=3 agents
  const candidates = results.filter(r => r.clean === true || r.changed === true).map(r => r.module);
  const target = Math.min(18, Math.max(2, Math.ceil(candidates.length / 10)));
  const step = Math.max(1, Math.floor(candidates.length / target));
  const sample = candidates.filter((_, i) => i % step === 0).slice(0, target);
  if (sample.length) {
    log(`Spot-checking ${sample.length}/${candidates.length} file(s) with independent read-only auditors`);
    const nAgents = Math.min(3, Math.ceil(sample.length / 6)); // ~6 files per verify agent, <=3 agents
    const perAgent = Math.ceil(sample.length / nAgents);
    const groups = [];
    for (let i = 0; i < sample.length; i += perAgent) groups.push(sample.slice(i, i + perAgent));
    const verifyPrompt = (files) =>
      `Independent READ-ONLY verification. Another agent claims these files now conform to the logging ` +
      `standard. Re-audit each against the six categories and report honestly — you are the check on the ` +
      `fixer, do not rubber-stamp. Do NOT edit anything.\n` +
      files.map((f, i) => `${i + 1}. \`${f}\``).join('\n') +
      `\n${CATEGORY_NOTE}\nReturn one entry per file: module, clean, gaps.\n\n${STANDARD_RULES}`;
    const verdicts = (await parallel(groups.map((g, n) => () =>
      agent(verifyPrompt(g), { agentType: AGENT, phase: 'Verify', label: `verify:${n + 1}`, schema: VERIFY_SCHEMA })
    ))).filter(Boolean).flatMap(v => Array.isArray(v.files) ? v.files : []);
    const claimedClean = new Set(results.filter(r => r.clean === true).map(r => r.module));
    const disputes = verdicts.filter(v => v && v.clean === false && claimedClean.has(v.module))
      .map(v => ({ module: v.module, gaps: v.gaps || [] }));
    verification = { mode: verifyMode, sampled: sample.length, agreed: sample.length - disputes.length, disputes };
    if (disputes.length) log(`DISPUTES: ${disputes.length} sampled file(s) failed independent re-audit — review these first`);
  } else {
    log('Verify: nothing claimed clean/changed to sample');
  }
}

const clean = results.filter(r => r.clean === true).length;
return {
  targets: moduleInfos.length,
  batches: batches.length,
  agentType: AGENT,
  results,
  stats: { clean, dirty: results.length - clean, changed: results.filter(r => r.changed === true).length },
  verification
};

function boundInt(n, lo, hi, dflt) {
  n = Number.isFinite(n) ? Math.floor(n) : dflt;
  return Math.max(lo, Math.min(hi, n));
}
