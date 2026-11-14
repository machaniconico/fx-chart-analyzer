import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyntheticOuterPlan, replaySyntheticOuterPlan } from './synthetic-outer-replay.mjs';
import { fingerprint } from './virtual-autonomy.mjs';
import { runResearchCycle } from './virtual-research-cycle.mjs';
import { createSyntheticFileStore } from './research-reservations.mjs';
const clone = x => JSON.parse(JSON.stringify(x));

describe('synthetic causal outer pipeline foundation', () => {
  it('fixes all windows, proposals, rules and engine identity before scoring', () => {
    const plan = createSyntheticOuterPlan();
    expect(plan).toEqual(createSyntheticOuterPlan());
    expect(Object.isFrozen(plan.folds[0].windows.test)).toBe(true);
    expect(Object.isFrozen(plan.candidates[0].parameters)).toBe(true);
    let previous = null;
    for (const fold of plan.folds) for (const window of Object.values(fold.windows)) {
      if (previous) expect(window.start - previous.end).toBeGreaterThanOrEqual(plan.embargoMs);
      previous = window;
    }
    expect(plan.candidates).toHaveLength(12);
  });

  it('replays deterministically and never upgrades even a profitable fixture', () => {
    const plan = createSyntheticOuterPlan();
    const result = replaySyntheticOuterPlan(plan);
    expect(replaySyntheticOuterPlan(plan)).toEqual(result);
    expect(result.summary).toEqual({ evaluatedFolds: 3, flatFolds: 0, failedFolds: 0 });
    expect(result.folds[0].outer.base.netProfitAfterCosts).toBeGreaterThan(0);
    expect(result.action).toBe('hold'); expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('observed_outer_pipeline_not_implemented');
    expect(result.folds.every(f => !f.eligible && f.action === 'hold')).toBe(true);
    for (const fold of result.folds) {
      expect(fold.trials).toHaveLength(12);
      expect(fold.frozen.selectionEnd).toBeLessThan(fold.windows.test.start);
      expect(fold.outer.stress.costMultiplier).toBe(2);
    }
  });

  it('keeps all completed fold results identical when later folds become available', () => {
    const plan = createSyntheticOuterPlan();
    const full = replaySyntheticOuterPlan(plan);
    for (const completedFoldCount of [1, 2]) {
      const prefix = replaySyntheticOuterPlan(plan, { completedFoldCount });
      expect(prefix.folds).toEqual(full.folds.slice(0, completedFoldCount));
      expect(prefix.planHash).toBe(full.planHash);
    }
  });

  it('changes outer scores but not proposals, trial scores or the frozen decision when the holdout changes', () => {
    const plan = createSyntheticOuterPlan();
    const base = replaySyntheticOuterPlan(plan, { completedFoldCount: 1 });
    const changed = replaySyntheticOuterPlan(plan, { completedFoldCount: 1,
      scenario: { fromIndex: plan.folds[0].windows.test.start / 1000, slopeChange: -0.02 } });
    expect(changed.folds[0].trials).toEqual(base.folds[0].trials);
    expect(changed.folds[0].frozen).toEqual(base.folds[0].frozen);
    expect(changed.folds[0].testHash).not.toBe(base.folds[0].testHash);
    expect(changed.folds[0].outer).not.toEqual(base.folds[0].outer);
  });

  it('does not allow a changed future fold to rewrite a completed earlier fold', () => {
    const plan = createSyntheticOuterPlan();
    const base = replaySyntheticOuterPlan(plan);
    const changed = replaySyntheticOuterPlan(plan, {
      scenario: { fromIndex: plan.folds[1].windows.train.start / 1000, slopeChange: -0.02 } });
    expect(changed.folds[0]).toEqual(base.folds[0]);
    expect(changed.folds[1].frozen.developmentHash).not.toBe(base.folds[1].frozen.developmentHash);
    expect(changed.folds[1].frozen.candidatesHash).toBe(base.folds[1].frozen.candidatesHash);
  });

  it('retains failed trials and chooses all-flat rather than forcing a candidate', () => {
    const plan = createSyntheticOuterPlan({ trainQuotes: 8, selectionQuotes: 8 });
    const result = replaySyntheticOuterPlan(plan);
    expect(result.summary.flatFolds).toBe(3);
    expect(result.folds[0].trials.some(t => t.error?.includes('insufficient partition quotes'))).toBe(true);
    expect(result.folds.every(f => f.frozen.champion === null && f.outer.trades === 0)).toBe(true);
  });

  it('reports outer evaluation errors rather than treating them as flat profits', () => {
    const result = replaySyntheticOuterPlan(createSyntheticOuterPlan({ testQuotes: 8 }));
    expect(result.summary.failedFolds).toBe(3);
    expect(result.summary.flatFolds).toBe(0);
    expect(result.folds[0].outer.error).toContain('insufficient partition quotes');
  });

  it('rejects edited plans, even with recomputed hashes', () => {
    for (const edit of [p => { p.folds[0].windows.test.start = 0; },
      p => { p.selectionRule = 'pick by outer profits'; }, p => { p.candidates.reverse(); },
      p => { p.policy.maxDrawdownPct = 100; }]) {
      const plan = clone(createSyntheticOuterPlan()); edit(plan);
      const { planHash: ignored, ...body } = plan; plan.planHash = fingerprint(body);
      expect(() => replaySyntheticOuterPlan(plan)).toThrow('plan changed');
    }
  });

  it('refuses observed tapes and unbounded or malformed configurations', () => {
    expect(() => createSyntheticOuterPlan({ dataset: { provenance: { kind: 'observed' } } })).toThrow('unsupported input');
    expect(() => createSyntheticOuterPlan({ foldCount: 7 })).toThrow('foldCount');
    expect(() => createSyntheticOuterPlan({ embargoQuotes: 0 })).toThrow('embargoQuotes');
    expect(() => createSyntheticOuterPlan({ maxTrials: 21 })).toThrow('trial limit');
    expect(() => createSyntheticOuterPlan({ trainQuotes: Infinity })).toThrow();
    const plan = createSyntheticOuterPlan();
    expect(() => replaySyntheticOuterPlan(plan, { quotes: [] })).toThrow('unsupported input');
    expect(() => replaySyntheticOuterPlan(plan, { completedFoldCount: 0 })).toThrow('completedFoldCount');
    expect(() => replaySyntheticOuterPlan(plan, { scenario: { quotes: [] } })).toThrow('unsupported input');
    expect(() => replaySyntheticOuterPlan(plan, { scenario: { slopeChange: 0.5 } })).toThrow('slopeChange');
  });

  it('matches the existing bounded selector and outer scores on the identical synthetic tape', async () => {
    const plan = createSyntheticOuterPlan({ foldCount: 1 });
    const actual = replaySyntheticOuterPlan(plan).folds[0];
    const quotes = Array.from({ length: plan.folds[0].windows.test.end / 1000 }, (_, i) => {
      const bid = 100 * Math.exp(i * 0.01 / 100), t = i * 1000;
      return { type: 'quote', symbol: 'USDJPY', t, observedAt: t, conversionObservedAt: t,
        bid, ask: bid + 0.001, quoteToAccount: 1 };
    });
    const dir = mkdtempSync(join(tmpdir(), 'synthetic-outer-parity-'));
    try {
      const existing = await runResearchCycle({ request: {
        dataset: { provenance: { kind: 'synthetic', source: 'invented outer parity fixture, NOT market evidence' }, quotes },
        portfolio: plan.portfolio, windows: plan.folds[0].windows, embargoMs: plan.embargoMs,
        seed: plan.config.seed, maxTrials: plan.config.maxTrials,
      }, stateDir: join(dir, 'artifacts'), reservationStore: createSyntheticFileStore(join(dir, 'authority')) });
      expect(actual.frozen.champion).toEqual(existing.frozen.champion);
      expect(actual.outer.base).toEqual(existing.finalTest.base);
      expect(actual.outer.stress).toEqual(existing.finalTest.stress);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
