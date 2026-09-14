export const meta = {
  name: 'audit-backend-logging',
  description:
    'Census-driven flow-based logging sweep. A deterministic AST script (scripts/logging_census.py) builds the entry-point table (routers, Celery tasks, middleware, signals), call chains, and every mechanical violation of the SuperStem/Fermi logging standard — zero tokens. Agents then do only judgment: trace each flow over the precomputed chains and decide where logs are REQUIRED / redundant; appliers fix judgment gaps AND run the linter on their files; verification is mechanical re-lint + read-only re-trace of sampled routes. Lanes: mechanical (lint-fix only, cheapest), judgment (flow tracing), both (default).',
  phases: [
    { title: 'Census', detail: 'run logging_census.py — entry points, chains, mechanical violations (1 agent, ~0 tokens of reading)' },
    { title: 'Trace', detail: 'judgment lane: per entry, walk the precomputed chain, judge the flow (read-only)' },
    { title: 'Apply', detail: 'per file batch: fix judgment gaps + every lint violation in the batch files' },
    { title: 'Verify', detail: 're-lint touched files (mechanical) + re-trace sampled routes (judgment)' }
  ]
};

// ---------------------------------------------------------------------------
// audit-backend-logging — census-driven (v4).
//
// v3 used agents to MAP entry points and TRACE call chains by reading code —
// deterministic work paid for in tokens, with blind spots (middleware, DI,
// signal hookups, dispatched task bodies, dynamic dispatch went unseen).
// v4 moves the mechanical substrate to scripts/logging_census.py (stdlib AST,
// seconds, free) and spends agents ONLY on judgment:
//
//   Census   1 agent    runs the script; returns entry table + per-file
//                       violation counts (violations THEMSELVES never travel
//                       through prompts — appliers re-run the linter locally)
//   Trace    judgment   per entry module, over PRECOMPUTED chains: where are
//            lane       logs REQUIRED, what is redundant across layers
//   Apply    per-file   disjoint batches; fix judgment gaps AND `--lint
//            batches    --files <batch>` violations in the same pass
//   Verify   cheap      re-lint touched files must be CLEAN (mechanical);
//                       re-trace a sample of ALL traced routes (judgment) —
//                       sampled from all routes, not just gap-carrying ones
//
// Real numbers (study-tools): euler-api = 274 files, 14 routers, 539
// mechanical violations; main backend = 1288 files, 224 entry points
// (171 routers + 52 tasks + 1 signal), 2461 violations — census in seconds.
//
// LANES:
//   'mechanical' — no trace agents at all: census + lint-fix appliers +
//                  re-lint verify. The cheap first pass (fixes prints,
//                  getLogger, swallowed excepts, f-string logs, exc_info).
//   'judgment'   — flow tracing + judgment gaps only (assumes mechanical
//                  debt already cleared or handled separately).
//   'both'       — default.
//
// SAFETY: apply agents EDIT the working tree (log statements only —
// behavior-preserving). Run on a scratch branch and review the diff.
//
// Caller contract (args) — args MUST be a JSON object:
//   {
//     dir:         string,    // service root package dir, e.g. "euler-api/app" (required)
//     pluginRoot?: string,    // fermi plugin root (command passes ${CLAUDE_PLUGIN_ROOT});
//                             // if absent the census agent locates the script or falls
//                             // back to reading the tree itself
//     lanes?:      string,    // 'both' (default) | 'mechanical' | 'judgment'
//     entries?:    string[],  // restrict the judgment lane to these entry modules
//     traceBatch?: number,    // entry modules per trace agent (default 3, clamped 1..6)
//     applyBatch?: number,    // files per apply agent (default 8, clamped 3..15)
//     verify?:     string,    // 'sample' (default) | 'none'
//     agentType?:  string,    // override (default 'fermi:fermi-logging-auditor')
//   }
//
// Returns:
//   { censusPath, entryPoints, lanes, routesTraced, judgmentGaps,
//     mechanicalFiles, filesTouched, agentType,
//     apply: [{file, changed, applied, skipped[]}],
//     verification: { lint: {ran, clean, remaining}, flows: {sampledRoutes, agreed, disputes[]} } }
// ---------------------------------------------------------------------------

// the harness sometimes delivers args as a JSON-encoded string — accept both
if (typeof args === 'string') {
  try { args = JSON.parse(args); } catch (e) {
    throw new Error('audit-backend-logging: args must be a JSON OBJECT, e.g. {"dir":"euler-api/app"} — got a non-JSON string. Re-invoke Workflow with args as an object literal, not prose.');
  }
}
if (!args || typeof args !== 'object') throw new Error('audit-backend-logging: args object required');
const dir = typeof args.dir === 'string' ? args.dir.trim() : '';
if (!dir) throw new Error('audit-backend-logging: args.dir (service root, e.g. "euler-api/app") is required');
const pluginRoot = typeof args.pluginRoot === 'string' ? args.pluginRoot.trim() : '';
const lanes = args.lanes === 'mechanical' || args.lanes === 'judgment' ? args.lanes : 'both';
const onlyEntries = Array.isArray(args.entries) ? args.entries.filter(e => typeof e === 'string' && e.trim()) : [];
const AGENT = typeof args.agentType === 'string' && args.agentType.trim() ? args.agentType.trim() : 'fermi:fermi-logging-auditor';
const traceBatch = boundInt(args.traceBatch, 1, 6, 3);
const applyBatch = boundInt(args.applyBatch, 3, 15, 8);
const verifyMode = args.verify === 'none' ? 'none' : 'sample';

const STANDARD_RULES = [
  'Logger: `from app.core.monitoring import get_logger` then `logger = get_logger(__name__)`. Never logging.getLogger in new code, never basicConfig, never print() in served code.',
  'Structured context: message is a CONSTANT string; every variable goes in extra={...}. f-string interpolation of a field is a finding.',
  'Do NOT hand-roll platform-injected fields: request_id, service, env, version, timestamp, user_id, and the HTTP access log are automatic. Adding them (or a request received/completed pair) is a finding.',
  'Errors: expected/handled -> logger.warning (no traceback). Unexpected -> logger.exception (traceback INCLUDED; ERROR auto-forwards to Sentry). Never logger.error for an expected condition; never logger.error(..., exc_info=True) by hand. A swallowed except (no log) is the top finding.',
  'Levels: DEBUG (cache miss/pre-call, off in prod) · INFO (normal flow) · WARNING (expected problems) · ERROR/exception (unexpected, pages Sentry).',
  'Security/cost: never log secrets, tokens, Authorization headers, raw bodies, full LLM prompts/completions; prefer user_id over email; log len(), not the list. No logging in hot loops / per-chunk streaming.',
  'Celery dispatch logs include task name + queue + key arg. Cache-hit early returns must be logged as a cache hit.',
  'Use the EVENT CATALOG in the backend-logging skill for message shape + extra keys — the same event type must produce the same-shaped log everywhere.',
  'Behavior-preserving: add/adjust log statements only. Twin rule R-028: if the change is under app/core/monitoring/**, STOP (mirror across services in one PR). Respect LEGACY_QUARANTINE.md. Never touch euler-backend/ (dead copy).'
].map(s => `- ${s}`).join('\n');

const CHAIN_RULES = [
  'Each layer logs ITS OWN concern, once per flow: router = entry (action + key ids in extra) and response summary; service = business inflection points (cache hit/miss, zero rows, external call about to happen, celery dispatch, state change); data layer / external clients = their own failures.',
  'Judge the CHAIN, not the file: the same event logged at two layers is a redundancy finding (keep the layer that owns it); an error swallowed anywhere in the chain with no log is the top finding; a chain where a failure at the bottom surfaces at the top with no breadcrumb in between is a gap at the middle layer.',
  'Mechanical violations (print, getLogger, f-string logs, except-no-log, exc_info) are handled by the lint lane — do NOT re-report them; report only judgment gaps: missing/redundant/misleveled/misplaced logs.',
  'The census marks DYNAMIC dispatch sites (registry lookups, getattr calls) in your chain files — resolve what they dispatch to and follow those targets; that is exactly what the static pass could not do.'
].map(s => `- ${s}`).join('\n');

// ---- schemas --------------------------------------------------------------
const CENSUS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['censusPath', 'entries', 'violationFiles'],
  properties: {
    censusPath: { type: 'string' },
    entries: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['path', 'kind'],
        properties: {
          path: { type: 'string' },
          kind: { type: 'string', enum: ['router', 'task', 'middleware', 'signal'] },
          handlers: { type: 'integer' }
        }
      }
    },
    violationFiles: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['file', 'count'],
        properties: { file: { type: 'string' }, count: { type: 'integer' } }
      }
    },
    dynamicSites: { type: 'integer' }
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
        properties: { entry: { type: 'string' }, routes: { type: 'array', items: { type: 'string' } } }
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
const LINT_VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['clean', 'remaining'],
  properties: { clean: { type: 'boolean' }, remaining: { type: 'integer' }, sample: { type: 'array', items: { type: 'string' } } }
};
const FLOW_VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['routes'],
  properties: {
    routes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['route', 'clean'],
        properties: { route: { type: 'string' }, clean: { type: 'boolean' }, gaps: { type: 'array', items: { type: 'string' } } }
      }
    }
  }
};

const CENSUS_CMD = (root) => root
  ? `python3 "${root}/scripts/logging_census.py"`
  : `python3 "$(find ~/.claude/plugins -name logging_census.py -path '*fermi*' 2>/dev/null | head -1)"`;

// ==========================================================================
// Phase 1 — Census (1 agent runs the deterministic script)
// ==========================================================================
phase('Census');
log(`Running logging census on ${dir}`);
const census = await agent(
  `Run the fermi logging census script on this service and relay its output.\n` +
  `1. Run: ${CENSUS_CMD(pluginRoot)} ${dir} --out /tmp/fermi-census.json\n` +
  `   (If the script cannot be found, fall back to building the same data yourself by listing ` +
  `router/task/middleware/signal modules under ${dir} — but PREFER the script.)\n` +
  `2. From its stdout summary return: censusPath (the --out path, or "" if you fell back), ` +
  `entries (path/kind/handlers for every entrypoint), violationFiles (per-file mechanical ` +
  `violation counts — get them via: ${CENSUS_CMD(pluginRoot)} ${dir} --lint | cut -d: -f1 | sort | uniq -c), ` +
  `and dynamicSites. Relay faithfully — do not editorialize or filter.`,
  { agentType: 'general-purpose', phase: 'Census', label: `census:${dir}`, schema: CENSUS_SCHEMA }
);
if (!census) throw new Error('audit-backend-logging: census agent returned nothing');
const censusPath = census.censusPath || '';
let entries = (census.entries || []).filter(e => e && e.path);
if (onlyEntries.length) {
  // match exact paths, path suffixes, or directory prefixes ("notebook" matches
  // "notebook/tasks/x.py") — dev-pipeline passes touched-module DIRS as entries
  entries = entries.filter(e => onlyEntries.some(w =>
    e.path === w || e.path.endsWith(w) || e.path.startsWith(w.endsWith('/') ? w : w + '/')
  ));
}
const violationFiles = (census.violationFiles || []).filter(v => v && v.file && v.count > 0);
log(`${entries.length} entry point(s), ${violationFiles.length} file(s) with mechanical violations, ${census.dynamicSites || 0} dynamic dispatch site(s)`);

// ==========================================================================
// Phase 2 — Trace (judgment lane only; read-only over precomputed chains)
// ==========================================================================
let allGaps = [];
let traced = [];
if (lanes !== 'mechanical' && entries.length) {
  phase('Trace');
  const groups = [];
  for (let i = 0; i < entries.length; i += traceBatch) groups.push(entries.slice(i, i + traceBatch));
  log(`Tracing ${entries.length} entry module(s) in ${groups.length} agent(s)`);
  const tracePrompt = (group, n) =>
    `READ-ONLY flow judgment, group ${n + 1}/${groups.length}. ` +
    (censusPath
      ? `The call-graph census is at \`${censusPath}\` — for each entry module below, read its "chain" ` +
        `from the census entrypoints (plus per-file logs/excepts inventories) instead of re-deriving them. `
      : `No census file — derive each entry's chain by reading its imports. `) +
    `For EACH entry, enumerate its routes/tasks and walk each chain like an engineer: handler -> service ` +
    `functions -> data layer / external clients / celery hand-offs. Read the chain files.\n` +
    group.map((e, i) => `${i + 1}. \`${e.path}\` (${e.kind})`).join('\n') +
    `\n\nDecide where logs are REQUIRED and what is redundant, per the rules below. Report each needed ` +
    `change as a gap: file + (line if known) + layer + route + action (one concrete sentence another agent ` +
    `can apply without re-tracing). Do NOT edit. Report traced routes under traced[].\n\n${CHAIN_RULES}\n\n${STANDARD_RULES}`;
  const traceResults = (await parallel(groups.map((g, n) => () =>
    agent(tracePrompt(g, n), { agentType: AGENT, phase: 'Trace', label: `trace:${n + 1}`, schema: TRACE_SCHEMA })
  ))).filter(Boolean);
  traced = traceResults.flatMap(t => Array.isArray(t.traced) ? t.traced : []);
  allGaps = traceResults.flatMap(t => Array.isArray(t.gaps) ? t.gaps : []);
  const tracedSet = new Set(traced.map(t => t.entry));
  const missing = entries.filter(e => !tracedSet.has(e.path));
  if (missing.length) log(`WARNING: ${missing.length} entry module(s) got no trace report: ${missing.map(e => e.path).join(', ')}`);
  log(`${traced.reduce((n, t) => n + t.routes.length, 0)} route(s) traced, ${allGaps.length} judgment gap(s)`);
}

// ==========================================================================
// Phase 3 — Apply: judgment gaps merged BY FILE + mechanical lint-fix,
// one agent per disjoint file batch
// ==========================================================================
const byFile = new Map();
for (const g of allGaps) {
  if (!g || !g.file) continue;
  if (!byFile.has(g.file)) byFile.set(g.file, []);
  byFile.get(g.file).push(g);
}
if (lanes !== 'judgment') {
  for (const v of violationFiles) if (!byFile.has(v.file)) byFile.set(v.file, []);
}
const mechFiles = new Set(lanes === 'judgment' ? [] : violationFiles.map(v => v.file));
const files = [...byFile.keys()];
let applyResults = [];
if (files.length) {
  phase('Apply');
  const groups = [];
  for (let i = 0; i < files.length; i += applyBatch) groups.push(files.slice(i, i + applyBatch));
  log(`Applying to ${files.length} file(s) (${allGaps.length} judgment gap(s), ${mechFiles.size} lint file(s)) in ${groups.length} agent(s)`);
  const applyPrompt = (groupFiles, n) =>
    `Fix the logging in these files, batch ${n + 1}/${groups.length}. Two kinds of work:\n` +
    `A. MECHANICAL: run \`${CENSUS_CMD(pluginRoot)} ${dir} --lint --files ${groupFiles.join(' ')}\` and fix ` +
    `EVERY reported violation in these files (print -> logger, getLogger -> get_logger, f-string -> constant ` +
    `message + extra, except-no-log -> appropriate warning/exception, exc_info -> logger.exception).\n` +
    `B. JUDGMENT gaps from flow tracing (several flows may demand similar logs at one spot — DEDUPE, one log ` +
    `per event per layer):\n` +
    groupFiles.map(f => {
      const gaps = byFile.get(f) || [];
      return `\`${f}\`:` + (gaps.length
        ? '\n' + gaps.map((g, i) => `  ${i + 1}. [${g.layer}] (${g.route}) ${g.action}${g.line ? ` (near line ${g.line})` : ''}`).join('\n')
        : ' (lint fixes only)');
    }).join('\n') +
    `\n\nRead each file before editing; minimal, behavior-preserving edits (log statements only; add the ` +
    `logger setup block only if missing). Re-run the lint on your files afterwards — it must come back clean. ` +
    `Return one entry per file: file, changed, applied (count), skipped (gap not applied + why). Every listed ` +
    `file MUST appear in your answer.\n\n${STANDARD_RULES}`;
  applyResults = (await parallel(groups.map((g, n) => () =>
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
  log('Nothing to apply');
}

// ==========================================================================
// Phase 4 — Verify: mechanical re-lint (must be clean) + flow re-trace sample
// ==========================================================================
let lintVerify = { ran: false, clean: null, remaining: null };
let flowVerify = { sampledRoutes: 0, agreed: 0, disputes: [] };
if (verifyMode === 'sample' && files.length) {
  phase('Verify');
  if (lanes !== 'judgment' && mechFiles.size) {
    const v = await agent(
      `Run \`${CENSUS_CMD(pluginRoot)} ${dir} --lint --files ${[...mechFiles].join(' ')}\` and report the result ` +
      `honestly: clean (true only if ZERO violations remain), remaining (count), sample (up to 10 remaining ` +
      `violation lines verbatim). Do NOT edit anything.`,
      { agentType: 'general-purpose', phase: 'Verify', label: 'verify:lint', schema: LINT_VERIFY_SCHEMA }
    );
    if (v) lintVerify = { ran: true, clean: v.clean === true, remaining: v.remaining };
    if (v && v.clean !== true) log(`LINT NOT CLEAN after apply: ${v.remaining} violation(s) remain`);
  }
  // sample from ALL traced routes (not just gap-carrying ones) — catches tracer false-negatives too
  const allRoutes = [...new Set(traced.flatMap(t => t.routes || []))];
  if (lanes !== 'mechanical' && allRoutes.length) {
    const target = Math.min(12, Math.max(2, Math.ceil(allRoutes.length / 10)));
    const step = Math.max(1, Math.floor(allRoutes.length / target));
    const sample = allRoutes.filter((_, i) => i % step === 0).slice(0, target);
    log(`Re-tracing ${sample.length}/${allRoutes.length} route(s) with independent read-only auditors`);
    const nAgents = Math.min(3, Math.ceil(sample.length / 4));
    const perAgent = Math.ceil(sample.length / nAgents);
    const groups = [];
    for (let i = 0; i < sample.length; i += perAgent) groups.push(sample.slice(i, i + perAgent));
    const verdicts = (await parallel(groups.map((g, n) => () =>
      agent(
        `Independent READ-ONLY verification. Re-trace each flow end-to-end (handler -> services -> data ` +
        `layer${censusPath ? `; chains are precomputed in \`${censusPath}\`` : ''}) and judge whether the ` +
        `chain's logging conforms — you are the check on the fixer AND on the tracer; a route nobody flagged ` +
        `may still have gaps. Do NOT edit.\n` +
        g.map((r, i) => `${i + 1}. ${r}`).join('\n') +
        `\nReturn one entry per route: route, clean, gaps (strings).\n\n${CHAIN_RULES}\n\n${STANDARD_RULES}`,
        { agentType: AGENT, phase: 'Verify', label: `verify:flows:${n + 1}`, schema: FLOW_VERIFY_SCHEMA }
      )
    ))).filter(Boolean).flatMap(v => Array.isArray(v.routes) ? v.routes : []);
    const disputes = verdicts.filter(v => v && v.clean === false).map(v => ({ route: v.route, gaps: v.gaps || [] }));
    flowVerify = { sampledRoutes: sample.length, agreed: sample.length - disputes.length, disputes };
    if (disputes.length) log(`DISPUTES: ${disputes.length} re-traced route(s) still have chain gaps`);
  }
}

return {
  censusPath,
  entryPoints: entries.length,
  lanes,
  routesTraced: traced.reduce((n, t) => n + (t.routes ? t.routes.length : 0), 0),
  judgmentGaps: allGaps.length,
  mechanicalFiles: mechFiles.size,
  filesTouched: applyResults.filter(f => f.changed === true).length,
  agentType: AGENT,
  apply: applyResults,
  verification: { lint: lintVerify, flows: flowVerify }
};

function boundInt(n, lo, hi, dflt) {
  n = Number.isFinite(n) ? Math.floor(n) : dflt;
  return Math.max(lo, Math.min(hi, n));
}
