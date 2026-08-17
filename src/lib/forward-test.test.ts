import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasOperationStatus,
  isRetiredForwardStrategy,
  loadForwardResults,
  loadRetiredForwardStrategies,
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
