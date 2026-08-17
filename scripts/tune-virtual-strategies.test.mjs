import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ENTRY_TYPE_PROFILES,
  TUNING_ENTRY_TYPES,
  TUNING_PAIRS,
  buildCandidateMatrix,
  createTuningReport,
  eligibilityRejectionReasons,
  filterTargets,
  isEligible,
  main,
  parseCliArgs,
  rankRows,
  selectEligibleRow,
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
    ]);
    expect(ENTRY_TYPE_PROFILES.rsi.timeframes).toEqual(['m30', 'h1']);
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

    expect(matrix).toHaveLength(expectedCount);
    expect(new Set(triples).size).toBe(expectedCount);
    expect(new Set(matrix.map((target) => target.id)).size).toBe(expectedCount);

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

    expect(filterTargets(matrix, parseCliArgs(['--pair', 'AUDJPY']))).toHaveLength(8);
    expect(filterTargets(matrix, parseCliArgs(['--entry-type', 'rsi']))).toHaveLength(12);
    expect(filterTargets(matrix, parseCliArgs(['--timeframe', 'm30']))).toHaveLength(12);
    expect(filterTargets(matrix, parseCliArgs(['--timeframe', 'h1']))).toHaveLength(24);
    expect(() => parseCliArgs(['--timeframe', 'm15'])).toThrow(/Invalid value for --timeframe/);
  });

  it('rejects invalid filter values and leaves incompatible valid filters empty', () => {
    expect(() => parseCliArgs(['--pair', 'CADJPY'])).toThrow(/Invalid value for --pair/);
    expect(() => parseCliArgs(['--entry-type'])).toThrow(/Missing value/);
    expect(() => parseCliArgs(['--unknown', 'x'])).toThrow(/Unknown option/);

    const incompatible = parseCliArgs(['--entry-type', 'rsi', '--timeframe', 'h4']);
    expect(filterTargets(buildCandidateMatrix(), incompatible)).toEqual([]);
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
    expect(logs[0]).toBe('チューニング候補: 1/48件');
    expect(writtenReport).toMatchObject({
      filters: { pairs: ['EURUSD'], entryTypes: ['rsi'], timeframes: ['h1'] },
      summary: { candidateCount: 1 },
    });
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
