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
export const DEEP_HISTORY_DIRECTORY = path.join(projectRoot, '.deep-history');
export const REFERENCE_SPAN_TARGET_DAYS = 730;
export const DEEP_HISTORY_MARGIN_DAYS = 7;
export const DEEP_HISTORY_LOOKBACK_DAYS =
  REFERENCE_SPAN_TARGET_DAYS + DEEP_HISTORY_MARGIN_DAYS;
export const DATA_SOURCE_PUBLIC_DATA = 'public-data';
export const DATA_SOURCE_DEEP_HISTORY = 'deep-history';

export const REJECTION_CODES = Object.freeze({
  OPTIMIZATION_NOT_PROFITABLE: 'optimization_not_profitable',
  VALIDATION_NOT_PROFITABLE: 'validation_not_profitable',
  INSUFFICIENT_VALIDATION_TRADES: 'insufficient_validation_trades',
  OVERFIT_WARNING: 'overfit_warning',
  VALIDATION_RETENTION_BELOW_THRESHOLD: 'validation_retention_below_threshold',
  LEGACY_OPTIMIZATION_PROFIT_FACTOR_PREFILTER: 'legacy_optimization_profit_factor_prefilter',
  QUARTERLY_STABILITY_BELOW_THRESHOLD: 'quarterly_stability_below_threshold',
  EVALUATION_ERROR: 'evaluation_error',
  NO_EVALUATED_COMBINATIONS: 'no_evaluated_combinations',
});

export const WARNING_CODES = Object.freeze({
  REFERENCE_SPAN_BELOW_TARGET: 'reference_span_below_target',
  USD_JPY_RATE_SOURCE_FALLBACK: 'usd_jpy_rate_source_fallback',
});

const oneDecimal = (value) => Math.round(value * 10) / 10;

const rangeWithSteps = (min, max, steps) => ({
  min,
  max,
  step: (max - min) / Math.max(1, steps - 1),
});

export const TUNING_REGISTERED_AT = 1782996300;
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

export const SESSION_VARIANTS = Object.freeze([
  null,
  Object.freeze({
    label: '東京00:00-08:00',
    filter: Object.freeze({
      enabled: true,
      start: '00:00',
      end: '08:00',
      serverUtcOffsetMinutes: 0,
    }),
  }),
  Object.freeze({
    label: 'ロンドン07:00-15:00',
    filter: Object.freeze({
      enabled: true,
      start: '07:00',
      end: '15:00',
      serverUtcOffsetMinutes: 0,
    }),
  }),
  Object.freeze({
    label: 'NY12:00-20:00',
    filter: Object.freeze({
      enabled: true,
      start: '12:00',
      end: '20:00',
      serverUtcOffsetMinutes: 0,
    }),
  }),
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
  donchianBreak: Object.freeze({
    label: 'ドンチアンブレイク順張り',
    timeframes: Object.freeze(['h1', 'h4']),
    entryCondition: Object.freeze({
      type: 'donchianBreak',
      period: 20,
    }),
    exit: Object.freeze({ stopLossPips: 30, takeProfitPips: 60, closeOnOppositeSignal: false }),
    parameterRanges: Object.freeze({
      stopLossPips: Object.freeze(rangeWithSteps(20, 80, 6)),
      takeProfitPips: Object.freeze(rangeWithSteps(30, 150, 6)),
    }),
    trailingStopPips: Object.freeze([null, 20]),
  }),
  stochastic: Object.freeze({
    label: 'ストキャス逆張り',
    timeframes: Object.freeze(['m30', 'h1']),
    entryCondition: Object.freeze({
      type: 'stochastic',
      kPeriod: 14,
      dPeriod: 3,
      smoothing: 3,
      threshold: 20,
      comparison: 'crossAbove',
    }),
    exit: Object.freeze({ stopLossPips: 25, takeProfitPips: 40, closeOnOppositeSignal: false }),
    parameterRanges: Object.freeze({
      stopLossPips: Object.freeze(rangeWithSteps(15, 60, 6)),
      takeProfitPips: Object.freeze(rangeWithSteps(20, 100, 6)),
    }),
    trailingStopPips: Object.freeze([null, 15]),
  }),
  ichimokuCross: Object.freeze({
    label: '一目クロス順張り',
    timeframes: Object.freeze(['h1', 'h4']),
    entryCondition: Object.freeze({
      type: 'ichimokuCross',
      conversionPeriod: 9,
      basePeriod: 26,
      spanBPeriod: 52,
      displacement: 26,
      requireCloudFilter: true,
    }),
    exit: Object.freeze({ stopLossPips: 30, takeProfitPips: 60, closeOnOppositeSignal: true }),
    parameterRanges: Object.freeze({
      stopLossPips: Object.freeze(rangeWithSteps(20, 80, 6)),
      takeProfitPips: Object.freeze(rangeWithSteps(30, 150, 6)),
    }),
    trailingStopPips: Object.freeze([null, 20]),
  }),
  keltnerBreak: Object.freeze({
    label: 'ケルトナーブレイク順張り',
    timeframes: Object.freeze(['h1', 'h4']),
    entryCondition: Object.freeze({
      type: 'keltnerBreak',
      emaPeriod: 20,
      atrPeriod: 10,
      multiplier: 2.0,
    }),
    exit: Object.freeze({ stopLossPips: 25, takeProfitPips: 50, closeOnOppositeSignal: false }),
    parameterRanges: Object.freeze({
      stopLossPips: Object.freeze(rangeWithSteps(15, 75, 6)),
      takeProfitPips: Object.freeze(rangeWithSteps(25, 125, 6)),
    }),
    trailingStopPips: Object.freeze([null, 20]),
  }),
  cciBreak: Object.freeze({
    label: 'CCIブレイク順張り',
    timeframes: Object.freeze(['m30', 'h1']),
    entryCondition: Object.freeze({
      type: 'cciBreak',
      period: 14,
      level: 100,
    }),
    exit: Object.freeze({ stopLossPips: 25, takeProfitPips: 50, closeOnOppositeSignal: false }),
    parameterRanges: Object.freeze({
      stopLossPips: Object.freeze(rangeWithSteps(15, 75, 6)),
      takeProfitPips: Object.freeze(rangeWithSteps(25, 125, 6)),
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
            meta: { id, name, version: 1, pair, timeframe, registeredAt: TUNING_REGISTERED_AT },
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
  --deep-history                       Use the source with wider pre-registration coverage
  --session-variants                   Evaluate no-session, Tokyo, London, and New York variants
  --walk-forward                       Check selected parameters across four time-based reference quarters
  --help, -h                            Show this help

Each filter can be repeated. With no filters, the complete candidate matrix is evaluated.
Rank population note: the console ranks the legacy PF >= 1 subset; the JSON report ranks all evaluated combinations.`;

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
  let deepHistory = false;
  let sessionVariants = false;
  let walkForward = false;

  if (args.some((argument) => argument === '--help' || argument === '-h')) {
    return {
      help: true,
      ...(args.includes('--deep-history') ? { deepHistory: true } : {}),
      ...(args.includes('--session-variants') ? { sessionVariants: true } : {}),
      ...(args.includes('--walk-forward') ? { walkForward: true } : {}),
      ...filters,
    };
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--deep-history') {
      deepHistory = true;
      continue;
    }
    if (argument === '--session-variants') {
      sessionVariants = true;
      continue;
    }
    if (argument === '--walk-forward') {
      walkForward = true;
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

  return {
    help: false,
    ...(deepHistory ? { deepHistory: true } : {}),
    ...(sessionVariants ? { sessionVariants: true } : {}),
    ...(walkForward ? { walkForward: true } : {}),
    ...filters,
  };
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

const spanDays = (segment) =>
  segment.length > 1 ? (segment[segment.length - 1].t - segment[0].t) / 86400 : 0;

const referenceBarsForTuning = (bars, registeredAt, useDeepHistoryWindow) => {
  if (!useDeepHistoryWindow) {
    return splitBarsByRegistration(bars, registeredAt).referenceBars;
  }
  const referenceStart = registeredAt - DEEP_HISTORY_LOOKBACK_DAYS * 86400;
  return bars.filter(
    (bar) => Number.isFinite(bar?.t) && bar.t < registeredAt && bar.t >= referenceStart,
  );
};

const barsCoverageBeforeRegistration = (bars, registeredAt) => {
  const eligibleBars = bars.filter(
    (bar) => Number.isFinite(bar?.t) && (!Number.isFinite(registeredAt) || bar.t < registeredAt),
  );
  if (eligibleBars.length === 0) {
    return { barsBeforeRegistration: 0, coverageBeforeRegistrationDays: 0 };
  }
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const bar of eligibleBars) {
    earliest = Math.min(earliest, bar.t);
    latest = Math.max(latest, bar.t);
  }
  return {
    barsBeforeRegistration: eligibleBars.length,
    coverageBeforeRegistrationDays: eligibleBars.length > 1 ? (latest - earliest) / 86400 : 0,
  };
};

const readBarsCandidate = async (
  source,
  filePath,
  pair,
  timeframe,
  registeredAt,
) => {
  let payload;
  try {
    payload = await readJson(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (!Array.isArray(payload?.bars)) {
    throw new Error(`${filePath}: bars must be an array`);
  }
  return {
    bars: payload.bars,
    source,
    pair,
    timeframe,
    payloadSource: typeof payload.source === 'string' ? payload.source : null,
    ...barsCoverageBeforeRegistration(payload.bars, registeredAt),
  };
};

const chooseWidestCoverage = (candidates) =>
  [...candidates].sort((left, right) => {
    const spanDifference =
      right.coverageBeforeRegistrationDays - left.coverageBeforeRegistrationDays;
    if (spanDifference !== 0) {
      return spanDifference;
    }
    const countDifference = right.barsBeforeRegistration - left.barsBeforeRegistration;
    if (countDifference !== 0) {
      return countDifference;
    }
    return left.source === DATA_SOURCE_PUBLIC_DATA ? -1 : 1;
  })[0];

export const loadBarsForTuning = async (
  pair,
  timeframe,
  {
    deepHistory = false,
    deepHistoryDirectory = DEEP_HISTORY_DIRECTORY,
    dataDirectory = dataRoot,
    registeredAt,
    preferredSource,
    includeProvenance = false,
  } = {},
) => {
  const publicPath = path.join(dataDirectory, pair, `${timeframe}.json`);
  const publicCandidate = await readBarsCandidate(
    DATA_SOURCE_PUBLIC_DATA,
    publicPath,
    pair,
    timeframe,
    registeredAt,
  );
  const deepCandidate = deepHistory
    ? await readBarsCandidate(
        DATA_SOURCE_DEEP_HISTORY,
        path.join(deepHistoryDirectory, pair, `${timeframe}.json`),
        pair,
        timeframe,
        registeredAt,
      )
    : null;
  const candidates = [publicCandidate, deepCandidate].filter(Boolean);
  if (candidates.length === 0) {
    const error = new Error(`No tuning bars found for ${pair} ${timeframe}`);
    error.code = 'ENOENT';
    error.path = publicPath;
    throw error;
  }
  const preferredCandidate = preferredSource
    ? candidates.find(
        (candidate) =>
          candidate.source === preferredSource && candidate.barsBeforeRegistration > 0,
      )
    : null;
  const selected = preferredCandidate ?? chooseWidestCoverage(candidates);
  return includeProvenance ? selected : selected.bars;
};

const barsWithin = (bars, segment) => {
  if (segment.length === 0) {
    return [];
  }
  const firstTime = segment[0].t;
  const lastTime = segment[segment.length - 1].t;
  return bars.filter((bar) => bar.t >= firstTime && bar.t <= lastTime);
};

export const QUARTERLY_SEGMENT_COUNT = 4;
export const QUARTERLY_STABILITY_MIN_POSITIVE_SEGMENTS = 3;

export const splitBarsIntoQuarterlySegments = (bars) => {
  const segments = Array.from({ length: QUARTERLY_SEGMENT_COUNT }, () => []);
  if (!Array.isArray(bars) || bars.length === 0) {
    return segments;
  }

  const firstTime = bars[0]?.t;
  const lastTime = bars[bars.length - 1]?.t;
  if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime)) {
    return segments;
  }

  const span = Math.max(0, lastTime - firstTime);
  if (span === 0) {
    segments[0] = [...bars];
    return segments;
  }

  for (const bar of bars) {
    if (!Number.isFinite(bar?.t)) {
      continue;
    }
    const relativePosition = (bar.t - firstTime) / span;
    const segmentIndex = Math.min(3, Math.max(0, Math.floor(relativePosition * 4)));
    segments[segmentIndex].push(bar);
  }
  return segments;
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

// 取引0件の四半期は PF を '-' で示す(NaN を 0.0 と誤読させない)。バー本数も
// 添えて、データ枯渇の縮退セグメントと本物のフラット四半期を区別できるようにする。
const quarterlySummary = (quarterlyResults) =>
  quarterlyResults
    .map(
      (quarter, index) =>
        `Q${index + 1} ${formatYen(quarter.netProfitYen)}(PF${quarter.tradeCount === 0 ? '-' : formatPf(quarter.profitFactor)}/${quarter.tradeCount}件/${quarter.barCount}本)`,
    )
    .join(' | ');

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

export const positiveQuarterlySegmentCount = (quarterlyResults) =>
  Array.isArray(quarterlyResults)
    ? quarterlyResults.filter((quarter) => quarter?.netProfitYen > 0).length
    : 0;

export const isQuarterlyStable = (row) =>
  Array.isArray(row?.quarterlyResults) &&
  row.quarterlyResults.length === QUARTERLY_SEGMENT_COUNT &&
  positiveQuarterlySegmentCount(row.quarterlyResults) >=
    QUARTERLY_STABILITY_MIN_POSITIVE_SEGMENTS;

export const quarterlyStabilityRejectionReasons = (row) => {
  if (!row?.quarterlyStability || row.quarterlyStability.passed) {
    return [];
  }
  const positiveSegments = row.quarterlyStability.positiveSegmentCount;
  return [
    rejectionReason(
      REJECTION_CODES.QUARTERLY_STABILITY_BELOW_THRESHOLD,
      `四半期安定性: 正のセグメントが${positiveSegments}/${QUARTERLY_SEGMENT_COUNT}件で${QUARTERLY_STABILITY_MIN_POSITIVE_SEGMENTS}件未満`,
      positiveSegments,
      '>=',
      QUARTERLY_STABILITY_MIN_POSITIVE_SEGMENTS,
    ),
  ];
};

// Validation is only a pass/fail gate here, never a ranking key: the adopted row
// must be profitable in-sample, hold up out-of-sample (>=10 trades, no overfit
// warning, and keep at least 35% of the in-sample profit).
export const isEligible = (row, { walkForward = false } = {}) =>
  row.optimization.netProfitYen > 0 &&
  row.validation.netProfitYen > 0 &&
  row.validation.tradeCount >= 10 &&
  !row.overfitWarning &&
  row.validationToOptimizationRatio >= 0.35 &&
  (!walkForward || isQuarterlyStable(row));

// Keep the historical PF prefilter separate from the validation gate above.
// In normal score output a positive net profit implies PF >= 1, but preserving
// this pipeline avoids silently changing how legacy edge-case rows are selected.
export const rankSelectableRows = (rows) =>
  rankRows(rows).filter((row) => row.optimization.profitFactor >= 1);

// 注意: walkForward オプションをここで true にしてはいけない。quarterlyResults は
// selectedCandidate 確定後に evaluateQuarterlyStability が付与するため、選定段階の row には
// 存在せず、常に null が返る(四半期ゲートは選定後の候補単位降格として別途適用される)。
export const selectEligibleRow = (rows, { walkForward = false } = {}) =>
  rankSelectableRows(rows).find((row) => isEligible(row, { walkForward })) ?? null;

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
        REJECTION_CODES.OPTIMIZATION_NOT_PROFITABLE,
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
        REJECTION_CODES.VALIDATION_NOT_PROFITABLE,
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
        REJECTION_CODES.INSUFFICIENT_VALIDATION_TRADES,
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
        REJECTION_CODES.OVERFIT_WARNING,
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
        REJECTION_CODES.VALIDATION_RETENTION_BELOW_THRESHOLD,
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
          REJECTION_CODES.LEGACY_OPTIMIZATION_PROFIT_FACTOR_PREFILTER,
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

const strategyWithSelectedRow = (strategy, row) => {
  const candidate = strategyWithCandidate(strategy, row.parameters, null);
  if (row.sessionFilter) {
    candidate.sessionFilter = cloneJson(row.sessionFilter);
  }
  return candidate;
};

const evaluateQuarterlyStability = (engine, strategy, pair, referenceBars, usdJpyReferenceBars, row) => {
  const candidate = strategyWithSelectedRow(strategy, row);
  const quarterlyResults = splitBarsIntoQuarterlySegments(referenceBars).map((segment) => {
    const options = pair.endsWith('JPY')
      ? {}
      : { usdJpyBars: barsWithin(usdJpyReferenceBars, segment) };
    const metrics = engine.scoreBacktestResult(
      engine.runBacktest(segment, candidate, pair, options),
    );
    return {
      // 期間の同定情報: レポート読者が「負けた四半期」と「バー欠落の退化セグメント」を区別できるようにする
      startTime: segment.length > 0 ? segment[0].t : null,
      endTime: segment.length > 0 ? segment[segment.length - 1].t : null,
      barCount: segment.length,
      netProfitYen: metrics.netProfitYen,
      profitFactor: metrics.profitFactor,
      tradeCount: metrics.tradeCount,
    };
  });
  const positiveSegmentCount = positiveQuarterlySegmentCount(quarterlyResults);
  row.quarterlyResults = quarterlyResults;
  row.quarterlyStability = {
    mode: 'selected-parameter-quarterly-stability',
    segmentCount: QUARTERLY_SEGMENT_COUNT,
    positiveSegmentCount,
    requiredPositiveSegmentCount: QUARTERLY_STABILITY_MIN_POSITIVE_SEGMENTS,
    passed: positiveSegmentCount >= QUARTERLY_STABILITY_MIN_POSITIVE_SEGMENTS,
  };
  row.quarterlyChecked = true;
  return row;
};

const loadTargetStrategy = async (target) => {
  if (target.strategy) {
    return cloneJson(target.strategy);
  }
  return readJson(path.join(strategiesRoot, `${target.id}.json`));
};

export const evaluateTarget = async (
  engine,
  target,
  {
    deepHistory = false,
    walkForward = false,
    deepHistoryDirectory = DEEP_HISTORY_DIRECTORY,
    dataDirectory = dataRoot,
  } = {},
) => {
  const strategy = await loadTargetStrategy(target);
  const { pair, timeframe, registeredAt } = strategy.meta;
  const priceBarsResolution = await loadBarsForTuning(pair, timeframe, {
    deepHistory,
    deepHistoryDirectory,
    dataDirectory,
    registeredAt,
    includeProvenance: true,
  });
  const bars = priceBarsResolution.bars;
  const referenceBars = referenceBarsForTuning(
    bars,
    registeredAt,
    deepHistory && priceBarsResolution.source === DATA_SOURCE_DEEP_HISTORY,
  );
  const { optimizationBars, validationBars } = engine.splitOptimizationBars(referenceBars, 0.7);
  const usdJpyBarsResolution = pair.endsWith('JPY')
    ? null
    : await loadBarsForTuning('USDJPY', timeframe, {
        deepHistory,
        deepHistoryDirectory,
        dataDirectory,
        registeredAt,
        preferredSource: priceBarsResolution.source,
        includeProvenance: true,
  });
  const usdJpyReferenceBars = usdJpyBarsResolution
    ? referenceBarsForTuning(
        usdJpyBarsResolution.bars,
        registeredAt,
        deepHistory && usdJpyBarsResolution.source === DATA_SOURCE_DEEP_HISTORY,
      )
    : [];
  const usedFallbackUsdJpyRate = Boolean(
    usdJpyBarsResolution && usdJpyBarsResolution.source !== priceBarsResolution.source,
  );
  const usdJpyReferenceSpanDays = usdJpyBarsResolution
    ? spanDays(usdJpyReferenceBars)
    : null;
  const usdJpyUncoveredReferenceSpanRatio = usedFallbackUsdJpyRate &&
    Number.isFinite(usdJpyReferenceSpanDays)
    ? Math.max(
        0,
        Math.min(
          1,
          (REFERENCE_SPAN_TARGET_DAYS - usdJpyReferenceSpanDays) /
            REFERENCE_SPAN_TARGET_DAYS,
        ),
      )
    : null;
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
  const selectedCandidate = selectEligibleRow(rows);
  if (walkForward && selectedCandidate) {
    evaluateQuarterlyStability(
      engine,
      strategy,
      pair,
      referenceBars,
      usdJpyReferenceBars,
      selectedCandidate,
    );
  }
  const eligible = walkForward
    ? selectedCandidate && isEligible(selectedCandidate, { walkForward })
      ? selectedCandidate
      : null
    : selectedCandidate;
  const result = {
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
    eligible,
    ...(walkForward ? { selectedCandidate } : {}),
  };
  if (!deepHistory) {
    return result;
  }
  const provenanceFor = (resolution) =>
    resolution
      ? {
          source: resolution.source,
          pair: resolution.pair,
          timeframe: resolution.timeframe,
          payloadSource: resolution.payloadSource,
          barsBeforeRegistration: resolution.barsBeforeRegistration,
          coverageBeforeRegistrationDays: resolution.coverageBeforeRegistrationDays,
        }
      : null;
  return {
    ...result,
    dataSource: priceBarsResolution.source,
    usdJpyDataSource: usdJpyBarsResolution?.source ?? null,
    usedFallbackUsdJpyRate,
    usdJpyReferenceSpanDays,
    usdJpyUncoveredReferenceSpanRatio,
    dataProvenance: {
      priceBars: provenanceFor(priceBarsResolution),
      usdJpyBars: provenanceFor(usdJpyBarsResolution),
      usedFallbackUsdJpyRate,
    },
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
        const summary = {
          code: reason.code,
          message: reason.message,
          count: 1,
        };
        if (reason.code === REJECTION_CODES.QUARTERLY_STABILITY_BELOW_THRESHOLD) {
          summary.actual = reason.actual;
          summary.operator = reason.operator;
          summary.threshold = reason.threshold;
        }
        summaries.set(reason.code, summary);
      }
    }
  }
  return [...summaries.values()];
};

const reportCombination = (row, rank, selected) => {
  const rejectionReasons = [
    ...eligibilityRejectionReasons(row),
    ...selectionPoolRejectionReasons(row),
    ...quarterlyStabilityRejectionReasons(row),
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
    ...(row.quarterlyChecked === true ? { quarterlyChecked: true } : {}),
    ...(row.quarterlyResults ? { quarterlyResults: row.quarterlyResults } : {}),
    ...(row.quarterlyStability ? { quarterlyStability: row.quarterlyStability } : {}),
  };
};

const referenceSpanWarnings = (referenceSpanDays) =>
  Number.isFinite(referenceSpanDays) && referenceSpanDays < REFERENCE_SPAN_TARGET_DAYS
    ? [
        {
          code: WARNING_CODES.REFERENCE_SPAN_BELOW_TARGET,
          actual: referenceSpanDays,
          threshold: REFERENCE_SPAN_TARGET_DAYS,
        },
      ]
    : [];

const fallbackCoverageRatio = (result) => {
  const directRatio = result.usdJpyUncoveredReferenceSpanRatio;
  if (Number.isFinite(directRatio)) {
    return Math.max(0, Math.min(1, directRatio));
  }
  const coverageDays =
    result.usdJpyReferenceSpanDays ??
    result.dataProvenance?.usdJpyBars?.coverageBeforeRegistrationDays;
  if (!Number.isFinite(coverageDays)) {
    return null;
  }
  return Math.max(
    0,
    Math.min(1, (REFERENCE_SPAN_TARGET_DAYS - coverageDays) / REFERENCE_SPAN_TARGET_DAYS),
  );
};

const dataSourceWarnings = (result) => {
  if (!result.usedFallbackUsdJpyRate) {
    return [];
  }
  const uncoveredReferenceSpanRatio = fallbackCoverageRatio(result);
  return [
    {
      code: WARNING_CODES.USD_JPY_RATE_SOURCE_FALLBACK,
      expectedSource: result.dataSource ?? null,
      actualSource: result.usdJpyDataSource ?? null,
      uncoveredReferenceSpanRatio,
      message: `USDJPYソースが参照窓をカバーしない割合(日数比): ${
        Number.isFinite(uncoveredReferenceSpanRatio)
          ? uncoveredReferenceSpanRatio.toFixed(6)
          : '不明'
      }`,
    },
  ];
};

const candidateWarnings = (result) => [
  ...referenceSpanWarnings(result.referenceSpanDays),
  ...dataSourceWarnings(result),
];

const reportProvenance = (result) =>
  result.dataProvenance
    ? {
        dataSource: result.dataSource ?? null,
        usdJpyDataSource: result.usdJpyDataSource ?? null,
        usedFallbackUsdJpyRate: Boolean(result.usedFallbackUsdJpyRate),
        priceBars: result.dataProvenance.priceBars ?? null,
        usdJpyBars: result.dataProvenance.usdJpyBars ?? null,
      }
    : null;

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
  const provenance = reportProvenance(result);
  if (hasEvaluationError(result)) {
    return {
      id: result.strategy.meta.id,
      pair: result.pair,
      entryType: result.entryType,
      timeframe: result.timeframe,
      status: 'rejected',
      dataWindow: reportDataWindow(result),
      warnings: candidateWarnings(result),
      ...(provenance ? { provenance } : {}),
      selectedCandidate: null,
      rejectionReasons: [
        {
          code: REJECTION_CODES.EVALUATION_ERROR,
          message: evaluationErrorMessage(result.evaluationError),
          count: 1,
        },
      ],
      combinations: [],
    };
  }

  const rows = result.evaluatedRows ?? rankRows(result.rows);
  // A quarterly-demoted row remains available in combinations for audit, but it
  // is not a selected row. This prevents the rejected row from looking adopted
  // and keeps the next row from being promoted implicitly.
  const selectedRow = result.eligible;
  const combinations = rows.map((row, index) =>
    reportCombination(row, index + 1, row === selectedRow),
  );
  const selectedCandidate = combinations.find((combination) => combination.selected) ?? null;
  const rejectionReasons = result.eligible ? [] : summarizeRejectionReasons(combinations);
  const warnings = candidateWarnings(result);
  if (!result.eligible && rejectionReasons.length === 0) {
    rejectionReasons.push({
      code: REJECTION_CODES.NO_EVALUATED_COMBINATIONS,
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
    ...(provenance ? { provenance } : {}),
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
  const usdJpyFallbackRatios = candidates
    .flatMap((candidate) => candidate.warnings)
    .filter((warning) => warning.code === WARNING_CODES.USD_JPY_RATE_SOURCE_FALLBACK)
    .map((warning) => warning.uncoveredReferenceSpanRatio)
    .filter(Number.isFinite);
  const usdJpyFallbackRatioSum = usdJpyFallbackRatios.reduce(
    (sum, ratio) => sum + ratio,
    0,
  );
  const usdJpyFallbackRatioAverage = usdJpyFallbackRatios.length
    ? usdJpyFallbackRatioSum / usdJpyFallbackRatios.length
    : null;
  const usdJpyFallbackRatioMax = usdJpyFallbackRatios.length
    ? Math.max(...usdJpyFallbackRatios)
    : null;
  const combinationCount = candidates.reduce(
    (count, candidate) => count + candidate.combinations.length,
    0,
  );
  const passedCombinationCount = candidates.reduce(
    (count, candidate) =>
      count + candidate.combinations.filter((combination) => combination.status === 'passed').length,
    0,
  );
  const deepHistoryRequested = filters.deepHistory === true;
  return jsonSafeValue({
    schemaVersion: TUNING_REPORT_SCHEMA_VERSION,
    generatedAt:
      generatedAt instanceof Date ? generatedAt.toISOString() : new Date(generatedAt).toISOString(),
    selectionPolicy: SELECTION_POLICY,
    filters: {
      pairs: [...(filters.pairs ?? [])],
      entryTypes: [...(filters.entryTypes ?? [])],
      timeframes: [...(filters.timeframes ?? [])],
      ...(deepHistoryRequested ? { deepHistory: true } : {}),
      ...(filters.sessionVariants ? { sessionVariants: true } : {}),
      ...(filters.walkForward ? { walkForward: true } : {}),
    },
    ...(deepHistoryRequested ? { provenance: { deepHistory: true } } : {}),
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
        candidate.warnings.some(
          (warning) => warning.code === WARNING_CODES.REFERENCE_SPAN_BELOW_TARGET,
        ),
      ).length,
      combinationCount,
      passedCombinationCount,
      rejectedCombinationCount: combinationCount - passedCombinationCount,
      ...(deepHistoryRequested
        ? {
            usedFallbackUsdJpyRateCount: candidates.filter(
              (candidate) => candidate.provenance?.usedFallbackUsdJpyRate,
            ).length,
            usdJpyFallbackUncoveredReferenceSpanRatioSum: usdJpyFallbackRatioSum,
            usdJpyFallbackUncoveredReferenceSpanRatioAverage: usdJpyFallbackRatioAverage,
            usdJpyFallbackUncoveredReferenceSpanRatioMax: usdJpyFallbackRatioMax,
          }
        : {}),
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

export const printTargetResult = (result) => {
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
  const quarterlyResults = result.selectedCandidate?.quarterlyResults;
  if (Array.isArray(quarterlyResults)) {
    console.log(`四半期: ${quarterlySummary(quarterlyResults)}`);
  }
  if (result.eligible) {
    console.log(`採用候補: ${combinationLabel(result.eligible)}`);
  } else if (Array.isArray(quarterlyResults)) {
    const positiveQuarters = quarterlyResults.filter((quarter) => quarter.netProfitYen > 0).length;
    console.log(`採用候補: 該当なし(四半期安定性 ${positiveQuarters}/${quarterlyResults.length} で降格)`);
  } else {
    console.log('採用候補: 該当なし');
  }
};

export const main = async ({
  args = process.argv.slice(2),
  reportDirectory = reportsRoot,
  deepHistoryDirectory = DEEP_HISTORY_DIRECTORY,
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
  const candidates = filters.sessionVariants
    ? candidateTargets.map((target) => ({ ...target, sessionVariants: SESSION_VARIANTS }))
    : candidateTargets;
  const selectedTargets = filterTargets(candidates, filters);
  if (selectedTargets.length === 0) {
    throw new Error('指定されたフィルターに一致するチューニング候補がありません。');
  }

  log(`チューニング候補: ${selectedTargets.length}/${candidateTargets.length}件`);
  if (filters.deepHistory) {
    log(
      `深履歴キャッシュ: ${path.relative(projectRoot, deepHistoryDirectory)} ` +
        '(登録日前coverageが広いソースを候補ごとに選択)',
    );
  }
  const engine = await loadEngine();
  try {
    const results = [];
    for (const target of selectedTargets) {
      let result;
      try {
        if (filters.deepHistory || filters.walkForward) {
          result = await evaluate(engine, target, {
            ...(filters.deepHistory
              ? {
                  deepHistory: true,
                  deepHistoryDirectory,
                }
              : {}),
            ...(filters.walkForward ? { walkForward: true } : {}),
          });
        } else {
          result = await evaluate(engine, target);
        }
      } catch (error) {
        result = {
          strategy: target.strategy,
          pair: target.strategy.meta.pair,
          entryType: target.entryType,
          timeframe: target.strategy.meta.timeframe,
          evaluationError: evaluationErrorMessage(error),
          ...(filters.deepHistory
            ? {
                dataSource: null,
                usdJpyDataSource: null,
                usedFallbackUsdJpyRate: false,
                dataProvenance: {
                  priceBars: null,
                  usdJpyBars: null,
                  usedFallbackUsdJpyRate: false,
                },
              }
            : {}),
        };
      }
      results.push(result);
      if (filters.deepHistory) {
        const usdJpySource = result.usdJpyDataSource ?? 'not-required/unresolved';
        const fallback = result.usedFallbackUsdJpyRate ? ' (fallback)' : '';
        log(
          `data source ${target.id}: price=${result.dataSource ?? 'unresolved'}, ` +
            `USDJPY=${usdJpySource}${fallback}`,
        );
      }
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
