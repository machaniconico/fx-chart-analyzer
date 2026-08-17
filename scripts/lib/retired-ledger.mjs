import { readFile } from 'node:fs/promises';

export const RETIRED_LEDGER_SCHEMA_VERSION = 1;

const isObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const retiredStrategyLedgerKey = (strategyId, registeredAt) =>
  `${strategyId}@${registeredAt}`;

export const retiredEntryRegisteredAt = (ledgerKey, entry) => {
  const registeredAt = entry.meta?.registeredAt
    ?? entry.finalSnapshot?.operationPeriod?.registeredAt;
  if (Number.isInteger(registeredAt) && registeredAt > 0) {
    return registeredAt;
  }
  const prefix = `${entry.strategyId}@`;
  if (!ledgerKey.startsWith(prefix)) {
    return null;
  }
  const keyRegisteredAt = Number(ledgerKey.slice(prefix.length));
  return Number.isInteger(keyRegisteredAt) && keyRegisteredAt > 0
    ? keyRegisteredAt
    : null;
};

export const createEmptyRetiredLedger = () => ({
  schemaVersion: RETIRED_LEDGER_SCHEMA_VERSION,
  strategies: {},
});

export const assertRetiredLedger = (ledger, context = 'retired ledger') => {
  if (!isObject(ledger)) {
    throw new Error(`${context}: root must be an object`);
  }
  if (ledger.schemaVersion !== RETIRED_LEDGER_SCHEMA_VERSION) {
    throw new Error(
      `${context}: schemaVersion must be ${RETIRED_LEDGER_SCHEMA_VERSION}`,
    );
  }
  if (!isObject(ledger.strategies)) {
    throw new Error(`${context}: strategies must be an object`);
  }
  for (const [ledgerKey, entry] of Object.entries(ledger.strategies)) {
    if (!isObject(entry) || typeof entry.strategyId !== 'string') {
      throw new Error(`${context}: strategies.${ledgerKey}.strategyId is required`);
    }
    if (ledgerKey === entry.strategyId) {
      continue;
    }
    const registeredAt = retiredEntryRegisteredAt(ledgerKey, entry);
    if (
      registeredAt === null
      || ledgerKey !== retiredStrategyLedgerKey(entry.strategyId, registeredAt)
    ) {
      throw new Error(
        `${context}: strategies.${ledgerKey} must use strategyId@registeredAt as its key`,
      );
    }
  }
};

export const readRetiredLedger = async (filePath) => {
  try {
    const ledger = JSON.parse(await readFile(filePath, 'utf8'));
    assertRetiredLedger(ledger);
    return ledger;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return createEmptyRetiredLedger();
    }
    throw error;
  }
};
