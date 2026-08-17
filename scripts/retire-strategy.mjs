import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultProjectRoot = path.resolve(__dirname, '..');

export const RETIRED_LEDGER_SCHEMA_VERSION = 1;
export const CLI_USAGE = `Usage:
  npm run retire:strategy -- <strategy-id> --reason <retirement reason>
  npm run retire:strategy -- <strategy-id> <retirement reason>`;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

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

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));

const exists = async (filePath) => {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

const createEmptyRetiredLedger = () => ({
  schemaVersion: RETIRED_LEDGER_SCHEMA_VERSION,
  strategies: {},
});

const assertRetiredLedger = (ledger) => {
  if (!isObject(ledger)) {
    throw new Error('retired ledger: root must be an object');
  }
  if (ledger.schemaVersion !== RETIRED_LEDGER_SCHEMA_VERSION) {
    throw new Error(
      `retired ledger: schemaVersion must be ${RETIRED_LEDGER_SCHEMA_VERSION}`,
    );
  }
  if (!isObject(ledger.strategies)) {
    throw new Error('retired ledger: strategies must be an object');
  }
  for (const [strategyId, entry] of Object.entries(ledger.strategies)) {
    if (!isObject(entry) || entry.strategyId !== strategyId) {
      throw new Error(
        `retired ledger: strategies.${strategyId}.strategyId must match its key`,
      );
    }
  }
};

const readRetiredLedger = async (filePath) => {
  try {
    const ledger = await readJson(filePath);
    assertRetiredLedger(ledger);
    return ledger;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return createEmptyRetiredLedger();
    }
    throw error;
  }
};

const writeJsonAtomically = async (filePath, payload) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const acquireFileLock = async (filePath, {
  retryMilliseconds = 20,
  timeoutMilliseconds = 10_000,
  staleMilliseconds = 60_000,
} = {}) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const startedAt = Date.now();
  while (true) {
    let handle;
    try {
      handle = await open(filePath, 'wx');
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      let released = false;
      return async () => {
        if (released) {
          return;
        }
        released = true;
        await handle.close();
        await rm(filePath, { force: true });
      };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        await rm(filePath, { force: true }).catch(() => {});
      }
      if (error?.code !== 'EEXIST') {
        throw error;
      }
      try {
        const lockStat = await stat(filePath);
        if (Date.now() - lockStat.mtimeMs >= staleMilliseconds) {
          await rm(filePath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') {
          continue;
        }
        throw statError;
      }
      if (Date.now() - startedAt >= timeoutMilliseconds) {
        throw new Error(`Timed out waiting for retirement lock: ${filePath}`);
      }
      await wait(retryMilliseconds);
    }
  }
};

const normalizeStrategyId = (value) => {
  const strategyId = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(strategyId)) {
    throw new Error('strategy-id must use only letters, numbers, dots, underscores, and hyphens');
  }
  return strategyId;
};

const normalizeReason = (value) => {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length === 0) {
    throw new Error('Retirement reason is required');
  }
  return reason;
};

const normalizeRetiredAt = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('retiredAt must be a valid date');
  }
  return date.toISOString();
};

const assertStrategyDefinition = (strategy, strategyId, context) => {
  if (!isObject(strategy) || !isObject(strategy.meta)) {
    throw new Error(`${context}: meta is required`);
  }
  if (strategy.meta.id !== strategyId || strategy.id !== strategyId) {
    throw new Error(`${context}: strategy id must match ${strategyId}`);
  }
  if (!Number.isInteger(strategy.meta.registeredAt) || strategy.meta.registeredAt <= 0) {
    throw new Error(`${context}: meta.registeredAt must be a unix timestamp`);
  }
};

const assertMatchingHistory = (strategyHistory, strategy) => {
  const strategyId = strategy.meta.id;
  if (!isObject(strategyHistory) || !isObject(strategyHistory.meta)) {
    throw new Error(`${strategyId}: confirmed forward history was not found`);
  }
  if (!isObject(strategyHistory.days)) {
    throw new Error(`${strategyId}: forward history days must be an object`);
  }
  for (const field of ['id', 'version', 'pair', 'timeframe', 'registeredAt']) {
    if (strategyHistory.meta[field] !== strategy.meta[field]) {
      throw new Error(`${strategyId}: forward history meta.${field} does not match the strategy`);
    }
  }
  const currentFingerprint = fingerprintStrategyDefinition(strategy);
  if (strategyHistory.strategyFingerprint !== currentFingerprint) {
    throw new Error(
      `${strategyId}: forward history fingerprint does not match the current strategy rules`,
    );
  }
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

const profitFactorFor = (trades) => {
  const grossProfitYen = trades.reduce(
    (total, trade) => total + (trade.netProfitYen > 0 ? trade.netProfitYen : 0),
    0,
  );
  const grossLossYen = trades.reduce(
    (total, trade) => total + (trade.netProfitYen < 0 ? trade.netProfitYen : 0),
    0,
  );
  if (grossLossYen === 0) {
    return grossProfitYen > 0 ? null : 0;
  }
  return grossProfitYen / Math.abs(grossLossYen);
};

export const buildFinalSnapshot = (strategy, strategyHistory) => {
  assertMatchingHistory(strategyHistory, strategy);
  const days = Object.entries(strategyHistory.days)
    .sort(([left], [right]) => left.localeCompare(right));
  const trades = days.flatMap(([, day]) => {
    if (!isObject(day) || !isObject(day.pnl) || !Array.isArray(day.trades)) {
      throw new Error(`${strategy.meta.id}: forward history contains an invalid day`);
    }
    if (!Number.isFinite(day.pnl.netProfitYen)) {
      throw new Error(`${strategy.meta.id}: forward history contains invalid cumulative profit`);
    }
    for (const trade of day.trades) {
      if (!isObject(trade) || !Number.isFinite(trade.netProfitYen)) {
        throw new Error(`${strategy.meta.id}: forward history contains an invalid trade`);
      }
    }
    return day.trades;
  });
  const dates = days.map(([date]) => date);

  return {
    tradeCount: trades.length,
    profitFactor: profitFactorFor(trades),
    cumulativeProfitYen: days.reduce(
      (total, [, day]) => total + day.pnl.netProfitYen,
      0,
    ),
    operationPeriod: {
      registeredAt: strategy.meta.registeredAt,
      firstConfirmedDate: dates[0] ?? null,
      confirmedThrough: dates[dates.length - 1] ?? null,
      confirmedDayCount: dates.length,
    },
  };
};

const strategyPaths = (projectRoot, strategyId) => ({
  source: path.join(projectRoot, 'strategies/virtual', `${strategyId}.json`),
  destination: path.join(projectRoot, 'strategies/retired', `${strategyId}.json`),
});

const moveStrategyDefinition = async ({ source, destination }) => {
  const sourceExists = await exists(source);
  const destinationExists = await exists(destination);
  if (sourceExists && destinationExists) {
    throw new Error(`Refusing to overwrite existing retired strategy: ${destination}`);
  }
  if (!sourceExists && !destinationExists) {
    throw new Error(`Strategy definition was not found: ${source}`);
  }
  if (sourceExists) {
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(source, destination);
    return true;
  }
  return false;
};

export const retireStrategy = async ({
  strategyId: rawStrategyId,
  reason: rawReason,
  retiredAt = new Date(),
  projectRoot = defaultProjectRoot,
  writeLedger = writeJsonAtomically,
} = {}) => {
  const strategyId = normalizeStrategyId(rawStrategyId);
  const reason = normalizeReason(rawReason);
  const retiredAtIso = normalizeRetiredAt(retiredAt);
  const root = path.resolve(projectRoot);
  const ledgerPath = path.join(root, 'public/data/forward/retired.json');
  const historyPath = path.join(root, 'public/data/forward/history.json');
  const lockPath = path.join(root, 'strategies/.retire-strategy.lock');
  const paths = strategyPaths(root, strategyId);
  const releaseLock = await acquireFileLock(lockPath);
  try {
    const ledger = await readRetiredLedger(ledgerPath);
    const existingEntry = Object.hasOwn(ledger.strategies, strategyId)
      ? ledger.strategies[strategyId]
      : undefined;

    if (existingEntry) {
      const moved = await moveStrategyDefinition(paths);
      return {
        alreadyRetired: true,
        moved,
        entry: cloneJson(existingEntry),
        ledgerPath,
        strategyPath: paths.destination,
      };
    }

    const sourceExists = await exists(paths.source);
    const destinationExists = await exists(paths.destination);
    if (sourceExists && destinationExists) {
      throw new Error(`Refusing to overwrite existing retired strategy: ${paths.destination}`);
    }
    if (!sourceExists && !destinationExists) {
      throw new Error(`Strategy definition was not found: ${paths.source}`);
    }
    const definitionPath = sourceExists ? paths.source : paths.destination;
    const strategy = await readJson(definitionPath);
    assertStrategyDefinition(strategy, strategyId, definitionPath);

    let history;
    try {
      history = await readJson(historyPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`${strategyId}: confirmed forward history was not found`);
      }
      throw error;
    }
    if (!isObject(history) || history.schemaVersion !== 1 || !isObject(history.strategies)) {
      throw new Error('forward history: invalid schema');
    }
    const entry = {
      strategyId,
      meta: cloneJson(strategy.meta),
      retiredAt: retiredAtIso,
      reason,
      finalSnapshot: buildFinalSnapshot(strategy, history.strategies[strategyId]),
    };

    const moved = await moveStrategyDefinition(paths);
    const nextLedger = cloneJson(ledger);
    nextLedger.strategies[strategyId] = entry;
    try {
      await writeLedger(ledgerPath, nextLedger);
    } catch (error) {
      if (moved) {
        try {
          await rename(paths.destination, paths.source);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `${strategyId}: ledger write and strategy move rollback both failed`,
          );
        }
      }
      throw error;
    }

    return {
      alreadyRetired: false,
      moved,
      entry: cloneJson(entry),
      ledgerPath,
      strategyPath: paths.destination,
    };
  } finally {
    await releaseLock();
  }
};

export const parseCliArgs = (args = []) => {
  let strategyId;
  let optionReason;
  const positionalReason = [];
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--reason') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --reason');
      }
      optionReason = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--reason=')) {
      optionReason = argument.slice('--reason='.length);
      continue;
    }
    if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (strategyId === undefined) {
      strategyId = argument;
    } else {
      positionalReason.push(argument);
    }
  }

  if (help) {
    return { help: true };
  }
  if (optionReason !== undefined && positionalReason.length > 0) {
    throw new Error('Specify the retirement reason either with --reason or as positional text');
  }
  return {
    strategyId: normalizeStrategyId(strategyId),
    reason: normalizeReason(optionReason ?? positionalReason.join(' ')),
    help: false,
  };
};

export const main = async ({
  args = process.argv.slice(2),
  projectRoot = defaultProjectRoot,
  retiredAt = new Date(),
  log = console.log,
} = {}) => {
  const parsed = parseCliArgs(args);
  if (parsed.help) {
    log(CLI_USAGE);
    return null;
  }
  const result = await retireStrategy({
    projectRoot,
    strategyId: parsed.strategyId,
    reason: parsed.reason,
    retiredAt,
  });
  log(
    result.alreadyRetired
      ? `${parsed.strategyId} is already retired; the ledger entry was left unchanged.`
      : `Retired ${parsed.strategyId} to ${path.relative(projectRoot, result.strategyPath)}.`,
  );
  return result;
};

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
