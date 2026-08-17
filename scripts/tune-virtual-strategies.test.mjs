import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CLI_USAGE,
  DATA_SOURCE_DEEP_HISTORY,
  DATA_SOURCE_PUBLIC_DATA,
  ENTRY_TYPE_PROFILES,
  REFERENCE_SPAN_TARGET_DAYS,
  SESSION_VARIANTS,
  TUNING_ENTRY_TYPES,
  TUNING_PAIRS,
  TUNING_REGISTERED_AT,
  buildCandidateMatrix,
  createTuningReport,
  eligibilityRejectionReasons,
  evaluateTarget,
  filterTargets,
  isEligible,
  loadBarsForTuning,
  main,
  parseCliArgs,
  rankRows,
  selectEligibleRow,
  splitBarsIntoQuarterlySegments,
  writeTuningReport,
} from './tune-virtual-strategies.mjs';

const row = ({
  optNet,
  optDd = 10_000,
  optPf = 1.5,
  valNet = optNet,
  valTrades = 20,
  ratio = valNet / Math.max(optNet, 1),
  overfitWarning = false,
}) => ({
  parameters: { stopLossPips: 30, takeProfitPips: 60, trailingStopPips: null },
  optimization: {
    netProfitYen: optNet,
    profitFactor: optPf,
    maxDrawdownYen: optDd,
    maxDrawdownPct: 1,
    tradeCount: 40,
    winRate: 50,
  },
  validation: {
    netProfitYen: valNet,
    profitFactor: 1.2,
    maxDrawdownYen: 5_000,
    maxDrawdownPct: 1,
    tradeCount: valTrades,
    winRate: 50,
  },
  validationToOptimizationRatio: ratio,
  overfitWarning,
  sessionLabel: 'なし',
  sessionFilter: {
    enabled: false,
    start: '00:00',
    end: '23:59',
    serverUtcOffsetMinutes: 0,
  },
});

const legacyEntryTypeExpectations = [
  {
    entryType: 'maCross',
    timeframes: ['h1', 'h4'],
    parameterRanges: {
      stopLossPips: { min: 20, max: 80, step: 12 },
      takeProfitPips: { min: 30, max: 150, step: 24 },
    },
    trailingStopPips: [null, 20],
  },
  {
    entryType: 'rsi',
    timeframes: ['m30', 'h1'],
    parameterRanges: {
      stopLossPips: { min: 10, max: 50, step: 8 },
      takeProfitPips: { min: 15, max: 75, step: 12 },
    },
    trailingStopPips: [null],
  },
  {
    entryType: 'bollinger',
    timeframes: ['m30', 'h1'],
    parameterRanges: {
      stopLossPips: { min: 15, max: 75, step: 12 },
      takeProfitPips: { min: 25, max: 125, step: 20 },
    },
    trailingStopPips: [null, 20],
  },
  {
    entryType: 'macdCross',
    timeframes: ['h1', 'h4'],
    parameterRanges: {
      stopLossPips: { min: 20, max: 80, step: 12 },
      takeProfitPips: { min: 30, max: 150, step: 24 },
    },
    trailingStopPips: [null, 20],
  },
  {
    entryType: 'donchianBreak',
    timeframes: ['h1', 'h4'],
    parameterRanges: {
      stopLossPips: { min: 20, max: 80, step: 12 },
      takeProfitPips: { min: 30, max: 150, step: 24 },
    },
    trailingStopPips: [null, 20],
  },
  {
    entryType: 'stochastic',
    timeframes: ['m30', 'h1'],
    parameterRanges: {
      stopLossPips: { min: 15, max: 60, step: 9 },
      takeProfitPips: { min: 20, max: 100, step: 16 },
    },
    trailingStopPips: [null, 15],
  },
];

const readMagicNumbers = async (directory) => {
  const filenames = (await readdir(directory)).filter((filename) => filename.endsWith('.json'));
  return Promise.all(
    filenames.map(async (filename) => {
      const strategy = JSON.parse(await readFile(new URL(filename, directory), 'utf8'));
      return strategy.magicNumber;
    }),
  );
};

describe('tune-virtual-strategies candidate matrix and CLI filters', () => {
  it('keeps the required pair and entry-type coverage explicit', () => {
    expect(TUNING_PAIRS).toEqual([
      'USDJPY',
      'EURUSD',
      'GBPJPY',
      'EURJPY',
      'GBPUSD',
      'AUDJPY',
    ]);
    expect(TUNING_ENTRY_TYPES).toEqual([
      'maCross',
      'rsi',
      'bollinger',
      'macdCross',
      'donchianBreak',
      'stochastic',
      'ichimokuCross',
    ]);
    expect(ENTRY_TYPE_PROFILES.rsi.timeframes).toEqual(['m30', 'h1']);
    expect(ENTRY_TYPE_PROFILES.donchianBreak).toEqual({
      label: 'ドンチアンブレイク順張り',
      timeframes: ['h1', 'h4'],
      entryCondition: { type: 'donchianBreak', period: 20 },
      exit: { stopLossPips: 30, takeProfitPips: 60, closeOnOppositeSignal: false },
      parameterRanges: {
        stopLossPips: { min: 20, max: 80, step: 12 },
        takeProfitPips: { min: 30, max: 150, step: 24 },
      },
      trailingStopPips: [null, 20],
    });
    expect(ENTRY_TYPE_PROFILES.stochastic).toEqual({
      label: 'ストキャス逆張り',
      timeframes: ['m30', 'h1'],
      entryCondition: {
        type: 'stochastic',
        kPeriod: 14,
        dPeriod: 3,
        smoothing: 3,
        threshold: 20,
        comparison: 'crossAbove',
      },
      exit: { stopLossPips: 25, takeProfitPips: 40, closeOnOppositeSignal: false },
      parameterRanges: {
        stopLossPips: { min: 15, max: 60, step: 9 },
        takeProfitPips: { min: 20, max: 100, step: 16 },
      },
      trailingStopPips: [null, 15],
    });
    expect(ENTRY_TYPE_PROFILES.ichimokuCross).toEqual({
      label: '一目クロス順張り',
      timeframes: ['h1', 'h4'],
      entryCondition: {
        type: 'ichimokuCross',
        conversionPeriod: 9,
        basePeriod: 26,
        spanBPeriod: 52,
        displacement: 26,
        requireCloudFilter: true,
      },
      exit: { stopLossPips: 30, takeProfitPips: 60, closeOnOppositeSignal: true },
      parameterRanges: {
        stopLossPips: { min: 20, max: 80, step: 12 },
        takeProfitPips: { min: 30, max: 150, step: 24 },
      },
      trailingStopPips: [null, 20],
    });
  });

  it('covers every pair, entry type, and suitable timeframe exactly once', () => {
    const matrix = buildCandidateMatrix();
    const expectedCount =
      TUNING_PAIRS.length *
      TUNING_ENTRY_TYPES.reduce(
        (count, entryType) => count + ENTRY_TYPE_PROFILES[entryType].timeframes.length,
        0,
      );
    const triples = matrix.map(
      (target) =>
        `${target.strategy.meta.pair}:${target.entryType}:${target.strategy.meta.timeframe}`,
    );

    expect(expectedCount).toBe(84);
    expect(matrix).toHaveLength(84);
    expect(new Set(triples).size).toBe(expectedCount);
    expect(new Set(matrix.map((target) => target.id)).size).toBe(expectedCount);
    expect(matrix.every((target) => target.strategy.meta.registeredAt === TUNING_REGISTERED_AT)).toBe(
      true,
    );

    for (const pair of TUNING_PAIRS) {
      for (const entryType of TUNING_ENTRY_TYPES) {
        const timeframes = matrix
          .filter(
            (target) =>
              target.strategy.meta.pair === pair && target.entryType === entryType,
          )
          .map((target) => target.strategy.meta.timeframe);
        expect(timeframes).toEqual([...ENTRY_TYPE_PROFILES[entryType].timeframes]);
        expect(
          matrix
            .filter(
              (target) =>
                target.strategy.meta.pair === pair && target.entryType === entryType,
            )
            .every(
              (target) => target.strategy.entryConditions[0].type === entryType,
            ),
        ).toBe(true);
      }
    }
  });

  it('keeps every legacy candidate id, magic number, and parameter range unchanged', () => {
    const matrix = buildCandidateMatrix();

    for (const [entryTypeIndex, expectation] of legacyEntryTypeExpectations.entries()) {
      for (const [pairIndex, pair] of TUNING_PAIRS.entries()) {
        for (const [timeframeIndex, timeframe] of expectation.timeframes.entries()) {
          const candidate = matrix.find(
            (target) =>
              target.strategy.meta.pair === pair
              && target.entryType === expectation.entryType
              && target.strategy.meta.timeframe === timeframe,
          );

          expect(candidate).toMatchObject({
            id: `tune-${expectation.entryType.toLowerCase()}-${pair.toLowerCase()}-${timeframe}-v1`,
            entryType: expectation.entryType,
            strategy: {
              magicNumber: 1783100000 + pairIndex * 100 + entryTypeIndex * 10 + timeframeIndex,
            },
            parameterRanges: expectation.parameterRanges,
            trailingStopPips: expectation.trailingStopPips,
          });
        }
      }
    }
  });

  it('parses repeated and comma-separated filters and applies them together', () => {
    const filters = parseCliArgs([
      '--pair=usdjpy,EURUSD',
      '--entry-type',
      'macdcross',
      '--timeframe',
      'H4',
      '--timeframe=h4',
    ]);
    const filtered = filterTargets(buildCandidateMatrix(), filters);

    expect(filters).toMatchObject({
      pairs: ['USDJPY', 'EURUSD'],
      entryTypes: ['macdCross'],
      timeframes: ['h4'],
    });
    expect(filtered).toHaveLength(2);
    expect(
      filtered.map((target) => [
        target.strategy.meta.pair,
        target.entryType,
        target.strategy.meta.timeframe,
      ]),
    ).toEqual([
      ['USDJPY', 'macdCross', 'h4'],
      ['EURUSD', 'macdCross', 'h4'],
    ]);
  });

  it('supports each filter independently', () => {
    const matrix = buildCandidateMatrix();

    expect(filterTargets(matrix, parseCliArgs(['--pair', 'AUDJPY']))).toHaveLength(14);
    expect(filterTargets(matrix, parseCliArgs(['--entry-type', 'rsi']))).toHaveLength(12);
    expect(filterTargets(matrix, parseCliArgs(['--entry-type', 'donchianBreak']))).toHaveLength(12);
    expect(filterTargets(matrix, parseCliArgs(['--entry-type', 'stochastic']))).toHaveLength(12);
    expect(filterTargets(matrix, parseCliArgs(['--entry-type', 'ichimokuCross']))).toHaveLength(12);
    expect(filterTargets(matrix, parseCliArgs(['--timeframe', 'm30']))).toHaveLength(18);
    expect(filterTargets(matrix, parseCliArgs(['--timeframe', 'h1']))).toHaveLength(42);
    expect(() => parseCliArgs(['--timeframe', 'm15'])).toThrow(/Invalid value for --timeframe/);
  });

  it('documents and filters the new entry types through the CLI', () => {
    const matrix = buildCandidateMatrix();

    expect(CLI_USAGE).toContain('donchianBreak');
    expect(CLI_USAGE).toContain('stochastic');
    expect(CLI_USAGE).toContain('ichimokuCross');
    expect(
      filterTargets(matrix, parseCliArgs(['--entry-type', 'DONCHIANBREAK'])),
    ).toEqual(
      matrix.filter((target) => target.entryType === 'donchianBreak'),
    );
    expect(
      filterTargets(matrix, parseCliArgs(['--entry-type', 'stochastic'])),
    ).toEqual(
      matrix.filter((target) => target.entryType === 'stochastic'),
    );
    expect(
      filterTargets(matrix, parseCliArgs(['--entry-type', 'ICHIMOKUCROSS'])),
    ).toEqual(
      matrix.filter((target) => target.entryType === 'ichimokuCross'),
    );
  });

  it('keeps all candidate magic numbers unique from candidates and registered EAs', async () => {
    const matrix = buildCandidateMatrix();
    const matrixMagicNumbers = matrix.map((target) => target.strategy.magicNumber);
    const registeredMagicNumbers = [
      ...(await readMagicNumbers(new URL('../strategies/virtual/', import.meta.url))),
      ...(await readMagicNumbers(new URL('../strategies/retired/', import.meta.url))),
    ];

    expect(new Set(matrixMagicNumbers).size).toBe(matrixMagicNumbers.length);
    expect(matrixMagicNumbers.every((magicNumber) => !registeredMagicNumbers.includes(magicNumber))).toBe(
      true,
    );
  });

  it('rejects invalid filter values and leaves incompatible valid filters empty', () => {
    expect(() => parseCliArgs(['--pair', 'CADJPY'])).toThrow(/Invalid value for --pair/);
    expect(() => parseCliArgs(['--entry-type'])).toThrow(/Missing value/);
    expect(() => parseCliArgs(['--unknown', 'x'])).toThrow(/Unknown option/);

    const incompatible = parseCliArgs(['--entry-type', 'rsi', '--timeframe', 'h4']);
    expect(filterTargets(buildCandidateMatrix(), incompatible)).toEqual([]);
  });

  it('supports deep-history mode and documents all CLI and rank-population details', () => {
    expect(parseCliArgs([])).toEqual({
      help: false,
      pairs: [],
      entryTypes: [],
      timeframes: [],
    });
    expect(parseCliArgs(['--deep-history']).deepHistory).toBe(true);
    expect(parseCliArgs(['--session-variants']).sessionVariants).toBe(true);
    expect(CLI_USAGE).toContain('--deep-history');
    expect(CLI_USAGE).toContain('--session-variants');
    expect(CLI_USAGE).toContain('--help, -h');
    expect(CLI_USAGE).toMatch(/console.*PF.*JSON report.*all evaluated combinations/i);
  });

  it('supports walk-forward mode without changing the default filter shape', () => {
    expect(parseCliArgs([])).not.toHaveProperty('walkForward');
    expect(parseCliArgs(['--walk-forward'])).toMatchObject({
      help: false,
      walkForward: true,
      pairs: [],
      entryTypes: [],
      timeframes: [],
    });
    expect(parseCliArgs(['--walk-forward', '--help'])).toMatchObject({
      help: true,
      walkForward: true,
    });
    expect(CLI_USAGE).toContain('--walk-forward');
  });

  it('splits reference bars by timestamp boundaries rather than bar counts', () => {
    const bars = [0, 1, 2, 25, 50, 75, 99].map((t) => ({ t }));

    expect(splitBarsIntoQuarterlySegments(bars).map((segment) => segment.map((bar) => bar.t))).toEqual([
      [0, 1, 2],
      [25],
      [50],
      [75, 99],
    ]);
  });

  it('shows usage instead of throwing when help and an unknown option coexist', async () => {
    const logs = [];
    const loadEngine = vi.fn();

    await expect(
      main({
        args: ['--unknown', '--help'],
        loadEngine,
        log: (message) => logs.push(message),
      }),
    ).resolves.toEqual([]);

    expect(loadEngine).not.toHaveBeenCalled();
    expect(logs).toEqual([CLI_USAGE]);

    expect(parseCliArgs(['--unknown', '-h'])).toEqual({
      help: true,
      pairs: [],
      entryTypes: [],
      timeframes: [],
    });
  });

  it('enables session variants only when the CLI flag is present', async () => {
    const target = buildCandidateMatrix()[0];
    const runWithArgs = async (args) => {
      const evaluate = vi.fn(async () => {
        throw new Error('stop after target wiring');
      });

      await expect(
        main({
          args,
          candidateTargets: [target],
          loadEngine: async () => ({ cleanup: vi.fn() }),
          evaluate,
          writeReport: async () => '/tmp/tune-virtual-strategies-test.json',
          printResult: vi.fn(),
          log: vi.fn(),
        }),
      ).rejects.toThrow('1件の候補評価に失敗しました');

      return evaluate.mock.calls[0][1];
    };

    const withoutFlag = await runWithArgs([]);
    expect(withoutFlag).toBe(target);
    expect(withoutFlag.sessionVariants).toBeNull();

    const withFlag = await runWithArgs(['--session-variants']);
    expect(withFlag.sessionVariants).toEqual(SESSION_VARIANTS);
    expect(withFlag.sessionVariants).toEqual([
      null,
      {
        label: '東京00:00-08:00',
        filter: {
          enabled: true,
          start: '00:00',
          end: '08:00',
          serverUtcOffsetMinutes: 0,
        },
      },
      {
        label: 'ロンドン07:00-15:00',
        filter: {
          enabled: true,
          start: '07:00',
          end: '15:00',
          serverUtcOffsetMinutes: 0,
        },
      },
      {
        label: 'NY12:00-20:00',
        filter: {
          enabled: true,
          start: '12:00',
          end: '20:00',
          serverUtcOffsetMinutes: 0,
        },
      },
    ]);

    // フラグ有り実行の後に元 target が破壊されていないことを確認する
    // (フラグ無し検証が先に走る順序だと、代入実装でも素通りするため)
    expect(target.sessionVariants).toBeNull();
    const withoutFlagAgain = await runWithArgs([]);
    expect(withoutFlagAgain.sessionVariants).toBeNull();
  });
});

describe('tune-virtual-strategies deep-history cache', () => {
  const daySeconds = 24 * 60 * 60;
  const barsBeforeRegistration = (registeredAt, days) =>
    Array.from({ length: days }, (_, index) => ({
      t: registeredAt - (days - index) * daySeconds,
      o: 150,
      h: 151,
      l: 149,
      c: 150.5,
      v: 1,
    }));

  const writeBarCache = async (root, pair, timeframe, bars) => {
    await mkdir(path.join(root, pair), { recursive: true });
    await writeFile(
      path.join(root, pair, `${timeframe}.json`),
      `${JSON.stringify({ source: 'dukascopy', bars })}\n`,
    );
  };

  const engine = {
    generateParameterCombinations: () => [{ stopLossPips: 30, takeProfitPips: 60 }],
    splitOptimizationBars: (bars) => {
      const splitAt = Math.floor(bars.length * 0.7);
      return { optimizationBars: bars.slice(0, splitAt), validationBars: bars.slice(splitAt) };
    },
    runBacktest: () => ({}),
    scoreBacktestResult: () => ({
      netProfitYen: 1,
      profitFactor: 1,
      maxDrawdownYen: 0,
      tradeCount: 10,
    }),
    validationToOptimizationRatio: () => 1,
    isOverfitSuspect: () => false,
  };

  it('uses a present deep cache and increases referenceSpanDays only when enabled', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fx-tuning-deep-history-'));
    const dataDirectory = path.join(tempRoot, 'data');
    const deepHistoryDirectory = path.join(tempRoot, 'deep-history');
    const target = {
      ...buildCandidateMatrix()[0],
      trailingStopPips: [null],
    };
    const { pair, timeframe, registeredAt } = target.strategy.meta;
    const shallowBars = barsBeforeRegistration(registeredAt, 31);
    const deepBars = barsBeforeRegistration(registeredAt, 731);
    await mkdir(path.join(dataDirectory, pair), { recursive: true });
    await mkdir(path.join(deepHistoryDirectory, pair), { recursive: true });
    await writeFile(
      path.join(dataDirectory, pair, `${timeframe}.json`),
      `${JSON.stringify({ bars: shallowBars })}\n`,
    );
    await writeFile(
      path.join(deepHistoryDirectory, pair, `${timeframe}.json`),
      `${JSON.stringify({ bars: deepBars })}\n`,
    );

    try {
      const withoutFlag = await evaluateTarget(engine, target, {
        dataDirectory,
        deepHistoryDirectory,
      });
      const withFlag = await evaluateTarget(engine, target, {
        deepHistory: true,
        dataDirectory,
        deepHistoryDirectory,
      });

      expect(withoutFlag.referenceSpanDays).toBe(30);
      expect(withFlag.referenceSpanDays).toBe(REFERENCE_SPAN_TARGET_DAYS);
      expect(withFlag.referenceSpanDays).toBeGreaterThanOrEqual(REFERENCE_SPAN_TARGET_DAYS);
      expect(withFlag.referenceSpanDays).toBeGreaterThan(withoutFlag.referenceSpanDays);
      expect(withFlag).toMatchObject({
        dataSource: DATA_SOURCE_DEEP_HISTORY,
        dataProvenance: {
          priceBars: { source: DATA_SOURCE_DEEP_HISTORY },
          usdJpyBars: null,
          usedFallbackUsdJpyRate: false,
        },
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('falls back per timeframe when the requested deep cache file is absent', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fx-tuning-deep-fallback-'));
    const dataDirectory = path.join(tempRoot, 'data');
    const deepHistoryDirectory = path.join(tempRoot, 'deep-history');
    const fallbackBars = [{ t: 123, o: 1, h: 1, l: 1, c: 1, v: 0 }];
    await mkdir(path.join(dataDirectory, 'USDJPY'), { recursive: true });
    await writeFile(
      path.join(dataDirectory, 'USDJPY', 'h4.json'),
      `${JSON.stringify({ bars: fallbackBars })}\n`,
    );

    try {
      await expect(
        loadBarsForTuning('USDJPY', 'h4', {
          deepHistory: true,
          dataDirectory,
          deepHistoryDirectory,
        }),
      ).resolves.toEqual(fallbackBars);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('chooses public data when its pre-registration coverage exceeds the deep cache', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fx-tuning-coverage-choice-'));
    const dataDirectory = path.join(tempRoot, 'data');
    const deepHistoryDirectory = path.join(tempRoot, 'deep-history');
    const registeredAt = Date.parse('2024-02-10T12:00:00.000Z') / 1_000;
    const publicBars = barsBeforeRegistration(registeredAt, 2_335);
    const deepBars = barsBeforeRegistration(registeredAt, 751);
    await mkdir(path.join(dataDirectory, 'USDJPY'), { recursive: true });
    await mkdir(path.join(deepHistoryDirectory, 'USDJPY'), { recursive: true });
    await writeFile(
      path.join(dataDirectory, 'USDJPY', 'd1.json'),
      `${JSON.stringify({ source: 'dukascopy', bars: publicBars })}\n`,
    );
    await writeFile(
      path.join(deepHistoryDirectory, 'USDJPY', 'd1.json'),
      `${JSON.stringify({ source: 'dukascopy', bars: deepBars })}\n`,
    );

    try {
      const resolved = await loadBarsForTuning('USDJPY', 'd1', {
        deepHistory: true,
        registeredAt,
        includeProvenance: true,
        dataDirectory,
        deepHistoryDirectory,
      });

      expect(resolved.bars).toEqual(publicBars);
      expect(resolved).toMatchObject({
        source: DATA_SOURCE_PUBLIC_DATA,
        barsBeforeRegistration: 2_335,
        coverageBeforeRegistrationDays: 2_334,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('records an explicit USDJPY fallback when a deep target lacks matching conversion data', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fx-tuning-usdjpy-fallback-'));
    const dataDirectory = path.join(tempRoot, 'data');
    const deepHistoryDirectory = path.join(tempRoot, 'deep-history');
    const target = {
      ...buildCandidateMatrix().find(
        (candidate) =>
          candidate.strategy.meta.pair === 'EURUSD' &&
          candidate.strategy.meta.timeframe === 'h1',
      ),
      trailingStopPips: [null],
    };
    const { pair, timeframe, registeredAt } = target.strategy.meta;
    await writeBarCache(
      dataDirectory,
      pair,
      timeframe,
      barsBeforeRegistration(registeredAt, 31),
    );
    await writeBarCache(
      deepHistoryDirectory,
      pair,
      timeframe,
      barsBeforeRegistration(registeredAt, 731),
    );
    await writeBarCache(
      dataDirectory,
      'USDJPY',
      timeframe,
      barsBeforeRegistration(registeredAt, 31),
    );

    try {
      const result = await evaluateTarget(engine, target, {
        deepHistory: true,
        dataDirectory,
        deepHistoryDirectory,
      });
      const report = createTuningReport([result], {
        filters: { pairs: [], entryTypes: [], timeframes: [], deepHistory: true },
      });

      expect(result).toMatchObject({
        dataSource: DATA_SOURCE_DEEP_HISTORY,
        usdJpyDataSource: DATA_SOURCE_PUBLIC_DATA,
        usedFallbackUsdJpyRate: true,
        dataProvenance: {
          priceBars: { source: DATA_SOURCE_DEEP_HISTORY },
          usdJpyBars: { source: DATA_SOURCE_PUBLIC_DATA },
          usedFallbackUsdJpyRate: true,
        },
      });
      expect(report).toMatchObject({
        provenance: { deepHistory: true },
        filters: { deepHistory: true },
        summary: { usedFallbackUsdJpyRateCount: 1 },
        candidates: [
          {
            provenance: {
              dataSource: DATA_SOURCE_DEEP_HISTORY,
              usdJpyDataSource: DATA_SOURCE_PUBLIC_DATA,
              usedFallbackUsdJpyRate: true,
            },
          },
        ],
      });
      expect(report.candidates[0].warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'usd_jpy_rate_source_fallback',
            uncoveredReferenceSpanRatio: 700 / REFERENCE_SPAN_TARGET_DAYS,
            message: expect.stringContaining('USDJPYソースが参照窓をカバーしない割合(日数比)'),
          }),
        ]),
      );
      expect(report.summary).toMatchObject({
        usdJpyFallbackUncoveredReferenceSpanRatioSum: 700 / REFERENCE_SPAN_TARGET_DAYS,
        usdJpyFallbackUncoveredReferenceSpanRatioAverage: 700 / REFERENCE_SPAN_TARGET_DAYS,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps USDJPY on the selected deep source when matching conversion data exists', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fx-tuning-usdjpy-same-source-'));
    const dataDirectory = path.join(tempRoot, 'data');
    const deepHistoryDirectory = path.join(tempRoot, 'deep-history');
    const target = {
      ...buildCandidateMatrix().find(
        (candidate) =>
          candidate.strategy.meta.pair === 'EURUSD' &&
          candidate.strategy.meta.timeframe === 'h1',
      ),
      trailingStopPips: [null],
    };
    const { pair, timeframe, registeredAt } = target.strategy.meta;
    await writeBarCache(
      dataDirectory,
      pair,
      timeframe,
      barsBeforeRegistration(registeredAt, 31),
    );
    await writeBarCache(
      deepHistoryDirectory,
      pair,
      timeframe,
      barsBeforeRegistration(registeredAt, 731),
    );
    await writeBarCache(
      dataDirectory,
      'USDJPY',
      timeframe,
      barsBeforeRegistration(registeredAt, 1_001),
    );
    await writeBarCache(
      deepHistoryDirectory,
      'USDJPY',
      timeframe,
      barsBeforeRegistration(registeredAt, 731),
    );

    try {
      const result = await evaluateTarget(engine, target, {
        deepHistory: true,
        dataDirectory,
        deepHistoryDirectory,
      });

      expect(result).toMatchObject({
        dataSource: DATA_SOURCE_DEEP_HISTORY,
        usdJpyDataSource: DATA_SOURCE_DEEP_HISTORY,
        usedFallbackUsdJpyRate: false,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('treats post-registration-only deep USDJPY data as unavailable and reports fallback', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fx-tuning-usdjpy-unusable-'));
    const dataDirectory = path.join(tempRoot, 'data');
    const deepHistoryDirectory = path.join(tempRoot, 'deep-history');
    const target = {
      ...buildCandidateMatrix().find(
        (candidate) =>
          candidate.strategy.meta.pair === 'EURUSD' &&
          candidate.strategy.meta.timeframe === 'h1',
      ),
      trailingStopPips: [null],
    };
    const { pair, timeframe, registeredAt } = target.strategy.meta;
    await writeBarCache(
      dataDirectory,
      pair,
      timeframe,
      barsBeforeRegistration(registeredAt, 31),
    );
    await writeBarCache(
      deepHistoryDirectory,
      pair,
      timeframe,
      barsBeforeRegistration(registeredAt, 731),
    );
    await writeBarCache(
      dataDirectory,
      'USDJPY',
      timeframe,
      barsBeforeRegistration(registeredAt, 731),
    );
    await writeBarCache(
      deepHistoryDirectory,
      'USDJPY',
      timeframe,
      barsBeforeRegistration(registeredAt, 10).map((bar, index) => ({
        ...bar,
        t: registeredAt + (index + 1) * daySeconds,
      })),
    );

    try {
      const result = await evaluateTarget(engine, target, {
        deepHistory: true,
        dataDirectory,
        deepHistoryDirectory,
      });

      expect(result).toMatchObject({
        dataSource: DATA_SOURCE_DEEP_HISTORY,
        usdJpyDataSource: DATA_SOURCE_PUBLIC_DATA,
        usedFallbackUsdJpyRate: true,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('tune-virtual-strategies quarterly stability mode', () => {
  const daySeconds = 24 * 60 * 60;

  const makeReferenceBars = (registeredAt) =>
    [0, 1, 2, 25, 50, 75, 99].map((offset) => ({
      t: registeredAt - (100 - offset) * daySeconds,
      o: 150,
      h: 151,
      l: 149,
      c: 150.5,
      v: 1,
    }));

  const writeBarCache = async (root, target, bars) => {
    const { pair, timeframe } = target.strategy.meta;
    await mkdir(path.join(root, pair), { recursive: true });
    await writeFile(
      path.join(root, pair, `${timeframe}.json`),
      `${JSON.stringify({ bars })}\n`,
    );
  };

  const makeEngine = (quarterlyNetProfits) => {
    let backtestIndex = 0;
    const runBacktest = vi.fn((bars, strategy, pair, options) => ({
      bars,
      strategy,
      pair,
      options,
      backtestIndex: backtestIndex++,
    }));
    return {
      generateParameterCombinations: () => [{ stopLossPips: 30, takeProfitPips: 60 }],
      splitOptimizationBars: (bars) => {
        const splitAt = Math.floor(bars.length * 0.7);
        return { optimizationBars: bars.slice(0, splitAt), validationBars: bars.slice(splitAt) };
      },
      runBacktest,
      scoreBacktestResult: ({ backtestIndex: index }) => {
        const netProfitYen = index < 2 ? 100 : quarterlyNetProfits[index - 2];
        return {
          netProfitYen,
          profitFactor: index < 2 || netProfitYen > 0 ? 1.5 : 0.5,
          maxDrawdownYen: 0,
          tradeCount: index < 2 ? 20 : netProfitYen > 0 ? 5 : 1,
        };
      },
      validationToOptimizationRatio: () => 0.6,
      isOverfitSuspect: () => false,
    };
  };

  const makeTarget = () => ({
    ...buildCandidateMatrix()[0],
    parameterRanges: {
      stopLossPips: { min: 30, max: 30, step: 1 },
      takeProfitPips: { min: 60, max: 60, step: 1 },
    },
    trailingStopPips: [null],
    sessionVariants: [SESSION_VARIANTS[1]],
  });

  it('runs four time-based selected-parameter checks and preserves the selected session filter', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fx-tuning-quarterly-pass-'));
    const dataDirectory = path.join(tempRoot, 'data');
    const target = makeTarget();
    const engine = makeEngine([100, 50, -10, 25]);

    try {
      await writeBarCache(dataDirectory, target, makeReferenceBars(target.strategy.meta.registeredAt));
      const result = await evaluateTarget(engine, target, {
        dataDirectory,
        walkForward: true,
      });
      const report = createTuningReport([result], {
        filters: { pairs: [], entryTypes: [], timeframes: [], walkForward: true },
      });

      expect(engine.runBacktest).toHaveBeenCalledTimes(6);
      expect(engine.runBacktest.mock.calls.slice(2).map(([bars]) => bars.map((bar) => bar.t))).toEqual([
        [target.strategy.meta.registeredAt - 100 * daySeconds, target.strategy.meta.registeredAt - 99 * daySeconds, target.strategy.meta.registeredAt - 98 * daySeconds],
        [target.strategy.meta.registeredAt - 75 * daySeconds],
        [target.strategy.meta.registeredAt - 50 * daySeconds],
        [target.strategy.meta.registeredAt - 25 * daySeconds, target.strategy.meta.registeredAt - daySeconds],
      ]);
      expect(engine.runBacktest.mock.calls.slice(2).map(([, candidate]) => candidate.sessionFilter)).toEqual([
        SESSION_VARIANTS[1].filter,
        SESSION_VARIANTS[1].filter,
        SESSION_VARIANTS[1].filter,
        SESSION_VARIANTS[1].filter,
      ]);
      expect(result).toMatchObject({
        eligible: expect.any(Object),
        selectedCandidate: {
          quarterlyResults: [
            { netProfitYen: 100, profitFactor: 1.5, tradeCount: 5 },
            { netProfitYen: 50, profitFactor: 1.5, tradeCount: 5 },
            { netProfitYen: -10, profitFactor: 0.5, tradeCount: 1 },
            { netProfitYen: 25, profitFactor: 1.5, tradeCount: 5 },
          ],
          quarterlyStability: {
            mode: 'selected-parameter-quarterly-stability',
            positiveSegmentCount: 3,
            requiredPositiveSegmentCount: 3,
            passed: true,
          },
        },
      });
      expect(report).toMatchObject({
        filters: { walkForward: true },
        candidates: [
          {
            status: 'passed',
            selectedCandidate: {
              quarterlyResults: expect.any(Array),
              quarterlyStability: { positiveSegmentCount: 3, passed: true },
            },
          },
        ],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('downgrades a selected candidate when fewer than three quarters are profitable', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fx-tuning-quarterly-reject-'));
    const dataDirectory = path.join(tempRoot, 'data');
    const target = makeTarget();
    const engine = makeEngine([100, -1, 50, -1]);

    try {
      await writeBarCache(dataDirectory, target, makeReferenceBars(target.strategy.meta.registeredAt));
      const result = await evaluateTarget(engine, target, {
        dataDirectory,
        walkForward: true,
      });
      const report = createTuningReport([result], {
        filters: { pairs: [], entryTypes: [], timeframes: [], walkForward: true },
      });

      expect(result.eligible).toBeNull();
      expect(result.selectedCandidate).toMatchObject({
        quarterlyStability: { positiveSegmentCount: 2, passed: false },
      });
      expect(isEligible(result.selectedCandidate, { walkForward: true })).toBe(false);
      expect(report.candidates[0]).toMatchObject({
        status: 'rejected',
        selectedCandidate: {
          selected: true,
          quarterlyResults: expect.any(Array),
          rejectionReasons: [
            {
              code: 'quarterly_stability_below_threshold',
              actual: 2,
              operator: '>=',
              threshold: 3,
            },
          ],
        },
        rejectionReasons: [{ code: 'quarterly_stability_below_threshold', actual: 2, count: 1 }],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('tune-virtual-strategies ranking and unchanged selection gate', () => {
  it('ranks by the optimization window, not the validation window', () => {
    const strongOptimization = row({ optNet: 100_000, valNet: 5_000 });
    const strongValidation = row({ optNet: 50_000, valNet: 90_000 });

    const ranked = rankRows([strongValidation, strongOptimization]);

    expect(ranked[0]).toBe(strongOptimization);
    expect(ranked[1]).toBe(strongValidation);
  });

  it('breaks optimization ties by the smaller in-sample drawdown', () => {
    const deepDrawdown = row({ optNet: 100_000, optDd: 20_000 });
    const shallowDrawdown = row({ optNet: 100_000, optDd: 5_000 });

    expect(rankRows([deepDrawdown, shallowDrawdown])[0]).toBe(shallowDrawdown);
  });

  it('does not mutate input order while ranking', () => {
    const first = row({ optNet: 50_000 });
    const second = row({ optNet: 100_000 });
    const input = [first, second];

    rankRows(input);

    expect(input).toEqual([first, second]);
  });

  it('does not use validation metrics as a tertiary ranking key', () => {
    const weakValidation = row({ optNet: 100_000, optDd: 5_000, valNet: 1_000 });
    const strongValidation = row({ optNet: 100_000, optDd: 5_000, valNet: 90_000 });

    expect(rankRows([weakValidation, strongValidation])).toEqual([
      weakValidation,
      strongValidation,
    ]);
  });

  it('accepts the exact inclusive trade and retention boundaries', () => {
    expect(
      isEligible(row({ optNet: 1, valNet: 1, valTrades: 10, ratio: 0.35 })),
    ).toBe(true);
  });

  it.each([
    ['zero in-sample profit', { optNet: 0, valNet: 1, ratio: 0.35 }],
    ['negative in-sample profit', { optNet: -1, valNet: 1, ratio: 0.35 }],
    ['zero out-of-sample profit', { optNet: 1, valNet: 0, ratio: 0.35 }],
    ['negative out-of-sample profit', { optNet: 1, valNet: -1, ratio: 0.35 }],
    ['nine validation trades', { optNet: 1, valNet: 1, valTrades: 9, ratio: 0.35 }],
    ['retention below 0.35', { optNet: 1, valNet: 1, ratio: 0.349999 }],
    ['overfit warning', { optNet: 1, valNet: 1, ratio: 0.35, overfitWarning: true }],
  ])('rejects %s', (_label, values) => {
    expect(isEligible(row(values))).toBe(false);
  });

  it('reports every failed gate reason for one combination', () => {
    const reasons = eligibilityRejectionReasons(
      row({
        optNet: 0,
        valNet: 0,
        valTrades: 9,
        ratio: 0.2,
        overfitWarning: true,
      }),
    );

    expect(reasons.map((reason) => reason.code)).toEqual([
      'optimization_not_profitable',
      'validation_not_profitable',
      'insufficient_validation_trades',
      'overfit_warning',
      'validation_retention_below_threshold',
    ]);
  });

  it('keeps the PF prefilter inclusive at 1 and chooses the first eligible ranked row', () => {
    const excludedByLegacyPrefilter = row({
      optNet: 300_000,
      optPf: 0.999999,
      valNet: 200_000,
      ratio: 0.7,
    });
    const higherRankedButGateRejected = row({
      optNet: 200_000,
      valNet: 20_000,
      ratio: 0.1,
    });
    const selected = row({ optNet: 100_000, optPf: 1, valNet: 60_000, ratio: 0.6 });

    expect(
      selectEligibleRow([selected, higherRankedButGateRejected, excludedByLegacyPrefilter]),
    ).toBe(selected);
  });
});

const resultFor = ({ target, rows, eligible, referenceSpanDays = 730 }) => ({
  strategy: target.strategy,
  pair: target.strategy.meta.pair,
  entryType: target.entryType,
  timeframe: target.strategy.meta.timeframe,
  referenceBars: 1_000,
  optimizationBars: 700,
  validationBars: 300,
  referenceSpanDays,
  validationSpanDays: 219,
  evaluatedRows: rows,
  rows,
  eligible,
});

describe('tune-virtual-strategies JSON report', () => {
  it('forwards deep-history mode while preserving the no-flag evaluate call', async () => {
    const [target] = buildCandidateMatrix();
    const passing = row({ optNet: 100_000, valNet: 60_000, ratio: 0.6 });
    const evaluate = vi.fn(async (_engine, candidate, options) => ({
      ...resultFor({ target: candidate, rows: [passing], eligible: passing }),
      ...(options?.deepHistory
        ? {
            dataSource: DATA_SOURCE_DEEP_HISTORY,
            usdJpyDataSource: null,
            usedFallbackUsdJpyRate: false,
            dataProvenance: {
              priceBars: { source: DATA_SOURCE_DEEP_HISTORY },
              usdJpyBars: null,
              usedFallbackUsdJpyRate: false,
            },
          }
        : {}),
    }));
    const logs = [];
    const reports = [];
    const common = {
      candidateTargets: [target],
      loadEngine: async () => ({ cleanup: async () => {} }),
      evaluate,
      writeReport: async (report) => {
        reports.push(report);
        return path.join(os.tmpdir(), 'mock-deep-history-report.json');
      },
      printResult: () => {},
      log: (message) => logs.push(message),
    };

    await main({ ...common, args: [] });
    expect(evaluate.mock.calls[0]).toHaveLength(2);
    expect(reports[0]).not.toHaveProperty('provenance');
    expect(reports[0].filters).not.toHaveProperty('deepHistory');
    expect(reports[0].filters).not.toHaveProperty('walkForward');

    const deepHistoryDirectory = path.join(os.tmpdir(), 'mock-deep-history');
    await main({ ...common, args: ['--deep-history'], deepHistoryDirectory });
    expect(evaluate.mock.calls[1]).toEqual([
      expect.anything(),
      target,
      { deepHistory: true, deepHistoryDirectory },
    ]);
    expect(reports[1]).toMatchObject({
      provenance: { deepHistory: true },
      filters: { deepHistory: true },
      candidates: [
        {
          provenance: {
            dataSource: DATA_SOURCE_DEEP_HISTORY,
            usedFallbackUsdJpyRate: false,
          },
        },
      ],
    });
    expect(logs.some((message) => /data source.*deep-history/i.test(message))).toBe(true);
  });

  it('evaluates only CLI-filtered targets through the main orchestration path', async () => {
    const evaluatedIds = [];
    const logs = [];
    let cleanupCalled = false;
    let writtenReport;
    const passing = row({ optNet: 100_000, valNet: 60_000, ratio: 0.6 });

    const results = await main({
      args: ['--pair', 'EURUSD', '--entry-type', 'rsi', '--timeframe', 'h1'],
      candidateTargets: buildCandidateMatrix(),
      generatedAt: '2026-08-17T12:34:56.000Z',
      loadEngine: async () => ({
        cleanup: async () => {
          cleanupCalled = true;
        },
      }),
      evaluate: async (_engine, target) => {
        evaluatedIds.push(target.id);
        return resultFor({ target, rows: [passing], eligible: passing });
      },
      writeReport: async (report) => {
        writtenReport = report;
        return path.join(os.tmpdir(), 'mock-tuning-report.json');
      },
      printResult: () => {},
      log: (message) => logs.push(message),
    });

    expect(evaluatedIds).toEqual(['tune-rsi-eurusd-h1-v1']);
    expect(results).toHaveLength(1);
    expect(cleanupCalled).toBe(true);
    expect(logs[0]).toBe('チューニング候補: 1/84件');
    expect(writtenReport).toMatchObject({
      filters: { pairs: ['EURUSD'], entryTypes: ['rsi'], timeframes: ['h1'] },
      summary: { candidateCount: 1 },
    });
  });

  it('forwards walk-forward mode and records it in the report filters', async () => {
    const [target] = buildCandidateMatrix();
    const passing = row({ optNet: 100_000, valNet: 60_000, ratio: 0.6 });
    let writtenReport;
    const evaluate = vi.fn(async (_engine, candidate) =>
      resultFor({ target: candidate, rows: [passing], eligible: passing }),
    );

    await main({
      args: ['--walk-forward'],
      candidateTargets: [target],
      loadEngine: async () => ({ cleanup: async () => {} }),
      evaluate,
      writeReport: async (report) => {
        writtenReport = report;
        return path.join(os.tmpdir(), 'mock-walk-forward-report.json');
      },
      printResult: () => {},
      log: () => {},
    });

    expect(evaluate.mock.calls[0]).toEqual([
      expect.anything(),
      target,
      { walkForward: true },
    ]);
    expect(writtenReport.filters).toMatchObject({ walkForward: true });
  });

  it('includes validation evidence for passes and reasons for every rejection', () => {
    const [passedTarget, rejectedTarget] = buildCandidateMatrix();
    const passing = row({
      optNet: 100_000,
      optPf: Number.POSITIVE_INFINITY,
      valNet: 60_000,
      ratio: 0.6,
    });
    const rejected = row({
      optNet: -10_000,
      valNet: -5_000,
      valTrades: 4,
      ratio: 0.2,
      overfitWarning: true,
    });
    const report = createTuningReport(
      [
        resultFor({ target: passedTarget, rows: [passing, rejected], eligible: passing }),
        resultFor({ target: rejectedTarget, rows: [rejected], eligible: null }),
      ],
      {
        generatedAt: '2026-08-17T12:34:56.000Z',
        filters: { pairs: ['USDJPY'], entryTypes: [], timeframes: [] },
      },
    );

    expect(report.summary).toMatchObject({
      candidateCount: 2,
      passedCandidateCount: 1,
      rejectedCandidateCount: 1,
      combinationCount: 3,
      passedCombinationCount: 1,
      rejectedCombinationCount: 2,
    });
    const passedCandidate = report.candidates.find((candidate) => candidate.status === 'passed');
    expect(passedCandidate.selectedCandidate).toMatchObject({
      status: 'passed',
      selected: true,
      optimizationMetrics: { netProfitYen: 100_000, profitFactor: 'Infinity' },
      validationMetrics: { netProfitYen: 60_000, tradeCount: 20 },
      selectionEvidence: {
        optimizationNetProfitYen: { actual: 100_000, threshold: 0, passed: true },
        validationNetProfitYen: { actual: 60_000, threshold: 0, passed: true },
        validationTradeCount: { actual: 20, threshold: 10, passed: true },
        overfitWarning: { actual: false, threshold: false, passed: true },
        validationToOptimizationRatio: { actual: 0.6, threshold: 0.35, passed: true },
      },
    });

    const rejectedCombinations = report.candidates.flatMap((candidate) =>
      candidate.combinations.filter((combination) => combination.status === 'rejected'),
    );
    expect(rejectedCombinations).toHaveLength(2);
    expect(rejectedCombinations.every((combination) => combination.rejectionReasons.length > 0)).toBe(
      true,
    );
    const rejectedCandidate = report.candidates.find(
      (candidate) => candidate.status === 'rejected',
    );
    expect(rejectedCandidate.rejectionReasons.map((reason) => reason.code)).toEqual([
      'optimization_not_profitable',
      'validation_not_profitable',
      'insufficient_validation_trades',
      'overfit_warning',
      'validation_retention_below_threshold',
    ]);
  });

  it('records and counts the same 730-day reference-span warning shown in the console', () => {
    const [belowTarget, meetsTarget] = buildCandidateMatrix();
    const passing = row({ optNet: 100_000, valNet: 60_000, ratio: 0.6 });
    const report = createTuningReport([
      resultFor({
        target: belowTarget,
        rows: [passing],
        eligible: passing,
        referenceSpanDays: 729.5,
      }),
      resultFor({
        target: meetsTarget,
        rows: [passing],
        eligible: passing,
        referenceSpanDays: 730,
      }),
    ]);

    expect(report.summary.referenceSpanBelowTargetCount).toBe(1);
    expect(report.candidates[0]).toMatchObject({
      status: 'passed',
      dataWindow: {
        referenceSpanDays: 729.5,
        referenceSpanTargetDays: 730,
        meetsReferenceSpanTarget: false,
      },
      warnings: [
        {
          code: 'reference_span_below_target',
          actual: 729.5,
          threshold: 730,
        },
      ],
    });
    expect(report.candidates[1]).toMatchObject({
      dataWindow: {
        referenceSpanDays: 730,
        referenceSpanTargetDays: 730,
        meetsReferenceSpanTarget: true,
      },
      warnings: [],
    });
  });

  it('keeps data-window and warning contracts stable for evaluation errors', () => {
    const [unknownWindowTarget, knownShortWindowTarget] = buildCandidateMatrix();
    const errorResult = (target, overrides = {}) => ({
      strategy: target.strategy,
      pair: target.strategy.meta.pair,
      entryType: target.entryType,
      timeframe: target.strategy.meta.timeframe,
      evaluationError: 'fixture evaluation failure',
      ...overrides,
    });
    const report = createTuningReport([
      errorResult(unknownWindowTarget),
      errorResult(knownShortWindowTarget, {
        referenceBars: 100,
        referenceSpanDays: 100,
      }),
    ]);

    expect(report.summary).toMatchObject({
      candidateCount: 2,
      rejectedCandidateCount: 2,
      referenceSpanBelowTargetCount: 1,
    });
    expect(report.candidates[0]).toMatchObject({
      status: 'rejected',
      dataWindow: {
        referenceBars: null,
        referenceSpanDays: null,
        referenceSpanTargetDays: 730,
        meetsReferenceSpanTarget: false,
      },
      warnings: [],
      rejectionReasons: [{ code: 'evaluation_error', count: 1 }],
    });
    expect(report.candidates[1]).toMatchObject({
      dataWindow: {
        referenceBars: 100,
        referenceSpanDays: 100,
        referenceSpanTargetDays: 730,
        meetsReferenceSpanTarget: false,
      },
      warnings: [
        {
          code: 'reference_span_below_target',
          actual: 100,
          threshold: 730,
        },
      ],
    });
  });

  it('keeps console and report span warnings aligned for evaluation errors', async () => {
    const candidateTargets = buildCandidateMatrix().slice(0, 3);
    const referenceSpans = [729.999, 730, undefined];
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    let writtenReport;
    let evaluationIndex = 0;
    let consoleWarnings = [];

    try {
      await expect(
        main({
          args: [],
          candidateTargets,
          generatedAt: '2026-08-17T12:34:56.000Z',
          loadEngine: async () => ({ cleanup: async () => {} }),
          evaluate: async (_engine, target) => ({
            strategy: target.strategy,
            pair: target.strategy.meta.pair,
            entryType: target.entryType,
            timeframe: target.strategy.meta.timeframe,
            evaluationError: 'fixture evaluation failure',
            referenceSpanDays: referenceSpans[evaluationIndex++],
          }),
          writeReport: async (report) => {
            writtenReport = report;
            return path.join(os.tmpdir(), 'mock-error-report.json');
          },
          log: () => {},
        }),
      ).rejects.toThrow('3件の候補評価に失敗しました');
      consoleWarnings = consoleLog.mock.calls
        .map(([message]) => message)
        .filter((message) => message.startsWith('⚠ 参照データ'));
    } finally {
      consoleLog.mockRestore();
    }

    expect(consoleWarnings).toHaveLength(1);
    expect(writtenReport.summary.referenceSpanBelowTargetCount).toBe(1);
    expect(writtenReport.candidates.map((candidate) => candidate.warnings)).toEqual([
      [
        {
          code: 'reference_span_below_target',
          actual: 729.999,
          threshold: 730,
        },
      ],
      [],
      [],
    ]);
  });

  it('writes an evaluation-error report when the thrown Error has an empty message', async () => {
    const [target] = buildCandidateMatrix();
    let cleanupCalled = false;
    let writtenReport;

    await expect(
      main({
        args: [],
        candidateTargets: [target],
        generatedAt: '2026-08-17T12:34:56.000Z',
        loadEngine: async () => ({
          cleanup: async () => {
            cleanupCalled = true;
          },
        }),
        evaluate: async () => {
          throw new Error();
        },
        writeReport: async (report) => {
          writtenReport = report;
          return path.join(os.tmpdir(), 'mock-empty-error-report.json');
        },
        printResult: () => {},
        log: () => {},
      }),
    ).rejects.toThrow('1件の候補評価に失敗しました');

    expect(cleanupCalled).toBe(true);
    expect(writtenReport.candidates[0]).toMatchObject({
      status: 'rejected',
      dataWindow: {
        referenceSpanDays: null,
        referenceSpanTargetDays: 730,
        meetsReferenceSpanTarget: false,
      },
      warnings: [],
      rejectionReasons: [
        {
          code: 'evaluation_error',
          message: '評価エラー（詳細なし）',
          count: 1,
        },
      ],
    });
  });

  it('serializes NaN and negative Infinity metrics without losing the report', () => {
    const [target] = buildCandidateMatrix();
    const nonFinite = row({
      optNet: 100_000,
      optPf: Number.NaN,
      valNet: 60_000,
      ratio: 0.6,
    });
    nonFinite.validation.profitFactor = Number.NEGATIVE_INFINITY;

    const report = createTuningReport([
      resultFor({ target, rows: [nonFinite], eligible: null }),
    ]);

    expect(report.candidates[0].combinations[0]).toMatchObject({
      optimizationMetrics: { profitFactor: 'NaN' },
      validationMetrics: { profitFactor: '-Infinity' },
    });
  });

  it('records the legacy PF prefilter as the sole rejection reason when other gates pass', () => {
    const [target] = buildCandidateMatrix();
    const rejectedByPf = row({
      optNet: 100_000,
      optPf: 0.999999,
      valNet: 60_000,
      ratio: 0.6,
    });
    const report = createTuningReport([
      resultFor({ target, rows: [rejectedByPf], eligible: null }),
    ]);

    expect(report.candidates[0]).toMatchObject({
      status: 'rejected',
      rejectionReasons: [
        { code: 'legacy_optimization_profit_factor_prefilter', count: 1 },
      ],
      combinations: [
        {
          status: 'rejected',
          rejectionReasons: [
            { code: 'legacy_optimization_profit_factor_prefilter', actual: 0.999999 },
          ],
        },
      ],
    });
  });

  it('writes parseable JSON beneath the supplied reports directory', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'fx-tuning-report-test-'));
    const directory = path.join(tempRoot, 'reports');
    try {
      const report = createTuningReport([], {
        generatedAt: '2026-08-17T12:34:56.000Z',
      });
      const outputPath = await writeTuningReport(report, { directory });
      const saved = JSON.parse(await readFile(outputPath, 'utf8'));

      expect(path.dirname(outputPath)).toBe(directory);
      expect(path.basename(outputPath)).toBe(
        'tune-virtual-strategies-2026-08-17T12-34-56-000Z.json',
      );
      expect(saved).toEqual(report);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('ignores generated reports in git', async () => {
    const gitignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
    expect(gitignore.split(/\r?\n/)).toContain('reports/');
  });
});
