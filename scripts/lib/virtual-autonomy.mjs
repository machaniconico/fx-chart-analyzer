/** Offline research governance only. This module cannot place or transmit orders. */
import { createHash } from 'node:crypto';

export const AUTONOMY_POLICY = Object.freeze({
  version: 1,
  mode: 'virtual-only',
  maxTrialsPerCycle: 20,
  minimumHistoryDays: 730,
  minimumOuterFolds: 3,
  minimumOuterTrades: 100,
  minimumPaperDays: 60,
  minimumPaperTrades: 50,
  maxDrawdownPct: 10,
  maxRelativeSpread: 0.15,
  maxFeedAgeSeconds: 10800,
  switchMargin: 0.1,
  minDwellSeconds: 86400,
});

const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const timestamp = (v) => finite(v) && v >= 0;
const nonempty = (v) => typeof v === 'string' && v.length > 0;
const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

export const canonicalJson = (value) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (finite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('Hash inputs must be finite JSON values');
};
export const fingerprint = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** A changed configuration always has a new identity. No in-place replacement. */
export const freezeCandidate = ({ strategy, family, version, parentId = null, createdAt,
  selectionEnd, dataHash, engineHash, policy = AUTONOMY_POLICY }) => {
  requireValue(nonempty(family) && Number.isInteger(version) && version > 0, 'Invalid candidate version');
  requireValue(timestamp(createdAt) && timestamp(selectionEnd) && selectionEnd <= createdAt, 'Invalid candidate times');
  requireValue(hash(dataHash) && hash(engineHash), 'Data and engine hashes are required');
  requireValue(parentId === null || nonempty(parentId), 'Invalid parentId');
  requireValue(strategy && typeof strategy === 'object' && !Array.isArray(strategy), 'Strategy is required');
  requireValue(policy.mode === 'virtual-only', 'Only virtual-only policy is supported');
  const manifest = {
    schemaVersion: 1, family, version, parentId, createdAt, selectionEnd,
    mode: 'virtual-only', strategy: clone(strategy), strategyHash: fingerprint(strategy),
    dataHash, engineHash, policyHash: fingerprint(policy),
  };
  return { ...manifest, candidateId: `${family}@${version}:${fingerprint(manifest).slice(0, 16)}` };
};

/** The same family/version cannot be redefined or silently backdated. */
export const registerCandidate = (registry, candidate) => {
  requireValue(Array.isArray(registry), 'Registry must be an array');
  const { candidateId, ...manifest } = candidate;
  requireValue(candidateId === `${candidate.family}@${candidate.version}:${fingerprint(manifest).slice(0, 16)}`
    && candidate.strategyHash === fingerprint(candidate.strategy), 'Candidate manifest changed');
  const existing = registry.find((entry) => entry.family === candidate.family && entry.version === candidate.version);
  if (existing) {
    requireValue(fingerprint(existing) === fingerprint(candidate), 'Cannot redefine an existing generation');
    return clone(registry);
  }
  const previous = registry.filter((entry) => entry.family === candidate.family)
    .sort((a, b) => b.version - a.version)[0];
  if (previous) {
    requireValue(candidate.version === previous.version + 1 && candidate.parentId === previous.candidateId
      && candidate.createdAt > previous.createdAt && candidate.selectionEnd >= previous.selectionEnd,
    'New generation needs its parent and a later registration');
  } else requireValue(candidate.version === 1 && candidate.parentId === null, 'First generation must start at version 1');
  return [...clone(registry), clone(candidate)];
};

/** Hash-chain links detect accidental edits; they are not signatures or access control. */
export const appendAudit = (events, record) => {
  verifyAudit(events);
  requireValue(record && timestamp(record.at) && nonempty(record.type), 'Invalid audit record');
  requireValue(events.length === 0 || record.at >= events.at(-1).at, 'Audit time must not regress');
  const body = { ...clone(record), sequence: events.length, previousHash: events.at(-1)?.hash ?? null };
  delete body.hash;
  return [...events, { ...body, hash: fingerprint(body) }];
};
export const verifyAudit = (events) => {
  requireValue(Array.isArray(events), 'Audit must be an array');
  events.forEach((event, i) => {
    const { hash: actual, ...body } = event;
    requireValue(event.sequence === i && event.previousHash === (events[i - 1]?.hash ?? null)
      && actual === fingerprint(body) && timestamp(event.at) && nonempty(event.type)
      && (i === 0 || event.at >= events[i - 1].at), `Invalid audit event ${i}`);
  });
  return true;
};

/** Windows are [start,end). Purge using when each trade/label actually ends. */
export const splitPurgedSamples = (samples, windows, embargoSeconds) => {
  requireValue(finite(embargoSeconds) && embargoSeconds >= 0, 'Invalid embargo');
  const names = ['train', 'selection', 'test'];
  names.forEach((name, i) => {
    const window = windows[name];
    requireValue(window && timestamp(window.start) && finite(window.end) && window.start < window.end, `Invalid ${name} window`);
    if (i) requireValue(windows[names[i - 1]].end + embargoSeconds <= window.start, 'Windows overlap or embargo is missing');
  });
  const result = { train: [], selection: [], test: [], purged: [] };
  let previous = -Infinity;
  for (const sample of samples) {
    requireValue(timestamp(sample.start) && timestamp(sample.end) && sample.end >= sample.start
      && sample.start >= previous, 'Samples must be ordered with known label end times');
    previous = sample.start;
    const name = names.find((key) => sample.start >= windows[key].start && sample.end < windows[key].end);
    result[name ?? 'purged'].push(sample);
  }
  return result;
};

/** Information available at bar-open time excludes the close of that same bar. */
export const closedBarsAsOf = (bars, asOf, timeframeSeconds) => {
  requireValue(timestamp(asOf) && finite(timeframeSeconds) && timeframeSeconds > 0, 'Invalid bar clock');
  let previous = -Infinity;
  return bars.filter((bar) => {
    requireValue(timestamp(bar.t) && bar.t > previous, 'Bars must be strictly ordered');
    previous = bar.t;
    // Values of future/incomplete bars must never influence past decisions.
    if (bar.t + timeframeSeconds > asOf) return false;
    requireValue([bar.o, bar.h, bar.l, bar.c].every((v) => finite(v) && v > 0)
      && bar.l <= Math.min(bar.o, bar.c) && bar.h >= Math.max(bar.o, bar.c) && bar.l <= bar.h, 'Invalid closed OHLC');
    return true;
  });
};
export const conversionAsOf = (bars, asOf, timeframeSeconds, maxAgeSeconds) => {
  requireValue(finite(maxAgeSeconds) && maxAgeSeconds >= 0, 'Invalid conversion freshness');
  const bar = closedBarsAsOf(bars, asOf, timeframeSeconds).at(-1);
  if (!bar || asOf - (bar.t + timeframeSeconds) > maxAgeSeconds) return null;
  return { rate: bar.c, knownAt: bar.t + timeframeSeconds };
};

/** Conservative initial router features, not a fitted/proven regime classifier. */
export const classifyRegime = (bars, { asOf, timeframeSeconds, source,
  spreadPrice = null, eventBlocked = true, policy = AUTONOMY_POLICY }) => {
  const unavailable = (reason) => ({ regime: 'unknown', reason, asOf, eligible: false });
  if (source !== 'dukascopy') return unavailable('unverified_or_fallback_source');
  if (eventBlocked !== false) return unavailable('event_risk_or_missing_calendar');
  if (!finite(spreadPrice) || spreadPrice < 0) return unavailable('missing_spread');
  const closed = closedBarsAsOf(bars, asOf, timeframeSeconds);
  if (closed.length < 61) return unavailable('insufficient_closed_bars');
  const latest = closed.at(-1);
  if (asOf - (latest.t + timeframeSeconds) > policy.maxFeedAgeSeconds) return unavailable('stale_feed');
  const recent = closed.slice(-61);
  const ranges = recent.slice(1).map((bar, i) => Math.max(bar.h - bar.l,
    Math.abs(bar.h - recent[i].c), Math.abs(bar.l - recent[i].c)));
  const atr = ranges.slice(-20).reduce((a, b) => a + b, 0) / 20;
  if (!(atr > 0)) return unavailable('zero_volatility');
  if (spreadPrice / atr > policy.maxRelativeSpread) return unavailable('expensive_spread');
  const sorted = [...ranges].sort((a, b) => a - b);
  const median = (sorted[29] + sorted[30]) / 2;
  if (!(median > 0) || ranges.at(-1) > median * 3) return unavailable('volatility_shock');
  const path = recent.slice(-20).reduce((sum, bar, i, arr) => sum + (i ? Math.abs(bar.c - arr[i - 1].c) : 0), 0);
  const efficiency = path > 0 ? Math.abs(latest.c - recent.at(-20).c) / path : 0;
  const regime = efficiency >= 0.4 ? (latest.c > recent.at(-20).c ? 'trend_up' : 'trend_down')
    : efficiency <= 0.2 ? 'range' : 'transition';
  return { regime, reason: regime === 'transition' ? 'ambiguous_regime' : 'classified', asOf,
    eligible: regime !== 'transition', atr, efficiency, barClosedAt: latest.t + timeframeSeconds };
};

/** Evidence must be from an untouched chronological outer replay, not legacy validation. */
export const evaluatePromotion = (candidate, evidence, { asOf, usedHoldoutIds = [], consumedHoldouts = [], policy = AUTONOMY_POLICY } = {}) => {
  const reasons = [];
  const fail = (condition, reason) => { if (!condition) reasons.push(reason); };
  fail(timestamp(asOf), 'invalid_evaluation_time');
  if (!candidate || typeof candidate !== 'object') return { action: 'hold', eligible: false, reasons: ['missing_candidate'] };
  fail(candidate?.mode === 'virtual-only' && candidate.policyHash === fingerprint(policy), 'candidate_policy_mismatch');
  const { candidateId, ...manifest } = candidate ?? {};
  fail(candidate?.strategyHash === fingerprint(candidate?.strategy ?? null)
    && candidateId === `${candidate?.family}@${candidate?.version}:${fingerprint(manifest).slice(0, 16)}`, 'candidate_changed');
  if (!evidence) return { action: 'hold', eligible: false, reasons: [...reasons, 'missing_independent_evidence'] };
  fail(evidence.candidateId === candidateId && evidence.engineHash === candidate.engineHash
    && evidence.dataHash === candidate.dataHash && evidence.policyHash === candidate.policyHash, 'evidence_identity_mismatch');
  fail(nonempty(evidence.holdoutId) && !usedHoldoutIds.includes(evidence.holdoutId), 'holdout_reused_or_missing');
  // Renaming a consumed test or perturbing its bytes does not make it unseen.
  fail(hash(evidence.holdoutDataHash) && !consumedHoldouts.some((used) =>
    used.dataHash === evidence.holdoutDataHash || (evidence.finalTestStart < used.end
      && evidence.finalTestEnd > used.start)), 'holdout_content_reused_or_missing');
  fail(timestamp(evidence.frozenAt) && evidence.frozenAt >= candidate.createdAt
    && timestamp(evidence.evaluatedAt) && evidence.evaluatedAt >= evidence.frozenAt && evidence.evaluatedAt <= asOf, 'invalid_freeze_or_evaluation_time');
  fail(Number.isInteger(evidence.trials) && evidence.trials >= 1 && evidence.trials <= policy.maxTrialsPerCycle, 'trial_budget_exceeded_or_missing');
  fail(evidence.pipelineReplay === true && evidence.routerFrozen === true && evidence.allocatorFrozen === true
    && evidence.causalConversion === true && evidence.purged === true && evidence.finalTestUsedForSelection === false,
  'incomplete_or_leaking_pipeline_replay');
  fail(evidence.costStressPassed === true && evidence.parameterNeighborsPassed === true
    && evidence.baselinesBeaten === true, 'robustness_or_baseline_failed');
  fail(evidence.dataQualityPassed === true, 'data_quality_failed');
  fail(timestamp(evidence.historyStart) && timestamp(evidence.historyEnd)
    && evidence.historyStart < evidence.historyEnd && evidence.historyEnd <= evidence.evaluatedAt
    && evidence.historyEnd >= evidence.finalTestEnd
    && evidence.historyEnd - evidence.historyStart >= policy.minimumHistoryDays * 86400,
  'insufficient_or_invalid_research_history');
  const folds = evidence.folds ?? [];
  fail(Array.isArray(folds) && folds.length >= policy.minimumOuterFolds, 'insufficient_outer_folds');
  let previousEnd = -Infinity;
  let totalTrades = 0;
  if (Array.isArray(folds)) folds.forEach((fold) => {
    fail(timestamp(fold.trainEnd) && timestamp(fold.selectionEnd) && fold.trainEnd < fold.selectionEnd
      && fold.trainEnd >= evidence.historyStart
      && timestamp(fold.testStart) && timestamp(fold.testEnd) && fold.selectionEnd < fold.testStart
      && fold.testStart < fold.testEnd && fold.testStart >= previousEnd
      && fold.testEnd <= evidence.evaluatedAt, 'invalid_outer_fold_order');
    previousEnd = fold.testEnd;
    fail(finite(fold.netProfitAfterCosts) && fold.netProfitAfterCosts > 0, 'nonpositive_outer_fold');
    fail(finite(fold.maxDrawdownPct) && fold.maxDrawdownPct >= 0 && fold.maxDrawdownPct <= policy.maxDrawdownPct, 'outer_drawdown_limit');
    fail(Number.isInteger(fold.trades) && fold.trades >= 0, 'invalid_outer_trade_count');
    totalTrades += Number.isInteger(fold.trades) && fold.trades >= 0 ? fold.trades : 0;
  });
  fail(totalTrades >= policy.minimumOuterTrades, 'insufficient_outer_trades');
  // Selection cutoff refers to the final holdout, after the nested development folds.
  fail(timestamp(evidence.finalTestStart) && evidence.finalTestStart > candidate.selectionEnd
    && evidence.finalTestStart >= previousEnd && timestamp(evidence.finalTestEnd)
    && evidence.finalTestStart < evidence.finalTestEnd && evidence.finalTestEnd <= evidence.evaluatedAt,
  'invalid_final_holdout_order');
  fail(finite(evidence.finalNetProfitAfterCosts) && evidence.finalNetProfitAfterCosts > 0
    && finite(evidence.finalDrawdownPct) && evidence.finalDrawdownPct >= 0
    && evidence.finalDrawdownPct <= policy.maxDrawdownPct, 'final_holdout_failed');
  const unique = [...new Set(reasons)];
  if (unique.length) return { action: 'hold', eligible: false, reasons: unique };
  return { action: 'eligible_for_new_paper_observation', eligible: true, reasons: [] };
};

/** Frozen, as-of-known scores only. All EAs can be rejected; never force a trade. */
export const selectVirtualCandidate = ({ regime, candidates, asOf, currentId = null, lastSwitchAt = null,
  policy = AUTONOMY_POLICY }) => {
  requireValue(timestamp(asOf), 'Invalid selection time');
  const flat = (reason) => ({ candidateId: null, action: 'flat_new_entries', reason });
  if (!regime?.eligible || regime.asOf !== asOf) return flat('regime_unavailable');
  const eligible = candidates.filter((candidate) => candidate.status === 'paper_approved'
    && candidate.regimes?.includes(regime.regime) && finite(candidate.score) && candidate.score > 0
    && timestamp(candidate.scoreKnownAt) && candidate.scoreKnownAt <= asOf
    && timestamp(candidate.availableAt) && candidate.availableAt <= asOf
    && finite(candidate.expiresAt) && candidate.expiresAt > asOf);
  const ranked = eligible.sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId));
  if (!ranked.length) return flat('no_eligible_candidate');
  const current = ranked.find((candidate) => candidate.candidateId === currentId);
  const best = ranked[0];
  if (current && best.candidateId !== current.candidateId) {
    if (!timestamp(lastSwitchAt) || lastSwitchAt > asOf) return flat('invalid_switch_clock');
    if (asOf - lastSwitchAt < policy.minDwellSeconds || best.score - current.score < policy.switchMargin) {
      return { candidateId: current.candidateId, action: 'monitor', reason: 'switch_hysteresis' };
    }
  }
  return { candidateId: best.candidateId, action: 'monitor', reason: 'best_eligible_frozen_score' };
};
