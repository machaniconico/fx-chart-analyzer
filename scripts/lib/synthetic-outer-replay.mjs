/** Causal outer walk-forward mechanics ONLY. No observed-data input, persistence,
 * reservation authority, broker, promotion, or adaptation from outer scores.
 * Every fold evaluates the entire fixed bounded proposal/selection procedure.
 */
import { readFileSync } from 'node:fs';
import { AUTONOMY_POLICY, canonicalJson, fingerprint } from './virtual-autonomy.mjs';
import { generateCandidates, evaluateQuoteCandidate, researchEngineHash, syntheticResearchRequest } from './virtual-research-cycle.mjs';

const assert = (ok, message) => { if (!ok) throw new Error(`synthetic-outer: ${message}`); };
const copy = value => JSON.parse(canonicalJson(value));
const sourceUrl = new URL(import.meta.url);
const loadedSourceHash = fingerprint(readFileSync(sourceUrl, 'utf8'));
const engineHash = () => {
  assert(fingerprint(readFileSync(sourceUrl, 'utf8')) === loadedSourceHash, 'outer engine changed; restart before replay');
  return fingerprint({ research: researchEngineHash(), outer: loadedSourceHash });
};
const selectionRule = 'uncensored positive train/selection/2x-cost, then maximum selection closed-trade net profit; candidate-id tie-break';
const exactKeys = (object, allowed) => assert(object && Object.getPrototypeOf(object) === Object.prototype
  && Object.keys(object).every(key => allowed.includes(key)), 'unsupported input fields; observed tapes are not accepted');
const integer = (value, min, max, label) => assert(Number.isSafeInteger(value) && value >= min && value <= max, `invalid ${label}`);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

/** Call before replay. All windows are UTC millisecond [start,end), fixed without
 * looking at prices. Adjacent folds share neither development nor outer rows.
 * Hashes detect edits, not prior human inspection or malicious recomputation.
 */
export function createSyntheticOuterPlan(options = {}) {
  exactKeys(options, ['foldCount', 'trainQuotes', 'selectionQuotes', 'testQuotes', 'embargoQuotes', 'seed', 'maxTrials']);
  const fixture = syntheticResearchRequest();
  const config = { foldCount: 3, trainQuotes: 399, selectionQuotes: 399, testQuotes: 400,
    embargoQuotes: 1, seed: fixture.seed, maxTrials: 12, ...copy(options) };
  integer(config.foldCount, 1, 6, 'foldCount');
  integer(config.embargoQuotes, 1, 100, 'embargoQuotes');
  for (const key of ['trainQuotes', 'selectionQuotes', 'testQuotes']) integer(config[key], 8, 2000, key);
  exactKeys(config.seed, ['family', 'lookback', 'holdSteps', 'stopFraction', 'riskFraction']);
  const candidates = generateCandidates(config.seed, config.maxTrials);
  const folds = []; let cursor = 0;
  for (let index = 0; index < config.foldCount; index++) {
    const windows = {};
    for (const name of ['train', 'selection', 'test']) {
      windows[name] = { start: cursor * 1000, end: (cursor + config[`${name}Quotes`]) * 1000 };
      cursor += config[`${name}Quotes`] + config.embargoQuotes;
    }
    folds.push({ index, windows });
  }
  const body = { schemaVersion: 1, kind: 'internally-generated-synthetic-only', config, folds,
    candidates, portfolio: fixture.portfolio, embargoMs: config.embargoQuotes * 1000,
    policy: copy(AUTONOMY_POLICY), selectionRule, costMultipliers: [1, 2], baseline: 'all-flat',
    engineHash: engineHash() };
  return freeze({ ...body, planHash: fingerprint(body) });
}

const developmentPass = score => score.censoredOpenPositions === 0 && score.trades > 0
  && score.netProfitAfterCosts > 0 && score.maxDrawdownPct <= AUTONOMY_POLICY.maxDrawdownPct;

/** Only a bounded invented price-slope change is accepted as a test scenario.
 * No quotes, paths, callbacks, source labels, or portfolio inputs can be supplied.
 * Scenarios are test fixtures, never independent performance evidence.
 */
export function replaySyntheticOuterPlan(plan, options = {}) {
  exactKeys(options, ['completedFoldCount', 'scenario']);
  // Rebuild from the configuration to reject altered windows, policy or candidate set,
  // even if someone recomputed the caller-side hash after changing them.
  const expected = createSyntheticOuterPlan(plan.config);
  assert(canonicalJson(plan) === canonicalJson(expected), 'plan changed or engine mismatch');
  plan = expected;
  const completedFoldCount = options.completedFoldCount ?? plan.folds.length;
  integer(completedFoldCount, 1, plan.folds.length, 'completedFoldCount');
  const scenario = { fromIndex: 0, slopeChange: 0, ...copy(options.scenario ?? {}) };
  exactKeys(scenario, ['fromIndex', 'slopeChange']);
  integer(scenario.fromIndex, 0, 100000, 'scenario.fromIndex');
  assert(Number.isFinite(scenario.slopeChange) && Math.abs(scenario.slopeChange) <= 0.02, 'invalid scenario.slopeChange');
  // A prefix replay generates only its available history, never future rows.
  const end = plan.folds[completedFoldCount - 1].windows.test.end;
  const quotes = Array.from({ length: end / 1000 }, (_, i) => {
    // Exponential prices remain positive, including declining stress fixtures.
    const bid = 100 * Math.exp((i * 0.01 + Math.max(0, i - scenario.fromIndex + 1) * scenario.slopeChange) / 100);
    return { type: 'quote', symbol: 'USDJPY', t: i * 1000, observedAt: i * 1000,
      conversionObservedAt: i * 1000, bid, ask: bid + 0.001, quoteToAccount: 1 };
  });
  const results = [];
  for (const fold of plan.folds.slice(0, completedFoldCount)) {
    const partition = name => quotes.filter(q => q.t >= fold.windows[name].start && q.t < fold.windows[name].end);
    const train = partition('train'), selection = partition('selection');
    const evaluate = (candidate, tape, costMultiplier = 1) => evaluateQuoteCandidate({ candidate, quotes: tape,
      portfolio: plan.portfolio, costMultiplier });
    // Regenerate proposals independently in each fold, before scoring. Previous
    // outer results never seed, rank, or filter this fold's candidates.
    const candidates = generateCandidates(plan.config.seed, plan.config.maxTrials);
    assert(fingerprint(candidates) === fingerprint(plan.candidates), 'proposal generation changed');
    const trials = candidates.map(candidate => {
      try {
        const scores = { train: evaluate(candidate, train), selection: evaluate(candidate, selection),
          stress: evaluate(candidate, selection, 2) };
        return { candidate, ...scores, passed: Object.values(scores).every(developmentPass) };
      } catch (error) { return { candidate, passed: false, error: error.message }; }
    });
    const ranked = trials.filter(t => t.passed).sort((a, b) => b.selection.netProfitAfterCosts - a.selection.netProfitAfterCosts
      || a.candidate.id.localeCompare(b.candidate.id));
    const champion = ranked[0]?.candidate ?? null;
    // Deliberately excludes full-tape hash and scenario identity: unseen future
    // changes cannot change the frozen development decision or its identity.
    const decision = { foldIndex: fold.index, planHash: plan.planHash, selectionEnd: fold.windows.selection.end,
      candidatesHash: fingerprint(candidates), developmentHash: fingerprint({ train, selection }),
      trialsHash: fingerprint(trials), champion, baseline: 'all-flat' };
    const frozen = freeze({ ...decision, decisionHash: fingerprint(decision) });
    // Access to outer partition occurs only after the decision is frozen.
    const test = partition('test');
    let outer;
    if (champion) {
      try { outer = { status: 'evaluated', base: evaluate(champion, test), stress: evaluate(champion, test, 2) }; }
      catch (error) { outer = { status: 'evaluation-failed', error: error.message }; }
    } else outer = { status: 'all-flat', netProfitAfterCosts: 0, trades: 0 };
    results.push({ foldIndex: fold.index, windows: fold.windows, trials, frozen, testHash: fingerprint(test),
      outer, baselineNetProfit: 0, action: 'hold', eligible: false });
  }
  return { mode: 'virtual-only', action: 'hold', eligible: false, planHash: plan.planHash,
    provenance: 'internally invented synthetic quotes; NOT observed market evidence', scenario,
    completedFoldCount, plannedFoldCount: plan.folds.length, folds: results,
    // No concatenated equity/Sharpe: independent partitions start flat at equal
    // capital and boundary-open positions are censored, not liquidated trades.
    summary: { evaluatedFolds: results.filter(r => r.outer.status === 'evaluated').length,
      flatFolds: results.filter(r => r.outer.status === 'all-flat').length,
      failedFolds: results.filter(r => r.outer.status === 'evaluation-failed').length },
    reasons: ['synthetic_data_not_evidence', 'observed_outer_pipeline_not_implemented',
      'shared_observed_holdout_authority_not_integrated', 'no_score_based_adaptation',
      'financing_liquidity_and_margin_not_modeled', 'router_and_allocator_not_validated',
      'quote_count_holding_and_boundary_censoring_exploratory', 'insufficient_history'] };
}
