import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildFinalSnapshot,
  RETIRED_LEDGER_SCHEMA_VERSION,
  parseCliArgs,
  retiredStrategyLedgerKey,
  retireStrategy,
} from './retire-strategy.mjs';
import { fingerprintStrategyDefinition } from './run-forward-test.mjs';

const strategyId = 'retire-test-v1';
const registeredAt = 1_700_000_000;
const ledgerKey = retiredStrategyLedgerKey(strategyId, registeredAt);
const strategy = {
  meta: {
    id: strategyId,
    name: 'Retirement test',
    version: 1,
    pair: 'USDJPY',
    timeframe: 'h1',
    registeredAt,
  },
  id: strategyId,
  name: 'Retirement test',
  direction: 'long',
  entryConditions: [{ type: 'maCross' }],
  exit: { stopLossPips: 10, takeProfitPips: 20 },
};

const trade = (id, netProfitYen) => ({ id, netProfitYen });

const history = {
  schemaVersion: 1,
  strategies: {
    [strategyId]: {
      meta: strategy.meta,
      strategyFingerprint: fingerprintStrategyDefinition(strategy),
      initialBalanceYen: 1_000_000,
      spreadPips: 0.9,
      days: {
        '2023-11-15': {
          pnl: { netPips: 15, netProfitYen: 15_000 },
          trades: [trade(1, 10_000), trade(2, 5_000)],
        },
        '2023-11-16': {
          pnl: { netPips: -5, netProfitYen: -5_000 },
          trades: [trade(3, -5_000)],
        },
      },
    },
  },
};

const writeJson = async (filePath, value) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const setupProject = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fx-retire-strategy-test-'));
  await writeJson(path.join(root, 'strategies/virtual', `${strategyId}.json`), strategy);
  await writeJson(path.join(root, 'public/data/forward/history.json'), history);
  return root;
};

describe('retire strategy CLI', () => {
  it('accepts the retirement reason as either an option or positional text', () => {
    expect(parseCliArgs([strategyId, '--reason', 'PF threshold failure'])).toEqual({
      strategyId,
      reason: 'PF threshold failure',
      help: false,
    });
    expect(parseCliArgs([strategyId, 'manual', 'review'])).toEqual({
      strategyId,
      reason: 'manual review',
      help: false,
    });
    expect(parseCliArgs([
      strategyId,
      '--scope',
      'observation',
      '--reason',
      'observation review',
    ])).toEqual({
      strategyId,
      reason: 'observation review',
      scope: 'observation',
      help: false,
    });
    expect(parseCliArgs([
      strategyId,
      '--scope=observation',
      'manual',
      'review',
    ])).toEqual({
      strategyId,
      reason: 'manual review',
      scope: 'observation',
      help: false,
    });
    expect(() => parseCliArgs([strategyId])).toThrow(/reason/i);
    expect(() => parseCliArgs([strategyId, '--scope', 'unknown', '--reason', 'x']))
      .toThrow(/scope must be one of virtual, observation/);
  });
});

describe('retireStrategy', () => {
  it('moves the EA and appends its final confirmed performance exactly once', async () => {
    const root = await setupProject();
    const retiredAt = '2026-08-17T12:34:56.000Z';
    const originalLedgerEntry = {
      strategyId: 'already-retired-v1',
      retiredAt: '2026-07-01T00:00:00.000Z',
      reason: 'previous decision',
      finalSnapshot: { immutable: true },
    };
    await writeJson(path.join(root, 'public/data/forward/retired.json'), {
      schemaVersion: RETIRED_LEDGER_SCHEMA_VERSION,
      strategies: {
        [originalLedgerEntry.strategyId]: originalLedgerEntry,
      },
    });
    const historyPath = path.join(root, 'public/data/forward/history.json');
    const resultsPath = path.join(root, 'public/data/forward/results.json');
    await writeJson(resultsPath, { stable: 'forward results' });
    const historyBytesBeforeRetirement = await readFile(historyPath, 'utf8');
    const resultsBytesBeforeRetirement = await readFile(resultsPath, 'utf8');

    try {
      const first = await retireStrategy({
        projectRoot: root,
        strategyId,
        reason: 'PFが退役基準を下回ったため',
        retiredAt,
      });
      const sourcePath = path.join(root, 'strategies/virtual', `${strategyId}.json`);
      const retiredPath = path.join(root, 'strategies/retired', `${ledgerKey}.json`);
      await expect(access(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(JSON.parse(await readFile(retiredPath, 'utf8'))).toEqual(strategy);

      const ledgerPath = path.join(root, 'public/data/forward/retired.json');
      const ledgerAfterFirstRun = JSON.parse(await readFile(ledgerPath, 'utf8'));
      expect(first.alreadyRetired).toBe(false);
      expect(first.moved).toBe(true);
      expect(ledgerAfterFirstRun.strategies['already-retired-v1']).toEqual(
        originalLedgerEntry,
      );
      expect(ledgerAfterFirstRun.strategies[ledgerKey]).toEqual({
        strategyId,
        meta: strategy.meta,
        retiredAt,
        reason: 'PFが退役基準を下回ったため',
        finalSnapshot: {
          tradeCount: 3,
          profitFactor: 3,
          cumulativeProfitYen: 10_000,
          operationPeriod: {
            registeredAt,
            firstConfirmedDate: '2023-11-15',
            confirmedThrough: '2023-11-16',
            confirmedDayCount: 2,
          },
        },
      });

      const ledgerBytesAfterFirstRun = await readFile(ledgerPath, 'utf8');
      const second = await retireStrategy({
        projectRoot: root,
        strategyId,
        reason: 'a later invocation must not rewrite the reason',
        retiredAt: '2026-08-18T00:00:00.000Z',
      });

      expect(second.alreadyRetired).toBe(true);
      expect(second.moved).toBe(false);
      expect(await readFile(ledgerPath, 'utf8')).toBe(ledgerBytesAfterFirstRun);
      expect(await readFile(historyPath, 'utf8')).toBe(historyBytesBeforeRetirement);
      expect(await readFile(resultsPath, 'utf8')).toBe(resultsBytesBeforeRetirement);
      expect(Object.keys(JSON.parse(ledgerBytesAfterFirstRun).strategies)).toEqual([
        'already-retired-v1',
        ledgerKey,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retires a re-registered generation with the same ID into a separate ledger entry', async () => {
    const root = await setupProject();
    const nextRegisteredAt = registeredAt + 86_400;
    const nextLedgerKey = retiredStrategyLedgerKey(strategyId, nextRegisteredAt);
    const nextStrategy = JSON.parse(JSON.stringify({
      ...strategy,
      meta: {
        ...strategy.meta,
        registeredAt: nextRegisteredAt,
      },
    }));
    const nextHistory = JSON.parse(JSON.stringify(history));
    nextHistory.strategies[strategyId] = {
      ...nextHistory.strategies[strategyId],
      meta: nextStrategy.meta,
      strategyFingerprint: fingerprintStrategyDefinition(nextStrategy),
    };

    try {
      await retireStrategy({
        projectRoot: root,
        strategyId,
        reason: 'first generation retirement',
        retiredAt: '2026-08-17T00:00:00.000Z',
      });
      await writeJson(
        path.join(root, 'strategies/virtual', `${strategyId}.json`),
        nextStrategy,
      );
      await writeJson(
        path.join(root, 'public/data/forward/history.json'),
        nextHistory,
      );

      const second = await retireStrategy({
        projectRoot: root,
        strategyId,
        reason: 'second generation retirement',
        retiredAt: '2026-08-18T00:00:00.000Z',
      });
      const ledger = JSON.parse(
        await readFile(path.join(root, 'public/data/forward/retired.json'), 'utf8'),
      );

      expect(second.alreadyRetired).toBe(false);
      expect(second.moved).toBe(true);
      expect(Object.keys(ledger.strategies)).toEqual([ledgerKey, nextLedgerKey]);
      expect(ledger.strategies[ledgerKey].meta.registeredAt).toBe(registeredAt);
      expect(ledger.strategies[nextLedgerKey]).toMatchObject({
        strategyId,
        meta: { registeredAt: nextRegisteredAt },
        reason: 'second generation retirement',
      });
      expect(JSON.parse(await readFile(
        path.join(root, 'strategies/retired', `${ledgerKey}.json`),
        'utf8',
      ))).toEqual(strategy);
      expect(JSON.parse(await readFile(
        path.join(root, 'strategies/retired', `${nextLedgerKey}.json`),
        'utf8',
      ))).toEqual(nextStrategy);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retires and re-registers observation generations in the observation scope', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fx-retire-observation-test-'));
    const observationId = 'obs-retire-test-v1';
    const observationDirectory = path.join(root, 'strategies/observation');
    const observationLedgerPath = path.join(
      root,
      'public/data/forward/observation-retired.json',
    );
    const observationHistoryPath = path.join(
      root,
      'public/data/forward/observation-history.json',
    );
    const makeObservation = (nextRegisteredAt) => JSON.parse(JSON.stringify({
      ...strategy,
      meta: {
        ...strategy.meta,
        id: observationId,
        name: 'Observation retirement test',
        registeredAt: nextRegisteredAt,
      },
      id: observationId,
      name: 'Observation retirement test',
    }));
    const firstObservation = makeObservation(registeredAt);
    const firstHistory = {
      schemaVersion: 1,
      strategies: {
        [observationId]: {
          ...JSON.parse(JSON.stringify(history.strategies[strategyId])),
          meta: firstObservation.meta,
          strategyFingerprint: fingerprintStrategyDefinition(firstObservation),
        },
      },
    };
    const secondObservation = makeObservation(registeredAt + 86_400);
    const secondHistory = JSON.parse(JSON.stringify(firstHistory));
    secondHistory.strategies[observationId] = {
      ...secondHistory.strategies[observationId],
      meta: secondObservation.meta,
      strategyFingerprint: fingerprintStrategyDefinition(secondObservation),
    };

    try {
      await writeJson(
        path.join(observationDirectory, `${observationId}.json`),
        firstObservation,
      );
      await writeJson(observationHistoryPath, firstHistory);
      await writeJson(observationLedgerPath, { schemaVersion: 1, strategies: {} });

      const first = await retireStrategy({
        projectRoot: root,
        strategyId: observationId,
        scope: 'observation',
        reason: 'observation generation one retired',
        retiredAt: '2026-08-18T00:00:00.000Z',
      });
      expect(first.moved).toBe(true);
      expect(first.ledgerPath).toBe(observationLedgerPath);
      expect(JSON.parse(await readFile(observationLedgerPath, 'utf8')).strategies)
        .toHaveProperty(`${observationId}@${registeredAt}`);

      await writeJson(
        path.join(observationDirectory, `${observationId}.json`),
        secondObservation,
      );
      await writeJson(observationHistoryPath, secondHistory);
      await expect(retireStrategy({
        projectRoot: root,
        strategyId: observationId,
        scope: 'observation',
        reason: 'observation generation two retired',
        retiredAt: '2026-08-19T00:00:00.000Z',
      })).resolves.toMatchObject({ moved: true, alreadyRetired: false });

      const observationLedger = JSON.parse(await readFile(observationLedgerPath, 'utf8'));
      expect(Object.keys(observationLedger.strategies)).toEqual([
        `${observationId}@${registeredAt}`,
        `${observationId}@${registeredAt + 86_400}`,
      ]);
      await expect(
        access(path.join(root, 'public/data/forward/retired.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers an unledgered compound archive for a later generation', async () => {
    const root = await setupProject();
    const nextRegisteredAt = registeredAt + 86_400;
    const nextLedgerKey = retiredStrategyLedgerKey(strategyId, nextRegisteredAt);
    const nextStrategy = JSON.parse(JSON.stringify({
      ...strategy,
      meta: { ...strategy.meta, registeredAt: nextRegisteredAt },
    }));
    const nextHistory = JSON.parse(JSON.stringify(history));
    nextHistory.strategies[strategyId] = {
      ...nextHistory.strategies[strategyId],
      meta: nextStrategy.meta,
      strategyFingerprint: fingerprintStrategyDefinition(nextStrategy),
    };

    try {
      await retireStrategy({
        projectRoot: root,
        strategyId,
        reason: 'first generation retirement',
        retiredAt: '2026-08-17T00:00:00.000Z',
      });
      const nextSourcePath = path.join(root, 'strategies/virtual', `${strategyId}.json`);
      const orphanedArchivePath = path.join(
        root,
        'strategies/retired',
        `${nextLedgerKey}.json`,
      );
      await writeJson(nextSourcePath, nextStrategy);
      await writeJson(path.join(root, 'public/data/forward/history.json'), nextHistory);
      await rename(nextSourcePath, orphanedArchivePath);

      const recovered = await retireStrategy({
        projectRoot: root,
        strategyId,
        reason: 'resume interrupted second retirement',
        retiredAt: '2026-08-18T00:00:00.000Z',
      });
      const ledger = JSON.parse(
        await readFile(path.join(root, 'public/data/forward/retired.json'), 'utf8'),
      );

      expect(recovered.alreadyRetired).toBe(false);
      expect(recovered.moved).toBe(false);
      expect(recovered.strategyPath).toBe(orphanedArchivePath);
      expect(Object.keys(ledger.strategies)).toEqual([ledgerKey, nextLedgerKey]);
      expect(ledger.strategies[nextLedgerKey].reason).toBe(
        'resume interrupted second retirement',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rounds cumulative yen once and records a null profit factor for zero trades', () => {
    const fractionalHistory = JSON.parse(JSON.stringify(history.strategies[strategyId]));
    fractionalHistory.days['2023-11-15'].pnl.netProfitYen = 10.4;
    fractionalHistory.days['2023-11-15'].trades = [trade(1, 10.4)];
    fractionalHistory.days['2023-11-16'].pnl.netProfitYen = 10.4;
    fractionalHistory.days['2023-11-16'].trades = [trade(2, 10.4)];
    expect(buildFinalSnapshot(strategy, fractionalHistory).cumulativeProfitYen).toBe(21);

    const zeroTradeHistory = JSON.parse(JSON.stringify(history.strategies[strategyId]));
    for (const day of Object.values(zeroTradeHistory.days)) {
      day.pnl.netProfitYen = 0;
      day.trades = [];
    }
    expect(buildFinalSnapshot(strategy, zeroTradeHistory)).toMatchObject({
      tradeCount: 0,
      profitFactor: null,
      cumulativeProfitYen: 0,
    });
  });

  it('does not move an EA when no confirmed forward history exists', async () => {
    const root = await setupProject();
    await writeJson(path.join(root, 'public/data/forward/history.json'), {
      schemaVersion: 1,
      strategies: {},
    });

    try {
      await expect(
        retireStrategy({
          projectRoot: root,
          strategyId,
          reason: 'missing evidence',
          retiredAt: '2026-08-17T00:00:00.000Z',
        }),
      ).rejects.toThrow(/forward history/i);
      expect(
        JSON.parse(
          await readFile(
            path.join(root, 'strategies/virtual', `${strategyId}.json`),
            'utf8',
          ),
        ),
      ).toEqual(strategy);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects performance recorded for different strategy rules', async () => {
    const root = await setupProject();
    const mismatchedHistory = JSON.parse(JSON.stringify(history));
    mismatchedHistory.strategies[strategyId].strategyFingerprint = '0'.repeat(64);
    await writeJson(
      path.join(root, 'public/data/forward/history.json'),
      mismatchedHistory,
    );

    try {
      await expect(
        retireStrategy({
          projectRoot: root,
          strategyId,
          reason: 'stale rules must not be archived',
          retiredAt: '2026-08-17T00:00:00.000Z',
        }),
      ).rejects.toThrow(/fingerprint/i);
      expect(
        JSON.parse(
          await readFile(
            path.join(root, 'strategies/virtual', `${strategyId}.json`),
            'utf8',
          ),
        ),
      ).toEqual(strategy);
      await expect(
        access(path.join(root, 'strategies/retired', `${ledgerKey}.json`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes concurrent retirements without losing either ledger entry', async () => {
    const root = await setupProject();
    const secondStrategyId = 'retire-concurrent-test-v1';
    const secondStrategy = JSON.parse(JSON.stringify({
      ...strategy,
      meta: {
        ...strategy.meta,
        id: secondStrategyId,
        name: 'Concurrent retirement test',
      },
      id: secondStrategyId,
      name: 'Concurrent retirement test',
    }));
    const concurrentHistory = JSON.parse(JSON.stringify(history));
    concurrentHistory.strategies[secondStrategyId] = {
      ...JSON.parse(JSON.stringify(history.strategies[strategyId])),
      meta: secondStrategy.meta,
      strategyFingerprint: fingerprintStrategyDefinition(secondStrategy),
    };
    await writeJson(
      path.join(root, 'strategies/virtual', `${secondStrategyId}.json`),
      secondStrategy,
    );
    await writeJson(
      path.join(root, 'public/data/forward/history.json'),
      concurrentHistory,
    );

    let releaseFirstWrite;
    let markFirstWriteStarted;
    let writeCount = 0;
    const firstWriteStarted = new Promise((resolve) => {
      markFirstWriteStarted = resolve;
    });
    const firstWriteGate = new Promise((resolve) => {
      releaseFirstWrite = resolve;
    });
    const controlledWriter = async (filePath, payload) => {
      writeCount += 1;
      if (writeCount === 1) {
        markFirstWriteStarted();
        await firstWriteGate;
      }
      await writeJson(filePath, payload);
    };

    try {
      const firstRetirement = retireStrategy({
        projectRoot: root,
        strategyId,
        reason: 'first concurrent retirement',
        retiredAt: '2026-08-17T00:00:00.000Z',
        writeLedger: controlledWriter,
      });
      await firstWriteStarted;
      const secondRetirement = retireStrategy({
        projectRoot: root,
        strategyId: secondStrategyId,
        reason: 'second concurrent retirement',
        retiredAt: '2026-08-17T00:00:01.000Z',
        writeLedger: controlledWriter,
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      releaseFirstWrite();
      await Promise.all([firstRetirement, secondRetirement]);

      const ledger = JSON.parse(
        await readFile(path.join(root, 'public/data/forward/retired.json'), 'utf8'),
      );
      expect(writeCount).toBe(2);
      expect(Object.keys(ledger.strategies)).toEqual([
        ledgerKey,
        retiredStrategyLedgerKey(secondStrategyId, registeredAt),
      ]);
      await expect(
        access(path.join(root, 'strategies/.retire-strategy.lock')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      releaseFirstWrite?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('restores the active definition when persisting the ledger fails', async () => {
    const root = await setupProject();
    const sourcePath = path.join(root, 'strategies/virtual', `${strategyId}.json`);
    const retiredPath = path.join(root, 'strategies/retired', `${ledgerKey}.json`);

    try {
      await expect(
        retireStrategy({
          projectRoot: root,
          strategyId,
          reason: 'forced write failure',
          retiredAt: '2026-08-17T00:00:00.000Z',
          writeLedger: async () => {
            throw new Error('forced ledger write failure');
          },
        }),
      ).rejects.toThrow('forced ledger write failure');
      expect(JSON.parse(await readFile(sourcePath, 'utf8'))).toEqual(strategy);
      await expect(access(retiredPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        access(path.join(root, 'strategies/.retire-strategy.lock')),
      ).rejects.toMatchObject({ code: 'ENOENT' });

      const retry = await retireStrategy({
        projectRoot: root,
        strategyId,
        reason: 'retry after write recovery',
        retiredAt: '2026-08-17T00:00:01.000Z',
      });
      expect(retry.alreadyRetired).toBe(false);
      expect(retry.moved).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not confuse an Object prototype property with an existing ledger entry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fx-retire-reserved-id-test-'));
    const reservedId = 'constructor';
    const reservedStrategy = JSON.parse(JSON.stringify({
      ...strategy,
      meta: {
        ...strategy.meta,
        id: reservedId,
        name: 'Reserved property ID test',
      },
      id: reservedId,
      name: 'Reserved property ID test',
    }));
    const reservedHistory = {
      schemaVersion: 1,
      strategies: {
        [reservedId]: {
          ...JSON.parse(JSON.stringify(history.strategies[strategyId])),
          meta: reservedStrategy.meta,
          strategyFingerprint: fingerprintStrategyDefinition(reservedStrategy),
        },
      },
    };
    await writeJson(
      path.join(root, 'strategies/virtual', `${reservedId}.json`),
      reservedStrategy,
    );
    await writeJson(
      path.join(root, 'public/data/forward/history.json'),
      reservedHistory,
    );

    try {
      const result = await retireStrategy({
        projectRoot: root,
        strategyId: reservedId,
        reason: 'reserved property regression',
        retiredAt: '2026-08-17T00:00:00.000Z',
      });
      const ledger = JSON.parse(
        await readFile(path.join(root, 'public/data/forward/retired.json'), 'utf8'),
      );

      expect(result.alreadyRetired).toBe(false);
      const reservedLedgerKey = retiredStrategyLedgerKey(reservedId, registeredAt);
      expect(Object.hasOwn(ledger.strategies, reservedLedgerKey)).toBe(true);
      expect(ledger.strategies[reservedLedgerKey].strategyId).toBe(reservedId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
