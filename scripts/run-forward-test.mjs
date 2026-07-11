import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEsbuild } from './lib/esbuild-loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const dataRoot = path.join(projectRoot, 'public/data');
const strategiesRoot = path.join(projectRoot, 'strategies/virtual');
const outputPath = path.join(dataRoot, 'forward/results.json');
const historyPath = path.join(dataRoot, 'forward/history.json');
const knownEntryConditionTypes = new Set(['maCross', 'rsi', 'bollinger', 'macdCross']);

export const TWO_YEARS_SECONDS = 365 * 2 * 24 * 60 * 60;
export const FORWARD_HISTORY_SCHEMA_VERSION = 1;
export const FORWARD_RESULTS_SCHEMA_VERSION = 2;
export const VIRTUAL_PAIRS = ['USDJPY', 'EURUSD', 'GBPJPY', 'EURJPY', 'AUDJPY', 'GBPUSD'];
export const VIRTUAL_TIMEFRAMES = ['m15', 'm30', 'h1', 'h4', 'd1'];

const UTC_DAY_SECONDS = 24 * 60 * 60;

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const positiveFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

const strategyContext = (filename, strategyId) =>
  filename === strategyId ? strategyId : `${filename} (${strategyId})`;

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

const roundYen = (value) => Math.round(value);

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

const fingerprintStrategy = (strategy) => createHash('sha256')
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
    const currentStrategy = merged.strategies[strategyId];
    if (!currentStrategy) {
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
      strategyFingerprint: fingerprintStrategy(strategy),
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

const loadVirtualStrategies = async () => {
  const files = (await readdir(strategiesRoot))
    .filter((filename) => filename.endsWith('.json'))
    .sort();
  const strategies = [];
  for (const filename of files) {
    const strategy = await readJson(path.join(strategiesRoot, filename));
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
}) => {
  assertForwardHistoryIntegrity(existingHistory, 'existing forward history');
  const strategies = await loadVirtualStrategies();
  const reports = [];
  const dataCache = new Map();

  const cachedBars = async (pair, timeframe) => {
    const key = `${pair}:${timeframe}`;
    if (!dataCache.has(key)) {
      dataCache.set(key, await loadBars(pair, timeframe));
    }
    return dataCache.get(key);
  };

  for (const strategy of strategies) {
    const { pair, timeframe } = strategy.meta;
    const bars = await cachedBars(pair, timeframe);
    const usdJpyBars = pair === 'USDJPY' ? bars : await cachedBars('USDJPY', timeframe);
    reports.push(buildStrategyReport({
      strategy,
      bars,
      usdJpyBars,
      runBacktest,
      computedAt,
      existingStrategyHistory: existingHistory.strategies[strategy.meta.id],
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
    strategies: reports.map((report) => ({
      meta: report.meta,
      forward: buildForwardFromHistory(history.strategies[report.meta.id]),
      backtestReference: report.backtestReference,
      backtestReferenceCoverage: report.backtestReferenceCoverage,
      // Retained for compatibility with the original results schema.
      barsEvaluated: report.barsEvaluated,
    })),
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

// The story's file lock excludes the colocated *.test.mjs file. Register these
// persistence invariants when that test imports the runner under Vitest.
const vitestApi = import.meta.vitest
  ?? (process.env.VITEST ? await import('vitest') : null);
if (vitestApi) {
  const { describe, expect, it } = vitestApi;
  const testMeta = {
    id: 'history-test-v1',
    name: 'History test',
    version: 1,
    pair: 'USDJPY',
    timeframe: 'h1',
    registeredAt: 1_700_000_000,
  };
  const testDay = (recordedAt) => ({
    recordedAt,
    firstBarAt: null,
    lastBarAt: null,
    barsEvaluated: 0,
    pnl: { netPips: 0, netProfitYen: 0 },
    trades: [],
    equity: null,
  });
  const testHistory = (days) => ({
    schemaVersion: FORWARD_HISTORY_SCHEMA_VERSION,
    strategies: {
      [testMeta.id]: {
        meta: testMeta,
        initialBalanceYen: 1_000_000,
        spreadPips: 0.9,
        days,
      },
    },
  });

  describe('forward history persistence', () => {
    it('appends missing UTC days without overwriting existing days or mutating inputs', () => {
      const existing = testHistory({ '2023-11-15': testDay('2023-11-16T00:00:00Z') });
      const candidate = testHistory({
        '2023-11-15': testDay('2023-11-17T00:00:00Z'),
        '2023-11-16': testDay('2023-11-17T00:00:00Z'),
      });
      const existingSnapshot = cloneJson(existing);
      const candidateSnapshot = cloneJson(candidate);

      const merged = mergeForwardHistory(existing, candidate);

      expect(merged.strategies[testMeta.id].days['2023-11-15']).toEqual(
        existing.strategies[testMeta.id].days['2023-11-15'],
      );
      expect(merged.strategies[testMeta.id].days['2023-11-16']).toEqual(
        candidate.strategies[testMeta.id].days['2023-11-16'],
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
      const existing = testHistory({ '2023-11-15': testDay('2023-11-16T00:00:00Z') });
      existing.strategies[testMeta.id].strategyFingerprint = fingerprint;
      const candidate = testHistory({
        '2023-11-15': testDay('2023-11-17T00:00:00Z'),
        '2023-11-16': testDay('2023-11-17T00:00:00Z'),
      });
      candidate.strategies[testMeta.id].strategyFingerprint = fingerprint;
      const rebaselined = [];

      const merged = mergeForwardHistory(existing, candidate, {
        onRebaseline: (event) => rebaselined.push(event),
      });

      expect(rebaselined).toEqual([]);
      expect(Object.keys(merged.strategies[testMeta.id].days)).toEqual(['2023-11-15', '2023-11-16']);
      // The already-confirmed day keeps its original recording, not the candidate's.
      expect(merged.strategies[testMeta.id].days['2023-11-15'].recordedAt).toBe('2023-11-16T00:00:00Z');
    });

    it('rebaselines confirmed history when the strategy fingerprint changes', () => {
      const previousFingerprint = 'a'.repeat(64);
      const nextFingerprint = 'b'.repeat(64);
      const existing = testHistory({
        '2023-11-15': testDay('2023-11-16T00:00:00Z'),
        '2023-11-16': testDay('2023-11-17T00:00:00Z'),
      });
      existing.strategies[testMeta.id].strategyFingerprint = previousFingerprint;
      const candidate = testHistory({ '2023-11-20': testDay('2023-11-21T00:00:00Z') });
      candidate.strategies[testMeta.id].strategyFingerprint = nextFingerprint;
      const rebaselined = [];

      const merged = mergeForwardHistory(existing, candidate, {
        onRebaseline: (event) => rebaselined.push(event),
      });

      expect(rebaselined).toEqual([
        {
          strategyId: testMeta.id,
          previousFingerprint,
          nextFingerprint,
          discardedDayCount: 2,
        },
      ]);
      // Stale confirmed days are dropped; only the current rules' days remain.
      expect(Object.keys(merged.strategies[testMeta.id].days)).toEqual(['2023-11-20']);
      expect(merged.strategies[testMeta.id].strategyFingerprint).toBe(nextFingerprint);
    });

    it('does not throw when re-selected rules also change balance or spread', () => {
      const existing = testHistory({ '2023-11-15': testDay('2023-11-16T00:00:00Z') });
      existing.strategies[testMeta.id].strategyFingerprint = 'a'.repeat(64);
      const candidate = testHistory({ '2023-11-20': testDay('2023-11-21T00:00:00Z') });
      candidate.strategies[testMeta.id].strategyFingerprint = 'b'.repeat(64);
      candidate.strategies[testMeta.id].initialBalanceYen = 2_000_000;
      candidate.strategies[testMeta.id].spreadPips = 1.5;

      const merged = mergeForwardHistory(existing, candidate);

      expect(merged.strategies[testMeta.id].initialBalanceYen).toBe(2_000_000);
      expect(merged.strategies[testMeta.id].spreadPips).toBe(1.5);
    });
  });
}
