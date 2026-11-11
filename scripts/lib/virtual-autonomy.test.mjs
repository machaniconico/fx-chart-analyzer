import { describe, it, expect } from 'vitest';
import { AUTONOMY_POLICY, fingerprint, freezeCandidate, registerCandidate, appendAudit, verifyAudit,
  splitPurgedSamples, closedBarsAsOf, conversionAsOf, classifyRegime, evaluatePromotion,
  selectVirtualCandidate } from './virtual-autonomy.mjs';

const D = 86400;
const createCandidate = () => freezeCandidate({ strategy: { exit: { stopLossPips: 30 } },
  family: 'trend', version: 1, createdAt: 1000 * D, selectionEnd: 700 * D,
  dataHash: fingerprint('data'), engineHash: fingerprint('engine') });
const createEvidence = (candidate) => ({
  candidateId: candidate.candidateId, engineHash: candidate.engineHash, dataHash: candidate.dataHash,
  policyHash: candidate.policyHash, holdoutId: 'untouched-test-1', holdoutDataHash: fingerprint('holdout'), frozenAt: 1001 * D, evaluatedAt: 1100 * D, historyStart: 0, historyEnd: 900 * D,
  trials: 20, pipelineReplay: true, routerFrozen: true, allocatorFrozen: true, causalConversion: true,
  purged: true, finalTestUsedForSelection: false, costStressPassed: true,
  parameterNeighborsPassed: true, baselinesBeaten: true, dataQualityPassed: true,
  folds: [0, 1, 2].map((i) => ({ trainEnd: (i * 100 + 10) * D, selectionEnd: (i * 100 + 20) * D,
    testStart: (i * 100 + 30) * D, testEnd: (i * 100 + 90) * D, netProfitAfterCosts: 100,
    maxDrawdownPct: 3, trades: 40 })),
  finalTestStart: 800 * D, finalTestEnd: 900 * D, finalNetProfitAfterCosts: 10, finalDrawdownPct: 4,
});
const bars = Array.from({ length: 70 }, (_, i) => ({ t: i * 3600, o: 100 + i,
  c: 100.5 + i, h: 101 + i, l: 99.5 + i }));

describe('immutable virtual experiment identities', () => {
  it('canonical hashes ignore object key order but reject ambiguous JSON', () => {
    expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }));
    for (const value of [NaN, Infinity, undefined, { x: undefined }]) expect(() => fingerprint(value)).toThrow();
  });
  it('freezes a copied strategy and gives every change a different identity', () => {
    const candidate = createCandidate();
    const changed = freezeCandidate({ ...candidate, strategy: { exit: { stopLossPips: 31 } } });
    expect(changed.candidateId).not.toBe(candidate.candidateId);
    expect(candidate.strategy.exit.stopLossPips).toBe(30);
    expect(() => freezeCandidate({ ...candidate, policy: { mode: 'live' } })).toThrow();
  });
  it('rejects in-place generation changes and backdated descendants', () => {
    const candidate = createCandidate(); const registry = registerCandidate([], candidate);
    expect(registerCandidate(registry, candidate)).toEqual(registry);
    const changed = freezeCandidate({ ...candidate, strategy: { different: true } });
    expect(() => registerCandidate(registry, changed)).toThrow('Cannot redefine');
    const child = freezeCandidate({ ...candidate, version: 2, parentId: candidate.candidateId, createdAt: 1001 * D });
    expect(registerCandidate(registry, child)).toHaveLength(2);
    expect(() => registerCandidate(registry, freezeCandidate({ ...candidate, version: 2, parentId: candidate.candidateId }))).toThrow('later registration');
    expect(registry).toHaveLength(1);
  });
  it('preserves hash-chained evidence and catches edits/reordering', () => {
    const events = appendAudit(appendAudit([], { at: 1, type: 'registered' }), { at: 2, type: 'rejected', trials: 1 });
    expect(verifyAudit(events)).toBe(true);
    const edited = structuredClone(events); edited[0].type = 'accepted';
    expect(() => verifyAudit(edited)).toThrow();
    expect(() => appendAudit(events, { at: 0, type: 'retroactive' })).toThrow();
  });
});

describe('causal time contracts', () => {
  it('purges overlapping labels and embargo intervals, not just starting rows', () => {
    const samples = [{ start: 1, end: 5 }, { start: 8, end: 13 }, { start: 11, end: 11 },
      { start: 13, end: 17 }, { start: 18, end: 20 }, { start: 23, end: 27 }];
    const windows = { train: { start: 0, end: 10 }, selection: { start: 12, end: 20 }, test: { start: 22, end: 30 } };
    const split = splitPurgedSamples(samples, windows, 2);
    expect(split.train).toEqual([samples[0]]); expect(split.selection).toEqual([samples[3]]);
    expect(split.test).toEqual([samples[5]]); expect(split.purged).toHaveLength(3);
    expect(() => splitPurgedSamples(samples, windows, 3)).toThrow();
    expect(() => splitPurgedSamples([{ start: 1, end: null }], windows, 2)).toThrow();
  });
  it('excludes same-bar close and future nearest conversion bars', () => {
    expect(conversionAsOf(bars, 3600, 3600, 3600)).toEqual({ rate: 100.5, knownAt: 3600 });
    expect(conversionAsOf(bars, 0, 3600, 3600)).toBeNull();
    expect(conversionAsOf(bars.slice(0, 1), 8000, 3600, 3600)).toBeNull();
  });
  it('has prefix-invariant conversion and regime decisions', () => {
    const asOf = 65 * 3600;
    const futureChanged = bars.map((bar, i) => i >= 65 ? { ...bar, c: 99999 } : bar);
    expect(closedBarsAsOf(futureChanged, asOf, 3600)).toEqual(bars.slice(0, 65));
    expect(conversionAsOf(futureChanged, asOf, 3600, 3600)).toEqual(conversionAsOf(bars.slice(0, 65), asOf, 3600, 3600));
    const options = { asOf, timeframeSeconds: 3600, source: 'dukascopy', spreadPrice: 0.01, eventBlocked: false };
    expect(classifyRegime(futureChanged, options)).toEqual(classifyRegime(bars.slice(0, 65), options));
    expect(classifyRegime(bars, options).regime).toBe('trend_up');
  });
  it('defaults to no new entries on missing event/spread or stale/fallback input', () => {
    const options = { asOf: 70 * 3600, timeframeSeconds: 3600, source: 'dukascopy', spreadPrice: 0.01, eventBlocked: false };
    for (const override of [{ eventBlocked: undefined }, { spreadPrice: null }, { source: 'yahoo-fallback' }, { asOf: 80 * 3600 }, { spreadPrice: 1 }]) {
      expect(classifyRegime(bars, { ...options, ...override }).eligible).toBe(false);
    }
  });
});

describe('independent pipeline promotion gate', () => {
  it('permits only a new paper observation, never real execution', () => {
    const candidate = createCandidate();
    expect(evaluatePromotion(candidate, createEvidence(candidate), { asOf: 1200 * D })).toEqual({ action: 'eligible_for_new_paper_observation', eligible: true, reasons: [] });
  });
  it.each([
    ['pipelineReplay', false], ['causalConversion', false], ['trials', 21],
    ['finalTestUsedForSelection', true], ['costStressPassed', false],
    ['finalNetProfitAfterCosts', -1], ['finalDrawdownPct', 11], ['evaluatedAt', 1201 * D],
    ['finalTestStart', 600 * D], ['frozenAt', 999 * D], ['dataQualityPassed', false], ['historyStart', 800 * D], ['historyEnd', 1000],
  ])('rejects %s=%s', (key, value) => {
    const candidate = createCandidate(); const evidence = { ...createEvidence(candidate), [key]: value };
    expect(evaluatePromotion(candidate, evidence, { asOf: 1200 * D }).eligible).toBe(false);
  });
  it('rejects sparse/overlapping folds, edited versions, reused holdouts and legacy evidence', () => {
    const candidate = createCandidate(); const evidence = createEvidence(candidate);
    expect(evaluatePromotion(candidate, { ...evidence, folds: [] }, { asOf: 1200 * D }).eligible).toBe(false);
    evidence.folds[2].testStart = 180 * D;
    expect(evaluatePromotion(candidate, evidence, { asOf: 1200 * D }).eligible).toBe(false);
    candidate.strategy.exit.stopLossPips = 10;
    expect(evaluatePromotion(candidate, createEvidence(candidate), { asOf: 1200 * D }).reasons).toContain('candidate_changed');
    const clean = createCandidate();
    expect(evaluatePromotion(clean, createEvidence(clean), { asOf: 1200 * D, consumedHoldouts: [{ dataHash: fingerprint('different bytes'), start: 850 * D, end: 1000 * D }] }).eligible).toBe(false);
    expect(evaluatePromotion(null, null, { asOf: 1200 * D }).eligible).toBe(false);
    expect(evaluatePromotion(clean, createEvidence(clean), { asOf: 1200 * D, usedHoldoutIds: ['untouched-test-1'] }).eligible).toBe(false);
    expect(evaluatePromotion(clean, null, { asOf: 1200 * D }).reasons).toContain('missing_independent_evidence');
  });
});

describe('flat-aware regime routing', () => {
  const asOf = 100000;
  const regime = { regime: 'trend_up', eligible: true, asOf };
  const candidate = { candidateId: 'a', status: 'paper_approved', regimes: ['trend_up'], score: 0.5,
    scoreKnownAt: asOf - 1, availableAt: asOf - 1, expiresAt: asOf + 1 };
  it('allows empty/unknown/expired or future-only pools to remain flat', () => {
    for (const candidates of [[], [{ ...candidate, availableAt: asOf + 1 }], [{ ...candidate, scoreKnownAt: asOf + 1 }], [{ ...candidate, expiresAt: asOf }], [{ ...candidate, score: NaN }]]) {
      expect(selectVirtualCandidate({ regime, candidates, asOf }).candidateId).toBeNull();
    }
    expect(selectVirtualCandidate({ regime: { ...regime, eligible: false }, candidates: [candidate], asOf }).candidateId).toBeNull();
  });
  it('uses stable ties and hysteresis without preserving ineligible incumbents', () => {
    const better = { ...candidate, candidateId: 'b', score: 0.7 };
    expect(selectVirtualCandidate({ regime, candidates: [better, candidate], asOf, currentId: 'a', lastSwitchAt: asOf - 5 }).candidateId).toBe('a');
    expect(selectVirtualCandidate({ regime, candidates: [better, candidate], asOf, currentId: 'a', lastSwitchAt: 0 }).candidateId).toBe('b');
    expect(selectVirtualCandidate({ regime, candidates: [better, { ...candidate, status: 'suspended' }], asOf, currentId: 'a', lastSwitchAt: asOf - 5 }).candidateId).toBe('b');
    expect(selectVirtualCandidate({ regime, candidates: [{ ...candidate, candidateId: 'b' }, candidate], asOf }).candidateId).toBe('a');
  });
  it('does not turn monitoring into an entry instruction', () => {
    expect(selectVirtualCandidate({ regime, candidates: [candidate], asOf }).action).toBe('monitor');
    expect(AUTONOMY_POLICY.mode).toBe('virtual-only');
  });
});
