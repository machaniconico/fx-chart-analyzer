import { describe, it, expect } from 'vitest';
import { replayVirtualPortfolio as replay } from './virtual-portfolio.mjs';
const config = { initialEquity: 10000, maxTotalRiskFraction: .1, maxCurrencyRiskFraction: .1, maxDailyLossFraction: .05, maxDrawdownFraction: .2, maxPositions: 4, maxQuoteAgeMs: 100, maxSignalAgeMs: 1000, maxGrossLeverage: 100 };
const spec = { base: 'EUR', quote: 'USD', contractSize: 100000, lotStep: .01, minLot: .01, maxLot: 100, commissionPerLot: 0, slippage: 0 };
const instruments = { EURUSD: spec, GBPUSD: { ...spec, base: 'GBP' } };
const q = (t, bid = 1, extra = {}) => ({ type: 'quote', t, observedAt: t, conversionObservedAt: t, symbol: 'EURUSD', bid, ask: bid, quoteToAccount: 1, ...extra });
const enter = (id = 'a', t = 0, extra = {}) => ({ type: 'enter', id, t, ea: id, symbol: 'EURUSD', side: 'long', stop: .99, riskFraction: .01, priority: 0, ...extra });
const run = (events, overrides = {}, specs = instruments) => replay({ config: { ...config, ...overrides }, instruments: specs, events });
const opens = r => r.audit.filter(e => e.type === 'open');
const rejects = r => r.audit.filter(e => e.type === 'reject').map(e => e.reason);

describe('virtual shared-capital replay', () => {
  it('allows flat and never invents a fill or future mark', () => {
    expect(run([]).equity).toBe(10000);
    const r = run([enter(), q(0), q(1, 1.01)]);
    expect(opens(r)[0].t).toBe(1); expect(opens(r)[0].entryPrice).toBe(1.01);
    expect(r.equityCurve[0].positions).toBe(0);
    expect(rejects(run([enter(), q(0)]))).toContain('no-later-executable-quote');
  });
  it('orders same timestamp competing EAs by stable priority then id, not tape order', () => {
    const a = enter('a', 0, { priority: 2 }), b = enter('b', 0, { priority: 1 });
    const first = run([a, b, q(1)], { maxPositions: 1 });
    expect(opens(first)[0].id).toBe('b');
    expect(first).toEqual(run([b, a, q(1)], { maxPositions: 1 }));
    expect(opens(run([enter('b'), enter('a'), q(1)], { maxPositions: 1 }))[0].id).toBe('a');
  });
  it('uses current shared liquidation equity for lot sizing, including floating losses', () => {
    const r = run([enter(), q(1), enter('b', 2), q(3, .995)]);
    expect(opens(r)[0].lots).toBeCloseTo(.09); // Floors, never rounds risk upward.
    expect(opens(r)[1].sizingEquity).toBeCloseTo(9955);
    expect(opens(r)[1].lots).toBeCloseTo(.19);
  });
  it('caps overlapping stop risk rather than summing independent EA results', () => {
    const r = run([enter(), enter('b'), q(1)], { maxTotalRiskFraction: .015 });
    expect(opens(r)).toHaveLength(1); expect(rejects(r)).toContain('total-stop-risk');
  });
  it('caps shared currency legs across different symbols', () => {
    const r = run([enter(), enter('b', 0, { symbol: 'GBPUSD' }), q(1), q(1, 1, { symbol: 'GBPUSD' })], { maxCurrencyRiskFraction: .015 });
    expect(opens(r)).toHaveLength(1); expect(rejects(r)).toContain('currency-stop-risk');
  });
  it('blocks conflicting currency exposure and maximum gross leverage', () => {
    expect(rejects(run([enter(), enter('b', 0, { side: 'short', stop: 1.01 }), q(1)]))).toContain('currency-exposure-conflict');
    expect(rejects(run([enter(), q(1)], { maxGrossLeverage: .1 }))).toContain('gross-leverage');
  });
  it('latches unrealized daily loss, allows next-day recovery, keeps drawdown halted', () => {
    const tape = [enter('a', 0, { stop: .5, riskFraction: .06 }), q(1), enter('b', 2), q(3, .7), q(4, 1), enter('c', 86400000), q(86400001)];
    const r = run(tape, { maxDailyLossFraction: .01, maxDrawdownFraction: .5 });
    expect(rejects(r)).toContain('daily-loss-halt'); expect(opens(r).map(p => p.id)).toEqual(['a', 'c']);
    expect(rejects(run(tape, { maxDailyLossFraction: .5, maxDrawdownFraction: .01 }))).toContain('drawdown-halt');
  });
  it('executes stops at gap quote plus slippage and charges both commissions', () => {
    const r = run([enter(), q(1), q(2, .9)], {}, { EURUSD: { ...spec, slippage: .001, commissionPerLot: 5 } });
    const p = opens(r)[0], closed = r.audit.find(e => e.type === 'close');
    expect(p.entryPrice).toBe(1.001); expect(closed.price).toBe(.899);
    const loss = p.lots * (1.001 - .899) * 100000 + 10 * p.lots;
    expect(r.cash).toBeCloseTo(10000 - loss); expect(loss).toBeGreaterThan(p.plannedRisk);
    expect(r.positions).toHaveLength(0);
  });
  it('runs requested exit on later quote and prioritizes stop over exit', () => {
    const tape = [enter(), q(1), { type: 'exit', id: 'exit', positionId: 'a', t: 2 }, q(3, 1.01)];
    expect(run(tape).audit.find(e => e.type === 'close').reason).toBe('requested-exit');
    tape[3] = q(3, .98);
    expect(run(tape).audit.find(e => e.type === 'close').reason).toBe('stop-observed-quote');
  });
  it('rejects undersized lots, stale portfolio marks, expired signals and unprotective stops', () => {
    expect(rejects(run([enter('a', 0, { riskFraction: .000001 }), q(1)]))).toContain('below-min-lot');
    expect(rejects(run([enter(), q(1), enter('b', 2, { symbol: 'GBPUSD' }), q(200, 1, { symbol: 'GBPUSD' })]))).toContain('stale-portfolio-mark');
    expect(rejects(run([enter(), q(1001)]))).toContain('intent-expired');
    expect(rejects(run([enter(), q(1, .98)]))).toContain('stop-not-protective-at-fill');
  });
  it('is prefix invariant: future conversion and price cannot alter past fills', () => {
    const prefix = [enter(), q(1), enter('b', 2), q(3)];
    const short = run(prefix), long = run([...prefix, q(4, 5, { quoteToAccount: 150 })]);
    expect(opens(long)).toEqual(opens(short));
    expect(long.equityCurve.slice(0, short.equityCurve.length)).toEqual(short.equityCurve);
    expect(prefix[0]).not.toHaveProperty('lots');
  });
  it.each([
    [q(2), q(1)], [q(1), q(1)], [enter(), enter()], [q(1, NaN)],
    [q(1, 1, { ask: .9 })], [q(1, 1, { observedAt: 2 })],
    [q(1, 1, { conversionObservedAt: 2 })], [q(101, 1, { conversionObservedAt: 0 })],
    [enter('a', 0, { riskFraction: -1 })], [q(1, 1, { symbol: 'BAD' })],
    [{ type: 'balance-adjustment', t: 1 }], [q(1, 1, { futureClose: 2 })],
  ])('fails closed for invalid tape %j', (...events) => { expect(() => run(events)).toThrow(/virtual-portfolio/); });
  it('realizes overlapping EA losses against the same cash account', () => {
    const r = run([enter(), enter('b'), q(1), q(2, .98)]);
    const ps = opens(r);
    expect(ps).toHaveLength(2);
    expect(r.cash).toBeCloseTo(10000 - ps.reduce((loss, p) => loss + p.lots * 2000, 0));
    expect(r.positions).toHaveLength(0);
  });
  it('short stops fill at adverse ask gaps, not the stop price', () => {
    const r = run([enter('a', 0, { side: 'short', stop: 1.01 }), q(1), q(2, 1.09, { ask: 1.1 })]);
    const p = opens(r)[0];
    expect(r.audit.find(e => e.type === 'close').price).toBe(1.1);
    expect(r.cash).toBeCloseTo(10000 - p.lots * 10000);
  });
  it('records insolvency honestly instead of clipping a gap loss to capital', () => {
    const r = run([enter('a', 0, { side: 'short', stop: 1.01 }), q(1), enter('b', 2), q(3, 100)]);
    expect(r.cash).toBeLessThan(0); expect(r.drawdownHalt).toBe(true);
    expect(rejects(r)).toContain('drawdown-halt');
  });
  it('uses post-fill liquidation equity for leverage, including spread and fees', () => {
    const specs = { EURUSD: { ...spec, contractSize: 100, lotStep: 1, minLot: 1 } };
    const tape = [enter('a', 0, { stop: 90, riskFraction: .1 }), q(1, 99, { ask: 100 })];
    const r = run(tape, { maxGrossLeverage: 1 }, specs);
    expect(opens(r)).toHaveLength(0); expect(rejects(r)).toEqual(['gross-leverage']);
    expect(r.equity).toBe(10000);
    const feeSpecs = { EURUSD: { ...specs.EURUSD, commissionPerLot: 10 } };
    const feeTape = [enter('a', 0, { stop: 91, riskFraction: .1 }), q(1, 100)];
    expect(rejects(run(feeTape, { maxGrossLeverage: 1 }, feeSpecs))).toEqual(['gross-leverage']);
  });
  it('uses post-fill denominator for remaining total and currency stop risk without charging friction twice', () => {
    const specs = { EURUSD: { ...spec, contractSize: 100, lotStep: 1, minLot: 1 } };
    const tape = [enter('a', 0, { stop: 90, riskFraction: .1 }), q(1, 99, { ask: 100 })];
    expect(rejects(run(tape, { maxTotalRiskFraction: .0905 }, specs))).toEqual(['total-stop-risk']);
    expect(rejects(run(tape, { maxCurrencyRiskFraction: .0905 }, specs))).toEqual(['currency-stop-risk']);
    const accepted = run(tape, { maxTotalRiskFraction: .091, maxCurrencyRiskFraction: .091 }, specs);
    expect(opens(accepted)).toHaveLength(1);
    expect(opens(accepted)[0].plannedRisk).toBe(1000);
    expect(opens(accepted)[0].remainingStopRisk).toBe(900);
    expect(opens(accepted)[0].postFillEquity).toBe(9900);
    expect(accepted.equity).toBe(9900);
  });
  it('preflights daily-loss and drawdown gates against entry friction', () => {
    const specs = { EURUSD: { ...spec, contractSize: 100, lotStep: 1, minLot: 1 } };
    const tape = [enter('a', 0, { stop: 90, riskFraction: .1 }), q(1, 99, { ask: 100 })];
    expect(rejects(run(tape, { maxDailyLossFraction: .005 }, specs))).toEqual(['post-fill-daily-loss']);
    expect(rejects(run(tape, { maxDrawdownFraction: .005 }, specs))).toEqual(['post-fill-drawdown']);
    expect(run(tape, { maxDrawdownFraction: .005 }, specs).drawdownHalt).toBe(false);
  });
  it('retains safety-reducing exits through quote gaps beyond entry intent expiry', () => {
    const r = run([enter(), q(1), { type: 'exit', id: 'exit', positionId: 'a', t: 2 },
      enter('b', 2), q(1500, 1, { symbol: 'GBPUSD' }), q(2003, 1.01)]);
    expect(r.positions).toHaveLength(0);
    expect(r.audit.find(e => e.type === 'close')).toMatchObject({ t: 2003, reason: 'requested-exit' });
    expect(r.audit.filter(e => e.type === 'reject')).toEqual([
      expect.objectContaining({ id: 'b', reason: 'intent-expired' }),
    ]);
  });
  it('fails closed for missing, invalid config and non-finite arithmetic', () => {
    expect(() => run([], { initialEquity: Infinity })).toThrow();
    expect(() => run([], { maxPositions: undefined })).toThrow();
    expect(() => run([enter(), q(1, 1, { quoteToAccount: 1e308 })])).toThrow();
  });
});
