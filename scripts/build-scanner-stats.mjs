import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildAdaptiveStats, defaultPredictionHorizons } from '../src/lib/adaptive-core.js';
import { defaultSpreadPipsByPair, spreadPipsForPair } from '../src/lib/spreads.js';
import { loadEsbuild } from './lib/esbuild-loader.mjs';

export { defaultSpreadPipsByPair };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const dataRoot = path.join(projectRoot, 'public/data');
const outputPath = path.join(dataRoot, 'stats/scanner.json');

export const scannerPairs = ['USDJPY', 'EURUSD', 'GBPJPY', 'EURJPY', 'AUDJPY', 'GBPUSD'];
export const scannerStyleKeys = ['daytrade', 'swing'];
export const expectationTierKeys = ['high', 'medium', 'low'];
export const initialSimulationBalanceYen = 1_000_000;
export const simulationRiskPercent = 1;
export const simulationWindowMonths = 12;

const timeframeOrder = ['m15', 'm30', 'h1', 'h4', 'd1'];
const timeframeSeconds = {
  m15: 15 * 60,
  m30: 30 * 60,
  h1: 60 * 60,
  h4: 4 * 60 * 60,
  d1: 24 * 60 * 60,
};
const styleHoldingBusinessDays = {
  daytrade: 5,
  swing: 20,
};

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const round = (value, digits = 4) =>
  isFiniteNumber(value) ? Number(value.toFixed(digits)) : null;

const pct = (value) => (isFiniteNumber(value) ? round(value, 4) : null);

const monthKeyFromSeconds = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 7);

const dayKeyFromSeconds = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);

const addMonths = (monthKey, delta) => {
  const [year, month] = monthKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
};

export const lastBarIndexesByDay = (bars, stepDays = 1) => {
  const byDay = [];
  let currentDay = null;
  for (let index = 0; index < bars.length; index += 1) {
    const day = dayKeyFromSeconds(bars[index].t);
    if (day !== currentDay) {
      currentDay = day;
      byDay.push(index);
    } else {
      byDay[byDay.length - 1] = index;
    }
  }
  return byDay.filter((_, index) => index % Math.max(1, stepDays) === 0);
};

const isWeekendUtc = (date) => {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
};

export const addBusinessDaysUnix = (seconds, businessDays) => {
  const date = new Date(seconds * 1000);
  let remaining = businessDays;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (!isWeekendUtc(date)) {
      remaining -= 1;
    }
  }
  return Math.floor(date.getTime() / 1000);
};

const compareByTime = (a, b) => a.t - b.t;

export const barsThroughTime = (bars, cutoffSeconds, barSeconds = 0) => {
  let low = 0;
  let high = bars.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (bars[mid].t + barSeconds <= cutoffSeconds) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return bars.slice(0, low);
};

const pipSize = (pair) => (pair.endsWith('JPY') ? 0.01 : 0.0001);

const entryPriceWithSpread = (recommendation, fillPrice) => {
  const spreadPrice = spreadPipsForPair(recommendation.pair) * pipSize(recommendation.pair);
  return recommendation.direction === '買い'
    ? fillPrice + spreadPrice
    : fillPrice - spreadPrice;
};

const realizedRAtPrice = (recommendation, entryPrice, exitPrice) => {
  const risk =
    recommendation.direction === '買い'
      ? entryPrice - recommendation.slPrice
      : recommendation.slPrice - entryPrice;
  if (!isFiniteNumber(risk) || risk <= 0) {
    return null;
  }
  const profit =
    recommendation.direction === '買い'
      ? exitPrice - entryPrice
      : entryPrice - exitPrice;
  return profit / risk;
};

const barTouchesPrice = (bar, price) => bar.l <= price && bar.h >= price;

const barTouchesZone = (bar, zone) => bar.h >= zone.low && bar.l <= zone.high;

const clampPriceToBar = (price, bar) => Math.min(bar.h, Math.max(bar.l, price));

const resolveEntryFill = (recommendation, evaluationBars) => {
  if (recommendation.entry.type === 'market') {
    const entryBar = evaluationBars[0];
    return entryBar
      ? { bar: entryBar, barIndex: 0, signalEntryPrice: entryBar.o }
      : null;
  }

  const targetPrice = recommendation.entry.price;
  const zone = recommendation.entry.zone;
  for (let index = 0; index < evaluationBars.length; index += 1) {
    const bar = evaluationBars[index];
    const touched = zone ? barTouchesZone(bar, zone) : barTouchesPrice(bar, targetPrice);
    if (touched) {
      return { bar, barIndex: index, signalEntryPrice: clampPriceToBar(targetPrice, bar) };
    }
  }
  return null;
};

export const judgeRecommendationOutcome = ({
  recommendation,
  futureBars,
  maxHoldingBusinessDays,
}) => {
  if (!futureBars.length) {
    return null;
  }

  const entryTime = recommendation.decisionTime ?? futureBars[0].t;
  const deadline = addBusinessDaysUnix(entryTime, maxHoldingBusinessDays);
  const evaluationBars = futureBars.filter((bar) => bar.t <= deadline);
  if (!evaluationBars.length) {
    return null;
  }

  const fill = resolveEntryFill(recommendation, evaluationBars);
  if (!fill) {
    if (futureBars[futureBars.length - 1].t < deadline) {
      return null;
    }
    return {
      outcome: 'unfilled',
      exitReason: 'unfilled',
      entryType: recommendation.entry.type,
      decisionTime: entryTime,
      deadline,
    };
  }

  const actualEntryTime = fill.bar.t;
  const signalEntryPrice = fill.signalEntryPrice;
  const actualEntryPrice = entryPriceWithSpread(recommendation, signalEntryPrice);
  const barsFromEntry = evaluationBars.slice(fill.barIndex);
  const isPullbackEntry = recommendation.entry.type !== 'market';

  for (let barOffset = 0; barOffset < barsFromEntry.length; barOffset += 1) {
    const bar = barsFromEntry[barOffset];
    const slHit =
      recommendation.direction === '買い'
        ? bar.l <= recommendation.slPrice
        : bar.h >= recommendation.slPrice;
    // On a pullback (limit) fill bar, the bar's TP-side extreme may have printed
    // before the limit filled, so only SL is judged on that bar; TP starts from
    // the next bar. This mirrors the pessimistic same-bar SL-over-TP rule.
    const tpEligible = !(isPullbackEntry && barOffset === 0);
    const tpHit =
      tpEligible &&
      (recommendation.direction === '買い'
        ? bar.h >= recommendation.tpPrice
        : bar.l <= recommendation.tpPrice);

    if (slHit || tpHit) {
      const exitPrice = slHit ? recommendation.slPrice : recommendation.tpPrice;
      const realizedR = realizedRAtPrice(recommendation, actualEntryPrice, exitPrice);
      return {
        outcome: slHit ? 'loss' : 'win',
        exitReason: slHit ? 'sl' : 'tp',
        entryTime: actualEntryTime,
        exitTime: bar.t,
        entryPrice: actualEntryPrice,
        signalEntryPrice,
        spreadPips: spreadPipsForPair(recommendation.pair),
        exitPrice,
        realizedR: round(realizedR ?? 0, 6),
      };
    }
  }

  if (futureBars[futureBars.length - 1].t < deadline) {
    return null;
  }

  const finalBar = barsFromEntry[barsFromEntry.length - 1];
  const realizedR = realizedRAtPrice(recommendation, actualEntryPrice, finalBar.c);
  return {
    outcome: realizedR === null || realizedR < 0 ? 'loss' : realizedR > 0 ? 'win' : 'draw',
    exitReason: 'time',
    entryTime: actualEntryTime,
    exitTime: finalBar.t,
    entryPrice: actualEntryPrice,
    signalEntryPrice,
    spreadPips: spreadPipsForPair(recommendation.pair),
    exitPrice: finalBar.c,
    realizedR: round(realizedR ?? 0, 6),
  };
};

const emptyAggregate = () => ({
  recommendations: 0,
  wins: 0,
  losses: 0,
  draws: 0,
  realizedRTotal: 0,
  decayedWins: 0,
  decayedTotal: 0,
  decayedRTotal: 0,
});

const addTradeToAggregate = (aggregate, trade, decay) => {
  aggregate.recommendations += 1;
  aggregate.decayedWins *= decay;
  aggregate.decayedTotal *= decay;
  aggregate.decayedRTotal *= decay;
  if (trade.outcome === 'win') {
    aggregate.wins += 1;
    aggregate.decayedWins += 1;
  } else if (trade.outcome === 'loss') {
    aggregate.losses += 1;
  } else {
    aggregate.draws += 1;
  }
  aggregate.realizedRTotal += trade.realizedR;
  aggregate.decayedTotal += 1;
  aggregate.decayedRTotal += trade.realizedR;
};

const finalizeAggregate = (aggregate, halfLifeSamples) => ({
  recommendations: aggregate.recommendations,
  wins: aggregate.wins,
  losses: aggregate.losses,
  draws: aggregate.draws,
  winRate: aggregate.recommendations > 0 ? pct(aggregate.wins / aggregate.recommendations) : null,
  averageRealizedR:
    aggregate.recommendations > 0 ? round(aggregate.realizedRTotal / aggregate.recommendations, 4) : null,
  ewa: {
    halfLifeSamples,
    decayedSampleCount: round(aggregate.decayedTotal, 2),
    winRate: aggregate.decayedTotal > 0 ? pct(aggregate.decayedWins / aggregate.decayedTotal) : null,
    averageRealizedR: aggregate.decayedTotal > 0 ? round(aggregate.decayedRTotal / aggregate.decayedTotal, 4) : null,
  },
});

const createPairStyleAggregates = () =>
  Object.fromEntries(
    scannerPairs.map((pair) => [
      pair,
      Object.fromEntries(scannerStyleKeys.map((style) => [style, emptyAggregate()])),
    ]),
  );

const createStyleTierAggregates = () =>
  Object.fromEntries(
    scannerStyleKeys.map((style) => [
      style,
      Object.fromEntries(expectationTierKeys.map((tier) => [tier, emptyAggregate()])),
    ]),
  );

const compareTrades = (a, b) => a.entryTime - b.entryTime || a.exitTime - b.exitTime || a.pair.localeCompare(b.pair);

const monthRangeEndingAt = (endMonth, count, startMonth = null) => {
  const firstMonth = addMonths(endMonth, -count + 1);
  const rangeStart = startMonth && startMonth > firstMonth ? startMonth : firstMonth;
  const months = [];
  for (let month = rangeStart; month <= endMonth; month = addMonths(month, 1)) {
    months.push(month);
  }
  return months;
};

const summarizeMonthlySimulation = (months) => {
  const activeMonths = months.filter((month) => month.tradeCount > 0);
  const plusMonths = activeMonths.filter((month) => month.pnlYen > 0).length;
  const best = activeMonths.length > 0 ? [...activeMonths].sort((a, b) => b.pnlYen - a.pnlYen)[0] : null;
  const worst = activeMonths.length > 0 ? [...activeMonths].sort((a, b) => a.pnlYen - b.pnlYen)[0] : null;
  const totalPnl = months.reduce((sum, month) => sum + month.pnlYen, 0);
  return {
    periodStartMonth: months[0]?.month ?? null,
    periodEndMonth: months[months.length - 1]?.month ?? null,
    plusMonthRate: activeMonths.length > 0 ? pct(plusMonths / activeMonths.length) : null,
    activeMonths: activeMonths.length,
    bestMonth: best ? { month: best.month, pnlYen: best.pnlYen } : null,
    worstMonth: worst ? { month: worst.month, pnlYen: worst.pnlYen } : null,
    averageMonthlyPnlYen: activeMonths.length > 0 ? Math.round(totalPnl / activeMonths.length) : 0,
    totalPnlYen: Math.round(totalPnl),
  };
};

export const buildMonthlySimulation = ({
  trades,
  mode,
  endMonth,
  startMonth = null,
  monthCount = simulationWindowMonths,
  initialBalanceYen = initialSimulationBalanceYen,
  riskPercent = simulationRiskPercent,
}) => {
  const tierAllowed =
    mode === 'highOnly'
      ? (tier) => tier === 'high'
      : (tier) => tier === 'high' || tier === 'medium';
  const monthKeys = monthRangeEndingAt(endMonth, monthCount, startMonth);
  const byMonth = Object.fromEntries(
    monthKeys.map((month) => [
      month,
      {
        month,
        pnlYen: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        tradeCount: 0,
        endBalanceYen: initialBalanceYen,
      },
    ]),
  );

  let balance = initialBalanceYen;
  for (const trade of [...trades].sort((a, b) => a.exitTime - b.exitTime || compareTrades(a, b))) {
    if (!tierAllowed(trade.expectationTier)) {
      continue;
    }
    const month = monthKeyFromSeconds(trade.exitTime);
    if (!byMonth[month]) {
      continue;
    }
    const riskYen = balance * (riskPercent / 100);
    const pnlYen = riskYen * trade.realizedR;
    balance += pnlYen;
    byMonth[month].pnlYen += pnlYen;
    byMonth[month].tradeCount += 1;
    if (trade.outcome === 'win') {
      byMonth[month].wins += 1;
    } else if (trade.outcome === 'loss') {
      byMonth[month].losses += 1;
    } else {
      byMonth[month].draws += 1;
    }
    byMonth[month].endBalanceYen = balance;
  }

  let carriedBalance = initialBalanceYen;
  const months = monthKeys.map((month) => {
    const row = byMonth[month];
    if (row.tradeCount === 0) {
      row.endBalanceYen = carriedBalance;
    } else {
      carriedBalance = row.endBalanceYen;
    }
    return {
      ...row,
      pnlYen: Math.round(row.pnlYen),
      endBalanceYen: Math.round(row.endBalanceYen),
    };
  });

  return {
    mode,
    label: mode === 'highOnly' ? '高のみ' : '中以上',
    initialBalanceYen,
    riskPercent,
    months,
    summary: summarizeMonthlySimulation(months),
  };
};

export const aggregateScannerTrades = ({
  trades,
  startMonth,
  endMonth,
  generatedAt,
  meta,
  halfLifeSamples = 30,
}) => {
  const pairStyleRaw = createPairStyleAggregates();
  const styleTierRaw = createStyleTierAggregates();
  const decay = Math.pow(0.5, 1 / halfLifeSamples);

  for (const trade of [...trades].sort(compareTrades)) {
    addTradeToAggregate(pairStyleRaw[trade.pair][trade.style], trade, decay);
    addTradeToAggregate(styleTierRaw[trade.style][trade.expectationTier], trade, decay);
  }

  const pairStyle = Object.fromEntries(
    Object.entries(pairStyleRaw).map(([pair, styles]) => [
      pair,
      Object.fromEntries(
        Object.entries(styles).map(([style, aggregate]) => [
          style,
          finalizeAggregate(aggregate, halfLifeSamples),
        ]),
      ),
    ]),
  );
  const styleTier = Object.fromEntries(
    Object.entries(styleTierRaw).map(([style, tiers]) => [
      style,
      Object.fromEntries(
        Object.entries(tiers).map(([tier, aggregate]) => [
          tier,
          finalizeAggregate(aggregate, halfLifeSamples),
        ]),
      ),
    ]),
  );

  return {
    version: 1,
    generatedAt,
    meta,
    pairStyle,
    styleTier,
    monthlySimulation: {
      mediumOrHigher: buildMonthlySimulation({ trades, mode: 'mediumOrHigher', startMonth, endMonth }),
      highOnly: buildMonthlySimulation({ trades, mode: 'highOnly', startMonth, endMonth }),
    },
  };
};

export const loadRecommendEngine = async () => {
  const esbuild = loadEsbuild();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fx-scanner-recommend-'));
  const outfile = path.join(tempDir, 'recommend-bundle.mjs');
  await esbuild.build({
    entryPoints: [path.join(projectRoot, 'src/lib/recommend.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'silent',
  });
  const module = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  if (typeof module.scanPair !== 'function') {
    throw new Error('Bundled recommendation engine does not export scanPair');
  }
  return {
    scanPair: module.scanPair,
    recommendationStyles: module.recommendationStyles,
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
};

const loadDataSet = async () => {
  const data = {};
  for (const pair of scannerPairs) {
    data[pair] = {};
    for (const timeframe of timeframeOrder) {
      const payload = await readJson(path.join(dataRoot, pair, `${timeframe}.json`));
      data[pair][timeframe] = payload;
    }
  }
  return data;
};

const adaptiveStatsCacheKey = (pair, timeframe, cutoffLength) => `${pair}:${timeframe}:${cutoffLength}`;

const rollingAdaptiveStats = (cache, pair, timeframe, bars) => {
  const key = adaptiveStatsCacheKey(pair, timeframe, bars.length);
  if (!cache.has(key)) {
    cache.set(key, buildAdaptiveStats(bars, defaultPredictionHorizons));
  }
  return cache.get(key);
};

export const buildScannerStats = async ({
  scanPair,
  recommendationStyles,
  data,
  computedAt = new Date().toISOString(),
  sampleStepDays = 1,
  useRollingAdaptiveStats = true,
  halfLifeSamples = 30,
}) => {
  const trades = [];
  const adaptiveCache = new Map();
  let decisionPoints = 0;
  let recommendationsFound = 0;
  let skippedIncompleteOutcome = 0;
  let skippedNoFutureBars = 0;
  let skippedUnfilledPullbacks = 0;
  const dataTimestamps = [];

  for (const pair of scannerPairs) {
    for (const style of scannerStyleKeys) {
      const styleDefinition = recommendationStyles[style];
      const executionFile = data[pair][styleDefinition.executionTimeframe];
      const environmentFile = data[pair][styleDefinition.environmentTimeframe];
      const executionBars = [...executionFile.bars].sort(compareByTime);
      const environmentBars = [...environmentFile.bars].sort(compareByTime);
      dataTimestamps.push(...executionBars.map((bar) => bar.t));
      const decisionIndexes = lastBarIndexesByDay(executionBars, sampleStepDays);

      for (const executionIndex of decisionIndexes) {
        const decisionTime = executionBars[executionIndex].t;
        const executionSlice = executionBars.slice(0, executionIndex + 1);
        const environmentSlice = barsThroughTime(
          environmentBars,
          decisionTime,
          timeframeSeconds[styleDefinition.environmentTimeframe],
        );
        decisionPoints += 1;
        const adaptiveStats = useRollingAdaptiveStats
          ? rollingAdaptiveStats(
              adaptiveCache,
              pair,
              styleDefinition.executionTimeframe,
              executionSlice,
            )
          : null;
        const recommendation = scanPair({
          pair,
          style,
          executionBars: executionSlice,
          environmentBars: environmentSlice,
          adaptiveStats,
          executionUpdatedAt: new Date(decisionTime * 1000).toISOString(),
          environmentUpdatedAt: environmentSlice.length
            ? new Date(environmentSlice[environmentSlice.length - 1].t * 1000).toISOString()
            : undefined,
        });
        if (!recommendation) {
          continue;
        }
        recommendationsFound += 1;
        const futureBars = executionBars.slice(executionIndex + 1);
        if (!futureBars.length) {
          skippedNoFutureBars += 1;
          continue;
        }
        const outcome = judgeRecommendationOutcome({
          recommendation: { ...recommendation, decisionTime },
          futureBars,
          maxHoldingBusinessDays: styleHoldingBusinessDays[style],
        });
        if (!outcome) {
          skippedIncompleteOutcome += 1;
          continue;
        }
        if (outcome.outcome === 'unfilled') {
          skippedUnfilledPullbacks += 1;
          continue;
        }
        trades.push({
          pair,
          style,
          styleLabel: recommendation.style,
          direction: recommendation.direction,
          expectationTier: recommendation.expectation.tier,
          score: recommendation.score,
          riskReward: recommendation.riskReward,
          ...outcome,
        });
      }
    }
  }

  const endTimestamp = dataTimestamps.length > 0 ? Math.max(...dataTimestamps) : Math.floor(Date.now() / 1000);
  const startTimestamp = dataTimestamps.length > 0 ? Math.min(...dataTimestamps) : endTimestamp;
  const startMonth = monthKeyFromSeconds(startTimestamp);
  const endMonth = monthKeyFromSeconds(endTimestamp);
  return aggregateScannerTrades({
    trades,
    startMonth,
    endMonth,
    generatedAt: computedAt,
    halfLifeSamples,
    meta: {
      source: 'scanner walk-forward simulation',
      dataStart: new Date(startTimestamp * 1000).toISOString(),
      dataEnd: new Date(endTimestamp * 1000).toISOString(),
      sampleStepDays,
      sampled: sampleStepDays > 1,
      adaptiveStatsMode: useRollingAdaptiveStats ? 'rolling-from-cutoff' : 'none',
      decisionFrequency: 'last execution bar of each UTC day',
      entryRule: 'market entries fill at the next execution bar open; pullback entries fill only when a future execution bar reaches the entry zone.',
      outcomeRule: 'Fixed pair spread is applied at entry; SL/TP judged on execution bars after fill; if both hit in one bar, SL wins pessimistically; on a pullback (limit) fill bar only SL is judged and TP judging starts from the next bar (the limit may fill after an intrabar TP spike); unsettled trades close at max holding deadline; slippage is not modeled.',
      spreadPips: defaultSpreadPipsByPair,
      maxHoldingBusinessDays: styleHoldingBusinessDays,
      initialBalanceYen: initialSimulationBalanceYen,
      riskPercent: simulationRiskPercent,
      simulationWindowMonths,
      evaluatedDecisionPoints: decisionPoints,
      recommendationsFound,
      judgedRecommendations: trades.length,
      skippedNoFutureBars,
      skippedIncompleteOutcome,
      skippedUnfilledPullbacks,
    },
  });
};

export const main = async () => {
  const engine = await loadRecommendEngine();
  try {
    const data = await loadDataSet();
    const results = await buildScannerStats({
      scanPair: engine.scanPair,
      recommendationStyles: engine.recommendationStyles,
      data,
    });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(
      `Generated scanner stats (${results.meta.judgedRecommendations} judged recommendations) in ${path.relative(process.cwd(), outputPath)}`,
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
