import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  fingerprintStrategyDefinition,
  roundYen,
} from './run-forward-test.mjs';
import {
  readRetiredLedger,
  retiredEntryRegisteredAt,
  retiredStrategyLedgerKey,
  RETIRED_LEDGER_SCHEMA_VERSION,
} from './lib/retired-ledger.mjs';

export {
  fingerprintStrategyDefinition,
  retiredStrategyLedgerKey,
  RETIRED_LEDGER_SCHEMA_VERSION,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultProjectRoot = path.resolve(__dirname, '..');

export const RETIREMENT_SCOPES = Object.freeze({
  virtual: Object.freeze({
    strategyDirectory: 'strategies/virtual',
    historyPath: 'public/data/forward/history.json',
    ledgerPath: 'public/data/forward/retired.json',
  }),
  observation: Object.freeze({
    strategyDirectory: 'strategies/observation',
    historyPath: 'public/data/forward/observation-history.json',
    ledgerPath: 'public/data/forward/observation-retired.json',
  }),
});

export const CLI_USAGE = `Usage:
  npm run retire:strategy -- <strategy-id> --reason <retirement reason>
  npm run retire:strategy -- <strategy-id> <retirement reason>
  npm run retire:strategy -- <strategy-id> --scope observation --reason <retirement reason>`;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const cloneJson = (value) => JSON.parse(JSON.stringify(value));

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

export const normalizeRetirementScope = (value = 'virtual') => {
  if (!Object.hasOwn(RETIREMENT_SCOPES, value)) {
    throw new Error(`scope must be one of ${Object.keys(RETIREMENT_SCOPES).join(', ')}`);
  }
  return value;
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

const profitFactorFor = (trades) => {
  if (trades.length === 0) {
    return null;
  }
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
    cumulativeProfitYen: roundYen(days.reduce(
      (total, [, day]) => total + day.pnl.netProfitYen,
      0,
    )),
    operationPeriod: {
      registeredAt: strategy.meta.registeredAt,
      firstConfirmedDate: dates[0] ?? null,
      confirmedThrough: dates[dates.length - 1] ?? null,
      confirmedDayCount: dates.length,
    },
  };
};

const strategyPaths = (
  projectRoot,
  strategyId,
  registeredAt,
  strategyDirectory = RETIREMENT_SCOPES.virtual.strategyDirectory,
) => ({
  source: path.join(projectRoot, strategyDirectory, `${strategyId}.json`),
  // Both scopes (virtual/observation) archive into the shared strategies/retired
  // directory. Ledger files are scope-separated; filename collision safety here
  // rests on the obs- id prefix invariant enforced at observation load time.
  destination: path.join(
    projectRoot,
    'strategies/retired',
    `${retiredStrategyLedgerKey(strategyId, registeredAt)}.json`,
  ),
  legacyDestination: path.join(projectRoot, 'strategies/retired', `${strategyId}.json`),
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

const ledgerEntriesForStrategy = (ledger, strategyId) =>
  Object.entries(ledger.strategies)
    .filter(([, entry]) => entry.strategyId === strategyId);

const latestLedgerEntry = (entries) => [...entries].sort((left, right) => {
  const registeredAtDifference = (
    retiredEntryRegisteredAt(left[0], left[1]) ?? Number.NEGATIVE_INFINITY
  ) - (
    retiredEntryRegisteredAt(right[0], right[1]) ?? Number.NEGATIVE_INFINITY
  );
  if (registeredAtDifference !== 0) {
    return registeredAtDifference;
  }
  return String(left[1].retiredAt ?? '').localeCompare(String(right[1].retiredAt ?? ''));
}).at(-1);

const findArchiveForGeneration = async (
  root,
  strategyId,
  registeredAt,
  strategyDirectory = RETIREMENT_SCOPES.virtual.strategyDirectory,
) => {
  const paths = strategyPaths(root, strategyId, registeredAt, strategyDirectory);
  if (await exists(paths.destination)) {
    return paths.destination;
  }
  if (await exists(paths.legacyDestination)) {
    const legacyStrategy = await readJson(paths.legacyDestination);
    if (legacyStrategy?.meta?.registeredAt === registeredAt) {
      return paths.legacyDestination;
    }
  }
  return null;
};

const findUnledgeredGenerationArchives = async (root, strategyId, ledgerEntries) => {
  const directory = path.join(root, 'strategies/retired');
  let filenames;
  try {
    filenames = await readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const ledgerGenerations = new Set(
    ledgerEntries
      .map(([key, entry]) => retiredEntryRegisteredAt(key, entry))
      .filter((registeredAt) => registeredAt !== null),
  );
  const candidates = [];
  for (const filename of filenames
    .filter((item) => item.startsWith(`${strategyId}@`) && item.endsWith('.json'))
    .sort()) {
    const definitionPath = path.join(directory, filename);
    const candidateStrategy = await readJson(definitionPath);
    assertStrategyDefinition(candidateStrategy, strategyId, definitionPath);
    const registeredAt = candidateStrategy.meta.registeredAt;
    const expectedFilename = `${retiredStrategyLedgerKey(strategyId, registeredAt)}.json`;
    if (filename !== expectedFilename) {
      throw new Error(
        `${definitionPath}: filename must match strategyId@meta.registeredAt`,
      );
    }
    if (!ledgerGenerations.has(registeredAt)) {
      candidates.push({ definitionPath, strategy: candidateStrategy });
    }
  }
  return candidates;
};

export const retireStrategy = async ({
  strategyId: rawStrategyId,
  reason: rawReason,
  retiredAt = new Date(),
  projectRoot = defaultProjectRoot,
  writeLedger = writeJsonAtomically,
  scope: rawScope,
  strategyScope,
} = {}) => {
  const strategyId = normalizeStrategyId(rawStrategyId);
  const reason = normalizeReason(rawReason);
  const retiredAtIso = normalizeRetiredAt(retiredAt);
  const scope = normalizeRetirementScope(rawScope ?? strategyScope ?? 'virtual');
  const scopeConfig = RETIREMENT_SCOPES[scope];
  const root = path.resolve(projectRoot);
  const ledgerPath = path.join(root, scopeConfig.ledgerPath);
  const historyPath = path.join(root, scopeConfig.historyPath);
  const lockPath = path.join(root, 'strategies/.retire-strategy.lock');
  const sourcePath = path.join(root, scopeConfig.strategyDirectory, `${strategyId}.json`);
  const legacyDestinationPath = path.join(root, 'strategies/retired', `${strategyId}.json`);
  const releaseLock = await acquireFileLock(lockPath);
  try {
    const ledger = await readRetiredLedger(ledgerPath);
    const entriesForStrategy = ledgerEntriesForStrategy(ledger, strategyId);
    const sourceExists = await exists(sourcePath);
    const unledgeredArchives = sourceExists
      ? []
      : await findUnledgeredGenerationArchives(root, strategyId, entriesForStrategy);

    if (unledgeredArchives.length > 1) {
      throw new Error(
        `${strategyId}: multiple unledgered retired generations were found; recovery is ambiguous`,
      );
    }

    if (!sourceExists && unledgeredArchives.length === 0 && entriesForStrategy.length > 0) {
      const [existingKey, existingEntry] = latestLedgerEntry(entriesForStrategy);
      const registeredAt = retiredEntryRegisteredAt(existingKey, existingEntry);
      const strategyPath = registeredAt === null
        ? ((await exists(legacyDestinationPath)) ? legacyDestinationPath : null)
        : await findArchiveForGeneration(
          root,
          strategyId,
          registeredAt,
          scopeConfig.strategyDirectory,
        );
      if (strategyPath === null) {
        throw new Error(
          `${strategyId}: retirement ledger entry exists, but its archived strategy definition was not found`,
        );
      }
      return {
        alreadyRetired: true,
        moved: false,
        entry: cloneJson(existingEntry),
        ledgerPath,
        strategyPath,
      };
    }

    if (
      !sourceExists
      && unledgeredArchives.length === 0
      && !(await exists(legacyDestinationPath))
    ) {
      throw new Error(`Strategy definition was not found: ${sourcePath}`);
    }
    const recoveryCandidate = unledgeredArchives[0];
    const definitionPath = sourceExists
      ? sourcePath
      : recoveryCandidate?.definitionPath ?? legacyDestinationPath;
    const strategy = recoveryCandidate?.strategy ?? await readJson(definitionPath);
    assertStrategyDefinition(strategy, strategyId, definitionPath);
    const paths = strategyPaths(
      root,
      strategyId,
      strategy.meta.registeredAt,
      scopeConfig.strategyDirectory,
    );
    const ledgerKey = retiredStrategyLedgerKey(strategyId, strategy.meta.registeredAt);
    const existingGeneration = entriesForStrategy.find(([key, entry]) =>
      retiredEntryRegisteredAt(key, entry) === strategy.meta.registeredAt);

    if (existingGeneration) {
      const [, existingEntry] = existingGeneration;
      const existingArchive = await findArchiveForGeneration(
        root,
        strategyId,
        strategy.meta.registeredAt,
        scopeConfig.strategyDirectory,
      );
      const moved = await moveStrategyDefinition({
        source: paths.source,
        destination: existingArchive ?? paths.destination,
      });
      return {
        alreadyRetired: true,
        moved,
        entry: cloneJson(existingEntry),
        ledgerPath,
        strategyPath: existingArchive ?? paths.destination,
      };
    }

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
      finalSnapshot: buildFinalSnapshot(
        strategy,
        Object.hasOwn(history.strategies, strategyId)
          ? history.strategies[strategyId]
          : undefined,
      ),
    };

    const moved = sourceExists
      ? await moveStrategyDefinition(paths)
      : false;
    const nextLedger = cloneJson(ledger);
    Object.defineProperty(nextLedger.strategies, ledgerKey, {
      value: entry,
      enumerable: true,
      configurable: true,
      writable: true,
    });
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
      strategyPath: sourceExists ? paths.destination : definitionPath,
    };
  } finally {
    await releaseLock();
  }
};

export const parseCliArgs = (args = []) => {
  let strategyId;
  let optionReason;
  let scope = 'virtual';
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
    if (argument === '--scope') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --scope');
      }
      scope = normalizeRetirementScope(value);
      index += 1;
      continue;
    }
    if (argument.startsWith('--scope=')) {
      scope = normalizeRetirementScope(argument.slice('--scope='.length));
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
    // Deliberate backward compatibility: omit the scope key for the default
    // virtual scope so legacy parseCliArgs toEqual assertions keep passing.
    ...(scope === 'virtual' ? {} : { scope }),
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
    scope: parsed.scope,
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
