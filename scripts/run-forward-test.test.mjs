import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildCandidateMatrix } from './tune-virtual-strategies.mjs';
import {
  buildMonthlySummary,
  buildConfirmedHistoryDays,
  buildForwardArtifacts,
  buildStrategyReport,
  fingerprintStrategyDefinition,
  FORWARD_HISTORY_SCHEMA_VERSION,
  FORWARD_RESULTS_SCHEMA_VERSION,
  knownEntryConditionTypes,
  mergeForwardHistory,
  splitBarsByRegistration,
  TWO_YEARS_SECONDS,
} from './run-forward-test.mjs';
import { retiredStrategyLedgerKey, retireStrategy } from './retire-strategy.mjs';

const registeredAt = 1782996300;
const UTC_DAY_SECONDS = 24 * 60 * 60;

const bar = (time) => ({
  t: time,
  o: 100,
  h: 101,
  l: 99,
  c: 100,
  v: 1000,
});

const strategy = {
  meta: {
    id: 'virtual-test-v1',
    name: '仮想テスト',
    version: 1,
    pair: 'USDJPY',
    timeframe: 'h1',
    registeredAt,
  },
  id: 'virtual-test-v1',
  name: '仮想テスト',
  direction: 'long',
  entryDirections: ['long', 'short'],
  entryConditions: [
    {
      type: 'maCross',
      fastType: 'ema',
      fastPeriod: 10,
      slowType: 'ema',
      slowPeriod: 20,
    },
  ],
  exit: {
    stopLossPips: 10,
    takeProfitPips: 20,
    trailingStopPips: null,
    closeOnOppositeSignal: false,
  },
  sessionFilter: {
    enabled: false,
    start: '00:00',
    end: '23:59',
    serverUtcOffsetMinutes: 0,
  },
  newsFilter: {
    enabled: false,
    blockMinutes: 30,
  },
  lotSize: 0.1,
  moneyManagement: {
    initialBalanceYen: 1_000_000,
    lotSizingMode: 'fixedRisk',
    fixedLot: 0.1,
    riskPercent: 1,
    maxLot: 100,
  },
  magicNumber: 1,
};

const selectionEvidence = {
  adoptedAt: '2026-08-18',
  reportId: 'selection-report-v1',
  candidatePool: 108,
  passedCount: 27,
  inSampleRank: 2,
  optimization: {
    netProfitYen: 269980,
    profitFactor: 1.2,
    tradeCount: 171,
  },
  validation: {
    netProfitYen: 117940,
    profitFactor: 1.24,
  },
  quarterlyStability: {
    positive: 4,
    total: 4,
  },
  reservations: ['採用時点の留保'],
};

const emptyBacktestResult = (bars) => ({
  pair: 'USDJPY',
  spreadPips: 0.9,
  moneyManagement: strategy.moneyManagement,
  conversionNote: '',
  winRate: 0,
  profitFactor: 0,
  maxDrawdownPips: 0,
  maxDrawdownYen: 0,
  maxDrawdownPct: 0,
  tradeCount: 0,
  netPips: 0,
  netProfitYen: 0,
  grossProfitPips: 0,
  grossLossPips: 0,
  grossProfitYen: 0,
  grossLossYen: 0,
  riskRewardRatio: 0,
  averageWinYen: 0,
  averageLossYen: 0,
  maxConsecutiveWins: 0,
  maxConsecutiveLosses: 0,
  trades: [],
  equityCurve: bars.map((item) => ({
    time: item.t,
    equityPips: 0,
    drawdownPips: 0,
    equityYen: 1_000_000,
    netProfitYen: 0,
    drawdownYen: 0,
    drawdownPct: 0,
  })),
});

describe('forward test runner', () => {
  it('exports a frozen entry condition type registry', () => {
    expect(Array.isArray(knownEntryConditionTypes)).toBe(true);
    expect(Object.isFrozen(knownEntryConditionTypes)).toBe(true);
    expect(() => knownEntryConditionTypes.push('unexpected')).toThrow(TypeError);
    expect(knownEntryConditionTypes).toEqual([
      'maCross',
      'rsi',
      'bollinger',
      'macdCross',
      'ichimokuCross',
      'donchianBreak',
      'stochastic',
      'keltnerBreak',
      'cciBreak',
      'adxTrend',
    ]);
  });

  it('filters forward bars to registeredAt or later', () => {
    const bars = [
      bar(registeredAt - TWO_YEARS_SECONDS - 60),
      bar(registeredAt - 60),
      bar(registeredAt),
      bar(registeredAt + 60),
    ];

    const split = splitBarsByRegistration(bars, registeredAt);

    expect(split.forwardBars.map((item) => item.t)).toEqual([registeredAt, registeredAt + 60]);
    expect(split.referenceBars.map((item) => item.t)).toEqual([registeredAt - 60]);
  });

  it('does not pass pre-registration bars into the forward backtest', () => {
    const calls = [];
    const report = buildStrategyReport({
      strategy,
      bars: [bar(registeredAt - 60), bar(registeredAt), bar(registeredAt + 60)],
      usdJpyBars: [bar(registeredAt - 30), bar(registeredAt + 30)],
      runBacktest: (bars) => {
        calls.push(bars);
        return emptyBacktestResult(bars);
      },
    });

    expect(calls[0].every((item) => item.t >= registeredAt)).toBe(true);
    expect(calls[1].every((item) => item.t < registeredAt)).toBe(true);
    expect(report.barsEvaluated).toBe(2);
    expect(report.historyCandidate.strategyFingerprint).toBe(
      fingerprintStrategyDefinition(strategy),
    );
  });

  it('keeps the expected zero-trade schema', () => {
    const report = buildStrategyReport({
      strategy,
      bars: [bar(registeredAt - 60)],
      usdJpyBars: [bar(registeredAt - 60)],
      runBacktest: emptyBacktestResult,
    });

    expect(report).toMatchObject({
      meta: strategy.meta,
      forward: {
        metrics: {
          tradeCount: 0,
          winRate: 0,
          netProfitYen: 0,
          maxDrawdownYen: 0,
        },
        trades: [],
        equityCurve: [],
      },
      barsEvaluated: 0,
    });
  });

  it('passes validated selection evidence through to each result strategy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fx-forward-selection-evidence-test-'));
    const virtualDirectory = path.join(root, 'strategies/virtual');
    try {
      await mkdir(virtualDirectory, { recursive: true });
      await writeFile(
        path.join(virtualDirectory, `${strategy.meta.id}.json`),
        `${JSON.stringify({ ...strategy, selectionEvidence }, null, 2)}\n`,
        'utf8',
      );

      const artifacts = await buildForwardArtifacts({
        strategiesDirectory: virtualDirectory,
        loadBarsFor: async () => [bar(registeredAt), bar(registeredAt + 60)],
        runBacktest: emptyBacktestResult,
        evaluateRetirement: () => ({ status: 'active', reason: 'test' }),
        retiredLedger: { schemaVersion: 1, strategies: {} },
      });

      expect(artifacts.results.strategies).toHaveLength(1);
      expect(artifacts.results.strategies[0].selectionEvidence).toEqual(selectionEvidence);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps legacy strategies without selection evidence unchanged', () => {
    const report = buildStrategyReport({
      strategy,
      bars: [bar(registeredAt)],
      usdJpyBars: [bar(registeredAt)],
      runBacktest: emptyBacktestResult,
    });

    expect(Object.hasOwn(report, 'selectionEvidence')).toBe(false);
  });

  it.each([
    {
      name: 'non-object evidence',
      selectionEvidence: null,
      expected: /selectionEvidence must be an object/,
    },
    {
      name: 'wrong report id type',
      selectionEvidence: { ...selectionEvidence, reportId: 123 },
      expected: /selectionEvidence\.reportId must be a non-empty string/,
    },
    {
      name: 'wrong report label type',
      selectionEvidence: { ...selectionEvidence, reportLabel: 123 },
      expected: /selectionEvidence\.reportLabel must be a non-empty string/,
    },
    {
      name: 'wrong passed count type',
      selectionEvidence: { ...selectionEvidence, passedCount: '27' },
      expected: /selectionEvidence\.passedCount must be a non-negative integer/,
    },
    {
      name: 'passed count exceeds candidate pool',
      selectionEvidence: { ...selectionEvidence, passedCount: 109 },
      expected: /selectionEvidence\.passedCount must be a non-negative integer not greater than candidatePool/,
    },
    {
      name: 'in-sample rank exceeds passed count',
      selectionEvidence: { ...selectionEvidence, passedCount: 1, inSampleRank: 2 },
      expected: /selectionEvidence\.inSampleRank cannot exceed passedCount/,
    },
    {
      name: 'wrong optimization trade count type',
      selectionEvidence: {
        ...selectionEvidence,
        optimization: { ...selectionEvidence.optimization, tradeCount: '171' },
      },
      expected: /selectionEvidence\.optimization\.tradeCount must be a non-negative integer/,
    },
  ])('throws for malformed selection evidence: $name', ({ selectionEvidence: invalid, expected }) => {
    expect(() => buildStrategyReport({
      strategy: { ...strategy, selectionEvidence: invalid },
      bars: [bar(registeredAt)],
      usdJpyBars: [bar(registeredAt)],
      runBacktest: emptyBacktestResult,
    })).toThrow(expected);
  });

  it('keeps selection evidence without the optional passed count valid', () => {
    const { passedCount: _passedCount, ...legacyEvidence } = selectionEvidence;

    expect(() => buildStrategyReport({
      strategy: { ...strategy, selectionEvidence: legacyEvidence },
      bars: [bar(registeredAt)],
      usdJpyBars: [bar(registeredAt)],
      runBacktest: emptyBacktestResult,
    })).not.toThrow();
  });

  it('accepts boundary passed counts (zero without rank, equal to candidate pool)', () => {
    const { inSampleRank: _rank, ...noRankEvidence } = selectionEvidence;
    for (const evidence of [
      { ...noRankEvidence, rankNote: '合格ゼロ回のラン(境界検証用)', passedCount: 0 },
      { ...selectionEvidence, passedCount: selectionEvidence.candidatePool },
    ]) {
      expect(() => buildStrategyReport({
        strategy: { ...strategy, selectionEvidence: evidence },
        bars: [bar(registeredAt)],
        usdJpyBars: [bar(registeredAt)],
        runBacktest: emptyBacktestResult,
      })).not.toThrow();
    }
  });

  it('rejects invalid virtual strategy JSON before running backtests', () => {
    const cases = [
      {
        id: 'invalid-stop-v1',
        patch: {
          exit: {
            ...strategy.exit,
            stopLossPips: 0,
          },
        },
        expected: /invalid-stop-v1: exit\.stopLossPips must be a positive finite number/,
      },
      {
        id: 'invalid-take-v1',
        patch: {
          exit: {
            ...strategy.exit,
            takeProfitPips: null,
          },
        },
        expected: /invalid-take-v1: exit\.takeProfitPips must be a positive finite number/,
      },
      {
        id: 'invalid-empty-conditions-v1',
        patch: {
          entryConditions: [],
        },
        expected: /invalid-empty-conditions-v1: entryConditions must be a non-empty array/,
      },
      {
        id: 'invalid-condition-type-v1',
        patch: {
          entryConditions: [
            {
              type: 'macd',
            },
          ],
        },
        expected: /invalid-condition-type-v1: entryConditions\[0\]\.type must be one of maCross, rsi, bollinger, macdCross, ichimokuCross, donchianBreak, stochastic, keltnerBreak, cciBreak, adxTrend/,
      },
    ];

    for (const { id, patch, expected } of cases) {
      const invalidStrategy = JSON.parse(JSON.stringify({
        ...strategy,
        ...patch,
        meta: {
          ...strategy.meta,
          id,
        },
        id,
      }));

      expect(() =>
        buildStrategyReport({
          strategy: invalidStrategy,
          bars: [bar(registeredAt)],
          usdJpyBars: [bar(registeredAt)],
          runBacktest: emptyBacktestResult,
        }),
      ).toThrow(expected);
    }
  });

  it.each([
    ['donchianBreak', { type: 'donchianBreak', period: 20 }],
    [
      'ichimokuCross',
      {
        type: 'ichimokuCross',
        conversionPeriod: 9,
        basePeriod: 26,
        spanBPeriod: 52,
        displacement: 26,
        requireCloudFilter: true,
      },
    ],
    [
      'stochastic',
      {
        type: 'stochastic',
        kPeriod: 14,
        dPeriod: 3,
        smoothing: 3,
        threshold: 20,
        comparison: 'crossAbove',
      },
    ],
    [
      'keltnerBreak',
      {
        type: 'keltnerBreak',
        emaPeriod: 20,
        atrPeriod: 10,
        multiplier: 2,
      },
    ],
    ['cciBreak', { type: 'cciBreak', period: 14, level: 100 }],
    ['adxTrend', { type: 'adxTrend', period: 14, threshold: 25 }],
  ])('accepts %s entry conditions in virtual strategies', (entryType, entryCondition) => {
    const candidate = JSON.parse(JSON.stringify(strategy));
    candidate.meta.id = `virtual-${entryType}-v1`;
    candidate.meta.name = `${entryType} test`;
    candidate.id = candidate.meta.id;
    candidate.name = candidate.meta.name;
    candidate.entryConditions = [entryCondition];

    expect(() => buildStrategyReport({
      strategy: candidate,
      bars: [bar(registeredAt)],
      usdJpyBars: [bar(registeredAt)],
      runBacktest: emptyBacktestResult,
    })).not.toThrow();
  });

  it('accepts every generated tuning candidate', () => {
    const candidates = buildCandidateMatrix();

    // 正確な件数は tune-virtual-strategies.test.mjs が所有(二重管理を避け、ここでは非空のみ)
    expect(candidates.length).toBeGreaterThan(0);
    for (const { strategy: candidate } of candidates) {
      expect(() => buildStrategyReport({
        strategy: candidate,
        bars: [bar(candidate.meta.registeredAt)],
        usdJpyBars: [bar(candidate.meta.registeredAt)],
        runBacktest: emptyBacktestResult,
      })).not.toThrow();
    }
  });

  it('accepts the standard Ichimoku cloud displacement configuration', () => {
    const candidate = JSON.parse(JSON.stringify(strategy));
    candidate.entryConditions = [{
      type: 'ichimokuCross',
      conversionPeriod: 9,
      basePeriod: 26,
      spanBPeriod: 52,
      displacement: 26,
      requireCloudFilter: true,
    }];

    expect(() => buildStrategyReport({
      strategy: candidate,
      bars: [bar(registeredAt)],
      usdJpyBars: [bar(registeredAt)],
      runBacktest: emptyBacktestResult,
    })).not.toThrow();
  });

  const validEntryConditionCases = [
    [
      'maCross',
      {
        type: 'maCross',
        fastType: 'ema',
        fastPeriod: 10,
        slowType: 'sma',
        slowPeriod: 20,
      },
    ],
    ['rsi', { type: 'rsi', period: 14, threshold: 30, comparison: 'below' }],
    [
      'bollinger',
      { type: 'bollinger', period: 20, multiplier: 2, mode: 'break', band: 'upper' },
    ],
    ['macdCross', { type: 'macdCross', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }],
    [
      'ichimokuCross',
      {
        type: 'ichimokuCross',
        conversionPeriod: 9,
        basePeriod: 26,
        spanBPeriod: 52,
        displacement: 26,
        requireCloudFilter: true,
      },
    ],
    ['donchianBreak', { type: 'donchianBreak', period: 20 }],
    [
      'stochastic',
      {
        type: 'stochastic',
        kPeriod: 14,
        dPeriod: 3,
        smoothing: 3,
        threshold: 20,
        comparison: 'crossAbove',
      },
    ],
    ['keltnerBreak', { type: 'keltnerBreak', emaPeriod: 20, atrPeriod: 10, multiplier: 2 }],
    ['cciBreak', { type: 'cciBreak', period: 14, level: 100 }],
  ];

  it.each(validEntryConditionCases)('accepts every %s condition with valid parameters', (entryType, entryCondition) => {
    const candidate = JSON.parse(JSON.stringify(strategy));
    candidate.meta.id = `valid-${entryType}-v1`;
    candidate.meta.name = `${entryType} valid test`;
    candidate.id = candidate.meta.id;
    candidate.name = candidate.meta.name;
    candidate.entryConditions = [entryCondition];

    expect(() => buildStrategyReport({
      strategy: candidate,
      bars: [bar(registeredAt)],
      usdJpyBars: [bar(registeredAt)],
      runBacktest: emptyBacktestResult,
    })).not.toThrow();
  });

  it('accepts a stochastic overbought threshold on the RSI 0-100 scale', () => {
    const candidate = JSON.parse(JSON.stringify(strategy));
    candidate.entryConditions = [{
      type: 'stochastic',
      kPeriod: 14,
      dPeriod: 3,
      smoothing: 3,
      threshold: 80,
      comparison: 'above',
    }];

    expect(() => buildStrategyReport({
      strategy: candidate,
      bars: [bar(registeredAt)],
      usdJpyBars: [bar(registeredAt)],
      runBacktest: emptyBacktestResult,
    })).not.toThrow();
  });

  it.each([
    [
      'maCross',
      {
        type: 'maCross',
        fastType: 'ema',
        fastPeriod: 20,
        slowType: 'sma',
        slowPeriod: 20,
      },
      /entryConditions\[0\]\.fastPeriod must be smaller than slowPeriod/,
    ],
    [
      'rsi',
      { type: 'rsi', period: 14, comparison: 'below' },
      /entryConditions\[0\]\.threshold must be a finite number greater than 0 and less than 100/,
    ],
    [
      'bollinger',
      { type: 'bollinger', period: 20, multiplier: 0, mode: 'break', band: 'upper' },
      /entryConditions\[0\]\.multiplier must be a positive finite number/,
    ],
    [
      'macdCross',
      { type: 'macdCross', fastPeriod: 26, slowPeriod: 26, signalPeriod: 9 },
      /entryConditions\[0\]\.fastPeriod must be smaller than slowPeriod/,
    ],
    [
      'ichimokuCross',
      {
        type: 'ichimokuCross',
        conversionPeriod: 9,
        basePeriod: 26,
        spanBPeriod: 52,
        requireCloudFilter: true,
      },
      /entryConditions\[0\]\.displacement must be a positive integer/,
    ],
    [
      'ichimokuCross (cloud displacement mismatch)',
      {
        type: 'ichimokuCross',
        conversionPeriod: 9,
        basePeriod: 26,
        spanBPeriod: 52,
        displacement: 30,
        requireCloudFilter: true,
      },
      /entryConditions\[0\]\.displacement must equal basePeriod when requireCloudFilter is true/,
    ],
    [
      'donchianBreak',
      { type: 'donchianBreak', period: -1 },
      /entryConditions\[0\]\.period must be a positive integer/,
    ],
    [
      'stochastic',
      {
        type: 'stochastic',
        kPeriod: 14,
        dPeriod: 3,
        smoothing: 3,
        threshold: 0,
        comparison: 'crossAbove',
      },
      /entryConditions\[0\]\.threshold must be a finite number greater than 0 and less than 100/,
    ],
    [
      'stochastic',
      {
        type: 'stochastic',
        kPeriod: 14,
        dPeriod: 3,
        smoothing: 3,
        threshold: 100,
        comparison: 'above',
      },
      /entryConditions\[0\]\.threshold must be a finite number greater than 0 and less than 100/,
    ],
    [
      'keltnerBreak',
      { type: 'keltnerBreak', emaPeriod: 20, atrPeriod: 10, multiplier: 0 },
      /entryConditions\[0\]\.multiplier must be a positive finite number/,
    ],
    [
      'cciBreak',
      { type: 'cciBreak', period: 14, level: 0 },
      /entryConditions\[0\]\.level must be a positive finite number/,
    ],
    [
      'cciBreak (degenerate period)',
      { type: 'cciBreak', period: 1, level: 100 },
      /entryConditions\[0\]\.period must be a positive integer greater than or equal to 2/,
    ],
    [
      'adxTrend',
      { type: 'adxTrend', period: 14, threshold: 0 },
      /entryConditions\[0\]\.threshold must be a finite number greater than 0 and less than 100/,
    ],
    [
      'adxTrend (upper threshold)',
      { type: 'adxTrend', period: 14, threshold: 100 },
      /entryConditions\[0\]\.threshold must be a finite number greater than 0 and less than 100/,
    ],
    [
      'adxTrend (degenerate period)',
      { type: 'adxTrend', period: 1, threshold: 25 },
      /entryConditions\[0\]\.period must be a positive integer greater than or equal to 2/,
    ],
  ])('rejects invalid %s condition parameters before backtesting', (entryType, entryCondition, expected) => {
    const candidate = JSON.parse(JSON.stringify(strategy));
    candidate.meta.id = `invalid-${entryType}-parameters-v1`;
    candidate.meta.name = `${entryType} invalid parameter test`;
    candidate.id = candidate.meta.id;
    candidate.name = candidate.meta.name;
    candidate.entryConditions = [entryCondition];

    expect(() => buildStrategyReport({
      strategy: candidate,
      bars: [bar(registeredAt)],
      usdJpyBars: [bar(registeredAt)],
      runBacktest: emptyBacktestResult,
    })).toThrow(expected);
  });

  it.each([
    [
      'rsi',
      { type: 'rsi', period: 1, threshold: 30, comparison: 'below' },
      /entryConditions\[0\]\.period must be a positive integer greater than or equal to 2/,
    ],
    [
      'bollinger',
      { type: 'bollinger', period: 1, multiplier: 2, mode: 'break', band: 'upper' },
      /entryConditions\[0\]\.period must be a positive integer greater than or equal to 2/,
    ],
  ])('rejects degenerate %s period values before backtesting', (entryType, entryCondition, expected) => {
    const candidate = JSON.parse(JSON.stringify(strategy));
    candidate.meta.id = `invalid-${entryType}-period-v1`;
    candidate.meta.name = `${entryType} invalid period test`;
    candidate.id = candidate.meta.id;
    candidate.name = candidate.meta.name;
    candidate.entryConditions = [entryCondition];

    expect(() => buildStrategyReport({
      strategy: candidate,
      bars: [bar(registeredAt)],
      usdJpyBars: [bar(registeredAt)],
      runBacktest: emptyBacktestResult,
    })).toThrow(expected);
  });

  it('rejects every known entry condition with no parameters', () => {
    for (const entryType of knownEntryConditionTypes) {
      const candidate = JSON.parse(JSON.stringify(strategy));
      candidate.meta.id = `invalid-${entryType}-empty-v1`;
      candidate.meta.name = `${entryType} empty test`;
      candidate.id = candidate.meta.id;
      candidate.name = candidate.meta.name;
      candidate.entryConditions = [{ type: entryType }];

      let thrown;
      try {
        buildStrategyReport({
          strategy: candidate,
          bars: [bar(registeredAt)],
          usdJpyBars: [bar(registeredAt)],
          runBacktest: emptyBacktestResult,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.message).toMatch(new RegExp(`invalid-${entryType}-empty-v1: entryConditions\\[0\\]`));
      // default throw(検証ブランチ未実装)ではなくパラメータ検証で拒否されたことを区別する
      expect(thrown.message).not.toMatch(/has no parameter validation/);
    }
  });

  it('allows unknown entry condition fields for forward compatibility', () => {
    const candidate = JSON.parse(JSON.stringify(strategy));
    candidate.entryConditions = [{
      type: 'rsi',
      period: 14,
      threshold: 30,
      comparison: 'below',
      futureParameter: 'ignored',
    }];

    expect(() => buildStrategyReport({
      strategy: candidate,
      bars: [bar(registeredAt)],
      usdJpyBars: [bar(registeredAt)],
      runBacktest: emptyBacktestResult,
    })).not.toThrow();
  });

  it('validates the generated public results schema', async () => {
    const payload = JSON.parse(await readFile('public/data/forward/results.json', 'utf8'));

    expect(typeof payload.computedAt).toBe('string');
    expect(Array.isArray(payload.strategies)).toBe(true);
    expect(payload.monthlySummary).toEqual({ months: expect.any(Array) });

    for (const item of payload.strategies) {
      expect(item.meta).toEqual({
        id: expect.any(String),
        name: expect.any(String),
        version: 1,
        pair: expect.any(String),
        timeframe: expect.any(String),
        // EAごとに登録日は異なる(入れ替えで新規登録が入る)ため固定値を断言しない
        registeredAt: expect.any(Number),
      });
      expect(Number.isInteger(item.meta.registeredAt)).toBe(true);
      expect(item.meta.registeredAt).toBeGreaterThan(0);
      expect(item.forward.metrics.tradeCount).toEqual(expect.any(Number));
      expect(Array.isArray(item.forward.trades)).toBe(true);
      expect(Array.isArray(item.forward.equityCurve)).toBe(true);
      expect(item.backtestReference.tradeCount).toEqual(expect.any(Number));
      expect(item.barsEvaluated).toEqual(expect.any(Number));
      expect(item.forward.trades.every((trade) => trade.entryTime >= registeredAt)).toBe(true);
    }
  });

  it('builds schema v3 results with an operation status for every EA', async () => {
    const { results } = await buildForwardArtifacts({
      computedAt: '2026-08-17T00:00:00.000Z',
      runBacktest: emptyBacktestResult,
    });
    const activeStrategyFiles = (await readdir(
      new URL('../strategies/virtual/', import.meta.url),
    )).filter((filename) => filename.endsWith('.json'));

    expect(FORWARD_RESULTS_SCHEMA_VERSION).toBe(3);
    expect(results.schemaVersion).toBe(3);
    expect(results.strategies).toHaveLength(activeStrategyFiles.length);
    for (const item of results.strategies) {
      expect(item.operationStatus).toEqual({
        status: 'active',
        reason: expect.stringContaining('サンプル不足'),
      });
      expect(item.operationStatus.reason).toContain('PF=0.00');
      expect(item.operationStatus.reason).toContain('取引数=0件');
      expect(item.operationStatus.reason).toContain('確定日数=');
    }
  });

  it('fails before backtesting when an active generation is already retired', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fx-forward-retired-conflict-test-'));
    const virtualDirectory = path.join(root, 'strategies/virtual');
    const conflictKey = retiredStrategyLedgerKey(strategy.meta.id, strategy.meta.registeredAt);
    const loadBarsFor = vi.fn(async () => [bar(registeredAt)]);
    const runBacktest = vi.fn(emptyBacktestResult);
    const evaluateRetirement = vi.fn(() => ({ status: 'active', reason: 'unused' }));

    try {
      await mkdir(virtualDirectory, { recursive: true });
      await writeFile(
        path.join(virtualDirectory, `${strategy.meta.id}.json`),
        `${JSON.stringify(strategy, null, 2)}\n`,
        'utf8',
      );

      await expect(buildForwardArtifacts({
        strategiesDirectory: virtualDirectory,
        loadBarsFor,
        runBacktest,
        evaluateRetirement,
        retiredLedger: {
          schemaVersion: 1,
          strategies: {
            [conflictKey]: {
              strategyId: strategy.meta.id,
              meta: strategy.meta,
              retiredAt: '2026-08-17T00:00:00.000Z',
            },
          },
        },
      })).rejects.toThrow(
        new RegExp(`strategies/virtual.*${strategy.meta.id}@${strategy.meta.registeredAt}.*retired\\.json`, 's'),
      );
      expect(loadBarsFor).not.toHaveBeenCalled();
      expect(runBacktest).not.toHaveBeenCalled();
      expect(evaluateRetirement).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows a re-registered ID when only an older generation is retired', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fx-forward-new-generation-test-'));
    const virtualDirectory = path.join(root, 'strategies/virtual');
    const olderRegisteredAt = strategy.meta.registeredAt - UTC_DAY_SECONDS;
    const olderDate = new Date(olderRegisteredAt * 1000).toISOString().slice(0, 10);
    const olderStrategy = JSON.parse(JSON.stringify({
      ...strategy,
      meta: { ...strategy.meta, registeredAt: olderRegisteredAt },
    }));
    const existingHistory = {
      schemaVersion: 1,
      strategies: {
        [strategy.meta.id]: {
          meta: olderStrategy.meta,
          strategyFingerprint: fingerprintStrategyDefinition(olderStrategy),
          initialBalanceYen: 1_000_000,
          spreadPips: 0.9,
          days: {
            [olderDate]: {
              recordedAt: '2026-08-16T00:00:00.000Z',
              firstBarAt: olderRegisteredAt,
              lastBarAt: olderRegisteredAt,
              barsEvaluated: 1,
              pnl: { netPips: 5, netProfitYen: 500 },
              trades: [{
                id: 1,
                entryTime: olderRegisteredAt - 3_600,
                exitTime: olderRegisteredAt,
                exitReason: 'takeProfit',
                netPips: 5,
                netProfitYen: 500,
              }],
              equity: null,
            },
          },
        },
      },
    };
    const forwardStartingBalances = [];
    const runBacktest = (bars, currentStrategy, pair, options = {}) => {
      if (options.moneyManagement) {
        forwardStartingBalances.push(options.moneyManagement.initialBalanceYen);
      }
      return emptyBacktestResult(bars, currentStrategy, pair, options);
    };

    try {
      await mkdir(virtualDirectory, { recursive: true });
      await writeFile(
        path.join(virtualDirectory, `${strategy.meta.id}.json`),
        `${JSON.stringify(strategy, null, 2)}\n`,
        'utf8',
      );
      const artifacts = await buildForwardArtifacts({
        existingHistory,
        strategiesDirectory: virtualDirectory,
        loadBarsFor: async () => [
          bar(registeredAt),
          bar(registeredAt + UTC_DAY_SECONDS),
          bar(registeredAt + (2 * UTC_DAY_SECONDS)),
        ],
        runBacktest,
        evaluateRetirement: () => ({ status: 'active', reason: 'new generation' }),
        retiredLedger: {
          schemaVersion: 1,
          strategies: {
            [retiredStrategyLedgerKey(strategy.meta.id, olderRegisteredAt)]: {
              strategyId: strategy.meta.id,
              meta: { ...strategy.meta, registeredAt: olderRegisteredAt },
            },
          },
        },
      });

      expect(artifacts.results.strategies.map((item) => item.meta.id)).toEqual([
        strategy.meta.id,
      ]);
      expect(forwardStartingBalances).toEqual([1_000_000]);
      expect(artifacts.rebaselined).toHaveLength(1);
      expect(artifacts.history.strategies[strategy.meta.id].meta.registeredAt).toBe(
        strategy.meta.registeredAt,
      );
      expect(Object.keys(artifacts.history.strategies[strategy.meta.id].days)).toHaveLength(2);
      expect(artifacts.history.strategies[strategy.meta.id].days[olderDate]).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to replace an unretired generation when registeredAt changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fx-forward-unretired-generation-test-'));
    const virtualDirectory = path.join(root, 'strategies/virtual');
    const loadBarsFor = vi.fn(async () => [bar(registeredAt)]);

    try {
      await mkdir(virtualDirectory, { recursive: true });
      await writeFile(
        path.join(virtualDirectory, `${strategy.meta.id}.json`),
        `${JSON.stringify(strategy, null, 2)}\n`,
        'utf8',
      );
      await expect(buildForwardArtifacts({
        existingHistory: {
          schemaVersion: 1,
          strategies: {
            [strategy.meta.id]: {
              meta: {
                ...strategy.meta,
                registeredAt: strategy.meta.registeredAt - UTC_DAY_SECONDS,
              },
              initialBalanceYen: 1_000_000,
              spreadPips: 0.9,
              days: {},
            },
          },
        },
        strategiesDirectory: virtualDirectory,
        loadBarsFor,
        runBacktest: emptyBacktestResult,
        evaluateRetirement: () => ({ status: 'active', reason: 'unused' }),
        retiredLedger: { schemaVersion: 1, strategies: {} },
      })).rejects.toThrow(/not recorded in public\/data\/forward\/retired\.json/i);
      expect(loadBarsFor).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops tracking a retired EA without changing any other EA history', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fx-forward-retirement-test-'));
    const virtualDirectory = path.join(root, 'strategies/virtual');
    const historyPath = path.join(root, 'public/data/forward/history.json');
    const activeStrategy = JSON.parse(JSON.stringify({
      ...strategy,
      meta: {
        ...strategy.meta,
        id: 'active-test-v1',
        name: 'Active test',
      },
      id: 'active-test-v1',
      name: 'Active test',
    }));
    const retiringStrategy = JSON.parse(JSON.stringify({
      ...strategy,
      meta: {
        ...strategy.meta,
        id: 'retiring-test-v1',
        name: 'Retiring test',
      },
      id: 'retiring-test-v1',
      name: 'Retiring test',
    }));
    const writeJson = async (filePath, payload) => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    };
    const build = (existingHistory) => buildForwardArtifacts({
      computedAt: '2026-08-17T00:00:00.000Z',
      existingHistory,
      strategiesDirectory: virtualDirectory,
      retiredLedgerFile: path.join(root, 'public/data/forward/retired.json'),
      loadBarsFor: async () => [
        bar(registeredAt),
        bar(registeredAt + UTC_DAY_SECONDS),
        bar(registeredAt + (2 * UTC_DAY_SECONDS)),
      ],
      runBacktest: emptyBacktestResult,
      evaluateRetirement: () => ({ status: 'active', reason: 'test fixture' }),
    });

    try {
      await writeJson(
        path.join(virtualDirectory, `${activeStrategy.meta.id}.json`),
        activeStrategy,
      );
      await writeJson(
        path.join(virtualDirectory, `${retiringStrategy.meta.id}.json`),
        retiringStrategy,
      );
      const baseline = await build({ schemaVersion: 1, strategies: {} });
      await writeJson(historyPath, baseline.history);
      expect(Object.keys(
        baseline.history.strategies[activeStrategy.meta.id].days,
      )).toHaveLength(2);
      expect(Object.keys(
        baseline.history.strategies[retiringStrategy.meta.id].days,
      )).toHaveLength(2);
      const activeHistoryBeforeRetirement = JSON.parse(JSON.stringify(
        baseline.history.strategies[activeStrategy.meta.id],
      ));
      const retiringHistoryBeforeRetirement = JSON.parse(JSON.stringify(
        baseline.history.strategies[retiringStrategy.meta.id],
      ));

      await retireStrategy({
        projectRoot: root,
        strategyId: retiringStrategy.meta.id,
        reason: 'test retirement',
        retiredAt: '2026-08-17T01:00:00.000Z',
      });
      const afterRetirement = await build(baseline.history);

      expect(afterRetirement.results.strategies.map((item) => item.meta.id)).toEqual([
        activeStrategy.meta.id,
      ]);
      expect(afterRetirement.history.strategies[activeStrategy.meta.id]).toEqual(
        activeHistoryBeforeRetirement,
      );
      expect(afterRetirement.history.strategies[retiringStrategy.meta.id]).toEqual(
        retiringHistoryBeforeRetirement,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const monthlyMeta = (id, name, registeredAt) => ({
  id,
  name,
  version: 1,
  pair: 'USDJPY',
  timeframe: 'h1',
  registeredAt,
});

const monthlyDay = (netProfitYen, netPips, tradeCount) => ({
  pnl: { netProfitYen, netPips },
  trades: Array.from({ length: tradeCount }, () => ({ id: 1 })),
});

describe('monthly forward summary', () => {
  it('aggregates UTC months, merges retired history, and marks the current month incomplete', () => {
    const activeMeta = monthlyMeta('active-v1', '現行EA', 1_700_000_000);
    const retiredMeta = monthlyMeta('retired-v1', '退役EA', 1_700_000_100);
    const summary = buildMonthlySummary({
      history: {
        schemaVersion: FORWARD_HISTORY_SCHEMA_VERSION,
        strategies: {
          [activeMeta.id]: {
            meta: activeMeta,
            days: {
              '2026-08-01': monthlyDay(300, 3.3, 2),
              '2026-07-31': monthlyDay(100, 1.1, 1),
            },
          },
          [retiredMeta.id]: {
            meta: retiredMeta,
            days: {
              '2026-07-31': monthlyDay(-50, -0.5, 1),
            },
          },
        },
      },
      activeStrategyIds: [activeMeta.id],
      retiredLedger: {
        schemaVersion: 1,
        strategies: {
          [`${retiredMeta.id}@${retiredMeta.registeredAt}`]: {
            strategyId: retiredMeta.id,
            meta: retiredMeta,
          },
        },
      },
      computedAt: '2026-08-18T00:00:00.000Z',
    });

    expect(summary).toEqual({
      months: [
        {
          month: '2026-07',
          total: { netProfitYen: 50, netPips: 0.6, tradeCount: 2 },
          strategies: [
            {
              id: 'active-v1',
              name: '現行EA',
              netProfitYen: 100,
              netPips: 1.1,
              tradeCount: 1,
              confirmedDays: 1,
              retired: false,
            },
            {
              id: 'retired-v1',
              name: '退役EA',
              netProfitYen: -50,
              netPips: -0.5,
              tradeCount: 1,
              confirmedDays: 1,
              retired: true,
            },
          ],
          confirmedDays: 1,
          complete: true,
        },
        {
          month: '2026-08',
          total: { netProfitYen: 300, netPips: 3.3, tradeCount: 2 },
          strategies: [
            {
              id: 'active-v1',
              name: '現行EA',
              netProfitYen: 300,
              netPips: 3.3,
              tradeCount: 2,
              confirmedDays: 1,
              retired: false,
            },
          ],
          confirmedDays: 1,
          complete: false,
        },
      ],
    });
  });

  it('returns no months for an empty history', () => {
    expect(buildMonthlySummary({
      history: { schemaVersion: FORWARD_HISTORY_SCHEMA_VERSION, strategies: {} },
      activeStrategyIds: [],
      retiredLedger: { schemaVersion: 1, strategies: {} },
      computedAt: '2026-08-18T00:00:00.000Z',
    })).toEqual({ months: [] });
  });

  it('throws when history contains a non-active strategy absent from the retired ledger', () => {
    const meta = monthlyMeta('missing-ledger-v1', '台帳なしEA', 1_700_000_000);

    expect(() => buildMonthlySummary({
      history: {
        schemaVersion: FORWARD_HISTORY_SCHEMA_VERSION,
        strategies: {
          [meta.id]: { meta, days: {} },
        },
      },
      activeStrategyIds: [],
      retiredLedger: { schemaVersion: 1, strategies: {} },
      computedAt: '2026-08-18T00:00:00.000Z',
    })).toThrow(/not recorded in public\/data\/forward\/retired\.json/);
  });
});

const historyTestMeta = {
  id: 'history-test-v1',
  name: 'History test',
  version: 1,
  pair: 'USDJPY',
  timeframe: 'h1',
  registeredAt: 1_700_000_000,
};

const historyTestDay = (recordedAt) => ({
  recordedAt,
  firstBarAt: null,
  lastBarAt: null,
  barsEvaluated: 0,
  pnl: { netPips: 0, netProfitYen: 0 },
  trades: [],
  equity: null,
});

const historyTestHistory = (days) => ({
  schemaVersion: FORWARD_HISTORY_SCHEMA_VERSION,
  strategies: {
    [historyTestMeta.id]: {
      meta: historyTestMeta,
      initialBalanceYen: 1_000_000,
      spreadPips: 0.9,
      days,
    },
  },
});

describe('forward history persistence', () => {
  it('appends missing UTC days without overwriting existing days or mutating inputs', () => {
    const existing = historyTestHistory({
      '2023-11-15': historyTestDay('2023-11-16T00:00:00Z'),
    });
    const candidate = historyTestHistory({
      '2023-11-15': historyTestDay('2023-11-17T00:00:00Z'),
      '2023-11-16': historyTestDay('2023-11-17T00:00:00Z'),
    });
    const existingSnapshot = JSON.parse(JSON.stringify(existing));
    const candidateSnapshot = JSON.parse(JSON.stringify(candidate));

    const merged = mergeForwardHistory(existing, candidate);

    expect(merged.strategies[historyTestMeta.id].days['2023-11-15']).toEqual(
      existing.strategies[historyTestMeta.id].days['2023-11-15'],
    );
    expect(merged.strategies[historyTestMeta.id].days['2023-11-16']).toEqual(
      candidate.strategies[historyTestMeta.id].days['2023-11-16'],
    );
    expect(existing).toEqual(existingSnapshot);
    expect(candidate).toEqual(candidateSnapshot);
    expect(mergeForwardHistory(merged, candidate)).toEqual(merged);
  });

  it('keeps the newest UTC day and provisional end trade out of history', () => {
    const firstDay = Date.parse('2026-07-01T12:00:00Z') / 1000;
    const newestDay = Date.parse('2026-07-02T12:00:00Z') / 1000;
    const days = buildConfirmedHistoryDays({
      registeredAt: firstDay,
      forwardBars: [{ t: firstDay }, { t: newestDay }],
      recordedAt: '2026-07-03T00:00:00Z',
      forwardResult: {
        moneyManagement: { initialBalanceYen: 1_000_000 },
        trades: [{ id: 1, exitTime: firstDay, exitReason: 'end' }],
        equityCurve: [],
      },
    });

    expect(Object.keys(days)).toEqual(['2026-07-01']);
    expect(days['2026-07-01'].trades).toEqual([]);
    expect(days['2026-07-02']).toBeUndefined();
  });

  it('appends confirmed days when the strategy fingerprint is unchanged', () => {
    const fingerprint = 'c'.repeat(64);
    const existing = historyTestHistory({
      '2023-11-15': historyTestDay('2023-11-16T00:00:00Z'),
    });
    existing.strategies[historyTestMeta.id].strategyFingerprint = fingerprint;
    const candidate = historyTestHistory({
      '2023-11-15': historyTestDay('2023-11-17T00:00:00Z'),
      '2023-11-16': historyTestDay('2023-11-17T00:00:00Z'),
    });
    candidate.strategies[historyTestMeta.id].strategyFingerprint = fingerprint;
    const rebaselined = [];

    const merged = mergeForwardHistory(existing, candidate, {
      onRebaseline: (event) => rebaselined.push(event),
    });

    expect(rebaselined).toEqual([]);
    expect(Object.keys(merged.strategies[historyTestMeta.id].days)).toEqual([
      '2023-11-15',
      '2023-11-16',
    ]);
    expect(merged.strategies[historyTestMeta.id].days['2023-11-15'].recordedAt).toBe(
      '2023-11-16T00:00:00Z',
    );
  });

  it('rebaselines confirmed history when the strategy fingerprint changes', () => {
    const previousFingerprint = 'a'.repeat(64);
    const nextFingerprint = 'b'.repeat(64);
    const existing = historyTestHistory({
      '2023-11-15': historyTestDay('2023-11-16T00:00:00Z'),
      '2023-11-16': historyTestDay('2023-11-17T00:00:00Z'),
    });
    existing.strategies[historyTestMeta.id].strategyFingerprint = previousFingerprint;
    const candidate = historyTestHistory({
      '2023-11-20': historyTestDay('2023-11-21T00:00:00Z'),
    });
    candidate.strategies[historyTestMeta.id].strategyFingerprint = nextFingerprint;
    const rebaselined = [];

    const merged = mergeForwardHistory(existing, candidate, {
      onRebaseline: (event) => rebaselined.push(event),
    });

    expect(rebaselined).toEqual([{
      strategyId: historyTestMeta.id,
      previousFingerprint,
      nextFingerprint,
      discardedDayCount: 2,
    }]);
    expect(Object.keys(merged.strategies[historyTestMeta.id].days)).toEqual(['2023-11-20']);
    expect(merged.strategies[historyTestMeta.id].strategyFingerprint).toBe(nextFingerprint);
  });

  it('does not throw when re-selected rules also change balance or spread', () => {
    const existing = historyTestHistory({
      '2023-11-15': historyTestDay('2023-11-16T00:00:00Z'),
    });
    existing.strategies[historyTestMeta.id].strategyFingerprint = 'a'.repeat(64);
    const candidate = historyTestHistory({
      '2023-11-20': historyTestDay('2023-11-21T00:00:00Z'),
    });
    candidate.strategies[historyTestMeta.id].strategyFingerprint = 'b'.repeat(64);
    candidate.strategies[historyTestMeta.id].initialBalanceYen = 2_000_000;
    candidate.strategies[historyTestMeta.id].spreadPips = 1.5;

    const merged = mergeForwardHistory(existing, candidate);

    expect(merged.strategies[historyTestMeta.id].initialBalanceYen).toBe(2_000_000);
    expect(merged.strategies[historyTestMeta.id].spreadPips).toBe(1.5);
  });
});
