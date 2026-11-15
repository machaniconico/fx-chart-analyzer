/** Read-only repository audit. Writes only a NEW local reports/autonomy artifact. */
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AUTONOMY_POLICY, AUTONOMY_TIME_UNIT, fingerprint, closedBarsAsOf, classifyRegime } from './lib/virtual-autonomy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const durations = { m15: 900, m30: 1800, h1: 3600, h4: 14400, d1: 86400 };
const readJson = async (name) => JSON.parse(await readFile(name, 'utf8'));

export const buildAutonomyAudit = async ({ projectRoot = root, asOf = Date.now(), timeUnit } = {}) => {
  if (!Number.isSafeInteger(asOf) || asOf < 0) throw new Error('Invalid asOf');
  if (timeUnit !== AUTONOMY_TIME_UNIT) throw new Error('Explicit UTC millisecond timeUnit required');
  const engineHash = fingerprint(await Promise.all(['scripts/lib/virtual-autonomy.mjs',
    'scripts/lib/virtual-portfolio.mjs', 'scripts/audit-virtual-autonomy.mjs'].map(async (name) => ({ name,
    source: await readFile(path.join(projectRoot, name), 'utf8') }))));
  const strategies = [];
  const dataCache = new Map();
  for (const lane of ['virtual', 'observation']) {
    const directory = path.join(projectRoot, 'strategies', lane);
    for (const name of (await readdir(directory)).filter((name) => name.endsWith('.json')).sort()) {
      const strategy = await readJson(path.join(directory, name));
      const { id, pair, timeframe } = strategy.meta;
      if (!/^[A-Z]{6}$/.test(pair) || !durations[timeframe] || !id) throw new Error(`Invalid strategy ${name}`);
      const key = `${pair}/${timeframe}`;
      if (!dataCache.has(key)) dataCache.set(key, await readJson(path.join(projectRoot, 'public/data', `${key}.json`)));
      const data = dataCache.get(key);
      if (data.pair !== pair || data.tf !== timeframe) throw new Error(`Dataset identity mismatch ${key}`);
      // Public OHLC schema uses seconds. Convert exactly once at this boundary,
      // without changing stored bars or pretending OHLC is executable quotes.
      const bars = data.bars.map(bar => {
        if (!Number.isSafeInteger(bar.t) || bar.t < 0 || !Number.isSafeInteger(bar.t * 1000)) throw new Error('Invalid source bar seconds');
        return { ...bar, t: bar.t * 1000 };
      });
      const timeframeMs = durations[timeframe] * 1000;
      const closed = closedBarsAsOf(bars, asOf, timeframeMs, timeUnit);
      const spanDays = closed.length > 1 ? (closed.at(-1).t - closed[0].t) / 86400000 : 0;
      const ageSeconds = closed.length ? (asOf - closed.at(-1).t - timeframeMs) / 1000 : null;
      const blockers = ['missing_independent_pipeline_replay', 'missing_generation_freeze_ledger',
        'missing_quote_spread_and_event_gate', 'legacy_individual_account_results_not_portfolio_evidence'];
      if (data.source !== 'dukascopy') blockers.push('unverified_or_fallback_source');
      if (spanDays < AUTONOMY_POLICY.minimumHistoryDays) blockers.push('insufficient_research_history');
      if (ageSeconds === null || ageSeconds * 1000 > AUTONOMY_POLICY.maxFeedAgeMs) blockers.push('stale_feed_for_new_entries');
      if (!pair.endsWith('JPY')) blockers.push('legacy_currency_conversion_requires_causal_replay');
      strategies.push({ id, lane, pair, timeframe, strategyHash: fingerprint(strategy), dataHash: fingerprint(data),
        closedBars: closed.length, spanDays: Math.round(spanDays * 10) / 10,
        lastClosedAt: closed.length ? closed.at(-1).t + timeframeMs : null,
        ageSeconds, admission: 'hold', blockers,
        regime: classifyRegime(bars, { asOf, timeframeMs, timeUnit, source: data.source }),
      });
    }
  }
  const body = { schemaVersion: 2, timeUnit, sourceBarTimeUnit: 'UTC epoch seconds', mode: 'virtual-only', kind: 'readiness-audit-not-performance',
    asOf, policy: AUTONOMY_POLICY, policyHash: fingerprint(AUTONOMY_POLICY), engineHash,
    summary: { strategies: strategies.length, virtual: strategies.filter((s) => s.lane === 'virtual').length,
      observation: strategies.filter((s) => s.lane === 'observation').length,
      approvedForNewPortfolio: 0, brokerActions: 0,
      historicalPerformanceCalculated: false, existingStateChanged: false }, strategies,
    nextSteps: ['Build a causal OHLC-to-event adapter with spread, gap, swap and conversion provenance.',
      'Prepare immutable long-history snapshots and preregister nested train/selection/test windows.',
      'Replay candidate generation, selection, router and shared allocator inside each outer time split.',
      'Record every attempted/rejected trial; freeze winner before consuming a final holdout once.',
      'Start a new paper generation, then evaluate 60 days and 50 trades before portfolio admission.'],
  };
  return { ...body, reportId: `autonomy-audit-${fingerprint(body).slice(0, 16)}` };
};

export const writeAutonomyAudit = async (report, outputDirectory = path.join(root, 'reports/autonomy')) => {
  if (!report || !/^[a-z0-9-]+$/.test(report.reportId)) throw new Error('Invalid reportId');
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `${report.reportId}.json`);
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  try { await writeFile(outputPath, bytes, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST' || await readFile(outputPath, 'utf8') !== bytes) throw error;
  }
  return outputPath;
};

export const main = async (args = process.argv.slice(2)) => {
  if (args.includes('--help')) {
    console.log('node scripts/audit-virtual-autonomy.mjs [--as-of=ISO8601] [--output-dir=PATH]\nOffline readiness audit only; no network, strategy edits, workflow or live orders.');
    return;
  }
  const options = { timeUnit: AUTONOMY_TIME_UNIT };
  let outputDirectory;
  for (const arg of args) {
    if (arg.startsWith('--as-of=')) options.asOf = Date.parse(arg.slice(8));
    else if (arg.startsWith('--output-dir=')) outputDirectory = path.resolve(arg.slice(13));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  const report = await buildAutonomyAudit(options);
  const outputPath = await writeAutonomyAudit(report, outputDirectory);
  console.log(JSON.stringify({ ...report.summary, outputPath, reportId: report.reportId }));
};
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
