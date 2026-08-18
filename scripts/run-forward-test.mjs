import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEsbuild } from './lib/esbuild-loader.mjs';
import {
  assertRetiredLedger,
  readRetiredLedger as readRetiredLedgerFile,
  retiredEntryRegisteredAt,
} from './lib/retired-ledger.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const dataRoot = path.join(projectRoot, 'public/data');
const strategiesRoot = path.join(projectRoot, 'strategies/virtual');
const outputPath = path.join(dataRoot, 'forward/results.json');
const historyPath = path.join(dataRoot, 'forward/history.json');
const retiredLedgerPath = path.join(dataRoot, 'forward/retired.json');
const retirementEnginePath = path.join(projectRoot, 'src/lib/forwardRetirement.ts');
export const knownEntryConditionTypes = new Set([
  'maCross',
  'rsi',
  'bollinger',
  'macdCross',
  'ichimokuCross',
  'donchianBreak',
  'stochastic',
  'keltnerBreak',
  'cciBreak',
]);

export const TWO_YEARS_SECONDS = 365 * 2 * 24 * 60 * 60;
export const FORWARD_HISTORY_SCHEMA_VERSION = 1;
export const FORWARD_RESULTS_SCHEMA_VERSION = 3;
export const VIRTUAL_PAIRS = ['USDJPY', 'EURUSD', 'GBPJPY', 'EURJPY', 'AUDJPY', 'GBPUSD'];
export const VIRTUAL_TIMEFRAMES = ['m15', 'm30', 'h1', 'h4', 'd1'];

const UTC_DAY_SECONDS = 24 * 60 * 60;

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));

let forwardRetirementEvaluatorPromise;

/**
 * Bundle the shared TypeScript policy so future relative imports resolve while
 * this .mjs runner remains executable on the Node 20 production workflow.
 */
export const loadForwardRetirementEvaluator = async () => {
  if (!forwardRetirementEvaluatorPromise) {
    forwardRetirementEvaluatorPromise = (async () => {
      const esbuild = loadEsbuild();
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fx-forward-retirement-'));
      const outfile = path.join(tempDir, 'forward-retirement-bundle.mjs');
      try {
        await esbuild.build({
          entryPoints: [retirementEnginePath],
          bundle: true,
          platform: 'node',
          format: 'esm',
          target: 'node20',
          outfile,
          logLevel: 'silent',
        });
        const module = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
        if (typeof module.evaluateForwardRetirement !== 'function') {
          throw new Error('Forward retirement engine does not export evaluateForwardRetirement');
        }
        return module.evaluateForwardRetirement;
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    })().catch((error) => {
      forwardRetirementEvaluatorPromise = undefined;
      throw error;
    });
  }
  return forwardRetirementEvaluatorPromise;
};

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const positiveFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const positiveInteger = (value) => Number.isInteger(value) && value > 0;

const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;

const nonEmptyString = (value) => typeof value === 'string' && value.length > 0;

const movingAverageTypes = new Set(['sma', 'ema']);
const rsiComparisons = new Set(['below', 'above', 'crossBelow', 'crossAbove']);
const bollingerModes = new Set(['touch', 'break']);
const bollingerBands = new Set(['lower', 'upper']);

const assertConditionField = (conditionContext, condition, field, predicate, expectation) => {
  if (!predicate(condition[field])) {
    throw new Error(`${conditionContext}.${field} ${expectation}`);
  }
};

const assertConditionEnum = (conditionContext, condition, field, values) => {
  assertConditionField(
    conditionContext,
    condition,
    field,
    (value) => values.has(value),
    `must be one of ${[...values].join(', ')}`,
  );
};

const assertPositiveIntegerField = (conditionContext, condition, field) => {
  // normalizePeriod() rounds decimals, but the pipeline is intentionally stricter for data hygiene.
  assertConditionField(
    conditionContext,
    condition,
    field,
    positiveInteger,
    'must be a positive integer',
  );
};

const assertPositiveIntegerFieldAtLeast = (conditionContext, condition, field, minimum) => {
  assertConditionField(
    conditionContext,
    condition,
    field,
    (value) => positiveInteger(value) && value >= minimum,
    `must be a positive integer greater than or equal to ${minimum}`,
  );
};

const assertPositiveFiniteNumberField = (conditionContext, condition, field) => {
  assertConditionField(
    conditionContext,
    condition,
    field,
    positiveFiniteNumber,
    'must be a positive finite number',
  );
};

const assertThresholdField = (conditionContext, condition, field, upperBound) => {
  assertConditionField(
    conditionContext,
    condition,
    field,
    (value) => finiteNumber(value) && value > 0 && value < upperBound,
    `must be a finite number greater than 0 and less than ${upperBound}`,
  );
};

const assertEntryCondition = (condition, context, index) => {
  const conditionContext = `${context}: entryConditions[${index}]`;

  switch (condition.type) {
    case 'maCross':
      assertConditionEnum(conditionContext, condition, 'fastType', movingAverageTypes);
      assertPositiveIntegerField(conditionContext, condition, 'fastPeriod');
      assertConditionEnum(conditionContext, condition, 'slowType', movingAverageTypes);
      assertPositiveIntegerField(conditionContext, condition, 'slowPeriod');
      // fast>slow は評価器上は動作するが、EAビルダーの正当性契約(fast<slow)に合わせ製品判断として拒否する
      if (condition.fastPeriod >= condition.slowPeriod) {
        throw new Error(
          `${conditionContext}.fastPeriod must be smaller than slowPeriod`,
        );
      }
      break;
    case 'rsi':
      // RSI period 1 degenerates to 0/100; two samples are the minimum useful window.
      assertPositiveIntegerFieldAtLeast(conditionContext, condition, 'period', 2);
      assertThresholdField(conditionContext, condition, 'threshold', 100);
      assertConditionEnum(conditionContext, condition, 'comparison', rsiComparisons);
      break;
    case 'bollinger':
      // Standard deviation needs at least two samples; any finite positive multiplier is valid, with no arbitrary lower bound.
      assertPositiveIntegerFieldAtLeast(conditionContext, condition, 'period', 2);
      assertPositiveFiniteNumberField(conditionContext, condition, 'multiplier');
      assertConditionEnum(conditionContext, condition, 'mode', bollingerModes);
      assertConditionEnum(conditionContext, condition, 'band', bollingerBands);
      break;
    case 'macdCross':
      assertPositiveIntegerField(conditionContext, condition, 'fastPeriod');
      assertPositiveIntegerField(conditionContext, condition, 'slowPeriod');
      assertPositiveIntegerField(conditionContext, condition, 'signalPeriod');
      if (condition.fastPeriod >= condition.slowPeriod) {
        throw new Error(
          `${conditionContext}.fastPeriod must be smaller than slowPeriod`,
        );
      }
      break;
    case 'ichimokuCross':
      assertPositiveIntegerField(conditionContext, condition, 'conversionPeriod');
      assertPositiveIntegerField(conditionContext, condition, 'basePeriod');
      assertPositiveIntegerField(conditionContext, condition, 'spanBPeriod');
      assertPositiveIntegerField(conditionContext, condition, 'displacement');
      assertConditionField(
        conditionContext,
        condition,
        'requireCloudFilter',
        (value) => typeof value === 'boolean',
        'must be a boolean',
      );
      break;
    case 'donchianBreak':
      assertPositiveIntegerField(conditionContext, condition, 'period');
      break;
    case 'stochastic':
      assertPositiveIntegerField(conditionContext, condition, 'kPeriod');
      assertPositiveIntegerField(conditionContext, condition, 'dPeriod');
      assertPositiveIntegerField(conditionContext, condition, 'smoothing');
      assertThresholdField(conditionContext, condition, 'threshold', 100);
      assertConditionEnum(conditionContext, condition, 'comparison', rsiComparisons);
      break;
    case 'keltnerBreak':
      assertPositiveIntegerField(conditionContext, condition, 'emaPeriod');
      assertPositiveIntegerField(conditionContext, condition, 'atrPeriod');
      assertPositiveFiniteNumberField(conditionContext, condition, 'multiplier');
      break;
    case 'cciBreak':
      // period 1 では平均絶対偏差が常に0となりCCIが定数0に退化(level>0では永久に発火しない)
      assertPositiveIntegerFieldAtLeast(conditionContext, condition, 'period', 2);
      assertPositiveFiniteNumberField(conditionContext, condition, 'level');
      break;
    default:
      throw new Error(`${conditionContext}.type ${condition.type} has no parameter validation`);
  }
};

const strategyContext = (filename, strategyId) =>
  filename === strategyId ? strategyId : `${filename} (${strategyId})`;

// selectionEvidence のフィールドを追加・変更するときは、src/lib/forward-test.ts のパーサと
// scripts/run-forward-test.test.mjs / src/lib/forward-test.test.ts の両テストも同時に更新する。
export const assertSelectionEvidence = (value, context = 'selectionEvidence') => {
  if (!isObject(value)) {
    throw new Error(`${context} must be an object`);
  }
  if (typeof value.adoptedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.adoptedAt)) {
    throw new Error(`${context}.adoptedAt must be a YYYY-MM-DD date`);
  }
  if (!nonEmptyString(value.reportId)) {
    throw new Error(`${context}.reportId must be a non-empty string`);
  }
  if (Object.hasOwn(value, 'reportLabel') && !nonEmptyString(value.reportLabel)) {
    throw new Error(`${context}.reportLabel must be a non-empty string`);
  }
  if (!positiveInteger(value.candidatePool)) {
    throw new Error(`${context}.candidatePool must be a positive integer`);
  }
  if (
    Object.hasOwn(value, 'passedCount')
    && (!nonNegativeInteger(value.passedCount) || value.passedCount > value.candidatePool)
  ) {
    throw new Error(`${context}.passedCount must be a non-negative integer not greater than candidatePool`);
  }

  const hasInSampleRank = Object.hasOwn(value, 'inSampleRank');
  const hasRankNote = Object.hasOwn(value, 'rankNote');
  if (!hasInSampleRank && !hasRankNote) {
    throw new Error(`${context} must contain inSampleRank or rankNote`);
  }
  if (hasInSampleRank && !positiveInteger(value.inSampleRank)) {
    throw new Error(`${context}.inSampleRank must be a positive integer`);
  }
  // 順位は合格候補内で付くので、合格件数を超える順位は矛盾。
  if (
    hasInSampleRank
    && Object.hasOwn(value, 'passedCount')
    && positiveInteger(value.inSampleRank)
    && nonNegativeInteger(value.passedCount)
    && value.inSampleRank > value.passedCount
  ) {
    throw new Error(`${context}.inSampleRank cannot exceed passedCount`);
  }
  if (hasRankNote && !nonEmptyString(value.rankNote)) {
    throw new Error(`${context}.rankNote must be a non-empty string`);
  }

  if (!isObject(value.optimization)) {
    throw new Error(`${context}.optimization must be an object`);
  }
  if (!finiteNumber(value.optimization.netProfitYen)) {
    throw new Error(`${context}.optimization.netProfitYen must be a finite number`);
  }
  if (!finiteNumber(value.optimization.profitFactor)) {
    throw new Error(`${context}.optimization.profitFactor must be a finite number`);
  }
  if (!nonNegativeInteger(value.optimization.tradeCount)) {
    throw new Error(`${context}.optimization.tradeCount must be a non-negative integer`);
  }

  if (!isObject(value.validation)) {
    throw new Error(`${context}.validation must be an object`);
  }
  if (!finiteNumber(value.validation.netProfitYen)) {
    throw new Error(`${context}.validation.netProfitYen must be a finite number`);
  }
  if (!finiteNumber(value.validation.profitFactor)) {
    throw new Error(`${context}.validation.profitFactor must be a finite number`);
  }

  if (!Object.hasOwn(value, 'quarterlyStability')) {
    throw new Error(`${context}.quarterlyStability must be an object or null`);
  }
  if (value.quarterlyStability !== null) {
    if (!isObject(value.quarterlyStability)) {
      throw new Error(`${context}.quarterlyStability must be an object or null`);
    }
    if (!nonNegativeInteger(value.quarterlyStability.positive)) {
      throw new Error(`${context}.quarterlyStability.positive must be a non-negative integer`);
    }
    if (!positiveInteger(value.quarterlyStability.total)) {
      throw new Error(`${context}.quarterlyStability.total must be a positive integer`);
    }
    if (value.quarterlyStability.positive > value.quarterlyStability.total) {
      throw new Error(`${context}.quarterlyStability.positive cannot exceed total`);
    }
  }

  if (!Array.isArray(value.reservations) || !value.reservations.every((item) => typeof item === 'string')) {
    throw new Error(`${context}.reservations must be an array of strings`);
  }
};

const assertVirtualStrategy = (strategy, filename = 'strategy') => {
  if (!isObject(strategy) || !isObject(strategy.meta)) {
    throw new Error(`${filename}: meta is required`);
  }
  const { meta } = strategy;
  if (typeof meta.id !== 'string' || meta.id.length === 0) {
    throw new Error(`${filename}: meta.id is required`);
  }
  const context = strategyContext(filename, meta.id);
  if (typeof meta.name !== 'string' || meta.name.length === 0) {
    throw new Error(`${context}: meta.name is required`);
  }
  if (meta.version !== 1) {
    throw new Error(`${context}: meta.version must be 1`);
  }
  if (!VIRTUAL_PAIRS.includes(meta.pair)) {
    throw new Error(`${context}: unsupported pair ${meta.pair}`);
  }
  if (!VIRTUAL_TIMEFRAMES.includes(meta.timeframe)) {
    throw new Error(`${context}: unsupported timeframe ${meta.timeframe}`);
  }
  if (!Number.isInteger(meta.registeredAt) || meta.registeredAt <= 0) {
    throw new Error(`${context}: meta.registeredAt must be a unix timestamp`);
  }
  if (strategy.id !== meta.id || strategy.name !== meta.name) {
    throw new Error(`${context}: strategy id/name must match meta id/name`);
  }
  if (Object.hasOwn(strategy, 'selectionEvidence')) {
    assertSelectionEvidence(strategy.selectionEvidence, `${context}: selectionEvidence`);
  }
  if (!isObject(strategy.exit)) {
    throw new Error(`${context}: exit is required`);
  }
  for (const field of ['stopLossPips', 'takeProfitPips']) {
    if (!positiveFiniteNumber(strategy.exit[field])) {
      throw new Error(`${context}: exit.${field} must be a positive finite number`);
    }
  }
  if (!Array.isArray(strategy.entryConditions) || strategy.entryConditions.length === 0) {
    throw new Error(`${context}: entryConditions must be a non-empty array`);
  }
  for (const [index, condition] of strategy.entryConditions.entries()) {
    if (!isObject(condition)) {
      throw new Error(`${context}: entryConditions[${index}] must be an object`);
    }
    if (!knownEntryConditionTypes.has(condition.type)) {
      throw new Error(
        `${context}: entryConditions[${index}].type must be one of ${[...knownEntryConditionTypes].join(', ')}`,
      );
    }
    assertEntryCondition(condition, context, index);
  }
};

export const splitBarsByRegistration = (bars, registeredAt) => {
  const referenceStart = registeredAt - TWO_YEARS_SECONDS;
  return {
    forwardBars: bars.filter((bar) => bar.t >= registeredAt),
    referenceBars: bars.filter((bar) => bar.t < registeredAt && bar.t >= referenceStart),
  };
};

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

const roundPips = (value) => Math.round(value * 10) / 10;

export const roundYen = (value) => Math.round(value);

export const utcDateKey = (timestamp) => new Date(timestamp * 1000).toISOString().slice(0, 10);

const utcDayStart = (timestamp) => Math.floor(timestamp / UTC_DAY_SECONDS) * UTC_DAY_SECONDS;

const utcDayEnd = (dayStart) => dayStart + UTC_DAY_SECONDS - 1;

const sumBy = (items, selector) => items.reduce((sum, item) => sum + selector(item), 0);

const sortedObject = (object) => Object.fromEntries(
  Object.entries(object).sort(([left], [right]) => left.localeCompare(right)),
);

const cloneJson = (value) => JSON.parse(JSON.stringify(value));

const canonicalize = (value) => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

export const fingerprintStrategyDefinition = (strategy) => createHash('sha256')
  .update(JSON.stringify(canonicalize({
    pair: strategy.meta.pair,
    timeframe: strategy.meta.timeframe,
    registeredAt: strategy.meta.registeredAt,
    direction: strategy.direction,
    entryDirections: strategy.entryDirections,
    entryConditions: strategy.entryConditions,
    exit: strategy.exit,
    sessionFilter: strategy.sessionFilter,
    newsFilter: strategy.newsFilter,
    lotSize: strategy.lotSize,
    moneyManagement: strategy.moneyManagement,
  })))
  .digest('hex');

export const readRetiredLedger = async (filePath = retiredLedgerPath) =>
  readRetiredLedgerFile(filePath);

export const assertNoRetiredStrategyConflicts = (strategies, retiredLedger) => {
  assertRetiredLedger(retiredLedger);
  const activeById = new Map(
    strategies.map((strategy) => [strategy.meta.id, strategy.meta.registeredAt]),
  );
  const conflicts = Object.entries(retiredLedger.strategies)
    .filter(([ledgerKey, entry]) => {
      const activeRegisteredAt = activeById.get(entry.strategyId);
      if (activeRegisteredAt === undefined) {
        return false;
      }
      const retiredRegisteredAt = retiredEntryRegisteredAt(ledgerKey, entry);
      return retiredRegisteredAt === null || retiredRegisteredAt === activeRegisteredAt;
    })
    .map(([ledgerKey, entry]) => {
      const registeredAt = retiredEntryRegisteredAt(ledgerKey, entry);
      return registeredAt === null
        ? `${entry.strategyId} (legacy ledger key ${ledgerKey})`
        : `${entry.strategyId}@${registeredAt}`;
    })
    .sort();

  if (conflicts.length > 0) {
    throw new Error(
      'Forward-test configuration contradiction: strategies/virtual contains '
      + `retired strategy generation(s) ${conflicts.join(', ')} already recorded in `
      + 'public/data/forward/retired.json. Remove the duplicate active definition or '
      + 'correct the retirement ledger before running the forward test.',
    );
  }
};

const assertHistoryGenerationTransitionsAreRetired = (
  strategies,
  existingHistory,
  retiredLedger,
) => {
  for (const strategy of strategies) {
    const strategyId = strategy.meta.id;
    if (!Object.hasOwn(existingHistory.strategies, strategyId)) {
      continue;
    }
    const previousRegisteredAt = existingHistory.strategies[strategyId].meta.registeredAt;
    if (previousRegisteredAt === strategy.meta.registeredAt) {
      continue;
    }
    const previousGenerationWasRetired = Object.entries(retiredLedger.strategies)
      .some(([ledgerKey, entry]) =>
        entry.strategyId === strategyId
        && retiredEntryRegisteredAt(ledgerKey, entry) === previousRegisteredAt);
    if (!previousGenerationWasRetired) {
      throw new Error(
        `${strategyId}: existing forward history belongs to generation `
        + `${strategyId}@${previousRegisteredAt}, but that generation is not recorded in `
        + 'public/data/forward/retired.json. Refusing to replace confirmed history for '
        + `the re-registered generation ${strategyId}@${strategy.meta.registeredAt}.`,
      );
    }
  }
};

export const createEmptyForwardHistory = () => ({
  schemaVersion: FORWARD_HISTORY_SCHEMA_VERSION,
  strategies: {},
});

const assertForwardHistory = (history, context = 'forward history') => {
  if (!isObject(history)) {
    throw new Error(`${context}: root must be an object`);
  }
  if (history.schemaVersion !== FORWARD_HISTORY_SCHEMA_VERSION) {
    throw new Error(
      `${context}: schemaVersion must be ${FORWARD_HISTORY_SCHEMA_VERSION}`,
    );
  }
  if (!isObject(history.strategies)) {
    throw new Error(`${context}: strategies must be an object`);
  }
  for (const [strategyId, strategyHistory] of Object.entries(history.strategies)) {
    if (!isObject(strategyHistory) || !isObject(strategyHistory.meta)) {
      throw new Error(`${context}: strategies.${strategyId} must contain meta`);
    }
    if (strategyHistory.meta.id !== strategyId) {
      throw new Error(`${context}: strategies.${strategyId}.meta.id must match its key`);
    }
    if (!isObject(strategyHistory.days)) {
      throw new Error(`${context}: strategies.${strategyId}.days must be an object`);
    }
  }
};

const assertForwardHistoryIntegrity = (history, context = 'forward history') => {
  assertForwardHistory(history, context);
  for (const [strategyId, strategyHistory] of Object.entries(history.strategies)) {
    if (!positiveFiniteNumber(strategyHistory.initialBalanceYen)) {
      throw new Error(`${context}: strategies.${strategyId}.initialBalanceYen must be positive`);
    }
    if (!Number.isFinite(strategyHistory.spreadPips) || strategyHistory.spreadPips < 0) {
      throw new Error(`${context}: strategies.${strategyId}.spreadPips must be finite`);
    }
    if (
      strategyHistory.strategyFingerprint !== undefined
      && !/^[a-f0-9]{64}$/.test(strategyHistory.strategyFingerprint)
    ) {
      throw new Error(`${context}: strategies.${strategyId}.strategyFingerprint is invalid`);
    }
    for (const [date, day] of Object.entries(strategyHistory.days)) {
      const dayContext = `${context}: strategies.${strategyId}.days.${date}`;
      const parsedDate = Date.parse(`${date}T00:00:00Z`) / 1000;
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !Number.isFinite(parsedDate)
        || utcDateKey(parsedDate) !== date
      ) {
        throw new Error(`${dayContext}: key must be a valid UTC date`);
      }
      if (!isObject(day) || !isObject(day.pnl) || !Array.isArray(day.trades)) {
        throw new Error(`${dayContext}: pnl and trades are required`);
      }
      if (
        typeof day.recordedAt !== 'string'
        || !Number.isFinite(Date.parse(day.recordedAt))
        || !Number.isInteger(day.barsEvaluated)
        || day.barsEvaluated < 0
        || (day.firstBarAt !== null && !Number.isInteger(day.firstBarAt))
        || (day.lastBarAt !== null && !Number.isInteger(day.lastBarAt))
      ) {
        throw new Error(`${dayContext}: recording and bar coverage are invalid`);
      }
      if (!Number.isFinite(day.pnl.netPips) || !Number.isFinite(day.pnl.netProfitYen)) {
        throw new Error(`${dayContext}: pnl values must be finite`);
      }
      for (const trade of day.trades) {
        if (
          !isObject(trade)
          || !Number.isFinite(trade.netPips)
          || !Number.isFinite(trade.netProfitYen)
          || !Number.isInteger(trade.exitTime)
        ) {
          throw new Error(`${dayContext}: trade values must be finite`);
        }
        if (trade.exitReason === 'end' || utcDateKey(trade.exitTime) !== date) {
          throw new Error(`${dayContext}: trades must be final exits within their UTC date`);
        }
      }
      const expectedPips = roundPips(sumBy(day.trades, (trade) => trade.netPips));
      const expectedYen = roundYen(sumBy(day.trades, (trade) => trade.netProfitYen));
      if (day.pnl.netPips !== expectedPips || day.pnl.netProfitYen !== expectedYen) {
        throw new Error(`${dayContext}: pnl must equal the sum of its trades`);
      }
      if (
        day.equity !== null
        && (
          !isObject(day.equity)
          || ![
            'asOf',
            'unrealizedPips',
            'unrealizedProfitYen',
            'maxDrawdownPips',
            'maxDrawdownYen',
            'maxDrawdownPct',
          ].every((field) => Number.isFinite(day.equity[field]))
        )
      ) {
        throw new Error(`${dayContext}: equity values must be finite`);
      }
    }
  }
};

const createMonthlyMetrics = () => ({
  netProfitYen: 0,
  netPips: 0,
  tradeCount: 0,
});

const hasRetiredGeneration = (retiredLedger, strategyHistory) => Object.entries(
  retiredLedger.strategies,
).some(([ledgerKey, entry]) =>
  entry.strategyId === strategyHistory.meta.id
    && retiredEntryRegisteredAt(ledgerKey, entry) === strategyHistory.meta.registeredAt,
);

/**
 * Aggregate immutable confirmed daily history by UTC calendar month.
 * The input days are already final; this function intentionally only sums the
 * persisted daily P/L and trade counts and never recalculates trades.
 */
export const buildMonthlySummary = ({
  history,
  activeStrategyIds = [],
  retiredLedger = { schemaVersion: 1, strategies: {} },
  computedAt = new Date().toISOString(),
}) => {
  assertForwardHistory(history, 'forward history for monthly summary');
  assertRetiredLedger(retiredLedger, 'retired ledger for monthly summary');

  const computedDate = new Date(computedAt);
  if (!Number.isFinite(computedDate.getTime())) {
    throw new Error('monthly summary computedAt must be a valid date');
  }
  const currentUtcMonth = computedDate.toISOString().slice(0, 7);
  const activeIds = new Set(activeStrategyIds);
  const monthAggregates = new Map();

  for (const [strategyId, strategyHistory] of Object.entries(history.strategies)) {
    const isActive = activeIds.has(strategyId);
    const retired = !isActive;
    if (retired && !hasRetiredGeneration(retiredLedger, strategyHistory)) {
      throw new Error(
        `Forward history integrity error: ${strategyId}@${strategyHistory.meta.registeredAt} `
        + 'is not present in strategies/virtual and is not recorded in '
        + 'public/data/forward/retired.json.',
      );
    }

    for (const [date, day] of Object.entries(strategyHistory.days)) {
      const month = date.slice(0, 7);
      if (!monthAggregates.has(month)) {
        monthAggregates.set(month, {
          total: createMonthlyMetrics(),
          confirmedDates: new Set(),
          strategies: new Map(),
        });
      }
      const monthAggregate = monthAggregates.get(month);
      monthAggregate.confirmedDates.add(date);

      if (!monthAggregate.strategies.has(strategyId)) {
        monthAggregate.strategies.set(strategyId, {
          id: strategyId,
          name: strategyHistory.meta.name,
          ...createMonthlyMetrics(),
          confirmedDays: 0,
          retired,
        });
      }
      const strategyAggregate = monthAggregate.strategies.get(strategyId);
      const tradeCount = day.trades.length;
      strategyAggregate.netProfitYen += day.pnl.netProfitYen;
      strategyAggregate.netPips += day.pnl.netPips;
      strategyAggregate.tradeCount += tradeCount;
      strategyAggregate.confirmedDays += 1;
      monthAggregate.total.netProfitYen += day.pnl.netProfitYen;
      monthAggregate.total.netPips += day.pnl.netPips;
      monthAggregate.total.tradeCount += tradeCount;
    }
  }

  // 「確定」は暦月が過ぎただけでは足りない: 日次確定は最新バー日の前日までしか
  // 進まないため、翌月頭が週末だと前月の最終営業日が未確定のまま残る。
  // 後続月に確定日次が1日でもあれば、その月の確定はもう増えない=閉じたと言い切れる。
  const monthsWithConfirmedDays = [...monthAggregates.entries()]
    .filter(([, aggregate]) => aggregate.confirmedDates.size > 0)
    .map(([month]) => month);
  const hasLaterConfirmedMonth = (month) =>
    monthsWithConfirmedDays.some((candidate) => candidate > month);

  return {
    months: [...monthAggregates.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([month, aggregate]) => ({
        month,
        total: {
          netProfitYen: roundYen(aggregate.total.netProfitYen),
          netPips: roundPips(aggregate.total.netPips),
          tradeCount: aggregate.total.tradeCount,
        },
        strategies: [...aggregate.strategies.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((strategy) => ({
            ...strategy,
            netProfitYen: roundYen(strategy.netProfitYen),
            netPips: roundPips(strategy.netPips),
          })),
        confirmedDays: aggregate.confirmedDates.size,
        complete: month < currentUtcMonth && hasLaterConfirmedMonth(month),
      })),
  };
};

/**
 * Merge a recalculated candidate ledger into the persisted ledger. Existing
 * strategy/day entries always win: once a UTC day is confirmed, later market
 * data or backtest changes cannot silently rewrite that result.
 *
 * The single exception is a rules change. When a registered strategy's rules are
 * re-selected without minting a new id (e.g. parameter re-tuning), its stored
 * fingerprint stops matching the candidate. Forward performance earned under the
 * old rules must not be claimed for the new rules, so that strategy's confirmed
 * history is discarded and rebaselined from the current rules. Every rebaseline
 * is reported through `onRebaseline` so the caller can log it instead of failing.
 * A new registeredAt is handled the same way after buildForwardArtifacts has
 * verified that the prior generation has an immutable retirement-ledger record.
 */
export const mergeForwardHistory = (
  existingHistory,
  candidateHistory,
  { onRebaseline } = {},
) => {
  const existing = existingHistory ?? createEmptyForwardHistory();
  assertForwardHistory(existing, 'existing forward history');
  assertForwardHistory(candidateHistory, 'candidate forward history');

  const merged = cloneJson(existing);
  for (const [strategyId, candidateStrategy] of Object.entries(candidateHistory.strategies)) {
    const currentStrategy = Object.hasOwn(merged.strategies, strategyId)
      ? merged.strategies[strategyId]
      : undefined;
    if (!currentStrategy) {
      merged.strategies[strategyId] = cloneJson({
        ...candidateStrategy,
        days: sortedObject(candidateStrategy.days),
      });
      continue;
    }

    const generationChanged =
      currentStrategy.meta.registeredAt !== candidateStrategy.meta.registeredAt;
    if (generationChanged) {
      onRebaseline?.({
        strategyId,
        previousFingerprint: currentStrategy.strategyFingerprint ?? 'unknown',
        nextFingerprint: candidateStrategy.strategyFingerprint ?? 'unknown',
        discardedDayCount: Object.keys(currentStrategy.days).length,
      });
      merged.strategies[strategyId] = cloneJson({
        ...candidateStrategy,
        days: sortedObject(candidateStrategy.days),
      });
      continue;
    }

    for (const field of ['id', 'version', 'pair', 'timeframe', 'registeredAt']) {
      if (currentStrategy.meta[field] !== candidateStrategy.meta[field]) {
        throw new Error(`${strategyId}: history meta.${field} does not match the current strategy`);
      }
    }

    const rulesChanged = Boolean(
      currentStrategy.strategyFingerprint
      && candidateStrategy.strategyFingerprint
      && currentStrategy.strategyFingerprint !== candidateStrategy.strategyFingerprint,
    );
    if (rulesChanged) {
      onRebaseline?.({
        strategyId,
        previousFingerprint: currentStrategy.strategyFingerprint,
        nextFingerprint: candidateStrategy.strategyFingerprint,
        discardedDayCount: Object.keys(currentStrategy.days).length,
      });
      merged.strategies[strategyId] = cloneJson({
        ...candidateStrategy,
        days: sortedObject(candidateStrategy.days),
      });
      continue;
    }

    for (const field of ['initialBalanceYen', 'spreadPips']) {
      if (
        currentStrategy[field] !== undefined
        && candidateStrategy[field] !== undefined
        && currentStrategy[field] !== candidateStrategy[field]
      ) {
        throw new Error(`${strategyId}: history ${field} does not match the current strategy`);
      }
    }
    currentStrategy.strategyFingerprint ??= candidateStrategy.strategyFingerprint;

    currentStrategy.days = sortedObject({
      ...cloneJson(candidateStrategy.days),
      ...currentStrategy.days,
    });
  }
  merged.strategies = sortedObject(merged.strategies);
  return merged;
};

const maxMetric = (points, field) => points.reduce(
  (maximum, point) => Math.max(maximum, Number.isFinite(point[field]) ? point[field] : 0),
  0,
);

/**
 * Build immutable day candidates from the part of the source window that is
 * known to be complete. The newest bar's UTC day is deliberately excluded:
 * runBacktest force-closes an open position on its last bar with exitReason=end.
 */
export const buildConfirmedHistoryDays = ({
  registeredAt,
  forwardBars,
  forwardResult,
  recordedAt,
}) => {
  if (forwardBars.length === 0) {
    return {};
  }

  const firstAvailableDay = utcDayStart(forwardBars[0].t);
  const registrationDay = utcDayStart(registeredAt);
  const newestBarDay = utcDayStart(forwardBars[forwardBars.length - 1].t);
  // If registration has already fallen outside the rolling source window, the
  // first retained UTC day is partial. Backfill starts on the following day.
  const sourceWindowIsTruncated = firstAvailableDay - registrationDay > 7 * UTC_DAY_SECONDS;
  const firstCompleteAvailableDay = sourceWindowIsTruncated
    ? firstAvailableDay + UTC_DAY_SECONDS
    : registrationDay;
  const firstDay = Math.max(firstCompleteAvailableDay, registrationDay);
  if (firstDay >= newestBarDay) {
    return {};
  }

  const initialBalanceYen = forwardResult.moneyManagement?.initialBalanceYen ?? 0;
  const confirmedTrades = forwardResult.trades
    .filter((trade) => trade.exitReason !== 'end')
    .sort((left, right) =>
      left.exitTime - right.exitTime
      || left.entryTime - right.entryTime
      || left.id - right.id);
  const equityCurve = [...forwardResult.equityCurve].sort((left, right) => left.time - right.time);
  const days = {};

  for (let dayStart = firstDay; dayStart < newestBarDay; dayStart += UTC_DAY_SECONDS) {
    const dayEnd = utcDayEnd(dayStart);
    const dayTrades = confirmedTrades
      .filter((trade) => trade.exitTime >= dayStart && trade.exitTime <= dayEnd)
      .map((trade) => ({ ...trade }));
    const pointsOnDay = equityCurve.filter(
      (point) => point.time >= dayStart && point.time <= dayEnd,
    );
    const barsOnDay = forwardBars.filter((bar) => bar.t >= dayStart && bar.t <= dayEnd);
    const isExpectedMarketClosure = new Date(dayStart * 1000).getUTCDay() === 6;
    if (barsOnDay.length === 0 && !isExpectedMarketClosure) {
      continue;
    }
    const closePoint = equityCurve.findLast((point) => point.time <= dayEnd) ?? null;
    const realizedPipsAtClose = closePoint === null
      ? 0
      : sumBy(
        confirmedTrades.filter((trade) => trade.exitTime <= closePoint.time),
        (trade) => trade.netPips,
      );

    days[utcDateKey(dayStart)] = {
      recordedAt,
      firstBarAt: barsOnDay[0]?.t ?? null,
      lastBarAt: barsOnDay[barsOnDay.length - 1]?.t ?? null,
      barsEvaluated: barsOnDay.length,
      pnl: {
        netPips: roundPips(sumBy(dayTrades, (trade) => trade.netPips)),
        netProfitYen: roundYen(sumBy(dayTrades, (trade) => trade.netProfitYen)),
      },
      trades: dayTrades,
      equity: closePoint === null
        ? null
        : {
          asOf: closePoint.time,
          unrealizedPips: roundPips(closePoint.equityPips - realizedPipsAtClose),
          unrealizedProfitYen: roundYen(
            closePoint.equityYen - initialBalanceYen - closePoint.netProfitYen,
          ),
          maxDrawdownPips: roundPips(maxMetric(pointsOnDay, 'drawdownPips')),
          maxDrawdownYen: roundYen(maxMetric(pointsOnDay, 'drawdownYen')),
          maxDrawdownPct: maxMetric(pointsOnDay, 'drawdownPct'),
        },
    };
  }

  return days;
};

export const summarizeMetrics = (result) => ({
  spreadPips: finiteOrNull(result.spreadPips),
  winRate: finiteOrNull(result.winRate),
  profitFactor: finiteOrNull(result.profitFactor),
  maxDrawdownPips: finiteOrNull(result.maxDrawdownPips),
  maxDrawdownYen: finiteOrNull(result.maxDrawdownYen),
  maxDrawdownPct: finiteOrNull(result.maxDrawdownPct),
  tradeCount: result.tradeCount,
  netPips: finiteOrNull(result.netPips),
  netProfitYen: finiteOrNull(result.netProfitYen),
  grossProfitPips: finiteOrNull(result.grossProfitPips),
  grossLossPips: finiteOrNull(result.grossLossPips),
  grossProfitYen: finiteOrNull(result.grossProfitYen),
  grossLossYen: finiteOrNull(result.grossLossYen),
  riskRewardRatio: finiteOrNull(result.riskRewardRatio),
  averageWinYen: finiteOrNull(result.averageWinYen),
  averageLossYen: finiteOrNull(result.averageLossYen),
  maxConsecutiveWins: result.maxConsecutiveWins,
  maxConsecutiveLosses: result.maxConsecutiveLosses,
});

export const latestTrades = (trades, limit = 50) => trades.slice(-limit).reverse();

const normalizeEquityCurve = (equityCurve) =>
  equityCurve.map((point) => ({
    time: point.time,
    equityPips: finiteOrNull(point.equityPips),
    drawdownPips: finiteOrNull(point.drawdownPips),
    equityYen: finiteOrNull(point.equityYen),
    netProfitYen: finiteOrNull(point.netProfitYen),
    drawdownYen: finiteOrNull(point.drawdownYen),
    drawdownPct: finiteOrNull(point.drawdownPct),
  }));

const normalizeMeta = (meta) => ({
  id: meta.id,
  name: meta.name,
  version: meta.version,
  pair: meta.pair,
  timeframe: meta.timeframe,
  registeredAt: meta.registeredAt,
});

const initialBalanceForStrategy = (strategy) =>
  strategy.moneyManagement?.initialBalanceYen ?? 1_000_000;

const balanceAtSourceWindowStart = (strategy, forwardBars, strategyHistory) => {
  const initialBalanceYen = initialBalanceForStrategy(strategy);
  if (!strategyHistory || forwardBars.length === 0) {
    return initialBalanceYen;
  }
  const firstSourceDate = utcDateKey(forwardBars[0].t);
  const realizedBeforeWindow = Object.entries(strategyHistory.days)
    .filter(([date]) => date < firstSourceDate)
    .reduce((total, [, day]) => total + day.pnl.netProfitYen, 0);
  return roundYen(initialBalanceYen + realizedBeforeWindow);
};

const maxConsecutiveOutcomes = (trades) => {
  let currentWins = 0;
  let currentLosses = 0;
  let wins = 0;
  let losses = 0;
  for (const trade of trades) {
    if (trade.netProfitYen > 0) {
      currentWins += 1;
      currentLosses = 0;
    } else if (trade.netProfitYen < 0) {
      currentLosses += 1;
      currentWins = 0;
    } else {
      currentWins = 0;
      currentLosses = 0;
    }
    wins = Math.max(wins, currentWins);
    losses = Math.max(losses, currentLosses);
  }
  return { wins, losses };
};

const realizedDrawdown = (trades, field) => {
  let cumulative = 0;
  let peak = 0;
  let maximum = 0;
  for (const trade of trades) {
    cumulative += trade[field];
    peak = Math.max(peak, cumulative);
    maximum = Math.max(maximum, peak - cumulative);
  }
  return maximum;
};

const realizedDrawdownPercentage = (trades, initialBalanceYen) => {
  let balance = initialBalanceYen;
  let peak = initialBalanceYen;
  let maximum = 0;
  for (const trade of trades) {
    balance += trade.netProfitYen;
    peak = Math.max(peak, balance);
    const percentage = peak <= 0 ? 0 : ((peak - balance) / peak) * 100;
    maximum = Math.max(maximum, percentage);
  }
  return maximum;
};

const summarizePersistedTrades = ({ trades, days, spreadPips, initialBalanceYen }) => {
  const grossProfitPips = sumBy(
    trades.filter((trade) => trade.netPips > 0),
    (trade) => trade.netPips,
  );
  const grossLossPips = sumBy(
    trades.filter((trade) => trade.netPips < 0),
    (trade) => trade.netPips,
  );
  const grossProfitYen = sumBy(
    trades.filter((trade) => trade.netProfitYen > 0),
    (trade) => trade.netProfitYen,
  );
  const grossLossYen = sumBy(
    trades.filter((trade) => trade.netProfitYen < 0),
    (trade) => trade.netProfitYen,
  );
  const wins = trades.filter((trade) => trade.netProfitYen > 0).length;
  const losses = trades.filter((trade) => trade.netProfitYen < 0).length;
  const averageWinYen = wins === 0 ? 0 : grossProfitYen / wins;
  const averageLossYen = losses === 0 ? 0 : grossLossYen / losses;
  const persistedEquity = days
    .map(([, day]) => day.equity)
    .filter((equity) => equity !== null);
  const maxDrawdownPips = Math.max(
    realizedDrawdown(trades, 'netPips'),
    ...persistedEquity.map((equity) => equity.maxDrawdownPips),
  );
  const maxDrawdownYen = Math.max(
    realizedDrawdown(trades, 'netProfitYen'),
    ...persistedEquity.map((equity) => equity.maxDrawdownYen),
  );
  const maxDrawdownPct = Math.max(
    realizedDrawdownPercentage(trades, initialBalanceYen),
    ...persistedEquity.map((equity) => equity.maxDrawdownPct),
  );
  const consecutive = maxConsecutiveOutcomes(trades);
  const profitFactor = grossLossYen === 0
    ? grossProfitYen > 0 ? Number.POSITIVE_INFINITY : 0
    : grossProfitYen / Math.abs(grossLossYen);
  const riskRewardRatio = averageLossYen === 0
    ? averageWinYen > 0 ? Number.POSITIVE_INFINITY : 0
    : averageWinYen / Math.abs(averageLossYen);

  return {
    spreadPips: finiteOrNull(spreadPips),
    winRate: trades.length === 0 ? 0 : (wins / trades.length) * 100,
    profitFactor: finiteOrNull(profitFactor),
    maxDrawdownPips: finiteOrNull(roundPips(maxDrawdownPips)),
    maxDrawdownYen: finiteOrNull(roundYen(maxDrawdownYen)),
    maxDrawdownPct: finiteOrNull(maxDrawdownPct),
    tradeCount: trades.length,
    netPips: finiteOrNull(roundPips(sumBy(trades, (trade) => trade.netPips))),
    netProfitYen: finiteOrNull(roundYen(sumBy(trades, (trade) => trade.netProfitYen))),
    grossProfitPips: finiteOrNull(roundPips(grossProfitPips)),
    grossLossPips: finiteOrNull(roundPips(grossLossPips)),
    grossProfitYen: finiteOrNull(roundYen(grossProfitYen)),
    grossLossYen: finiteOrNull(roundYen(grossLossYen)),
    riskRewardRatio: finiteOrNull(riskRewardRatio),
    averageWinYen: finiteOrNull(roundYen(averageWinYen)),
    averageLossYen: finiteOrNull(roundYen(averageLossYen)),
    maxConsecutiveWins: consecutive.wins,
    maxConsecutiveLosses: consecutive.losses,
  };
};

export const buildForwardFromHistory = (strategyHistory) => {
  const days = Object.entries(strategyHistory.days).sort(([left], [right]) => left.localeCompare(right));
  let balanceAfterYen = strategyHistory.initialBalanceYen;
  const trades = days
    .flatMap(([, day]) => day.trades)
    .sort((left, right) =>
      left.exitTime - right.exitTime
      || left.entryTime - right.entryTime
      || left.id - right.id)
    .map((trade, index) => {
      balanceAfterYen = roundYen(balanceAfterYen + trade.netProfitYen);
      return {
        ...trade,
        id: index + 1,
        balanceAfterYen,
      };
    });

  let cumulativePips = 0;
  let cumulativeYen = 0;
  let peakEquityPips = 0;
  let peakEquityYen = strategyHistory.initialBalanceYen;
  const equityCurve = days.map(([date, day]) => {
    cumulativePips = roundPips(cumulativePips + day.pnl.netPips);
    cumulativeYen = roundYen(cumulativeYen + day.pnl.netProfitYen);
    const equityPips = roundPips(cumulativePips + (day.equity?.unrealizedPips ?? 0));
    const equityYen = roundYen(
      strategyHistory.initialBalanceYen
      + cumulativeYen
      + (day.equity?.unrealizedProfitYen ?? 0),
    );
    peakEquityPips = Math.max(peakEquityPips, equityPips);
    peakEquityYen = Math.max(peakEquityYen, equityYen);
    const drawdownPips = roundPips(Math.max(0, peakEquityPips - equityPips));
    const drawdownYen = roundYen(Math.max(0, peakEquityYen - equityYen));
    return {
      time: Date.parse(`${date}T23:59:59Z`) / 1000,
      equityPips,
      drawdownPips,
      equityYen,
      netProfitYen: cumulativeYen,
      drawdownYen,
      drawdownPct: peakEquityYen <= 0 ? 0 : (drawdownYen / peakEquityYen) * 100,
    };
  });

  const dates = days.map(([date]) => date);
  return {
    source: 'confirmed-history',
    firstConfirmedDate: dates[0] ?? null,
    confirmedThrough: dates[dates.length - 1] ?? null,
    confirmedDayCount: dates.length,
    metrics: summarizePersistedTrades({
      trades,
      days,
      spreadPips: strategyHistory.spreadPips,
      initialBalanceYen: strategyHistory.initialBalanceYen,
    }),
    trades: latestTrades(trades, 50),
    equityCurve,
  };
};

export const buildStrategyReport = ({
  strategy,
  bars,
  usdJpyBars,
  runBacktest,
  computedAt = new Date().toISOString(),
  existingStrategyHistory,
}) => {
  assertVirtualStrategy(strategy, strategy?.meta?.id ?? 'strategy');
  const meta = normalizeMeta(strategy.meta);
  const { forwardBars, referenceBars } = splitBarsByRegistration(bars, meta.registeredAt);
  const splitUsdJpy = usdJpyBars
    ? splitBarsByRegistration(usdJpyBars, meta.registeredAt)
    : { forwardBars: undefined, referenceBars: undefined };
  const forwardResult = runBacktest(forwardBars, strategy, meta.pair, {
    usdJpyBars: splitUsdJpy.forwardBars,
    moneyManagement: {
      initialBalanceYen: balanceAtSourceWindowStart(
        strategy,
        forwardBars,
        existingStrategyHistory,
      ),
    },
  });
  const referenceResult = runBacktest(referenceBars, strategy, meta.pair, {
    usdJpyBars: splitUsdJpy.referenceBars,
  });

  return {
    meta,
    ...(Object.hasOwn(strategy, 'selectionEvidence')
      ? { selectionEvidence: strategy.selectionEvidence }
      : {}),
    forward: {
      metrics: summarizeMetrics(forwardResult),
      trades: latestTrades(forwardResult.trades, 50),
      equityCurve: normalizeEquityCurve(forwardResult.equityCurve),
    },
    backtestReference: summarizeMetrics(referenceResult),
    backtestReferenceCoverage: {
      source: 'current-window',
      firstBarAt: referenceBars[0]?.t ?? null,
      lastBarAt: referenceBars[referenceBars.length - 1]?.t ?? null,
      barsEvaluated: referenceBars.length,
    },
    barsEvaluated: forwardBars.length,
    historyCandidate: {
      meta,
      strategyFingerprint: fingerprintStrategyDefinition(strategy),
      initialBalanceYen: initialBalanceForStrategy(strategy),
      spreadPips: finiteOrNull(forwardResult.spreadPips),
      days: buildConfirmedHistoryDays({
        registeredAt: meta.registeredAt,
        forwardBars,
        forwardResult,
        recordedAt: computedAt,
      }),
    },
  };
};

export const loadBacktestEngine = async () => {
  const esbuild = loadEsbuild();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fx-forward-backtest-'));
  const outfile = path.join(tempDir, 'backtest-bundle.mjs');
  await esbuild.build({
    entryPoints: [path.join(projectRoot, 'src/lib/backtest.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'silent',
  });
  const module = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  if (typeof module.runBacktest !== 'function') {
    throw new Error('Bundled backtest engine does not export runBacktest');
  }
  return {
    runBacktest: module.runBacktest,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
};

export const loadVirtualStrategies = async (directory = strategiesRoot) => {
  const files = (await readdir(directory))
    .filter((filename) => filename.endsWith('.json'))
    .sort();
  const strategies = [];
  for (const filename of files) {
    const strategy = await readJson(path.join(directory, filename));
    assertVirtualStrategy(strategy, filename);
    strategies.push(strategy);
  }
  return strategies;
};

const loadBars = async (pair, timeframe) => {
  const payload = await readJson(path.join(dataRoot, pair, `${timeframe}.json`));
  return payload.bars;
};

export const buildForwardArtifacts = async ({
  computedAt = new Date().toISOString(),
  runBacktest,
  existingHistory = createEmptyForwardHistory(),
  strategiesDirectory = strategiesRoot,
  loadBarsFor = loadBars,
  evaluateRetirement,
  retiredLedger,
  retiredLedgerFile = retiredLedgerPath,
}) => {
  assertForwardHistoryIntegrity(existingHistory, 'existing forward history');
  const [strategies, effectiveRetiredLedger] = await Promise.all([
    loadVirtualStrategies(strategiesDirectory),
    retiredLedger === undefined
      ? readRetiredLedger(retiredLedgerFile)
      : Promise.resolve(retiredLedger),
  ]);
  assertNoRetiredStrategyConflicts(strategies, effectiveRetiredLedger);
  assertHistoryGenerationTransitionsAreRetired(
    strategies,
    existingHistory,
    effectiveRetiredLedger,
  );
  const evaluateForwardRetirement = evaluateRetirement
    ?? await loadForwardRetirementEvaluator();
  const reports = [];
  const dataCache = new Map();

  const cachedBars = async (pair, timeframe) => {
    const key = `${pair}:${timeframe}`;
    if (!dataCache.has(key)) {
      dataCache.set(key, await loadBarsFor(pair, timeframe));
    }
    return dataCache.get(key);
  };

  for (const strategy of strategies) {
    const { pair, timeframe } = strategy.meta;
    const bars = await cachedBars(pair, timeframe);
    const usdJpyBars = pair === 'USDJPY' ? bars : await cachedBars('USDJPY', timeframe);
    const persistedHistory = Object.hasOwn(existingHistory.strategies, strategy.meta.id)
      ? existingHistory.strategies[strategy.meta.id]
      : undefined;
    reports.push(buildStrategyReport({
      strategy,
      bars,
      usdJpyBars,
      runBacktest,
      computedAt,
      existingStrategyHistory:
        persistedHistory?.meta.registeredAt === strategy.meta.registeredAt
          ? persistedHistory
          : undefined,
    }));
  }

  const candidateHistory = {
    schemaVersion: FORWARD_HISTORY_SCHEMA_VERSION,
    strategies: Object.fromEntries(
      reports.map((report) => [report.meta.id, report.historyCandidate]),
    ),
  };
  assertForwardHistoryIntegrity(candidateHistory, 'candidate forward history');
  const rebaselined = [];
  const history = mergeForwardHistory(existingHistory, candidateHistory, {
    onRebaseline: (event) => rebaselined.push(event),
  });
  assertForwardHistoryIntegrity(history, 'merged forward history');
  const results = {
    schemaVersion: FORWARD_RESULTS_SCHEMA_VERSION,
    computedAt,
    monthlySummary: buildMonthlySummary({
      history,
      activeStrategyIds: strategies.map((strategy) => strategy.meta.id),
      retiredLedger: effectiveRetiredLedger,
      computedAt,
    }),
    strategies: reports.map((report) => {
      const forward = buildForwardFromHistory(history.strategies[report.meta.id]);
      return {
        meta: report.meta,
        ...(report.selectionEvidence === undefined
          ? {}
          : { selectionEvidence: report.selectionEvidence }),
        operationStatus: evaluateForwardRetirement({
          profitFactor: forward.metrics.profitFactor,
          tradeCount: forward.metrics.tradeCount,
          confirmedDayCount: forward.confirmedDayCount,
          netProfitYen: forward.metrics.netProfitYen,
        }),
        forward,
        backtestReference: report.backtestReference,
        backtestReferenceCoverage: report.backtestReferenceCoverage,
        // Retained for compatibility with the original results schema.
        barsEvaluated: report.barsEvaluated,
      };
    }),
  };

  return { results, history, rebaselined };
};

export const buildForwardResults = async (options) =>
  (await buildForwardArtifacts(options)).results;

const readForwardHistory = async () => {
  try {
    const history = await readJson(historyPath);
    assertForwardHistoryIntegrity(history);
    return history;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return createEmptyForwardHistory();
    }
    throw error;
  }
};

const writeJsonAtomically = async (filePath, payload) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`);
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

const historyDayCount = (history) => Object.values(history.strategies).reduce(
  (total, strategyHistory) => total + Object.keys(strategyHistory.days).length,
  0,
);

export const main = async () => {
  const engine = await loadBacktestEngine();
  try {
    const existingHistory = await readForwardHistory();
    const { results, history, rebaselined } = await buildForwardArtifacts({
      runBacktest: engine.runBacktest,
      existingHistory,
    });
    for (const event of rebaselined) {
      console.warn(
        `${event.strategyId}: rules changed; forward history rebaselined `
        + `(discarded ${event.discardedDayCount} confirmed day(s); fingerprint `
        + `${event.previousFingerprint.slice(0, 12)}... -> ${event.nextFingerprint.slice(0, 12)}...)`,
      );
    }
    const appendedDays = historyDayCount(history) - historyDayCount(existingHistory);
    if (JSON.stringify(history) !== JSON.stringify(existingHistory)) {
      await writeJsonAtomically(historyPath, history);
    }
    await writeJsonAtomically(outputPath, results);
    console.log(
      `Generated ${results.strategies.length} forward-test results; `
      + `appended ${appendedDays} confirmed day(s) to ${path.relative(process.cwd(), historyPath)}`,
    );
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
