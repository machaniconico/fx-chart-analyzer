import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildConfirmedHistoryDays,
  buildForwardArtifacts,
  buildStrategyReport,
  fingerprintStrategyDefinition,
  FORWARD_HISTORY_SCHEMA_VERSION,
  FORWARD_RESULTS_SCHEMA_VERSION,
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
        expected: /invalid-condition-type-v1: entryConditions\[0\]\.type must be one of maCross, rsi, bollinger, macdCross, donchianBreak, stochastic/,
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

  it('validates the generated public results schema', async () => {
    const payload = JSON.parse(await readFile('public/data/forward/results.json', 'utf8'));

    expect(typeof payload.computedAt).toBe('string');
    expect(Array.isArray(payload.strategies)).toBe(true);

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
