/** Bounded offline research, not a trading/promotion service. UTC times are milliseconds.
 * Request: {dataset:{provenance:{source,kind:'observed'|'synthetic'},quotes:[quote]},
 * portfolio:{config,instruments}, windows:{train:{start,end},selection:{start,end},test:{start,end}},
 * embargoMs, seed:{family:'trend'|'range',lookback,holdSteps,stopFraction,riskFraction},maxTrials}.
 * Quotes must be executable single-symbol observations in portfolio event format.
 * Each partition starts flat and warms up locally; boundary-open positions are censored.
 * The bounded deterministic parameter search is NOT ML or a validated regime router.
 * History is append-only/tamper-evident, not secure against a privileged file owner.
 */
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, openSync, closeSync, fsyncSync, writeSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTONOMY_POLICY, fingerprint, canonicalJson, appendAudit, verifyAudit } from './virtual-autonomy.mjs';
import { replayVirtualPortfolio } from './virtual-portfolio.mjs';
const assert = (ok, message) => { if (!ok) throw new Error(`virtual-research: ${message}`); };
const names = ['train', 'selection', 'test'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const codeFiles = [fileURLToPath(import.meta.url), fileURLToPath(new URL('./virtual-autonomy.mjs', import.meta.url)), fileURLToPath(new URL('./virtual-portfolio.mjs', import.meta.url))];
const engineSources = codeFiles.map(path => ({ name: path.split('/').at(-1), source: readFileSync(path, 'utf8') }));
const loadedEngineHash = fingerprint(engineSources.map(x => ({ name: x.name, hash: digest(x.source) })));
export const researchEngineHash = () => {
  const current = fingerprint(codeFiles.map(path => ({ name: path.split('/').at(-1), hash: digest(readFileSync(path)) })));
  assert(current === loadedEngineHash, 'engine files changed since process startup; restart before research');
  return current;
};

export function generateCandidates(seed, maxTrials = 9) {
  assert(Number.isSafeInteger(maxTrials) && maxTrials > 0 && maxTrials <= AUTONOMY_POLICY.maxTrialsPerCycle, 'trial limit must be 1..20');
  assert(seed && ['trend', 'range'].includes(seed.family), 'invalid family');
  assert(Number.isSafeInteger(seed.lookback) && seed.lookback >= 2 && seed.lookback <= 1000, 'lookback must be 2..1000');
  assert(Number.isSafeInteger(seed.holdSteps) && seed.holdSteps >= 1 && seed.holdSteps <= 1000, 'holdSteps must be 1..1000');
  assert(Number.isFinite(seed.stopFraction) && seed.stopFraction > 0 && seed.stopFraction <= 0.1, 'invalid stopFraction');
  assert(Number.isFinite(seed.riskFraction) && seed.riskFraction > 0 && seed.riskFraction <= 0.01, 'riskFraction must be <= 1%');
  const result = [], seen = new Set();
  for (const lookback of [seed.lookback, Math.max(2, Math.floor(seed.lookback * 0.75)), Math.min(1000, Math.ceil(seed.lookback * 1.25))]) {
    for (const holdSteps of [seed.holdSteps, Math.max(1, Math.floor(seed.holdSteps * 0.75)), Math.min(1000, Math.ceil(seed.holdSteps * 1.25))]) {
      for (const family of [seed.family, seed.family === 'trend' ? 'range' : 'trend']) {
        const parameters = { family, lookback, holdSteps, stopFraction: seed.stopFraction, riskFraction: seed.riskFraction };
        const id = fingerprint(parameters); if (!seen.has(id)) { seen.add(id); result.push({ id, parameters }); }
      }
    }
  }
  return result.slice(0, maxTrials);
}

/** Signals use only observed quotes; orders fill no earlier than the NEXT quote.
 * Financing is deliberately not modeled: results can never certify promotion.
 */
export function evaluateQuoteCandidate({ candidate, quotes, portfolio, costMultiplier = 1, includeTrace = false }) {
  assert(costMultiplier === 1 || costMultiplier === 2, 'unsupported cost scenario');
  const p = candidate.parameters;
  generateCandidates(p, 1);
  assert(quotes.length >= p.lookback + p.holdSteps + 4, 'insufficient partition quotes');
  const symbols = Object.keys(portfolio.instruments);
  assert(symbols.length === 1 && quotes.every(q => q.symbol === symbols[0] && q.type === 'quote'), 'single-symbol quote tape required');
  const symbol = symbols[0], instrument = portfolio.instruments[symbol];
  const stressed = quotes.map(q => ({ ...q, ask: q.bid + (q.ask - q.bid) * costMultiplier }));
  const instruments = { [symbol]: { ...instrument, commissionPerLot: instrument.commissionPerLot * costMultiplier, slippage: instrument.slippage * costMultiplier } };
  const events = []; let active = null, exitIndex = -1;
  for (let i = 0; i < stressed.length; i++) {
    const q = stressed[i]; events.push(q);
    if (active && i === exitIndex) { events.push({ type: 'exit', t: q.t, id: `exit-${i}`, positionId: active }); active = null; continue; }
    // Never inspect remaining tape length: an appended future quote must not alter this intent.
    if (!active && i >= p.lookback) {
      const current = (quotes[i].bid + quotes[i].ask) / 2;
      const prior = quotes.slice(i - p.lookback, i).reduce((sum, x) => sum + (x.bid + x.ask) / 2, 0) / p.lookback;
      if (current === prior) continue;
      const rising = current > prior, side = (p.family === 'trend' ? rising : !rising) ? 'long' : 'short';
      active = `entry-${i}`; exitIndex = i + p.holdSteps + 1;
      events.push({ type: 'enter', t: q.t, id: active, ea: p.family, symbol, side,
        stop: side === 'long' ? q.bid * (1 - p.stopFraction) : q.ask * (1 + p.stopFraction), riskFraction: p.riskFraction, priority: 0 });
    }
  }
  const replay = replayVirtualPortfolio({ config: portfolio.config, instruments, events });
  const opens = new Map(replay.audit.filter(x => x.type === 'open').map(x => [x.id, x]));
  const closes = replay.audit.filter(x => x.type === 'close');
  // Do not turn a terminal mark into a completed trade or fabricate a terminal exit.
  const completedNetProfit = closes.reduce((sum, x) => sum + x.netPnlExcludingEntryFee - opens.get(x.id).entryFee, 0);
  let peak = portfolio.config.initialEquity, maxDrawdownPct = 0;
  for (const mark of replay.equityCurve) { peak = Math.max(peak, mark.equity); maxDrawdownPct = Math.max(maxDrawdownPct, (peak - mark.equity) / peak * 100); }
  return { metricScope: 'closed_trades_only_exploratory', netProfitAfterCosts: completedNetProfit, maxDrawdownPct,
    terminalLiquidationNetProfit: replay.equity - portfolio.config.initialEquity,
    censoredOpenPositions: replay.positions.length,
    trades: closes.length,
    rejectedIntents: replay.audit.filter(x => x.type === 'reject').length,
    executionHash: fingerprint(replay), costMultiplier, finalPositions: replay.positions.length,
    ...(includeTrace ? { executionTrace: replay.audit.filter(x => ['intent', 'open', 'close'].includes(x.type)) } : {}) };
}

function validateRequest(request) {
  canonicalJson(request);
  assert(!request.bars && !request.dataset?.bars, 'OHLC bars are not executable bid/ask quotes; observed quote tape absent');
  assert(request.dataset?.provenance && ['observed', 'synthetic'].includes(request.dataset.provenance.kind)
    && typeof request.dataset.provenance.source === 'string' && request.dataset.provenance.source.length > 0, 'explicit provenance required');
  const quotes = request.dataset.quotes;
  assert(Array.isArray(quotes) && quotes.length > 0, 'quotes required');
  assert(Number.isSafeInteger(request.embargoMs) && request.embargoMs > 0, 'positive embargoMs required');
  const candidates = generateCandidates(request.seed, request.maxTrials);
  const partitions = {};
  names.forEach((name, i) => {
    const w = request.windows?.[name];
    assert(w && Number.isSafeInteger(w.start) && Number.isSafeInteger(w.end) && w.start >= 0 && w.end > w.start, `invalid ${name} window`);
    if (i) assert(request.windows[names[i - 1]].end + request.embargoMs <= w.start, 'overlapping windows/missing embargo');
    partitions[name] = quotes.filter(q => q.t >= w.start && q.t < w.end);
  });
  assert(Object.keys(request.portfolio.instruments).length === 1, 'single instrument required');
  assert(quotes.every((q, i) => q.t <= Date.now() && q.type === 'quote' && (!i || q.t > quotes[i - 1].t)), 'strictly chronological quotes only');
  replayVirtualPortfolio({ ...request.portfolio, events: quotes }); // Validate every observation and conversion, including embargo rows.
  for (const name of names) assert(partitions[name].length > 0, `empty ${name} partition`);
  return { candidates, partitions };
}

/** Uses one exclusive directory lock; never automatically breaks stale locks.
 * Individual file writes are fsynced; directory durability on power loss is NOT guaranteed.
 * Reservation is fsynced BEFORE any fitting. A crash permanently burns its test
 * interval. A completed identical request is read back; interrupted runs block.
 * New datasets must advance beyond every reserved test interval, even if renamed.
 */
export function runResearchCycle({ request, stateDir }) {
  const { candidates, partitions } = validateRequest(request);
  const root = resolve(stateDir); mkdirSync(root, { recursive: true });
  const lockPath = join(root, 'research.lock'); const lock = openSync(lockPath, 'wx', 0o600);
  try {
    writeSync(lock, `${process.pid}\n`); fsyncSync(lock);
    const journalPath = join(root, 'audit.jsonl');
    let audit = existsSync(journalPath) ? readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    verifyAudit(audit);
    for (const event of audit) if (event.artifact) {
      assert(/^[a-f0-9]{64}\/[-a-z0-9]+\.json$/.test(event.artifact), 'invalid artifact path');
      assert(digest(readFileSync(join(root, event.artifact))) === event.artifactHash, 'artifact modified');
    }
    const engineHash = researchEngineHash(), requestHash = fingerprint(request), cycleId = fingerprint({ requestHash, engineHash, policy: AUTONOMY_POLICY });
    const done = audit.find(e => e.cycleId === cycleId && e.type === 'cycle-completed');
    if (done) return JSON.parse(readFileSync(join(root, done.artifact), 'utf8'));
    assert(!audit.some(e => e.cycleId === cycleId), 'interrupted cycle: holdout is consumed; do not rerun or remove reservation');
    const testHash = fingerprint(partitions.test), range = request.windows.test;
    const consumed = audit.filter(e => e.type === 'holdout-reserved');
    assert(!consumed.some(e => e.testHash === testHash || (range.start < e.end && range.end > e.start)), 'holdout reused or overlapping, including renamed datasets');
    // Time must move forward: older unreserved data is not a fresh future holdout.
    assert(!consumed.some(e => range.start < e.end), 'new cycles require a later untouched holdout');
    const dir = join(root, cycleId); mkdirSync(dir);
    const append = record => {
      const at = Math.max(Date.now(), audit.at(-1)?.at ?? 0);
      const next = appendAudit(audit, { ...record, cycleId, at });
      const fd = openSync(journalPath, 'a', 0o600);
      try { writeSync(fd, canonicalJson(next.at(-1)) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      audit = next;
    };
    const artifact = (name, value, type) => {
      const relative = `${cycleId}/${name}.json`, bytes = canonicalJson(value) + '\n';
      const fd = openSync(join(root, relative), 'wx', 0o444);
      try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      append({ type, artifact: relative, artifactHash: digest(bytes) });
    };
    append({ type: 'holdout-reserved', testHash, start: range.start, end: range.end, engineHash, requestHash });
    artifact('request', request, 'request-snapshotted');
    artifact('engine', { engineHash, sources: engineSources }, 'engine-snapshotted');
    const reasons = ['quote_count_holding_and_boundary_censoring_exploratory', 'nested_outer_pipeline_folds_not_implemented', 'provenance_not_independently_verified', 'financing_liquidity_and_margin_not_modeled', 'router_and_allocator_not_validated'];
    if (request.dataset.provenance.kind === 'synthetic') reasons.push('synthetic_data_not_evidence', 'observed_bid_ask_tape_not_supplied');
    if (request.dataset.quotes.at(-1).t - request.dataset.quotes[0].t < AUTONOMY_POLICY.minimumHistoryDays * 86400000) reasons.push('insufficient_history');
    const trials = [];
    for (const candidate of candidates) {
      let trial;
      try {
        const train = evaluateQuoteCandidate({ candidate, quotes: partitions.train, portfolio: request.portfolio });
        const selection = evaluateQuoteCandidate({ candidate, quotes: partitions.selection, portfolio: request.portfolio });
        const stress = evaluateQuoteCandidate({ candidate, quotes: partitions.selection, portfolio: request.portfolio, costMultiplier: 2 });
        const passed = [train, selection, stress].every(x => x.censoredOpenPositions === 0 && x.trades > 0 && x.netProfitAfterCosts > 0 && x.maxDrawdownPct <= AUTONOMY_POLICY.maxDrawdownPct);
        trial = { candidate, train, selection, stress, passed, reason: passed ? 'development_pass' : 'development_or_cost_stress_failed' };
      } catch (error) { trial = { candidate, passed: false, reason: 'evaluation_failed', error: error.message }; }
      trials.push(trial); artifact(`trial-${String(trials.length).padStart(2, '0')}`, trial, 'trial-recorded');
    }
    const ranked = trials.filter(t => t.passed).sort((a, b) => b.selection.netProfitAfterCosts - a.selection.netProfitAfterCosts || a.candidate.id.localeCompare(b.candidate.id));
    const champion = ranked[0]?.candidate ?? null;
    const frozen = { champion, selectionEnd: request.windows.selection.end, historyStart: request.dataset.quotes[0].t, historyEnd: request.dataset.quotes.at(-1).t, timeUnit: 'UTC epoch milliseconds', engineHash, requestHash,
      candidatesHash: fingerprint(candidates), trialsHash: fingerprint(trials), policyHash: fingerprint(AUTONOMY_POLICY), baseline: 'all-flat', selectionRule: 'uncensored positive train/selection/2x-cost, then maximum selection closed-trade net profit' };
    artifact('frozen', frozen, 'selection-frozen');
    let finalTest = null;
    if (champion) {
      try {
        const base = evaluateQuoteCandidate({ candidate: champion, quotes: partitions.test, portfolio: request.portfolio });
        const stress = evaluateQuoteCandidate({ candidate: champion, quotes: partitions.test, portfolio: request.portfolio, costMultiplier: 2 });
        finalTest = { base, stress, allFlatNetProfit: 0, passed: [base, stress].every(x => x.censoredOpenPositions === 0 && x.trades >= AUTONOMY_POLICY.minimumOuterTrades && x.netProfitAfterCosts > 0 && x.maxDrawdownPct <= AUTONOMY_POLICY.maxDrawdownPct) };
        if (!finalTest.passed) reasons.push('final_holdout_or_cost_stress_failed');
      } catch (error) { finalTest = { passed: false, error: error.message }; reasons.push('final_evaluation_failed'); }
    } else reasons.push('no_development_candidate_passed');
    artifact('holdout', finalTest, 'holdout-recorded');
    const result = { cycleId, mode: 'virtual-only', action: 'hold', eligible: false, reasons,
      trialCount: trials.length, rejectedTrialCount: trials.filter(t => !t.passed).length,
      frozen, finalTest, nextStep: 'Supply a later untouched quote tape and rerun. Do not tune on consumed holdout scores. Promotion remains blocked until independent pipeline validation is implemented.' };
    artifact('result', result, 'cycle-completed');
    return result;
  } finally { closeSync(lock); unlinkSync(lockPath); }
}

/** Explicitly invented mechanical fixture, never an observed market dataset. */
export function syntheticResearchRequest(offset = 0) {
  const quotes = Array.from({ length: 1200 }, (_, i) => {
    const t = offset + i * 1000, bid = 100 + i * 0.01;
    return { type: 'quote', symbol: 'USDJPY', t, observedAt: t, conversionObservedAt: t, bid, ask: bid + 0.001, quoteToAccount: 1 };
  });
  return {
    dataset: { provenance: { kind: 'synthetic', source: 'invented linear price fixture; NOT market evidence' }, quotes },
    portfolio: { config: { initialEquity: 1000000, maxTotalRiskFraction: 0.02, maxCurrencyRiskFraction: 0.02,
      maxDailyLossFraction: 0.02, maxDrawdownFraction: 0.1, maxPositions: 1, maxQuoteAgeMs: 2000, maxSignalAgeMs: 2000, maxGrossLeverage: 10 },
    instruments: { USDJPY: { base: 'USD', quote: 'JPY', contractSize: 100000, lotStep: 0.01, minLot: 0.01, maxLot: 5, commissionPerLot: 10, slippage: 0.001 } } },
    windows: { train: { start: offset, end: offset + 399000 }, selection: { start: offset + 400000, end: offset + 799000 }, test: { start: offset + 800000, end: offset + 1200000 } },
    embargoMs: 1000, seed: { family: 'trend', lookback: 8, holdSteps: 3, stopFraction: 0.002, riskFraction: 0.001 }, maxTrials: 12,
  };
}
