export const meta = {
  name: 'audit-backend-logging',
  description:
    'Flow-based logging sweep: per router, backtrack every route through the service functions to the data layer, judge where logs are REQUIRED along each chain (and what is redundant across layers), then add them. Trace is read-only and parallel per router; edits are applied per FILE (disjoint, parallel) from the merged per-file gap list; a sample of routes is re-traced read-only to verify. Conforms to the SuperStem/Fermi logging-platform standard.',
  phases: [
    { title: 'Map', detail: 'list entry points: router modules + non-routed Celery tasks' },
    { title: 'Trace', detail: 'per router: backtrack every route to the data layer, judge the chain (read-only)' },
    { title: 'Apply', detail: 'per file batch: apply the merged gap list (disjoint files, parallel)' },
    { title: 'Verify', detail: 'independent read-only re-trace of a sample of routes' }
  ]
};

// ---------------------------------------------------------------------------
// audit-backend-logging — flow-based (v3).
//
// v1 audited per file with separate audit/fix/re-audit agents (~5 agents/file,
// ~500 on a service). v2 batched files (~17 agents/100 files) but still judged
// files in isolation. v3 works the way an engineer does:
//
//   pick each router -> backtrack every route it serves -> through the service
//   functions -> down to the data layer / external clients / celery dispatch ->
//   decide where logs are REQUIRED along that chain -> add them.
//
// Why trace and apply are separate phases: different routers call the SAME
// shared service files. Tracing is read-only, so one-agent-per-router is
// parallel-safe; edits are re-grouped BY FILE (each file appears in exactly one
// apply batch), so appliers never collide. Chain-level judgment happens at
// trace time; appliers execute the merged, deduped gap list.
//
// What flow coverage means: code is audited because a FLOW reaches it. The Map
// phase also lists Celery/beat tasks NOT dispatched from any route so those
// chains get traced too. A file no flow reaches is dead weight for logging
// purposes (and probably a LEGACY_QUARANTINE candidate).
//
// Agent economics (E entry modules, F files with gaps):
//   1 map + ceil(E/traceBatch) trace + ceil(F/applyBatch) apply + <=3 verify
//   euler-api (~14 routers): 1 + 5 + ~4 + 2  ~= 12 agents
//
// AGENT RESOLUTION: defaults to 'fermi:fermi-logging-auditor'. Pass
// args.agentType: 'general-purpose' if fermi isn't installed — the logging
// standard is ALSO inlined in the prompts.
//
// SAFETY: apply agents EDIT the working tree (log statements only —
// behavior-preserving). Run on a scratch branch and review the diff.
//
// Caller contract (args) — provide modules OR dir. args MUST be a JSON object:
//   {
//     dir?:        string,    // service root (e.g. "euler-api/app") — entry points discovered
//     modules?:    string[],  // explicit entry-point modules (router/task files) to trace
//     traceBatch?: number,    // entry modules per trace agent (default 3, clamped 1..6)
//     applyBatch?: number,    // files per apply agent (default 8, clamped 3..15)
//     verify?:     string,    // 'sample' (default): re-trace ~10% of routes; 'none': skip
//     agentType?:  string,    // override the auditor agent (default 'fermi:fermi-logging-auditor')
//   }
//
// Returns:
//   { entryPoints, routesTraced, gaps, filesTouched, agentType,
//     trace:  [{ entry, routes, gaps }],
//     apply:  [{ file, changed, applied, skipped[] }],
//     verification: { mode, sampledRoutes, agreed, disputes: [{route, gaps}] } }
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
const traceBatch = boundInt(args.traceBatch, 1, 6, 3);
const applyBatch = boundInt(args.applyBatch, 3, 15, 8);
const verifyMode = args.verify === 'none' ? 'none' : 'sample';

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

const CHAIN_RULES = [
  'Each layer logs ITS OWN concern, once per flow: router = entry (action + key ids in extra) and response summary; service = business inflection points (cache hit/miss, zero rows, external call about to happen, celery dispatch, state change); data layer / external clients = their own failures.',
  'Judge the CHAIN, not the file: the same event logged at two layers is a redundancy finding (keep the layer that owns it); an error swallowed anywhere in the chain with no log is the top finding; a chain where a failure at the bottom surfaces at the top with no breadcrumb in between is a gap at the middle layer.',
  'Trace through: handler -> every service function it calls -> data-layer/CRUD helpers -> external clients (DB, Redis, S3, LLM, HTTP) -> celery .delay/.apply_async hand-offs. Stop at package boundaries (third-party libs) and at app/core/monitoring/** (platform, R-028 — never a finding target).'
].map(s => `- ${s}`).join('\n');

// ---- schemas --------------------------------------------------------------
const MAP_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['path', 'kind'],
        properties: {
          path: { type: 'string' },
          kind: { type: 'string', enum: ['router', 'task'] }
        }
      }
    }
  }
};
const TRACE_GAP = {
  type: 'object', additionalProperties: false, required: ['file', 'layer', 'route', 'action'],
  properties: {
    file: { type: 'string' },
    line: { type: 'integer' },
    layer: { type: 'string', enum: ['router', 'service', 'data', 'external', 'task'] },
    route: { type: 'string' },
    action: { type: 'string' },
    category: { type: 'string' }
  }
};
const TRACE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['traced', 'gaps'],
  properties: {
    traced: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['entry', 'routes'],
        properties: {
          entry: { type: 'string' },
          routes: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    gaps: { type: 'array', items: TRACE_GAP }
  }
};
const APPLY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['files'],
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['file', 'changed', 'applied'],
        properties: {
          file: { type: 'string' },
          changed: { type: 'boolean' },
          applied: { type: 'integer' },
          skipped: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
};
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['routes'],
  properties: {
    routes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['route', 'clean'],
        properties: {
          route: { type: 'string' },
          clean: { type: 'boolean' },
          gaps: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
};

// ==========================================================================
// Phase 1 — Map: entry points (routers + non-routed Celery tasks)
// ==========================================================================
let entries = explicitModules.map(p => ({ path: p, kind: 'router' }));
if (!entries.length) {
  phase('Map');
  log(`Mapping entry points under ${dir}`);
  const found = await agent(
    `List the FLOW ENTRY POINTS under \`${dir}\`:\n` +
    `1. kind "router": every module containing FastAPI @router.get/post/put/delete/patch or ` +
    `websocket endpoints.\n` +
    `2. kind "task": every module defining Celery tasks or beat jobs that are NOT dispatched from ` +
    `any route (standalone/scheduled flows) — these chains must be traced too.\n` +
    `EXCLUDE tests, migrations, \`__init__.py\`, and \`app/core/monitoring/\` (platform, R-028). ` +
    `Return file paths + kind only — do not read files fully.`,
    { agentType: 'general-purpose', phase: 'Map', label: `map:${dir}`, schema: MAP_SCHEMA }
  );
  entries = (found && Array.isArray(found.entries) ? found.entries : [])
    .filter(e => e && typeof e.path === 'string' && e.path.trim());
  log(`${entries.length} entry module(s): ${entries.filter(e => e.kind === 'router').length} router, ${entries.filter(e => e.kind === 'task').length} task`);
}
if (!entries.length) {
  return { entryPoints: 0, routesTraced: 0, gaps: 0, filesTouched: 0, agentType: AGENT, trace: [], apply: [], verification: { mode: verifyMode, sampledRoutes: 0, agreed: 0, disputes: [] } };
}

// ==========================================================================
// Phase 2 — Trace: per entry module, backtrack every route to the data layer
// (READ-ONLY -> parallel is safe even though flows share service files)
// ==========================================================================
phase('Trace');
const traceGroups = [];
for (let i = 0; i < entries.length; i += traceBatch) traceGroups.push(entries.slice(i, i + traceBatch));
log(`Tracing ${entries.length} entry module(s) in ${traceGroups.length} agent(s)`);

const tracePrompt = (group, n) =>
  `READ-ONLY flow trace, group ${n + 1}/${traceGroups.length}. For EACH entry module below, work exactly ` +
  `like an engineer doing this by hand: enumerate every route/task it defines, then BACKTRACK each one — ` +
  `handler -> the service functions it calls -> down to the data layer, external clients, and celery ` +
  `hand-offs. Read every file on the chain.\n` +
  group.map((e, i) => `${i + 1}. \`${e.path}\` (${e.kind})`).join('\n') +
  `\n\nFor each chain, decide where logs are REQUIRED and what is wrong/redundant, per the rules below. ` +
  `Report each needed change as a gap: file + (line if known) + layer (router|service|data|external|task) + ` +
  `route (e.g. "POST /api/notebook/blocks" or task name) + action (the concrete log to add/change/remove, ` +
  `one sentence, specific enough that another agent can apply it without re-tracing).\n` +
  `Do NOT edit anything. Report routes you traced under traced[].\n\n${CHAIN_RULES}\n\n${STANDARD_RULES}`;

const traceResults = (await parallel(traceGroups.map((g, n) => () =>
  agent(tracePrompt(g, n), { agentType: AGENT, phase: 'Trace', label: `trace:${n + 1}`, schema: TRACE_SCHEMA })
))).filter(Boolean);

const traced = traceResults.flatMap(t => Array.isArray(t.traced) ? t.traced : []);
const allGaps = traceResults.flatMap(t => Array.isArray(t.gaps) ? t.gaps : []);
const routesTraced = traced.reduce((n, t) => n + (t.routes ? t.routes.length : 0), 0);
const tracedEntries = new Set(traced.map(t => t.entry));
const untraced = entries.filter(e => !tracedEntries.has(e.path));
if (untraced.length) log(`WARNING: ${untraced.length} entry module(s) not reported by trace agents: ${untraced.map(e => e.path).join(', ')}`);
log(`${routesTraced} route(s)/task(s) traced, ${allGaps.length} gap(s) found`);

// ==========================================================================
// Phase 3 — Apply: merge gaps BY FILE (shared services get the union of every
// flow's demands), then one agent per disjoint file batch
// ==========================================================================
let applyResults = [];
if (allGaps.length) {
  phase('Apply');
  const byFile = new Map();
  for (const g of allGaps) {
    if (!g || !g.file) continue;
    if (!byFile.has(g.file)) byFile.set(g.file, []);
    byFile.get(g.file).push(g);
  }
  const files = [...byFile.keys()];
  const applyGroups = [];
  for (let i = 0; i < files.length; i += applyBatch) applyGroups.push(files.slice(i, i + applyBatch));
  log(`Applying ${allGaps.length} gap(s) across ${files.length} file(s) in ${applyGroups.length} agent(s)`);

  const applyPrompt = (groupFiles, n) =>
    `Apply the logging gaps below, batch ${n + 1}/${applyGroups.length}. They were produced by tracing ` +
    `whole request flows; several flows may demand similar logs at the same spot — DEDUPE: one log per ` +
    `event per layer. Read each file before editing; minimal, targeted, behavior-preserving edits only ` +
    `(log statements; add the logger setup block only if missing). After editing a file, re-read it and ` +
    `confirm the gaps are addressed.\n\n` +
    groupFiles.map(f =>
      `\`${f}\`:\n` + byFile.get(f).map((g, i) => `  ${i + 1}. [${g.layer}] (${g.route}) ${g.action}${g.line ? ` (near line ${g.line})` : ''}`).join('\n')
    ).join('\n\n') +
    `\n\nReturn one entry per file: file, changed, applied (count), skipped (gap you did not apply + why — ` +
    `unsafe, already covered, or wrong on inspection). Every listed file MUST appear in your answer.\n\n${STANDARD_RULES}`;

  applyResults = (await parallel(applyGroups.map((g, n) => () =>
    agent(applyPrompt(g, n), { agentType: AGENT, phase: 'Apply', label: `apply:${n + 1}`, schema: APPLY_SCHEMA })
  ))).filter(Boolean).flatMap(r => Array.isArray(r.files) ? r.files : []);

  const reportedFiles = new Set(applyResults.map(f => f.file));
  for (const f of files) {
    if (!reportedFiles.has(f)) {
      applyResults.push({ file: f, changed: false, applied: 0, skipped: ['apply agent returned no verdict for this file'] });
      log(`WARNING: no apply verdict for ${f}`);
    }
  }
} else {
  log('No gaps found — nothing to apply');
}

// ==========================================================================
// Phase 4 — Verify: independent read-only re-trace of a sample of routes
// ==========================================================================
let verification = { mode: verifyMode, sampledRoutes: 0, agreed: 0, disputes: [] };
if (verifyMode === 'sample' && allGaps.length) {
  phase('Verify');
  const allRoutes = [...new Set(allGaps.map(g => g.route).filter(Boolean))];
  const target = Math.min(12, Math.max(2, Math.ceil(allRoutes.length / 10)));
  const step = Math.max(1, Math.floor(allRoutes.length / target));
  const sample = allRoutes.filter((_, i) => i % step === 0).slice(0, target);
  if (sample.length) {
    log(`Re-tracing ${sample.length}/${allRoutes.length} route(s) with independent read-only auditors`);
    const nAgents = Math.min(3, Math.ceil(sample.length / 4)); // ~4 routes per verify agent
    const perAgent = Math.ceil(sample.length / nAgents);
    const groups = [];
    for (let i = 0; i < sample.length; i += perAgent) groups.push(sample.slice(i, i + perAgent));
    const verifyPrompt = (routes) =>
      `Independent READ-ONLY verification. Fixes were just applied along these flows; re-trace each one ` +
      `end-to-end (handler -> services -> data layer) and judge whether the chain's logging now conforms — ` +
      `you are the check on the fixer, do not rubber-stamp. Do NOT edit.\n` +
      routes.map((r, i) => `${i + 1}. ${r}`).join('\n') +
      `\nReturn one entry per route: route, clean, gaps (what is still wrong, as strings).\n\n${CHAIN_RULES}\n\n${STANDARD_RULES}`;
    const verdicts = (await parallel(groups.map((g, n) => () =>
      agent(verifyPrompt(g), { agentType: AGENT, phase: 'Verify', label: `verify:${n + 1}`, schema: VERIFY_SCHEMA })
    ))).filter(Boolean).flatMap(v => Array.isArray(v.routes) ? v.routes : []);
    const disputes = verdicts.filter(v => v && v.clean === false).map(v => ({ route: v.route, gaps: v.gaps || [] }));
    verification = { mode: verifyMode, sampledRoutes: sample.length, agreed: sample.length - disputes.length, disputes };
    if (disputes.length) log(`DISPUTES: ${disputes.length} re-traced route(s) still have chain gaps — review these first`);
  }
}

return {
  entryPoints: entries.length,
  routesTraced,
  gaps: allGaps.length,
  filesTouched: applyResults.filter(f => f.changed === true).length,
  agentType: AGENT,
  trace: traced.map(t => {
    const routeSet = new Set(t.routes || []);
    return { entry: t.entry, routes: t.routes || [], gaps: allGaps.filter(g => routeSet.has(g.route)).length };
  }),
  apply: applyResults,
  verification
};

function boundInt(n, lo, hi, dflt) {
  n = Number.isFinite(n) ? Math.floor(n) : dflt;
  return Math.max(lo, Math.min(hi, n));
}
