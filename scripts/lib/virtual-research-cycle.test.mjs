import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { generateCandidates, evaluateQuoteCandidate, runResearchCycle, syntheticResearchRequest } from './virtual-research-cycle.mjs';
const temp = fn => { const dir = mkdtempSync(join(tmpdir(), 'research-test-')); try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
const run = (stateDir, request = syntheticResearchRequest()) => runResearchCycle({ request, stateDir });

describe('bounded quote research cycle', () => {
  it('bounds deterministic proposals and rejects unsafe sizing', () => {
    const r = syntheticResearchRequest();
    expect(generateCandidates(r.seed, 12)).toEqual(generateCandidates(r.seed, 12));
    expect(generateCandidates(r.seed, 12)).toHaveLength(12);
    expect(generateCandidates(r.seed, 2).map(c => c.parameters.family)).toEqual(['trend', 'range']);
    expect(generateCandidates(r.seed, 12).some(c => c.parameters.family === 'range')).toBe(true);
    expect(() => generateCandidates(r.seed, 21)).toThrow('trial limit');
    expect(() => generateCandidates({ ...r.seed, riskFraction: 0.02 }, 1)).toThrow('riskFraction');
  });
  it('replays actual quote costs deterministically and reports boundary censoring', () => {
    const r = syntheticResearchRequest(), candidate = generateCandidates(r.seed, 1)[0];
    const args = { candidate, portfolio: r.portfolio, quotes: r.dataset.quotes };
    const base = evaluateQuoteCandidate(args);
    expect(base).toEqual(evaluateQuoteCandidate(args));
    expect(base.trades).toBeGreaterThan(0); expect(base.finalPositions).toBe(base.censoredOpenPositions);
    expect(evaluateQuoteCandidate({ ...args, costMultiplier: 2 }).netProfitAfterCosts).toBeLessThan(base.netProfitAfterCosts);
  });
  it('keeps prior intents and fills unchanged when future quote rows are appended', () => {
    const r = syntheticResearchRequest();
    const candidate = generateCandidates({ ...r.seed, lookback: 2, holdSteps: 1 }, 1)[0];
    for (const length of [8, 9, 10, 11, 12, 17, 25]) {
      const args = { candidate, portfolio: r.portfolio, includeTrace: true };
      const prefix = evaluateQuoteCandidate({ ...args, quotes: r.dataset.quotes.slice(0, length) });
      const extended = evaluateQuoteCandidate({ ...args, quotes: r.dataset.quotes.slice(0, length + 7) });
      const cutoff = r.dataset.quotes[length - 1].t;
      expect(prefix.executionTrace).toEqual(extended.executionTrace.filter(x => x.t <= cutoff));
    }
    const censored = evaluateQuoteCandidate({ candidate, portfolio: r.portfolio, quotes: r.dataset.quotes.slice(0, 7), includeTrace: true });
    expect(censored.censoredOpenPositions).toBe(1);
    const completed = censored.executionTrace.filter(x => x.type === 'close');
    const opens = new Map(censored.executionTrace.filter(x => x.type === 'open').map(x => [x.id, x]));
    expect(censored.trades).toBe(completed.length);
    expect(censored.netProfitAfterCosts).toBeCloseTo(completed.reduce((n, x) => n + x.netPnlExcludingEntryFee - opens.get(x.id).entryFee, 0));
    expect(censored.terminalLiquidationNetProfit).not.toBe(censored.netProfitAfterCosts);
  });
  it('logs every trial, freezes before test, always holds synthetic evidence, and reruns idempotently', () => temp(dir => {
    const r = run(dir); expect(r.action).toBe('hold'); expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('synthetic_data_not_evidence'); expect(r.reasons).toContain('observed_bid_ask_tape_not_supplied');
    expect(r.finalTest.base.trades).toBeGreaterThan(0);
    const audit = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
    expect(run(dir)).toEqual(r); expect(readFileSync(join(dir, 'audit.jsonl'), 'utf8')).toBe(audit);
    expect(readdirSync(join(dir, r.cycleId)).filter(x => x.startsWith('trial-'))).toHaveLength(12);
    const events = audit.trim().split('\n').map(JSON.parse);
    expect(events.findIndex(e => e.type === 'selection-frozen')).toBeLessThan(events.findIndex(e => e.type === 'holdout-recorded'));
    expect(events[0].type).toBe('holdout-reserved');
  }));
  it('rejects renamed, changed, or partially overlapping holdout; accepts only later fresh cycles', () => temp(dir => {
    run(dir);
    const renamed = syntheticResearchRequest(); renamed.dataset.provenance.source = 'renamed';
    expect(() => run(dir, renamed)).toThrow('reused or overlapping');
    const changed = syntheticResearchRequest(); changed.dataset.quotes.at(-1).bid += 0.0001;
    expect(() => run(dir, changed)).toThrow('reused or overlapping');
    expect(() => run(dir, syntheticResearchRequest(300000))).toThrow('reused or overlapping');
    const next = run(dir, syntheticResearchRequest(1200000)); expect(next.action).toBe('hold');
  }));
  it('holds observed-data claims too; no provenance boolean can certify', () => temp(dir => {
    const r = syntheticResearchRequest(); r.dataset.provenance.kind = 'observed';
    const result = run(dir, r); expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('provenance_not_independently_verified');
  }));
  it('never uses final holdout outcomes to change the selected parameters', () => temp(a => temp(b => {
    const good = syntheticResearchRequest(), bad = syntheticResearchRequest();
    for (const q of bad.dataset.quotes) if (q.t >= bad.windows.test.start) { q.ask = q.bid + 5; }
    const first = run(a, good), second = run(b, bad);
    expect(second.frozen.champion).toEqual(first.frozen.champion);
    expect(second.finalTest.base.netProfitAfterCosts).toBeLessThan(first.finalTest.base.netProfitAfterCosts);
    expect(second.action).toBe('hold'); expect(second.reasons).toContain('final_holdout_or_cost_stress_failed');
  })));
  it('blocks artifact tampering, stale locks, partial journals, and interrupted reservations', () => {
    temp(dir => { const result = run(dir), path = join(dir, result.cycleId, 'result.json'); chmodSync(path, 0o600); writeFileSync(path, '{}'); expect(() => run(dir)).toThrow('artifact modified'); });
    temp(dir => { writeFileSync(join(dir, 'research.lock'), 'stale'); expect(() => run(dir)).toThrow(); });
    temp(dir => { writeFileSync(join(dir, 'audit.jsonl'), '{'); expect(() => run(dir)).toThrow(); });
    temp(dir => { run(dir); const path = join(dir, 'audit.jsonl'); writeFileSync(path, readFileSync(path, 'utf8').split('\n')[0] + '\n'); expect(() => run(dir)).toThrow('interrupted cycle'); });
  });
  it('rejects OHLC, future conversions, overlapping windows and future prices', () => temp(dir => {
    expect(() => run(dir, { bars: [] })).toThrow('OHLC');
    const r = syntheticResearchRequest(); r.dataset.quotes[1].conversionObservedAt += 1; expect(() => run(dir, r)).toThrow('noncontemporaneous');
    const s = syntheticResearchRequest(); s.windows.selection.start = 100; expect(() => run(dir, s)).toThrow('overlapping');
    expect(() => run(dir, syntheticResearchRequest(Date.now() + 10000))).toThrow('chronological');
  }));
  it('logs all failed trials and leaves no champion when costs overwhelm signals', () => temp(dir => {
    const r = syntheticResearchRequest(); for (const q of r.dataset.quotes) q.ask = q.bid + 1;
    const result = run(dir, r); expect(result.rejectedTrialCount).toBe(result.trialCount);
    expect(result.frozen.champion).toBe(null); expect(result.finalTest).toBe(null);
  }));
  it('offers a runnable demo CLI with nonzero blocked exit status', () => temp(dir => {
    const result = spawnSync(process.execPath, ['scripts/run-virtual-research.mjs', '--demo', dir], { encoding: 'utf8' });
    expect(result.status).toBe(3); expect(JSON.parse(result.stdout).eligible).toBe(false); expect(result.stderr).toBe('');
  }));
});
