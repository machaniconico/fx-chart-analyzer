import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasOperationStatus,
  formatQuarterlyStability,
  isRetiredForwardStrategy,
  loadForwardResults,
  loadRetiredForwardStrategies,
  parseMonthlySummary,
  parseSelectionEvidence,
  selectionRankLabel,
  type ForwardResultsFile,
  type ForwardStrategyResult,
  type RetiredForwardStrategy,
} from './forward-test';

const REGISTERED_AT = 1_700_000_000;

const retiredStrategy = (
  strategyId = 'break-bb-gbpjpy-v1',
  registeredAt = REGISTERED_AT,
): RetiredForwardStrategy => ({
  strategyId,
  meta: {
    id: strategyId,
    name: 'GBPJPY ボリンジャーブレイク',
    version: 1,
    pair: 'GBPJPY',
    timeframe: 'h1',
    registeredAt,
  },
  retiredAt: '2026-08-17T12:00:00.000Z',
  reason: '淘汰基準に到達',
  finalSnapshot: {
    tradeCount: 20,
    profitFactor: 0.85,
    cumulativeProfitYen: -12_345,
    operationPeriod: {
      registeredAt,
      firstConfirmedDate: '2026-07-01',
      confirmedThrough: null,
      confirmedDayCount: 48,
    },
  },
});

const emptyForwardMetrics: ForwardStrategyResult['forward']['metrics'] = {
  spreadPips: null,
  winRate: null,
  profitFactor: null,
  maxDrawdownPips: null,
  maxDrawdownYen: null,
  maxDrawdownPct: null,
  tradeCount: 0,
  netPips: null,
  netProfitYen: null,
  grossProfitPips: null,
  grossLossPips: null,
  grossProfitYen: null,
  grossLossYen: null,
  riskRewardRatio: null,
  averageWinYen: null,
  averageLossYen: null,
  maxConsecutiveWins: 0,
  maxConsecutiveLosses: 0,
};

const selectionEvidence = {
  adoptedAt: '2026-08-18',
  reportId: 'selection-report-v1',
  candidatePool: 96,
  passedCount: 27,
  inSampleRank: 2,
  optimization: {
    netProfitYen: 269980,
    profitFactor: 1.2,
    tradeCount: 171,
  },
  validation: {
    netProfitYen: 117940,
    profitFactor: 1.24,
  },
  quarterlyStability: {
    positive: 4,
    total: 4,
  },
  reservations: ['採用時点の留保'],
};

const strategyWithStatus = (operationStatus: unknown): ForwardStrategyResult => ({
  meta: {
    id: 'forward-strategy',
    name: 'フォワード戦略',
    version: 1,
    pair: 'USDJPY',
    timeframe: 'h1',
    registeredAt: REGISTERED_AT,
  },
  operationStatus: operationStatus as ForwardStrategyResult['operationStatus'],
  forward: {
    metrics: emptyForwardMetrics,
    trades: [],
    equityCurve: [],
  },
  backtestReference: emptyForwardMetrics,
  barsEvaluated: 0,
});

const responseWithJson = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const stubFetch = (response: Response) => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('isRetiredForwardStrategy', () => {
  it.each([
    {
      name: 'null entry',
      invalid: () => null,
    },
    {
      name: 'primitive entry',
      invalid: () => 'retired-strategy',
    },
    {
      name: 'array entry',
      invalid: () => [],
    },
    {
      name: 'entry without a record meta',
      invalid: (strategy: RetiredForwardStrategy) => ({ ...strategy, meta: null }),
    },
    {
      name: 'entry without a record final snapshot',
      invalid: (strategy: RetiredForwardStrategy) => ({ ...strategy, finalSnapshot: null }),
    },
    {
      name: 'entry without a record operation period',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        finalSnapshot: { ...strategy.finalSnapshot, operationPeriod: [] },
      }),
    },
    {
      name: 'non-string strategy id',
      invalid: (strategy: RetiredForwardStrategy) => ({ ...strategy, strategyId: 1 }),
    },
    {
      name: 'non-string retirement date',
      invalid: (strategy: RetiredForwardStrategy) => ({ ...strategy, retiredAt: 0 }),
    },
    {
      name: 'unparseable retirement date',
      invalid: (strategy: RetiredForwardStrategy) => ({ ...strategy, retiredAt: 'not-a-date' }),
    },
    {
      name: 'non-string reason',
      invalid: (strategy: RetiredForwardStrategy) => ({ ...strategy, reason: null }),
    },
    {
      name: 'non-string meta id',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        meta: { ...strategy.meta, id: 1 },
      }),
    },
    {
      name: 'meta id that differs from the strategy id',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        meta: { ...strategy.meta, id: 'different-id' },
      }),
    },
    {
      name: 'non-string name',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        meta: { ...strategy.meta, name: false },
      }),
    },
    {
      name: 'unsupported meta version',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        meta: { ...strategy.meta, version: 2 },
      }),
    },
    {
      name: 'unsupported pair',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        meta: { ...strategy.meta, pair: 'CADJPY' },
      }),
    },
    {
      name: 'unsupported timeframe',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        meta: { ...strategy.meta, timeframe: 'm1' },
      }),
    },
    {
      name: 'non-number meta registration time',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        meta: { ...strategy.meta, registeredAt: String(REGISTERED_AT) },
      }),
    },
    {
      name: 'non-integer meta registration time',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        meta: { ...strategy.meta, registeredAt: REGISTERED_AT + 0.5 },
        finalSnapshot: {
          ...strategy.finalSnapshot,
          operationPeriod: {
            ...strategy.finalSnapshot.operationPeriod,
            registeredAt: REGISTERED_AT + 0.5,
          },
        },
      }),
    },
    {
      name: 'non-number trade count',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        finalSnapshot: { ...strategy.finalSnapshot, tradeCount: '20' },
      }),
    },
    {
      name: 'non-integer trade count',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        finalSnapshot: { ...strategy.finalSnapshot, tradeCount: 20.5 },
      }),
    },
    {
      name: 'negative trade count',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        finalSnapshot: { ...strategy.finalSnapshot, tradeCount: -1 },
      }),
    },
    {
      name: 'non-number profit factor',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        finalSnapshot: { ...strategy.finalSnapshot, profitFactor: '0.85' },
      }),
    },
    {
      name: 'non-finite profit factor',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        finalSnapshot: { ...strategy.finalSnapshot, profitFactor: Number.POSITIVE_INFINITY },
      }),
    },
    {
      name: 'non-number cumulative profit',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        finalSnapshot: { ...strategy.finalSnapshot, cumulativeProfitYen: '-12345' },
      }),
    },
    {
      name: 'non-finite cumulative profit',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        finalSnapshot: { ...strategy.finalSnapshot, cumulativeProfitYen: Number.NaN },
      }),
    },
    {
      name: 'non-number operation registration time',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        finalSnapshot: {
          ...strategy.finalSnapshot,
          operationPeriod: {
            ...strategy.finalSnapshot.operationPeriod,
            registeredAt: String(REGISTERED_AT),
          },
        },
      }),
    },
    {
      name: 'non-integer operation registration time',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        finalSnapshot: {
          ...strategy.finalSnapshot,
          operationPeriod: {
            ...strategy.finalSnapshot.operationPeriod,
            registeredAt: REGISTERED_AT + 0.5,
          },
        },
      }),
    },
    {
      name: 'operation registration time that differs from meta',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        finalSnapshot: {
          ...strategy.finalSnapshot,
          operationPeriod: {
            ...strategy.finalSnapshot.operationPeriod,
            registeredAt: REGISTERED_AT + 1,
          },
        },
      }),
    },
    {
      name: 'invalid first confirmed date value',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        finalSnapshot: {
          ...strategy.finalSnapshot,
          operationPeriod: {
            ...strategy.finalSnapshot.operationPeriod,
            firstConfirmedDate: 0,
          },
        },
      }),
    },
    {
      name: 'invalid confirmed-through value',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        finalSnapshot: {
          ...strategy.finalSnapshot,
          operationPeriod: {
            ...strategy.finalSnapshot.operationPeriod,
            confirmedThrough: false,
          },
        },
      }),
    },
    {
      name: 'non-number confirmed day count',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        finalSnapshot: {
          ...strategy.finalSnapshot,
          operationPeriod: {
            ...strategy.finalSnapshot.operationPeriod,
            confirmedDayCount: '48',
          },
        },
      }),
    },
    {
      name: 'non-integer confirmed day count',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        finalSnapshot: {
          ...strategy.finalSnapshot,
          operationPeriod: {
            ...strategy.finalSnapshot.operationPeriod,
            confirmedDayCount: 48.5,
          },
        },
      }),
    },
    {
      name: 'negative confirmed day count',
      invalid: (strategy: RetiredForwardStrategy) => ({
        ...strategy,
        finalSnapshot: {
          ...strategy.finalSnapshot,
          operationPeriod: {
            ...strategy.finalSnapshot.operationPeriod,
            confirmedDayCount: -1,
          },
        },
      }),
    },
  ])('rejects $name', ({ invalid }) => {
    expect(isRetiredForwardStrategy(invalid(retiredStrategy()))).toBe(false);
  });

  it.each([
    { profitFactor: 0.85, firstConfirmedDate: '2026-07-01', confirmedThrough: null },
    { profitFactor: null, firstConfirmedDate: null, confirmedThrough: '2026-08-16' },
  ])(
    'accepts a complete entry with nullable metrics and dates',
    ({ profitFactor, firstConfirmedDate, confirmedThrough }) => {
      const strategy = retiredStrategy();
      strategy.finalSnapshot.profitFactor = profitFactor;
      strategy.finalSnapshot.operationPeriod.firstConfirmedDate = firstConfirmedDate;
      strategy.finalSnapshot.operationPeriod.confirmedThrough = confirmedThrough;

      expect(isRetiredForwardStrategy(strategy)).toBe(true);
    },
  );
});

describe('hasOperationStatus', () => {
  it.each(['active', 'probation', 'retire_candidate'] as const)(
    'accepts the %s status with a reason',
    (status) => {
      expect(hasOperationStatus(strategyWithStatus({ status, reason: '判定理由' }))).toBe(true);
    },
  );

  it.each([
    { name: 'missing status object', operationStatus: undefined },
    { name: 'null status object', operationStatus: null },
    { name: 'unknown status', operationStatus: { status: 'paused', reason: '停止中' } },
    { name: 'non-string reason', operationStatus: { status: 'active', reason: 123 } },
  ])('rejects $name', ({ operationStatus }) => {
    expect(hasOperationStatus(strategyWithStatus(operationStatus))).toBe(false);
  });
});

describe('parseSelectionEvidence', () => {
  it('accepts a complete evidence object', () => {
    expect(parseSelectionEvidence(selectionEvidence)).toEqual(selectionEvidence);
  });

  it('accepts an optional human-readable report label', () => {
    const evidence = {
      ...selectionEvidence,
      reportLabel: '改善ウェーブ4・84候補深履歴ラン',
    };

    expect(parseSelectionEvidence(evidence)).toEqual(evidence);
  });

  it('accepts legacy evidence without the optional passed count', () => {
    const { passedCount: _passedCount, ...legacyEvidence } = selectionEvidence;

    expect(parseSelectionEvidence(legacyEvidence)).toEqual(legacyEvidence);
  });

  it.each([
    { name: 'missing evidence', value: undefined },
    {
      name: 'missing rank and note',
      value: (() => {
        const value: Record<string, unknown> = { ...selectionEvidence };
        delete value.inSampleRank;
        return value;
      })(),
    },
    {
      name: 'wrong report label type',
      value: { ...selectionEvidence, reportLabel: 123 },
    },
    {
      name: 'wrong passed count type',
      value: { ...selectionEvidence, passedCount: '27' },
    },
    {
      name: 'passed count exceeds candidate pool',
      value: { ...selectionEvidence, passedCount: 97 },
    },
    {
      name: 'wrong nested metric type',
      value: {
        ...selectionEvidence,
        optimization: { ...selectionEvidence.optimization, profitFactor: '1.20' },
      },
    },
  ])('returns undefined for $name', ({ value }) => {
    expect(parseSelectionEvidence(value)).toBeUndefined();
  });
});

describe('parseMonthlySummary', () => {
  const summary = {
    months: [
      {
        month: '2026-07',
        total: { netProfitYen: 12_345, netPips: 6.7, tradeCount: 4 },
        strategies: [
          {
            id: 'retired-v1',
            name: '退役EA',
            netProfitYen: -100,
            netPips: -1.2,
            tradeCount: 1,
            confirmedDays: 1,
            retired: true,
          },
        ],
        confirmedDays: 2,
        complete: true,
      },
    ],
  };

  it('accepts a valid optional summary', () => {
    expect(parseMonthlySummary(summary)).toEqual(summary);
  });

  it.each([
    { name: 'missing value', value: undefined },
    { name: 'null value', value: null },
    { name: 'missing months', value: {} },
    { name: 'invalid month', value: { ...summary, months: [{ ...summary.months[0], month: '2026-13' }] } },
    {
      name: 'invalid total metric',
      value: {
        ...summary,
        months: [{ ...summary.months[0], total: { ...summary.months[0].total, tradeCount: '4' } }],
      },
    },
    {
      name: 'invalid strategy retired flag',
      value: {
        ...summary,
        months: [{
          ...summary.months[0],
          strategies: [{ ...summary.months[0].strategies[0], retired: 'true' }],
        }],
      },
    },
  ])('returns undefined for $name', ({ value }) => {
    expect(parseMonthlySummary(value)).toBeUndefined();
  });
});

describe('formatQuarterlyStability', () => {
  it('marks every quarter as positive only when all quarters are positive', () => {
    expect(formatQuarterlyStability({ positive: 4, total: 4 })).toBe('4/4全四半期プラス');
    expect(formatQuarterlyStability({ positive: 3, total: 4 })).toBe(
      '3/4四半期プラス(1四半期マイナス)',
    );
    expect(formatQuarterlyStability({ positive: 3, total: 4 })).not.toContain('全四半期プラス');
  });

  it('marks a missing quarterly check as untested', () => {
    expect(formatQuarterlyStability(null)).toBe('未検査');
  });
});

describe('selectionRankLabel', () => {
  it('makes the rank denominator explicit when passedCount is present', () => {
    expect(selectionRankLabel({ candidatePool: 96, passedCount: 27, inSampleRank: 2 })).toBe(
      '96候補中の合格27件で in-sample 2位',
    );
  });

  it('keeps legacy labels when passedCount is absent', () => {
    expect(selectionRankLabel({ candidatePool: 96, inSampleRank: 2 })).toBe(
      '96候補中 in-sample 2位',
    );
    expect(selectionRankLabel({ candidatePool: 72 })).toBe('72候補');
    expect(selectionRankLabel({ candidatePool: 72, passedCount: 9 })).toBe('72候補(合格9件)');
  });
});

describe('loadForwardResults', () => {
  const validResults = (): ForwardResultsFile => ({
    schemaVersion: 3,
    computedAt: '2026-08-17T12:00:00.000Z',
    strategies: [strategyWithStatus({ status: 'active', reason: '判定理由' })],
  });

  it('loads a valid results fixture without changing its payload', async () => {
    const fixture = validResults();
    const fetchMock = stubFetch(responseWithJson(fixture));

    await expect(loadForwardResults()).resolves.toEqual(fixture);
    expect(fetchMock).toHaveBeenCalledWith('/data/forward/results.json', { cache: 'no-cache' });
  });

  it('preserves valid selection evidence on a strategy', async () => {
    const fixture = validResults();
    fixture.strategies[0] = { ...fixture.strategies[0], selectionEvidence };
    stubFetch(responseWithJson(fixture));

    await expect(loadForwardResults()).resolves.toEqual(fixture);
  });

  it('preserves a valid monthly summary', async () => {
    const fixture = validResults();
    const monthlySummary = {
      months: [{
        month: '2026-08',
        total: { netProfitYen: 100, netPips: 1.2, tradeCount: 1 },
        strategies: [{
          id: fixture.strategies[0].meta.id,
          name: fixture.strategies[0].meta.name,
          netProfitYen: 100,
          netPips: 1.2,
          tradeCount: 1,
          confirmedDays: 1,
          retired: false,
        }],
        confirmedDays: 1,
        complete: false,
      }],
    };
    const payload = { ...fixture, monthlySummary };
    stubFetch(responseWithJson(payload));

    await expect(loadForwardResults()).resolves.toEqual(payload);
  });

  it('drops malformed monthly summary while keeping the result usable', async () => {
    const fixture = validResults();
    (fixture as unknown as Record<string, unknown>).monthlySummary = {
      months: [{ month: '2026-08', complete: 'false' }],
    };
    stubFetch(responseWithJson(fixture));

    const loaded = await loadForwardResults();

    expect(Object.prototype.hasOwnProperty.call(loaded, 'monthlySummary')).toBe(false);
  });

  it('drops malformed optional selection evidence while keeping the result usable', async () => {
    const fixture = validResults();
    (fixture.strategies[0] as unknown as Record<string, unknown>).selectionEvidence = {
      ...selectionEvidence,
      validation: { ...selectionEvidence.validation, profitFactor: '1.24' },
    };
    stubFetch(responseWithJson(fixture));

    const loaded = await loadForwardResults();

    expect(Object.prototype.hasOwnProperty.call(loaded.strategies[0], 'selectionEvidence')).toBe(false);
  });

  it.each([
    { name: 'non-object payload', payload: () => null },
    {
      name: 'non-number schema version',
      payload: () => ({ ...validResults(), schemaVersion: '3' }),
    },
    {
      name: 'missing computedAt',
      payload: () => {
        const payload = validResults();
        delete (payload as Partial<ForwardResultsFile>).computedAt;
        return payload;
      },
    },
    {
      name: 'strategies is not an array',
      payload: () => ({ ...validResults(), strategies: {} }),
    },
    {
      name: 'strategy is missing meta',
      payload: () => ({ ...validResults(), strategies: [{ forward: {} }] }),
    },
    {
      name: 'strategy is missing forward',
      payload: () => ({ ...validResults(), strategies: [{ meta: {} }] }),
    },
  ])('throws a Japanese shape error for $name', async ({ payload }) => {
    stubFetch(responseWithJson(payload()));

    await expect(loadForwardResults()).rejects.toThrow('フォワードテスト結果の形式が不正です');
  });
});

describe('loadRetiredForwardStrategies', () => {
  it('requests the retired ledger without cache and returns an empty list for 404', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 404 }));

    await expect(loadRetiredForwardStrategies()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/data/forward/retired.json', { cache: 'no-cache' });
  });

  it('throws the loader error for a non-404 unsuccessful response', async () => {
    stubFetch(new Response(null, { status: 503 }));

    await expect(loadRetiredForwardStrategies()).rejects.toThrow(
      '退役EAの記録を読み込めませんでした',
    );
  });

  it('propagates a fetch rejection', async () => {
    const networkError = new TypeError('network unavailable');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(networkError));

    await expect(loadRetiredForwardStrategies()).rejects.toBe(networkError);
  });

  it('propagates a JSON parse failure from a successful response', async () => {
    stubFetch(new Response('{broken json', { status: 200 }));

    await expect(loadRetiredForwardStrategies()).rejects.toBeInstanceOf(SyntaxError);
  });

  it.each([
    { name: 'non-object payload', payload: () => null },
    {
      // 有効エントリ入りで検証する: strategies が空だと schemaVersion ガードを
      // 削除してもテストが通ってしまい、ゲート退行を検出できない
      name: 'schema version mismatch',
      payload: () => {
        const valid = retiredStrategy();
        return {
          schemaVersion: 2,
          strategies: { [`${valid.strategyId}@${valid.meta.registeredAt}`]: valid },
        };
      },
    },
    { name: 'missing strategies', payload: () => ({ schemaVersion: 1 }) },
    { name: 'non-object strategies', payload: () => ({ schemaVersion: 1, strategies: [] }) },
  ])('returns an empty list for $name', async ({ payload }) => {
    stubFetch(responseWithJson(payload()));

    await expect(loadRetiredForwardStrategies()).resolves.toEqual([]);
  });

  it('keeps valid entries, rejects mixed invalid entries, and warns for each rejection reason', async () => {
    const valid = retiredStrategy();
    const invalidSchemaBase = retiredStrategy('invalid-schema');
    const invalidSchema = {
      ...invalidSchemaBase,
      meta: { ...invalidSchemaBase.meta, version: 2 },
    };
    const mismatchedKey = retiredStrategy('mismatched-key');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubFetch(responseWithJson({
      schemaVersion: 1,
      strategies: {
        [`${valid.strategyId}@${valid.meta.registeredAt}`]: valid,
        [`${invalidSchema.strategyId}@${invalidSchema.meta.registeredAt}`]: invalidSchema,
        'unrelated-ledger-key': mismatchedKey,
      },
    }));

    await expect(loadRetiredForwardStrategies()).resolves.toEqual([valid]);
    // 文言のリライトで壊れないよう、理由の識別語とキーの対応だけを検証する
    // (呼び出し順にも依存しない)
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('スキーマ不一致'),
      `${invalidSchema.strategyId}@${invalidSchema.meta.registeredAt}`,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('キー不一致'),
      'unrelated-ledger-key',
    );
  });

  it.each([
    ['legacy key first', (strategy: RetiredForwardStrategy) => [
      [strategy.strategyId, strategy],
      [`${strategy.strategyId}@${strategy.meta.registeredAt}`, strategy],
    ]],
    ['composite key first', (strategy: RetiredForwardStrategy) => [
      [`${strategy.strategyId}@${strategy.meta.registeredAt}`, strategy],
      [strategy.strategyId, strategy],
    ]],
  ] as const)('deduplicates one generation when the %s', async (_name, entriesFor) => {
    const strategy = retiredStrategy();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubFetch(responseWithJson({
      schemaVersion: 1,
      strategies: Object.fromEntries(entriesFor(strategy)),
    }));

    await expect(loadRetiredForwardStrategies()).resolves.toEqual([strategy]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps separate registrations of the same strategy id', async () => {
    const firstGeneration = retiredStrategy();
    const nextGeneration = retiredStrategy(
      firstGeneration.strategyId,
      firstGeneration.meta.registeredAt + 86_400,
    );
    stubFetch(responseWithJson({
      schemaVersion: 1,
      strategies: {
        [`${firstGeneration.strategyId}@${firstGeneration.meta.registeredAt}`]: firstGeneration,
        [`${nextGeneration.strategyId}@${nextGeneration.meta.registeredAt}`]: nextGeneration,
      },
    }));

    await expect(loadRetiredForwardStrategies()).resolves.toEqual([
      firstGeneration,
      nextGeneration,
    ]);
  });

  it('rejects a non-integer meta.registeredAt even when the ledger key has an integer suffix', async () => {
    const strategy = retiredStrategy();
    strategy.meta.registeredAt += 0.5;
    strategy.finalSnapshot.operationPeriod.registeredAt += 0.5;
    const ledgerKey = `${strategy.strategyId}@${REGISTERED_AT}`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubFetch(responseWithJson({
      schemaVersion: 1,
      strategies: { [ledgerKey]: strategy },
    }));

    await expect(loadRetiredForwardStrategies()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      '退役EAエントリを表示対象から除外しました(スキーマ不一致):',
      ledgerKey,
    );
  });
});
