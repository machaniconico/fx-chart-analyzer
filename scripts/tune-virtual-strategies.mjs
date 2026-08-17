import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEsbuild } from './lib/esbuild-loader.mjs';
import { splitBarsByRegistration } from './run-forward-test.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const dataRoot = path.join(projectRoot, 'public/data');
const strategiesRoot = path.join(projectRoot, 'strategies/virtual');
const reportsRoot = path.join(projectRoot, 'reports');
export const REFERENCE_SPAN_TARGET_DAYS = 730;

const oneDecimal = (value) => Math.round(value * 10) / 10;

const rangeWithSteps = (min, max, steps) => ({
  min,
  max,
  step: (max - min) / Math.max(1, steps - 1),
});

const registeredAt = 1782996300;
const disabledSessionFilter = {
  enabled: false,
  start: '00:00',
  end: '23:59',
  serverUtcOffsetMinutes: 0,
};
const disabledNewsFilter = {
  enabled: false,
  blockMinutes: 30,
};
const fixedRiskMoneyManagement = {
  initialBalanceYen: 1000000,
  lotSizingMode: 'fixedRisk',
  fixedLot: 0.1,
  riskPercent: 1,
  maxLot: 100,
};

export const TUNING_PAIRS = Object.freeze([
  'USDJPY',
  'EURUSD',
  'GBPJPY',
  'EURJPY',
  'GBPUSD',
  'AUDJPY',
]);

export const ENTRY_TYPE_PROFILES = Object.freeze({
  maCross: Object.freeze({
    label: 'MAクロス順張り',
    timeframes: Object.freeze(['h1', 'h4']),
    entryCondition: Object.freeze({
      type: 'maCross',
      fastType: 'ema',
      fastPeriod: 20,
      slowType: 'ema',
      slowPeriod: 50,
    }),
    exit: Object.freeze({ stopLossPips: 30, takeProfitPips: 60, closeOnOppositeSignal: true }),
    parameterRanges: Object.freeze({
      stopLossPips: Object.freeze(rangeWithSteps(20, 80, 6)),
      takeProfitPips: Object.freeze(rangeWithSteps(30, 150, 6)),
    }),
    trailingStopPips: Object.freeze([null, 20]),
  }),
  rsi: Object.freeze({
    label: 'RSI逆張り',
    timeframes: Object.freeze(['m30', 'h1']),
    entryCondition: Object.freeze({
      type: 'rsi',
      period: 14,
      threshold: 30,
      comparison: 'below',
    }),
    exit: Object.freeze({ stopLossPips: 25, takeProfitPips: 35, closeOnOppositeSignal: false }),
    parameterRanges: Object.freeze({
      stopLossPips: Object.freeze(rangeWithSteps(10, 50, 6)),
      takeProfitPips: Object.freeze(rangeWithSteps(15, 75, 6)),
    }),
    trailingStopPips: Object.freeze([null]),
  }),
  bollinger: Object.freeze({
    label: 'BBブレイク順張り',
    timeframes: Object.freeze(['m30', 'h1']),
    entryCondition: Object.freeze({
      type: 'bollinger',
      period: 20,
      multiplier: 2,
      mode: 'break',
      band: 'upper',
    }),
    exit: Object.freeze({ stopLossPips: 25, takeProfitPips: 50, closeOnOppositeSignal: false }),
    parameterRanges: Object.freeze({
      stopLossPips: Object.freeze(rangeWithSteps(15, 75, 6)),
      takeProfitPips: Object.freeze(rangeWithSteps(25, 125, 6)),
    }),
    trailingStopPips: Object.freeze([null, 20]),
  }),
  macdCross: Object.freeze({
    label: 'MACDクロス順張り',
    timeframes: Object.freeze(['h1', 'h4']),
    entryCondition: Object.freeze({
      type: 'macdCross',
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
    }),
    exit: Object.freeze({ stopLossPips: 30, takeProfitPips: 60, closeOnOppositeSignal: true }),
    parameterRanges: Object.freeze({
      stopLossPips: Object.freeze(rangeWithSteps(20, 80, 6)),
      takeProfitPips: Object.freeze(rangeWithSteps(30, 150, 6)),
    }),
    trailingStopPips: Object.freeze([null, 20]),
  }),
});

export const TUNING_ENTRY_TYPES = Object.freeze(Object.keys(ENTRY_TYPE_PROFILES));
export const TUNING_TIMEFRAMES = Object.freeze(
  [...new Set(TUNING_ENTRY_TYPES.flatMap((entryType) => ENTRY_TYPE_PROFILES[entryType].timeframes))],
);

export const buildCandidateMatrix = () => {
  const candidates = [];
  for (const [pairIndex, pair] of TUNING_PAIRS.entries()) {
    for (const [entryTypeIndex, entryType] of TUNING_ENTRY_TYPES.entries()) {
      const profile = ENTRY_TYPE_PROFILES[entryType];
      for (const [timeframeIndex, timeframe] of profile.timeframes.entries()) {
        const id = `tune-${entryType.toLowerCase()}-${pair.toLowerCase()}-${timeframe}-v1`;
        const name = `${pair} ${timeframe} ${profile.label}`;
        candidates.push({
          id,
          entryType,
          strategy: {
            meta: { id, name, version: 1, pair, timeframe, registeredAt },
            id,
            name,
            description: `${pair} ${timeframe}の${profile.label}を買い・売りの両方向で検証します。`,
            direction: 'long',
            entryDirections: ['long', 'short'],
            entryConditions: [{ ...profile.entryCondition }],
            exit: {
              ...profile.exit,
              trailingStopPips: profile.trailingStopPips[0],
            },
            sessionFilter: { ...disabledSessionFilter },
            newsFilter: { ...disabledNewsFilter },
            lotSize: 0.1,
            moneyManagement: { ...fixedRiskMoneyManagement },
            magicNumber: 1783100000 + pairIndex * 100 + entryTypeIndex * 10 + timeframeIndex,
          },
          parameterRanges: {
            stopLossPips: { ...profile.parameterRanges.stopLossPips },
            takeProfitPips: { ...profile.parameterRanges.takeProfitPips },
          },
          trailingStopPips: [...profile.trailingStopPips],
          sessionVariants: null,
        });
      }
    }
  }
  return candidates;
};

export const targets = buildCandidateMatrix();

export const CLI_USAGE = `Usage: node scripts/tune-virtual-strategies.mjs [options]

Options:
  --pair <pair[,pair...]>              Filter pairs (${TUNING_PAIRS.join(', ')})
  --entry-type <type[,type...]>        Filter entry types (${TUNING_ENTRY_TYPES.join(', ')})
  --timeframe <timeframe[,timeframe...]> Filter timeframes (${TUNING_TIMEFRAMES.join(', ')})
  --help                               Show this help

Each filter can be repeated. With no filters, the complete candidate matrix is evaluated.`;

const filterDefinitions = new Map([
  ['--pair', { key: 'pairs', values: TUNING_PAIRS, normalize: (value) => value.toUpperCase() }],
  ['--pairs', { key: 'pairs', values: TUNING_PAIRS, normalize: (value) => value.toUpperCase() }],
  ['--entry-type', { key: 'entryTypes', values: TUNING_ENTRY_TYPES }],
  ['--entry-types', { key: 'entryTypes', values: TUNING_ENTRY_TYPES }],
  ['--timeframe', { key: 'timeframes', values: TUNING_TIMEFRAMES, normalize: (value) => value.toLowerCase() }],
  ['--timeframes', { key: 'timeframes', values: TUNING_TIMEFRAMES, normalize: (value) => value.toLowerCase() }],
]);

const canonicalFilterValue = (rawValue, definition, flag) => {
  const normalized = definition.normalize ? definition.normalize(rawValue) : rawValue;
  const canonical = definition.values.find(
    (value) => value.toLowerCase() === normalized.toLowerCase(),
  );
  if (!canonical) {
    throw new Error(
      `Invalid value for ${flag}: ${rawValue}. Expected one of: ${definition.values.join(', ')}`,
    );
  }
  return canonical;
};

export const parseCliArgs = (args) => {
  const filters = { pairs: [], entryTypes: [], timeframes: [] };
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    const equalsIndex = argument.indexOf('=');
    const flag = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const definition = filterDefinitions.get(flag);
    if (!definition) {
      throw new Error(`Unknown option: ${argument}\n\n${CLI_USAGE}`);
    }
    const rawValues = equalsIndex === -1 ? args[index + 1] : argument.slice(equalsIndex + 1);
    if (equalsIndex === -1) {
      index += 1;
    }
    if (!rawValues || rawValues.startsWith('--')) {
      throw new Error(`Missing value for ${flag}`);
    }
    for (const rawValue of rawValues.split(',')) {
      const value = rawValue.trim();
      if (!value) {
        throw new Error(`Empty value for ${flag}`);
      }
      const canonical = canonicalFilterValue(value, definition, flag);
      if (!filters[definition.key].includes(canonical)) {
        filters[definition.key].push(canonical);
      }
    }
  }

  return { help, ...filters };
};

export const filterTargets = (candidateTargets, filters) =>
  candidateTargets.filter((target) => {
    const { pair, timeframe } = target.strategy.meta;
    return (
      (filters.pairs.length === 0 || filters.pairs.includes(pair)) &&
      (filters.entryTypes.length === 0 || filters.entryTypes.includes(target.entryType)) &&
      (filters.timeframes.length === 0 || filters.timeframes.includes(timeframe))
    );
  });

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));

const loadTuningEngine = async () => {
  const esbuild = loadEsbuild();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fx-virtual-tuning-'));
  const outfile = path.join(tempDir, 'tuning-engine.mjs');
  await esbuild.build({
    stdin: {
      contents: `
        export {
          generateParameterCombinations,
          splitOptimizationBars,
          scoreBacktestResult,
          validationToOptimizationRatio,
          isOverfitSuspect,
        } from './src/lib/optimize.ts';
        export { runBacktest } from './src/lib/backtest.ts';
      `,
      loader: 'ts',
      resolveDir: projectRoot,
      sourcefile: 'virtual-tuning-entry.ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'silent',
  });
  const module = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  for (const exportName of [
    'generateParameterCombinations',
    'splitOptimizationBars',
    'scoreBacktestResult',
    'validationToOptimizationRatio',
    'isOverfitSuspect',
    'runBacktest',
  ]) {
    if (typeof module[exportName] !== 'function') {
      throw new Error(`Bundled tuning engine does not export ${exportName}`);
    }
  }
  return {
    ...module,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
};

const sevenPointRange = (baseValue) => {
  const min = baseValue * 0.5;
  const max = baseValue * 2.5;
  return {
    min: oneDecimal(min),
    max: oneDecimal(max),
    step: (max - min) / 6,
  };
};

const cloneJson = (value) => JSON.parse(JSON.stringify(value));

const loadBars = async (pair, timeframe) => {
  const payload = await readJson(path.join(dataRoot, pair, `${timeframe}.json`));
  return payload.bars;
};

const barsWithin = (bars, segment) => {
  if (segment.length === 0) {
    return [];
  }
  const firstTime = segment[0].t;
  const lastTime = segment[segment.length - 1].t;
  return bars.filter((bar) => bar.t >= firstTime && bar.t <= lastTime);
};

const strategyWithCandidate = (strategy, parameters, sessionVariant) => {
  const candidate = cloneJson(strategy);
  candidate.exit = {
    ...candidate.exit,
    stopLossPips: parameters.stopLossPips,
    takeProfitPips: parameters.takeProfitPips,
    trailingStopPips: parameters.trailingStopPips,
  };
  if (sessionVariant) {
    candidate.sessionFilter = cloneJson(sessionVariant.filter);
  }
  return candidate;
};

const sessionLabel = (variant, strategy) => {
  if (variant) {
    return variant.label;
  }
  const filter = strategy.sessionFilter;
  return filter.enabled ? `${filter.start}-${filter.end}` : 'なし';
};

const trailingLabel = (value) => (value === null || value === undefined ? 'なし' : `${value}p`);

const combinationLabel = (row) => {
  const parts = [
    `SL ${row.parameters.stopLossPips}p`,
    `TP ${row.parameters.takeProfitPips}p`,
  ];
  if (row.includeTrailing) {
    parts.push(`TR ${trailingLabel(row.parameters.trailingStopPips)}`);
  }
  if (row.includeSession) {
    parts.push(`Session ${row.sessionLabel}`);
  }
  return parts.join(' / ');
};

const formatYen = (value) =>
  `${Math.round(value).toLocaleString('ja-JP', { signDisplay: 'exceptZero' })}円`;

const formatPf = (value) => {
  if (value === Number.POSITIVE_INFINITY) {
    return '∞';
  }
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
};

const formatDd = (value) => `${Math.round(value).toLocaleString('ja-JP')}円`;

const markdownTable = (rows) => {
  const header = [
    '#',
    '組合せ',
    'Opt損益',
    'Opt PF',
    'Opt DD',
    'Opt取引',
    'Val損益',
    'Val PF',
    'Val DD',
    'Val取引',
    '過学習',
  ];
  const body = rows.map((row, index) => [
    String(index + 1),
    combinationLabel(row),
    formatYen(row.optimization.netProfitYen),
    formatPf(row.optimization.profitFactor),
    formatDd(row.optimization.maxDrawdownYen),
    String(row.optimization.tradeCount),
    formatYen(row.validation.netProfitYen),
    formatPf(row.validation.profitFactor),
    formatDd(row.validation.maxDrawdownYen),
    String(row.validation.tradeCount),
    row.overfitWarning ? '⚠ 疑い' : '-',
  ]);
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((cells) => `| ${cells.join(' | ')} |`),
  ].join('\n');
};

// Rank by the optimization (in-sample) window, matching src/lib/optimize.ts, so
// the validation window stays a genuine out-of-sample hold-out. Ranking by the
// validation window turned it into a second optimization set (selection bias).
export const rankRows = (rows) =>
  [...rows].sort((left, right) => {
    const optimizationProfitDiff = right.optimization.netProfitYen - left.optimization.netProfitYen;
    if (optimizationProfitDiff !== 0) {
      return optimizationProfitDiff;
    }
    return left.optimization.maxDrawdownYen - right.optimization.maxDrawdownYen;
  });

// Validation is only a pass/fail gate here, never a ranking key: the adopted row
// must be profitable in-sample, hold up out-of-sample (>=10 trades, no overfit
// warning, and keep at least 35% of the in-sample profit).
export const isEligible = (row) =>
  row.optimization.netProfitYen > 0 &&
  row.validation.netProfitYen > 0 &&
  row.validation.tradeCount >= 10 &&
  !row.overfitWarning &&
  row.validationToOptimizationRatio >= 0.35;

// Keep the historical PF prefilter separate from the validation gate above.
// In normal score output a positive net profit implies PF >= 1, but preserving
// this pipeline avoids silently changing how legacy edge-case rows are selected.
export const rankSelectableRows = (rows) =>
  rankRows(rows).filter((row) => row.optimization.profitFactor >= 1);

export const selectEligibleRow = (rows) => rankSelectableRows(rows).find(isEligible) ?? null;

export const SELECTION_POLICY = Object.freeze({
  ranking: Object.freeze([
    'optimization.netProfitYen descending',
    'optimization.maxDrawdownYen ascending',
  ]),
  legacyPrefilter: Object.freeze({
    field: 'optimization.profitFactor',
    operator: '>=',
    threshold: 1,
  }),
  gate: Object.freeze({
    optimizationNetProfitYen: Object.freeze({ operator: '>', threshold: 0 }),
    validationNetProfitYen: Object.freeze({ operator: '>', threshold: 0 }),
    validationTradeCount: Object.freeze({ operator: '>=', threshold: 10 }),
    overfitWarning: Object.freeze({ operator: '===', threshold: false }),
    validationToOptimizationRatio: Object.freeze({ operator: '>=', threshold: 0.35 }),
  }),
});

const rejectionReason = (code, message, actual, operator, threshold) => ({
  code,
  message,
  actual,
  operator,
  threshold,
});

export const eligibilityRejectionReasons = (row) => {
  const reasons = [];
  if (!(row.optimization.netProfitYen > 0)) {
    reasons.push(
      rejectionReason(
        'optimization_not_profitable',
        'インサンプル損益が0円以下',
        row.optimization.netProfitYen,
        '>',
        0,
      ),
    );
  }
  if (!(row.validation.netProfitYen > 0)) {
    reasons.push(
      rejectionReason(
        'validation_not_profitable',
        'アウトオブサンプル損益が0円以下',
        row.validation.netProfitYen,
        '>',
        0,
      ),
    );
  }
  if (!(row.validation.tradeCount >= 10)) {
    reasons.push(
      rejectionReason(
        'insufficient_validation_trades',
        'アウトオブサンプル取引が10件未満',
        row.validation.tradeCount,
        '>=',
        10,
      ),
    );
  }
  if (row.overfitWarning) {
    reasons.push(
      rejectionReason(
        'overfit_warning',
        '過学習警告あり',
        row.overfitWarning,
        '===',
        false,
      ),
    );
  }
  if (!(row.validationToOptimizationRatio >= 0.35)) {
    reasons.push(
      rejectionReason(
        'validation_retention_below_threshold',
        '検証保持率が0.35未満',
        row.validationToOptimizationRatio,
        '>=',
        0.35,
      ),
    );
  }
  return reasons;
};

const selectionPoolRejectionReasons = (row) =>
  row.optimization.profitFactor >= 1
    ? []
    : [
        rejectionReason(
          'legacy_optimization_profit_factor_prefilter',
          '既存のインサンプルPF事前フィルターが1未満',
          row.optimization.profitFactor,
          '>=',
          1,
        ),
      ];

export const selectionEvidence = (row) => ({
  optimizationNetProfitYen: {
    actual: row.optimization.netProfitYen,
    ...SELECTION_POLICY.gate.optimizationNetProfitYen,
    passed: row.optimization.netProfitYen > 0,
  },
  validationNetProfitYen: {
    actual: row.validation.netProfitYen,
    ...SELECTION_POLICY.gate.validationNetProfitYen,
    passed: row.validation.netProfitYen > 0,
  },
  validationTradeCount: {
    actual: row.validation.tradeCount,
    ...SELECTION_POLICY.gate.validationTradeCount,
    passed: row.validation.tradeCount >= 10,
  },
  overfitWarning: {
    actual: row.overfitWarning,
    ...SELECTION_POLICY.gate.overfitWarning,
    passed: !row.overfitWarning,
  },
  validationToOptimizationRatio: {
    actual: row.validationToOptimizationRatio,
    ...SELECTION_POLICY.gate.validationToOptimizationRatio,
    passed: row.validationToOptimizationRatio >= 0.35,
  },
});

const loadTargetStrategy = async (target) => {
  if (target.strategy) {
    return cloneJson(target.strategy);
  }
  return readJson(path.join(strategiesRoot, `${target.id}.json`));
};

const evaluateTarget = async (engine, target) => {
  const strategy = await loadTargetStrategy(target);
  const { pair, timeframe, registeredAt } = strategy.meta;
  const bars = await loadBars(pair, timeframe);
  const referenceBars = splitBarsByRegistration(bars, registeredAt).referenceBars;
  const { optimizationBars, validationBars } = engine.splitOptimizationBars(referenceBars, 0.7);
  const usdJpyReferenceBars = pair.endsWith('JPY')
    ? []
    : splitBarsByRegistration(await loadBars('USDJPY', timeframe), registeredAt).referenceBars;
  const optimizationOptions = pair.endsWith('JPY')
    ? {}
    : { usdJpyBars: barsWithin(usdJpyReferenceBars, optimizationBars) };
  const validationOptions = pair.endsWith('JPY')
    ? {}
    : { usdJpyBars: barsWithin(usdJpyReferenceBars, validationBars) };
  const parameterRanges = target.parameterRanges ?? {
    stopLossPips: sevenPointRange(strategy.exit.stopLossPips),
    takeProfitPips: sevenPointRange(strategy.exit.takeProfitPips),
  };
  const baseCombinations = engine.generateParameterCombinations(parameterRanges);
  const trailingValues = target.trailingStopPips ?? [strategy.exit.trailingStopPips ?? null];
  const sessionVariants = target.sessionVariants ?? [null];
  const rows = [];

  for (const baseParameters of baseCombinations) {
    for (const trailingStopPips of trailingValues) {
      for (const sessionVariant of sessionVariants) {
        const parameters = {
          ...baseParameters,
          trailingStopPips,
        };
        const candidate = strategyWithCandidate(strategy, parameters, sessionVariant);
        const optimization = engine.scoreBacktestResult(
          engine.runBacktest(optimizationBars, candidate, pair, optimizationOptions),
        );
        const validation = engine.scoreBacktestResult(
          engine.runBacktest(validationBars, candidate, pair, validationOptions),
        );
        rows.push({
          parameters,
          optimization,
          validation,
          validationToOptimizationRatio: engine.validationToOptimizationRatio(optimization, validation),
          overfitWarning: engine.isOverfitSuspect(optimization, validation),
          sessionLabel: sessionLabel(sessionVariant, strategy),
          sessionFilter: sessionVariant ? cloneJson(sessionVariant.filter) : cloneJson(strategy.sessionFilter),
          includeTrailing: Array.isArray(target.trailingStopPips),
          includeSession: Array.isArray(target.sessionVariants),
        });
      }
    }
  }

  // Preserve the legacy PF-filtered console/selection pool, while retaining the
  // full ranked set so the JSON report can explain every rejected combination.
  const evaluatedRows = rankRows(rows);
  const rankedRows = rankSelectableRows(rows);
  const spanDays = (segment) =>
    segment.length > 1 ? (segment[segment.length - 1].t - segment[0].t) / 86400 : 0;
  return {
    strategy,
    pair,
    entryType: target.entryType ?? strategy.entryConditions[0]?.type ?? 'unknown',
    timeframe,
    referenceBars: referenceBars.length,
    optimizationBars: optimizationBars.length,
    validationBars: validationBars.length,
    referenceSpanDays: spanDays(referenceBars),
    validationSpanDays: spanDays(validationBars),
    evaluatedRows,
    rows: rankedRows,
    eligible: selectEligibleRow(rows),
  };
};

export const TUNING_REPORT_SCHEMA_VERSION = 1;

const jsonSafeValue = (value) => {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    if (value === Number.POSITIVE_INFINITY) {
      return 'Infinity';
    }
    if (value === Number.NEGATIVE_INFINITY) {
      return '-Infinity';
    }
    return 'NaN';
  }
  if (Array.isArray(value)) {
    return value.map(jsonSafeValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonSafeValue(item)]),
    );
  }
  return value;
};

const summarizeRejectionReasons = (combinations) => {
  const summaries = new Map();
  for (const combination of combinations) {
    for (const reason of combination.rejectionReasons) {
      const current = summaries.get(reason.code);
      if (current) {
        current.count += 1;
      } else {
        summaries.set(reason.code, {
          code: reason.code,
          message: reason.message,
          count: 1,
        });
      }
    }
  }
  return [...summaries.values()];
};

const reportCombination = (row, rank, selected) => {
  const rejectionReasons = [
    ...eligibilityRejectionReasons(row),
    ...selectionPoolRejectionReasons(row),
  ];
  return {
    rank,
    status: rejectionReasons.length === 0 ? 'passed' : 'rejected',
    selected,
    parameters: row.parameters,
    sessionLabel: row.sessionLabel,
    sessionFilter: row.sessionFilter,
    optimizationMetrics: row.optimization,
    validationMetrics: row.validation,
    selectionEvidence: selectionEvidence(row),
    rejectionReasons,
  };
};

const referenceSpanWarnings = (referenceSpanDays) =>
  Number.isFinite(referenceSpanDays) && referenceSpanDays < REFERENCE_SPAN_TARGET_DAYS
    ? [
        {
          code: 'reference_span_below_target',
          actual: referenceSpanDays,
          threshold: REFERENCE_SPAN_TARGET_DAYS,
        },
      ]
    : [];

const finiteNumberOrNull = (value) => (Number.isFinite(value) ? value : null);

const reportDataWindow = (result) => {
  const referenceSpanDays = finiteNumberOrNull(result.referenceSpanDays);
  return {
    referenceBars: finiteNumberOrNull(result.referenceBars),
    optimizationBars: finiteNumberOrNull(result.optimizationBars),
    validationBars: finiteNumberOrNull(result.validationBars),
    referenceSpanDays,
    validationSpanDays: finiteNumberOrNull(result.validationSpanDays),
    referenceSpanTargetDays: REFERENCE_SPAN_TARGET_DAYS,
    meetsReferenceSpanTarget:
      referenceSpanDays !== null && referenceSpanDays >= REFERENCE_SPAN_TARGET_DAYS,
  };
};

const hasEvaluationError = (result) =>
  Object.prototype.hasOwnProperty.call(result, 'evaluationError');

const evaluationErrorMessage = (error) => {
  const rawMessage = error instanceof Error ? error.message : String(error ?? '');
  return rawMessage.trim() || '評価エラー（詳細なし）';
};

const reportCandidate = (result) => {
  if (hasEvaluationError(result)) {
    return {
      id: result.strategy.meta.id,
      pair: result.pair,
      entryType: result.entryType,
      timeframe: result.timeframe,
      status: 'rejected',
      dataWindow: reportDataWindow(result),
      warnings: referenceSpanWarnings(result.referenceSpanDays),
      selectedCandidate: null,
      rejectionReasons: [
        {
          code: 'evaluation_error',
          message: evaluationErrorMessage(result.evaluationError),
          count: 1,
        },
      ],
      combinations: [],
    };
  }

  const rows = result.evaluatedRows ?? rankRows(result.rows);
  const combinations = rows.map((row, index) =>
    reportCombination(row, index + 1, row === result.eligible),
  );
  const selectedCandidate = combinations.find((combination) => combination.selected) ?? null;
  const rejectionReasons = result.eligible ? [] : summarizeRejectionReasons(combinations);
  const warnings = referenceSpanWarnings(result.referenceSpanDays);
  if (!result.eligible && rejectionReasons.length === 0) {
    rejectionReasons.push({
      code: 'no_evaluated_combinations',
      message: '評価されたパラメータ組合せなし',
      count: 1,
    });
  }

  return {
    id: result.strategy.meta.id,
    pair: result.pair,
    entryType: result.entryType,
    timeframe: result.timeframe,
    status: result.eligible ? 'passed' : 'rejected',
    dataWindow: reportDataWindow(result),
    warnings,
    selectedCandidate,
    rejectionReasons,
    combinations,
  };
};

export const createTuningReport = (
  results,
  {
    generatedAt = new Date().toISOString(),
    filters = { pairs: [], entryTypes: [], timeframes: [] },
  } = {},
) => {
  const candidates = results.map(reportCandidate);
  const combinationCount = candidates.reduce(
    (count, candidate) => count + candidate.combinations.length,
    0,
  );
  const passedCombinationCount = candidates.reduce(
    (count, candidate) =>
      count + candidate.combinations.filter((combination) => combination.status === 'passed').length,
    0,
  );
  return jsonSafeValue({
    schemaVersion: TUNING_REPORT_SCHEMA_VERSION,
    generatedAt:
      generatedAt instanceof Date ? generatedAt.toISOString() : new Date(generatedAt).toISOString(),
    selectionPolicy: SELECTION_POLICY,
    filters: {
      pairs: [...(filters.pairs ?? [])],
      entryTypes: [...(filters.entryTypes ?? [])],
      timeframes: [...(filters.timeframes ?? [])],
    },
    matrix: {
      pairs: [...TUNING_PAIRS],
      entryTypeTimeframes: Object.fromEntries(
        TUNING_ENTRY_TYPES.map((entryType) => [
          entryType,
          [...ENTRY_TYPE_PROFILES[entryType].timeframes],
        ]),
      ),
      definedCandidateCount: targets.length,
      evaluatedCandidateCount: candidates.length,
    },
    summary: {
      candidateCount: candidates.length,
      passedCandidateCount: candidates.filter((candidate) => candidate.status === 'passed').length,
      rejectedCandidateCount: candidates.filter((candidate) => candidate.status === 'rejected').length,
      referenceSpanBelowTargetCount: candidates.filter((candidate) =>
        candidate.warnings.some((warning) => warning.code === 'reference_span_below_target'),
      ).length,
      combinationCount,
      passedCombinationCount,
      rejectedCombinationCount: combinationCount - passedCombinationCount,
    },
    candidates,
  });
};

export const writeTuningReport = async (report, { directory = reportsRoot } = {}) => {
  const timestamp = report.generatedAt.replace(/[^0-9A-Za-z]+/g, '-').replace(/-+$/g, '');
  const outputPath = path.join(directory, `tune-virtual-strategies-${timestamp}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outputPath;
};

const printReferenceSpanWarning = (result) => {
  const [warning] = referenceSpanWarnings(result.referenceSpanDays);
  if (!warning) {
    return;
  }
  const actualDays = Math.floor(warning.actual * 10) / 10;
  const validationCaveat = Number.isFinite(result.validationSpanDays)
    ? `検証スライスは約${Math.round(result.validationSpanDays)}日しかなく、`
    : '検証スライス期間も確認できず、';
  console.log(
    `⚠ 参照データが2年(${warning.threshold}日)未満(${actualDays}日)。${validationCaveat}採用候補のウォークフォワード検証は限定的です。`,
  );
};

const printTargetResult = (result) => {
  console.log(`\n## ${result.strategy.meta.id} (${result.pair} ${result.timeframe})`);
  if (hasEvaluationError(result)) {
    console.log(`評価失敗: ${evaluationErrorMessage(result.evaluationError)}`);
    printReferenceSpanWarning(result);
    return;
  }
  console.log(
    `bars: reference=${result.referenceBars} (${Math.round(result.referenceSpanDays)}日), optimization=${result.optimizationBars}, validation=${result.validationBars} (${Math.round(result.validationSpanDays)}日)`,
  );
  printReferenceSpanWarning(result);
  console.log(markdownTable(result.rows.slice(0, 5)));
  if (result.eligible) {
    console.log(`採用候補: ${combinationLabel(result.eligible)}`);
  } else {
    console.log('採用候補: 該当なし');
  }
};

export const main = async ({
  args = process.argv.slice(2),
  reportDirectory = reportsRoot,
  generatedAt = new Date(),
  candidateTargets = targets,
  loadEngine = loadTuningEngine,
  evaluate = evaluateTarget,
  writeReport = writeTuningReport,
  printResult = printTargetResult,
  log = console.log,
} = {}) => {
  const filters = parseCliArgs(args);
  if (filters.help) {
    log(CLI_USAGE);
    return [];
  }
  const selectedTargets = filterTargets(candidateTargets, filters);
  if (selectedTargets.length === 0) {
    throw new Error('指定されたフィルターに一致するチューニング候補がありません。');
  }

  log(`チューニング候補: ${selectedTargets.length}/${candidateTargets.length}件`);
  const engine = await loadEngine();
  try {
    const results = [];
    for (const target of selectedTargets) {
      let result;
      try {
        result = await evaluate(engine, target);
      } catch (error) {
        result = {
          strategy: target.strategy,
          pair: target.strategy.meta.pair,
          entryType: target.entryType,
          timeframe: target.strategy.meta.timeframe,
          evaluationError: evaluationErrorMessage(error),
        };
      }
      results.push(result);
      printResult(result);
    }
    const report = createTuningReport(results, { generatedAt, filters });
    const reportPath = await writeReport(report, { directory: reportDirectory });
    log(`\nJSONレポート: ${path.relative(projectRoot, reportPath)}`);
    const evaluationErrorCount = results.filter(hasEvaluationError).length;
    if (evaluationErrorCount > 0) {
      throw new Error(`${evaluationErrorCount}件の候補評価に失敗しました。JSONレポートに理由を記録しました。`);
    }
    return results;
  } finally {
    await engine.cleanup();
  }
};

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
