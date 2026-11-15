import { describe, it, expect } from 'vitest';
import { AUTONOMY_POLICY, AUTONOMY_TIME_UNIT, fingerprint, freezeCandidate, registerCandidate, appendAudit, verifyAudit,
  splitPurgedSamples, closedBarsAsOf, conversionAsOf, classifyRegime, evaluatePromotion,
  selectVirtualCandidate } from './virtual-autonomy.mjs';

const U = AUTONOMY_TIME_UNIT;
const D = 86400000;
const createCandidate = () => freezeCandidate({ timeUnit: U, strategy: { exit: { stopLossPips: 30 } },
  family: 'trend', version: 1, createdAt: 1000 * D, selectionEnd: 700 * D,
  dataHash: fingerprint('data'), engineHash: fingerprint('engine') });
const createEvidence = (candidate) => ({
  timeUnit: U, candidateId: candidate.candidateId, engineHash: candidate.engineHash, dataHash: candidate.dataHash,
  policyHash: candidate.policyHash, holdoutId: 'untouched-test-1', holdoutDataHash: fingerprint('holdout'), frozenAt: 1001 * D, evaluatedAt: 1100 * D, historyStart: 0, historyEnd: 900 * D,
  trials: 20, pipelineReplay: true, routerFrozen: true, allocatorFrozen: true, causalConversion: true,
  purged: true, finalTestUsedForSelection: false, costStressPassed: true,
  parameterNeighborsPassed: true, baselinesBeaten: true, dataQualityPassed: true,
  folds: [0, 1, 2].map((i) => ({ holdoutId: `outer-${i}`, holdoutDataHash: fingerprint(['outer', i]), trainEnd: (i * 100 + 10) * D, selectionEnd: (i * 100 + 20) * D,
    testStart: (i * 100 + 30) * D, testEnd: (i * 100 + 90) * D, netProfitAfterCosts: 100,
    maxDrawdownPct: 3, trades: 40 })),
  finalTestStart: 800 * D, finalTestEnd: 900 * D, finalNetProfitAfterCosts: 10, finalDrawdownPct: 4,
});
const bars = Array.from({ length: 70 }, (_, i) => ({ t: i * 3600000, o: 100 + i,
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
    const split = splitPurgedSamples(samples, windows, 2, U);
    expect(split.train).toEqual([samples[0]]); expect(split.selection).toEqual([samples[3]]);
    expect(split.test).toEqual([samples[5]]); expect(split.purged).toHaveLength(3);
    expect(() => splitPurgedSamples(samples, windows, 3, U)).toThrow();
    expect(() => splitPurgedSamples([{ start: 1, end: null }], windows, 2, U)).toThrow();
  });
  it('excludes same-bar close and future nearest conversion bars', () => {
    expect(conversionAsOf(bars, 3600000, 3600000, 3600000, U)).toEqual({ rate: 100.5, knownAt: 3600000 });
    expect(conversionAsOf(bars, 0, 3600000, 3600000, U)).toBeNull();
    expect(conversionAsOf(bars.slice(0, 1), 8000000, 3600000, 3600000, U)).toBeNull();
  });
  it('has prefix-invariant conversion and regime decisions', () => {
    const asOf = 65 * 3600000;
    const futureChanged = bars.map((bar, i) => i >= 65 ? { ...bar, c: 99999 } : bar);
    expect(closedBarsAsOf(futureChanged, asOf, 3600000, U)).toEqual(bars.slice(0, 65));
    expect(conversionAsOf(futureChanged, asOf, 3600000, 3600000, U)).toEqual(conversionAsOf(bars.slice(0, 65), asOf, 3600000, 3600000, U));
    const options = { timeUnit: U, asOf, timeframeMs: 3600000, source: 'dukascopy', spreadPrice: 0.01, eventBlocked: false };
    expect(classifyRegime(futureChanged, options)).toEqual(classifyRegime(bars.slice(0, 65), options));
    expect(classifyRegime(bars, options).regime).toBe('trend_up');
  });
  it('defaults to no new entries on missing event/spread or stale/fallback input', () => {
    const options = { timeUnit: U, asOf: 70 * 3600000, timeframeMs: 3600000, source: 'dukascopy', spreadPrice: 0.01, eventBlocked: false };
    for (const override of [{ eventBlocked: undefined }, { spreadPrice: null }, { source: 'yahoo-fallback' }, { asOf: 80 * 3600000 }, { spreadPrice: 1 }]) {
      expect(classifyRegime(bars, { ...options, ...override }).eligible).toBe(false);
    }
  });
});

describe('independent pipeline promotion gate', () => {
  it('permits only a new paper observation, never real execution', () => {
    const candidate = createCandidate();
    expect(evaluatePromotion(candidate, createEvidence(candidate), { timeUnit: U, asOf: 1200 * D })).toEqual({ action: 'eligible_for_new_paper_observation', eligible: true, reasons: [] });
  });
  it.each([
    ['pipelineReplay', false], ['causalConversion', false], ['trials', 21],
    ['finalTestUsedForSelection', true], ['costStressPassed', false],
    ['finalNetProfitAfterCosts', -1], ['finalDrawdownPct', 11], ['evaluatedAt', 1201 * D],
    ['finalTestStart', 600 * D], ['frozenAt', 999 * D], ['dataQualityPassed', false], ['historyStart', 800 * D], ['historyEnd', 1000],
  ])('rejects %s=%s', (key, value) => {
    const candidate = createCandidate(); const evidence = { ...createEvidence(candidate), [key]: value };
    expect(evaluatePromotion(candidate, evidence, { timeUnit: U, asOf: 1200 * D }).eligible).toBe(false);
  });
  it('rejects sparse/overlapping folds, edited versions, reused holdouts and legacy evidence', () => {
    const candidate = createCandidate(); const evidence = createEvidence(candidate);
    expect(evaluatePromotion(candidate, { ...evidence, folds: [] }, { timeUnit: U, asOf: 1200 * D }).eligible).toBe(false);
    evidence.folds[2].testStart = 180 * D;
    expect(evaluatePromotion(candidate, evidence, { timeUnit: U, asOf: 1200 * D }).eligible).toBe(false);
    candidate.strategy.exit.stopLossPips = 10;
    expect(evaluatePromotion(candidate, createEvidence(candidate), { timeUnit: U, asOf: 1200 * D }).reasons).toContain('candidate_changed');
    const clean = createCandidate();
    expect(evaluatePromotion(clean, createEvidence(clean), { timeUnit: U, asOf: 1200 * D, consumedHoldouts: [{ timeUnit: U, dataHash: fingerprint('different bytes'), start: 850 * D, end: 1000 * D }] }).eligible).toBe(false);
    expect(evaluatePromotion(null, null, { timeUnit: U, asOf: 1200 * D }).eligible).toBe(false);
    expect(evaluatePromotion(clean, createEvidence(clean), { timeUnit: U, asOf: 1200 * D, usedHoldoutIds: ['untouched-test-1'] }).eligible).toBe(false);
    expect(evaluatePromotion(clean, null, { timeUnit: U, asOf: 1200 * D }).reasons).toContain('missing_independent_evidence');
  });
});

describe('flat-aware regime routing', () => {
  const asOf = 100000000;
  const regime = { timeUnit: U, regime: 'trend_up', eligible: true, asOf };
  const candidate = { timeUnit: U, candidateId: 'a', status: 'paper_approved', regimes: ['trend_up'], score: 0.5,
    scoreKnownAt: asOf - 1, availableAt: asOf - 1, expiresAt: asOf + 1 };
  it('allows empty/unknown/expired or future-only pools to remain flat', () => {
    for (const candidates of [[], [{ ...candidate, availableAt: asOf + 1 }], [{ ...candidate, scoreKnownAt: asOf + 1 }], [{ ...candidate, expiresAt: asOf }], [{ ...candidate, score: NaN }]]) {
      expect(selectVirtualCandidate({ timeUnit: U, regime, candidates, asOf }).candidateId).toBeNull();
    }
    expect(selectVirtualCandidate({ timeUnit: U, regime: { ...regime, eligible: false }, candidates: [candidate], asOf }).candidateId).toBeNull();
  });
  it('uses stable ties and hysteresis without preserving ineligible incumbents', () => {
    const better = { ...candidate, candidateId: 'b', score: 0.7 };
    expect(selectVirtualCandidate({ timeUnit: U, regime, candidates: [better, candidate], asOf, currentId: 'a', lastSwitchAt: asOf - 5 }).candidateId).toBe('a');
    expect(selectVirtualCandidate({ timeUnit: U, regime, candidates: [better, candidate], asOf, currentId: 'a', lastSwitchAt: 0 }).candidateId).toBe('b');
    expect(selectVirtualCandidate({ timeUnit: U, regime, candidates: [better, { ...candidate, status: 'suspended' }], asOf, currentId: 'a', lastSwitchAt: asOf - 5 }).candidateId).toBe('b');
    expect(selectVirtualCandidate({ timeUnit: U, regime, candidates: [{ ...candidate, candidateId: 'b' }, candidate], asOf }).candidateId).toBe('a');
  });
  it('does not turn monitoring into an entry instruction', () => {
    expect(selectVirtualCandidate({ timeUnit: U, regime, candidates: [candidate], asOf }).action).toBe('monitor');
    expect(AUTONOMY_POLICY.mode).toBe('virtual-only');
  });
});

describe('explicit millisecond governance regression cases', () => {
  it('rejects the 20-hour epoch-ms history that previously passed a 730-day gate', () => {
    const start = Date.UTC(2026, 10, 10), hour = 3600000;
    const candidate = freezeCandidate({ timeUnit: U, strategy: { exit: { stopLossPips: 30 } }, family: 'trend', version: 1,
      createdAt: start + 21 * hour, selectionEnd: start + 15 * hour, dataHash: fingerprint('data'), engineHash: fingerprint('engine') });
    const evidence = { ...createEvidence(candidate), frozenAt: start + 22 * hour, evaluatedAt: start + 23 * hour,
      historyStart: start, historyEnd: start + 20 * hour,
      folds: [0, 1, 2].map(i => ({ holdoutId: `outer-${i}`, holdoutDataHash: fingerprint(['outer', i]),
        trainEnd: start + (i * 4 + 1) * hour, selectionEnd: start + (i * 4 + 2) * hour,
        testStart: start + (i * 4 + 2.5) * hour, testEnd: start + (i * 4 + 3.5) * hour,
        netProfitAfterCosts: 100, maxDrawdownPct: 3, trades: 40 })),
      finalTestStart: start + 16 * hour, finalTestEnd: start + 20 * hour };
    const decision = evaluatePromotion(candidate, evidence, { asOf: start + 24 * hour, timeUnit: U });
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain('insufficient_or_invalid_research_history');
  });
  it('requires the full 730-day millisecond duration at its exact boundary', () => {
    const candidate = createCandidate(), evidence = { ...createEvidence(candidate), historyEnd: 730 * D,
      finalTestStart: 720 * D, finalTestEnd: 730 * D };
    expect(evaluatePromotion(candidate, evidence, { asOf: 1200 * D, timeUnit: U }).eligible).toBe(true);
    expect(evaluatePromotion(candidate, { ...evidence, historyEnd: 730 * D - 1, finalTestEnd: 730 * D - 1 }, { asOf: 1200 * D, timeUnit: U }).reasons).toContain('insufficient_or_invalid_research_history');
  });
  it.each([undefined, 'UTC epoch seconds', 'nanoseconds'])('rejects missing or mismatched unit %s instead of inferring it', timeUnit => {
    const candidate = createCandidate(), evidence = createEvidence(candidate);
    expect(() => freezeCandidate({ ...candidate, timeUnit })).toThrow('millisecond');
    for (const [c, e, options] of [[candidate, evidence, { asOf: 1200 * D, timeUnit }],
      [{ ...candidate, timeUnit }, evidence, { asOf: 1200 * D, timeUnit: U }],
      [candidate, { ...evidence, timeUnit }, { asOf: 1200 * D, timeUnit: U }]]) {
      expect(evaluatePromotion(c, e, options).reasons).toContain('time_unit_or_policy_mismatch');
    }
  });
  it('refuses old generations and second-valued policy fields without silently converting histories', () => {
    const candidate = createCandidate(), legacy = { ...candidate, schemaVersion: 1 };
    delete legacy.timeUnit;
    expect(() => registerCandidate([], legacy)).toThrow('Legacy');
    const policy = { ...AUTONOMY_POLICY, minDwellSeconds: 86400 };
    expect(evaluatePromotion(candidate, createEvidence(candidate), { asOf: 1200 * D, timeUnit: U, policy }).eligible).toBe(false);
    expect(() => closedBarsAsOf(bars, 70 * 3600000, 3600000)).toThrow('millisecond');
    expect(() => conversionAsOf(bars, 70 * 3600000, 3600000, 3600000, 'UTC epoch seconds')).toThrow('millisecond');
  });
  it('keeps the incumbent after 90 seconds and switches only after 24 hours', () => {
    const asOf = Date.UTC(2026, 10, 10), regime = { timeUnit: U, regime: 'trend_up', eligible: true, asOf };
    const a = { timeUnit: U, candidateId: 'a', status: 'paper_approved', regimes: ['trend_up'], score: 0.5,
      scoreKnownAt: asOf - 1000, availableAt: asOf - 1000, expiresAt: asOf + 1000 };
    const candidates = [a, { ...a, candidateId: 'b', score: 0.7 }];
    for (const elapsed of [90000, D - 1]) expect(selectVirtualCandidate({ regime, candidates, asOf, timeUnit: U,
      currentId: 'a', lastSwitchAt: asOf - elapsed }).candidateId).toBe('a');
    expect(selectVirtualCandidate({ regime, candidates, asOf, timeUnit: U, currentId: 'a', lastSwitchAt: asOf - D }).candidateId).toBe('b');
    expect(selectVirtualCandidate({ regime, candidates, asOf, currentId: 'a', lastSwitchAt: asOf - D }).candidateId).toBeNull();
    expect(selectVirtualCandidate({ regime: { ...regime, timeUnit: 'UTC epoch seconds' }, candidates, asOf, timeUnit: U }).candidateId).toBeNull();
    expect(selectVirtualCandidate({ regime, candidates: candidates.map(c => ({ ...c, timeUnit: undefined })), asOf, timeUnit: U }).candidateId).toBeNull();
  });
  it('rejects fractional and unsafe epoch values', () => {
    for (const createdAt of [1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      expect(() => freezeCandidate({ ...createCandidate(), createdAt })).toThrow('times');
    }
  });
});

describe('every independent outer holdout is protected at the admission gate', () => {
  const decide = (evidence, options = {}) => evaluatePromotion(createCandidate(), evidence,
    { asOf: 1200 * D, timeUnit: U, ...options });
  it('rejects a consumed outer interval even when final holdout is untouched', () => {
    const evidence = createEvidence(createCandidate()), fold = evidence.folds[1];
    const prior = { timeUnit: U, dataHash: fingerprint('different renamed bytes'), start: fold.testStart + 1, end: fold.testEnd - 1 };
    expect(decide(evidence, { consumedHoldouts: [prior] }).reasons).toContain('outer_holdout_content_reused_or_missing');
    expect(decide(evidence, { consumedHoldouts: [{ ...prior, start: fold.testEnd, end: fold.testEnd + 1 }] }).eligible).toBe(true);
  });
  it('rejects reused outer content under renamed nonoverlapping timestamps or ids', () => {
    const evidence = createEvidence(createCandidate()), fold = evidence.folds[1];
    expect(decide(evidence, { consumedHoldouts: [{ timeUnit: U, dataHash: fold.holdoutDataHash, start: 1000 * D, end: 1001 * D }] }).eligible).toBe(false);
    expect(decide(evidence, { usedHoldoutIds: [fold.holdoutId] }).reasons).toContain('outer_holdout_id_reused_or_missing');
  });
  it.each(['missing-hash', 'missing-id', 'duplicate-hash', 'duplicate-id', 'final-hash', 'final-id'])('rejects %s outer identity', mode => {
    const evidence = createEvidence(createCandidate());
    if (mode === 'missing-hash') delete evidence.folds[1].holdoutDataHash;
    if (mode === 'missing-id') delete evidence.folds[1].holdoutId;
    if (mode === 'duplicate-hash') evidence.folds[1].holdoutDataHash = evidence.folds[0].holdoutDataHash;
    if (mode === 'duplicate-id') evidence.folds[1].holdoutId = evidence.folds[0].holdoutId;
    if (mode === 'final-hash') evidence.folds[1].holdoutDataHash = evidence.holdoutDataHash;
    if (mode === 'final-id') evidence.folds[1].holdoutId = evidence.holdoutId;
    expect(decide(evidence).eligible).toBe(false);
  });
  it('rejects a malformed consumption inventory instead of treating it as empty', () => {
    const evidence = createEvidence(createCandidate());
    for (const consumedHoldouts of [null, {}, [{ dataHash: 'bad', start: 1, end: 2 }], [{ dataHash: fingerprint('a'), start: 2, end: 1 }]]) {
      expect(decide(evidence, { consumedHoldouts }).reasons).toContain('invalid_consumed_holdout_inventory');
    }
  });
});

it('rejects legacy, missing or incompatible units on separately retained consumption records', () => {
  const candidate = createCandidate(), evidence = createEvidence(candidate), fold = evidence.folds[1];
  for (const unit of [undefined, 'UTC epoch seconds']) {
    const record = { timeUnit: unit, dataHash: fingerprint('renamed'), start: fold.testStart / 1000, end: fold.testEnd / 1000 };
    expect(evaluatePromotion(candidate, evidence, { asOf: 1200 * D, timeUnit: U, consumedHoldouts: [record] }).reasons).toContain('invalid_consumed_holdout_inventory');
  }
});

it('rejects sparse or non-object folds rather than counting missing entries', () => {
  const candidate = createCandidate(), evidence = createEvidence(candidate), sparse = Array(3);
  sparse[2] = { ...evidence.folds[2], trades: 120 };
  for (const folds of [sparse, [null, ...evidence.folds.slice(1)], [3, ...evidence.folds.slice(1)]]) {
    expect(evaluatePromotion(candidate, { ...evidence, folds }, { asOf: 1200 * D, timeUnit: U }).reasons).toContain('invalid_outer_folds');
  }
});
it('rejects sparse separately retained consumption inventories', () => {
  const candidate = createCandidate(), evidence = createEvidence(candidate);
  for (const options of [{ consumedHoldouts: Array(2) }, { usedHoldoutIds: Array(1) }]) {
    expect(evaluatePromotion(candidate, evidence, { asOf: 1200 * D, timeUnit: U, ...options }).reasons).toContain('invalid_consumed_holdout_inventory');
  }
});
