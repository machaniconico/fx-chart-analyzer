import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

const targets = [
  {
    id: 'break-bb-gbpjpy-v1',
    strategy: {
      meta: {
        id: 'break-bb-gbpjpy-v1',
        name: 'ポンド円BBブレイク順張り',
        version: 1,
        pair: 'GBPJPY',
        timeframe: 'h1',
        registeredAt,
      },
      id: 'break-bb-gbpjpy-v1',
      name: 'ポンド円BBブレイク順張り',
      description: 'GBPJPY h1でボリンジャーバンド上限ブレイクを買い、下限ブレイクを売りで追随します。',
      direction: 'long',
      entryDirections: ['long', 'short'],
      entryConditions: [
        {
          type: 'bollinger',
          period: 20,
          multiplier: 2,
          mode: 'break',
          band: 'upper',
        },
      ],
      exit: {
        stopLossPips: 15,
        takeProfitPips: 25,
        trailingStopPips: null,
        closeOnOppositeSignal: false,
      },
      sessionFilter: disabledSessionFilter,
      newsFilter: disabledNewsFilter,
      lotSize: 0.1,
      moneyManagement: fixedRiskMoneyManagement,
      magicNumber: 1782996304,
    },
    parameterRanges: {
      stopLossPips: rangeWithSteps(15, 75, 6),
      takeProfitPips: rangeWithSteps(25, 125, 6),
    },
    trailingStopPips: null,
    sessionVariants: [
      {
        label: 'なし',
        filter: disabledSessionFilter,
      },
      {
        label: '7-15時',
        filter: {
          enabled: true,
          start: '07:00',
          end: '15:00',
          serverUtcOffsetMinutes: 0,
        },
      },
    ],
  },
  {
    id: 'swing-sma-eurjpy-v1',
    strategy: {
      meta: {
        id: 'swing-sma-eurjpy-v1',
        name: 'ユーロ円スイング順張り(SMAクロス)',
        version: 1,
        pair: 'EURJPY',
        timeframe: 'h4',
        registeredAt,
      },
      id: 'swing-sma-eurjpy-v1',
      name: 'ユーロ円スイング順張り(SMAクロス)',
      description: 'EURJPY h4のSMA20/50クロスを買い・売りの両方向で追随し、反対シグナルで撤退します。',
      direction: 'long',
      entryDirections: ['long', 'short'],
      entryConditions: [
        {
          type: 'maCross',
          fastType: 'sma',
          fastPeriod: 20,
          slowType: 'sma',
          slowPeriod: 50,
        },
      ],
      exit: {
        stopLossPips: 30,
        takeProfitPips: 40,
        trailingStopPips: null,
        closeOnOppositeSignal: true,
      },
      sessionFilter: disabledSessionFilter,
      newsFilter: disabledNewsFilter,
      lotSize: 0.1,
      moneyManagement: fixedRiskMoneyManagement,
      magicNumber: 1782996305,
    },
    parameterRanges: {
      stopLossPips: rangeWithSteps(30, 90, 6),
      takeProfitPips: rangeWithSteps(40, 160, 6),
    },
    trailingStopPips: [null, 20],
    sessionVariants: null,
  },
  /*
   * To retune a saved virtual strategy instead of an inline candidate, add:
   * { id: 'strategy-file-id', trailingStopPips: [...], sessionVariants: [...] }
   */
];

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
  ]);
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((cells) => `| ${cells.join(' | ')} |`),
  ].join('\n');
};

const rankRows = (rows) =>
  [...rows].sort((left, right) => {
    const validationProfitDiff = right.validation.netProfitYen - left.validation.netProfitYen;
    if (validationProfitDiff !== 0) {
      return validationProfitDiff;
    }
    const validationPfDiff = right.validation.profitFactor - left.validation.profitFactor;
    if (validationPfDiff !== 0) {
      return validationPfDiff;
    }
    const optimizationProfitDiff = right.optimization.netProfitYen - left.optimization.netProfitYen;
    if (optimizationProfitDiff !== 0) {
      return optimizationProfitDiff;
    }
    return left.validation.maxDrawdownYen - right.validation.maxDrawdownYen;
  });

const isEligible = (row) =>
  row.optimization.netProfitYen > 0 &&
  row.validation.netProfitYen > 0 &&
  row.validation.tradeCount >= 10;

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

  const rankedRows = rankRows(rows);
  return {
    strategy,
    pair,
    timeframe,
    referenceBars: referenceBars.length,
    optimizationBars: optimizationBars.length,
    validationBars: validationBars.length,
    rows: rankedRows,
    eligible: rankedRows.find(isEligible) ?? null,
  };
};

const printTargetResult = (result) => {
  console.log(`\n## ${result.strategy.meta.id} (${result.pair} ${result.timeframe})`);
  console.log(
    `bars: reference=${result.referenceBars}, optimization=${result.optimizationBars}, validation=${result.validationBars}`,
  );
  console.log(markdownTable(result.rows.slice(0, 5)));
  if (result.eligible) {
    console.log(`採用候補: ${combinationLabel(result.eligible)}`);
  } else {
    console.log('採用候補: 該当なし');
  }
};

export const main = async () => {
  const engine = await loadTuningEngine();
  try {
    const results = [];
    for (const target of targets) {
      const result = await evaluateTarget(engine, target);
      results.push(result);
      printTargetResult(result);
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
