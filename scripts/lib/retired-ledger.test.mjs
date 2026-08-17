import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertRetiredLedger,
  createEmptyRetiredLedger,
  readRetiredLedger,
  retiredEntryRegisteredAt,
  retiredStrategyLedgerKey,
  RETIRED_LEDGER_SCHEMA_VERSION,
} from './retired-ledger.mjs';

const temporaryDirectories = [];

const writeLedger = async (ledger) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fx-retired-ledger-test-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'retired.json');
  await writeFile(filePath, JSON.stringify(ledger), 'utf8');
  return filePath;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

describe('retired ledger', () => {
  it('creates and reads a valid generation-keyed ledger', async () => {
    const strategyId = 'shared-ledger-v1';
    const registeredAt = 1_700_000_000;
    const ledgerKey = retiredStrategyLedgerKey(strategyId, registeredAt);
    const ledger = {
      schemaVersion: RETIRED_LEDGER_SCHEMA_VERSION,
      strategies: {
        [ledgerKey]: {
          strategyId,
          meta: { registeredAt },
        },
      },
    };

    expect(() => assertRetiredLedger(ledger)).not.toThrow();
    expect(retiredEntryRegisteredAt(ledgerKey, ledger.strategies[ledgerKey]))
      .toBe(registeredAt);
    await expect(readRetiredLedger(await writeLedger(ledger))).resolves.toEqual(ledger);
  });

  it('derives registeredAt from the snapshot or composite key', () => {
    const strategyId = 'shared-ledger-v1';
    const registeredAt = 1_700_000_000;
    const ledgerKey = retiredStrategyLedgerKey(strategyId, registeredAt);

    expect(retiredEntryRegisteredAt(ledgerKey, {
      strategyId,
      finalSnapshot: { operationPeriod: { registeredAt } },
    })).toBe(registeredAt);
    expect(retiredEntryRegisteredAt(ledgerKey, { strategyId })).toBe(registeredAt);
  });

  it('keeps the legacy single-key ledger format readable', async () => {
    const strategyId = 'legacy-ledger-v1';
    const ledger = {
      schemaVersion: RETIRED_LEDGER_SCHEMA_VERSION,
      strategies: {
        [strategyId]: { strategyId, reason: 'legacy entry' },
      },
    };

    expect(() => assertRetiredLedger(ledger)).not.toThrow();
    expect(retiredEntryRegisteredAt(strategyId, ledger.strategies[strategyId])).toBeNull();
    await expect(readRetiredLedger(await writeLedger(ledger))).resolves.toEqual(ledger);
  });

  it.each([
    [
      'non-object entry',
      { schemaVersion: 1, strategies: { invalid: null } },
      /strategies\.invalid\.strategyId is required/,
    ],
    [
      'missing strategyId',
      { schemaVersion: 1, strategies: { invalid: {} } },
      /strategies\.invalid\.strategyId is required/,
    ],
    [
      'mismatched composite key',
      {
        schemaVersion: 1,
        strategies: {
          'wrong-id@1700000000': {
            strategyId: 'expected-id',
            meta: { registeredAt: 1_700_000_000 },
          },
        },
      },
      /must use strategyId@registeredAt as its key/,
    ],
    [
      'malformed composite timestamp',
      {
        schemaVersion: 1,
        strategies: {
          'expected-id@not-a-timestamp': { strategyId: 'expected-id' },
        },
      },
      /must use strategyId@registeredAt as its key/,
    ],
  ])('rejects an invalid entry: %s', async (_label, ledger, expectedError) => {
    expect(() => assertRetiredLedger(ledger)).toThrow(expectedError);
    await expect(readRetiredLedger(await writeLedger(ledger)))
      .rejects.toThrow(expectedError);
  });

  it.each([
    ['non-object root', null, /root must be an object/],
    ['schema version mismatch', { schemaVersion: 2, strategies: {} }, /schemaVersion must be/],
    ['non-object strategies', { schemaVersion: 1, strategies: [] }, /strategies must be an object/],
  ])('rejects an invalid ledger: %s', async (_label, ledger, expectedError) => {
    expect(() => assertRetiredLedger(ledger)).toThrow(expectedError);
    await expect(readRetiredLedger(await writeLedger(ledger)))
      .rejects.toThrow(expectedError);
  });

  it('rethrows a non-ENOENT read failure instead of failing open', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fx-retired-ledger-test-'));
    temporaryDirectories.push(directory);
    const brokenPath = path.join(directory, 'retired.json');
    await writeFile(brokenPath, '{broken json', 'utf8');

    await expect(readRetiredLedger(brokenPath)).rejects.toThrow(SyntaxError);
  });

  it('returns a fresh empty ledger when the file does not exist', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'fx-retired-ledger-test-'));
    temporaryDirectories.push(directory);
    const missingPath = path.join(directory, 'missing.json');

    const first = await readRetiredLedger(missingPath);
    const second = await readRetiredLedger(missingPath);

    expect(first).toEqual(createEmptyRetiredLedger());
    expect(first).not.toBe(second);
    expect(first.strategies).not.toBe(second.strategies);
  });
});
