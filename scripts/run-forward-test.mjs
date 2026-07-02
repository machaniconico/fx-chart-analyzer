import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const dataRoot = path.join(projectRoot, 'public/data');
const strategiesRoot = path.join(projectRoot, 'strategies/virtual');
const outputPath = path.join(dataRoot, 'forward/results.json');
const knownEntryConditionTypes = new Set(['maCross', 'rsi', 'bollinger', 'macdCross']);

export const TWO_YEARS_SECONDS = 365 * 2 * 24 * 60 * 60;
export const VIRTUAL_PAIRS = ['USDJPY', 'EURUSD', 'GBPJPY', 'EURJPY', 'AUDJPY', 'GBPUSD'];
export const VIRTUAL_TIMEFRAMES = ['m15', 'm30', 'h1', 'h4', 'd1'];

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

export const buildStrategyReport = ({
  strategy,
  bars,
  usdJpyBars,
  runBacktest,
}) => {
  assertVirtualStrategy(strategy, strategy?.meta?.id ?? 'strategy');
  const meta = normalizeMeta(strategy.meta);
  const { forwardBars, referenceBars } = splitBarsByRegistration(bars, meta.registeredAt);
  const splitUsdJpy = usdJpyBars
    ? splitBarsByRegistration(usdJpyBars, meta.registeredAt)
    : { forwardBars: undefined, referenceBars: undefined };
  const forwardResult = runBacktest(forwardBars, strategy, meta.pair, {
    usdJpyBars: splitUsdJpy.forwardBars,
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
    barsEvaluated: forwardBars.length,
  };
};

export const loadEsbuild = () => {
  const require = createRequire(import.meta.url);
  const candidates = [
    'esbuild',
    path.join(projectRoot, 'node_modules/vitest/node_modules/esbuild/lib/main.js'),
    path.join(projectRoot, 'node_modules/vite-node/node_modules/esbuild/lib/main.js'),
  ];
  const errors = [];
  for (const candidate of candidates) {
    try {
      const resolvedPath = require.resolve(candidate);
      const esbuild = require(resolvedPath);
      console.log(`Using esbuild from ${resolvedPath}`);
      return esbuild;
    } catch (error) {
      errors.push(`${candidate}: ${error.code ?? error.message}`);
    }
  }
  throw new Error(`esbuild を読み込めませんでした。\n${errors.join('\n')}`);
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

export const buildForwardResults = async ({ computedAt = new Date().toISOString(), runBacktest }) => {
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
    reports.push(buildStrategyReport({ strategy, bars, usdJpyBars, runBacktest }));
  }

  return {
    computedAt,
    strategies: reports,
  };
};

export const main = async () => {
  const engine = await loadBacktestEngine();
  try {
    const results = await buildForwardResults({ runBacktest: engine.runBacktest });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`Generated ${results.strategies.length} forward-test results in ${path.relative(process.cwd(), outputPath)}`);
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
