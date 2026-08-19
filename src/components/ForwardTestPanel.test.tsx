import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import observationHistory from '../../public/data/forward/observation-history.json';
import observationResults from '../../public/data/forward/observation-results.json';
import {
  ForwardTestPanel,
  MonthlySummarySection,
  ObservationCandidateSection,
  SelectionEvidenceDetails,
  loadObservationData,
  type ObservationCandidate,
  type ObservationPanelState,
} from './ForwardTestPanel';
import {
  formatQuarterlyStability,
  selectionRankLabel,
  type ForwardMetrics,
  type ForwardResultsFile,
  type MonthlySummary,
  type MonthlySummaryMonth,
  type SelectionEvidence,
} from '../lib/forward-test';

const panelState = vi.hoisted(() => ({
  values: [] as unknown[],
  consumed: 0,
  noInjectedState: Symbol('no-injected-state'),
}));

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
}[character] ?? character));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  const mockUseState = function <T>(initialState: T | (() => T)) {
    panelState.consumed += 1;
    // キュー枯渇(過少注入)も「注入なし」として番兵に落とす=fallbackへ確実に到達させる
    const state = panelState.values.length > 0 ? panelState.values.shift() : panelState.noInjectedState;
    const fallback = typeof initialState === 'function' ? (initialState as () => T)() : initialState;
    return [state === panelState.noInjectedState ? fallback : state as T, vi.fn()];
  };

  return {
    ...actual,
    useState: mockUseState as typeof actual.useState,
  };
});

const createMonthlyMonth = (
  overrides: Partial<MonthlySummaryMonth> = {},
): MonthlySummaryMonth => ({
  month: '2026-08',
  total: {
    netProfitYen: 12_345,
    netPips: 12.3,
    tradeCount: 4,
  },
  strategies: [
    {
      id: 'retired-ea',
      name: '退役EA',
      netProfitYen: -1_234,
      netPips: -4.5,
      tradeCount: 1,
      confirmedDays: 2,
      retired: true,
    },
  ],
  confirmedDays: 2,
  complete: false,
  ...overrides,
});

const createMonthlySummary = (): MonthlySummary => ({
  months: [
    createMonthlyMonth(),
    createMonthlyMonth({
      month: '2026-07',
      total: {
        netProfitYen: 23_456,
        netPips: 23.4,
        tradeCount: 5,
      },
      strategies: [],
      confirmedDays: 3,
      complete: true,
    }),
  ],
});

const createCompleteMonthlySummary = (): MonthlySummary => ({
  months: [
    createMonthlyMonth({
      month: '2026-07',
      strategies: [],
      complete: true,
    }),
  ],
});

const renderMonthlySummary = (summary: MonthlySummary): string =>
  renderToStaticMarkup(<MonthlySummarySection summary={summary} />);

const createResultsWithoutMonthlySummary = (): ForwardResultsFile => ({
  schemaVersion: 1,
  computedAt: '2026-08-18T00:00:00.000Z',
  strategies: [],
});

const createObservationMetrics = (
  overrides: Partial<ForwardMetrics> = {},
): ForwardMetrics => ({
  spreadPips: 1.2,
  winRate: 50,
  profitFactor: 1.2,
  maxDrawdownPips: 3,
  maxDrawdownYen: 3_000,
  maxDrawdownPct: 0.3,
  tradeCount: 2,
  netPips: 4,
  netProfitYen: 4_000,
  grossProfitPips: 6,
  grossLossPips: -2,
  grossProfitYen: 6_000,
  grossLossYen: -2_000,
  riskRewardRatio: 1.5,
  averageWinYen: 3_000,
  averageLossYen: -2_000,
  maxConsecutiveWins: 2,
  maxConsecutiveLosses: 1,
  ...overrides,
});

const createObservationCandidate = ({
  id = 'obs-adxtrend-usdjpy-h1-v1',
  name = 'USDJPY h1 ADXトレンド順張り 観察候補',
  metrics: metricOverrides = {},
  historyDayCount = 1,
  historyAvailable = true,
  observationType = 'ADXトレンド順張り',
  stopLossPips = 20,
  takeProfitPips = 40,
}: {
  id?: string;
  name?: string;
  metrics?: Partial<ForwardMetrics>;
  historyDayCount?: number;
  historyAvailable?: boolean;
  observationType?: string;
  stopLossPips?: number | null;
  takeProfitPips?: number | null;
} = {}): ObservationCandidate => {
  const metrics = createObservationMetrics(metricOverrides);
  return {
    meta: {
      id,
      name,
      version: 1,
      pair: 'USDJPY',
      timeframe: 'h1',
      registeredAt: 1_787_098_354,
    },
    forward: {
      source: 'confirmed-history',
      firstConfirmedDate: historyDayCount > 0 ? '2026-08-19' : null,
      confirmedThrough: historyDayCount > 0 ? '2026-08-19' : null,
      confirmedDayCount: historyDayCount,
      metrics,
      trades: [],
      equityCurve: [],
    },
    backtestReference: metrics,
    barsEvaluated: 0,
    observationType,
    stopLossPips,
    takeProfitPips,
    historyDayCount,
    historyAvailable,
  };
};

const renderObservationSection = (state: ObservationPanelState): string =>
  renderToStaticMarkup(<ObservationCandidateSection state={state} />);

const renderPanelWithState = (
  results: ForwardResultsFile,
  observationState: ObservationPanelState = {
    status: 'loading',
    candidates: [],
    historyAvailable: false,
  },
): string => {
  // ForwardTestPanel直下のuseState 5つだけを宣言順に注入する。strategiesは空配列前提で、
  // 注入なしは番兵で表すためundefinedも明示値として扱える。消費数の断言で検知できるのは個数のズレのみ
  // (宣言順の入れ替えは検知できない=注入値は宣言順依存である前提を崩さないこと)。
  panelState.values = [results, [], undefined, false, observationState];
  panelState.consumed = 0;
  const markup = renderToStaticMarkup(<ForwardTestPanel now={1_750_000_000} />);
  // パネル本体が実際に描画されたことの正アンカー(読込中/エラー分岐に落ちたら即RED)
  expect(markup).toContain('forward-test-stack');
  // useState の個数/順序ズレ(state注入の暗黙結合)を顕在化
  expect(panelState.consumed).toBe(5);
  expect(panelState.values).toHaveLength(0);
  return markup;
};

const createSelectionEvidence = (
  overrides: Partial<SelectionEvidence> = {},
): SelectionEvidence => ({
  adoptedAt: '2026-01-15',
  reportId: 'selection-report-2026-01',
  candidatePool: 96,
  inSampleRank: 2,
  optimization: {
    netProfitYen: 100_000,
    profitFactor: 1.8,
    tradeCount: 120,
  },
  validation: {
    netProfitYen: 80_000,
    profitFactor: 1.5,
  },
  quarterlyStability: {
    positive: 4,
    total: 4,
  },
  reservations: [],
  ...overrides,
});

const renderSelectionEvidence = (evidence: SelectionEvidence): string =>
  renderToStaticMarkup(<SelectionEvidenceDetails evidence={evidence} />);

describe('MonthlySummarySection', () => {
  it('renders the note before the month list', () => {
    const markup = renderMonthlySummary(createMonthlySummary());
    const noteIndex = markup.indexOf('確定した日次のみの集計です。');
    const monthRowIndex = markup.indexOf('forward-monthly-row');

    // 属性順に結合しない形で「role=note のラッパー+ネイティブ list」を断言
    expect(markup).toMatch(/<div[^>]*class="forward-monthly-note"[^>]*role="note"[^>]*>/);
    expect(markup).toMatch(/<ul[^>]*class="forward-monthly-note-items"[^>]*>/);
    expect(markup.match(/<li>/g)?.length).toBeGreaterThanOrEqual(5);
    expect(markup).toContain(
      `<li>${escapeHtml('確定した日次のみの集計です。')}</li>`,
    );
    expect(markup).toContain(escapeHtml('過去に運用し退役したEAの実績も含みます。'));
    expect(markup).toContain(escapeHtml('pipsはペア間で価値が異なるため参考値です'));
    expect(noteIndex).toBeGreaterThanOrEqual(0);
    expect(monthRowIndex).toBeGreaterThanOrEqual(0);
    expect(noteIndex).toBeLessThan(monthRowIndex);
  });

  it('marks incomplete months as 集計中 and complete months as 確定', () => {
    expect(renderMonthlySummary(createMonthlySummary())).toContain(escapeHtml('集計中'));
    const completeMarkup = renderMonthlySummary(createCompleteMonthlySummary());
    expect(completeMarkup).not.toContain(escapeHtml('集計中'));
    expect(completeMarkup).toContain(escapeHtml('確定'));
  });

  it('marks retired strategies in the monthly breakdown', () => {
    expect(renderMonthlySummary(createMonthlySummary())).toContain(escapeHtml('退役済み'));
  });

  it('omits the section when monthly summary data is absent through ForwardTestPanel', () => {
    expect(() => renderPanelWithState(createResultsWithoutMonthlySummary())).not.toThrow();
    expect(renderPanelWithState(createResultsWithoutMonthlySummary())).not.toContain(
      'forward-monthly-summary',
    );
  });
});

describe('ObservationCandidateSection', () => {
  it('normalizes the canonical 33-result and 33-history files', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(
      JSON.stringify(
        String(input).includes('observation-history') ? observationHistory : observationResults,
      ),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const state = await loadObservationData();

      expect(state.status).toBe('ready');
      expect(state.historyAvailable).toBe(true);
      expect(state.candidates).toHaveLength(33);
      expect(state.candidates.every((candidate) => candidate.historyDayCount === 0)).toBe(true);
      expect(state.candidates.every((candidate) => (
        candidate.stopLossPips !== null && candidate.takeProfitPips !== null
      ))).toBe(true);
      const markup = renderObservationSection(state);
      const tbody = markup.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '';
      expect(markup).toContain(escapeHtml('33件を候補別に表示しています。'));
      expect(tbody.match(/<td>[^<]+p<\/td>/g)).toHaveLength(66);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders the observation section and all 33 candidate rows', () => {
    const candidates = Array.from({ length: 33 }, (_, index) => createObservationCandidate({
      id: `obs-candidate-${index + 1}`,
      name: `USDJPY h1 観察候補${index + 1}`,
    }));
    const markup = renderObservationSection({
      status: 'ready',
      candidates,
      historyAvailable: true,
    });

    expect(markup).toContain(escapeHtml('観察候補(未採用)'));
    expect(markup).toContain(escapeHtml('33件を候補別に表示しています。'));
    expect(markup).toContain(escapeHtml('USDJPY h1 観察候補1'));
    expect(markup).toContain(escapeHtml('20p'));
    expect(markup).toContain(escapeHtml('40p'));
    expect(markup.match(/<tbody>/g)).toHaveLength(1);
    expect(markup.match(/<tr>/g)).toHaveLength(34);
  });

  it('states that candidates are not adopted and separates them from adopted EAs', () => {
    const candidate = createObservationCandidate();
    const markup = renderPanelWithState(
      {
        ...createResultsWithoutMonthlySummary(),
        strategies: [candidate],
      },
      {
        status: 'ready',
        candidates: [candidate],
        historyAvailable: true,
      },
    );
    const observationIndex = markup.indexOf('forward-observation-title');
    const adoptedIndex = markup.indexOf('forward-adopted-title');

    expect(markup).toContain(escapeHtml('観察中の候補であり、採用EAではありません。'));
    expect(markup).toContain(escapeHtml('フォワード実績を蓄積し'));
    expect(markup).toContain(escapeHtml('採用EA(1件)'));
    expect(observationIndex).toBeGreaterThanOrEqual(0);
    expect(adoptedIndex).toBeGreaterThanOrEqual(0);
    expect(observationIndex).toBeGreaterThan(adoptedIndex);
  });

  it('shows a clear empty state when observation data has no candidates', () => {
    const markup = renderObservationSection({
      status: 'ready',
      candidates: [],
      historyAvailable: true,
    });

    expect(markup).toContain(escapeHtml('観察候補のデータはまだありません。'));
    expect(markup).not.toContain('<tbody>');
  });

  it('shows the no-history state for candidates registered immediately before the first run', () => {
    const candidate = createObservationCandidate({
      metrics: { tradeCount: 0, netProfitYen: 0, netPips: 0 },
      historyDayCount: 0,
    });
    const markup = renderObservationSection({
      status: 'ready',
      candidates: [candidate],
      historyAvailable: true,
    });

    const noDataBanner = '1件すべて観察開始直後で、確定履歴ゼロ・取引なしです。';
    const tbody = markup.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '';
    expect(markup).toContain(escapeHtml(noDataBanner));
    expect(markup).toContain(escapeHtml('未計上'));
    expect(tbody).toContain('<td>履歴ゼロ</td>');
    expect(tbody).not.toContain(escapeHtml(noDataBanner));
  });

  it('merges multiple observation history days and renders the day count in the row', async () => {
    const results = JSON.parse(JSON.stringify(observationResults));
    const history = JSON.parse(JSON.stringify(observationHistory));
    const candidateId = results.strategies[0].meta.id;
    history.strategies[candidateId].days = {
      '2026-08-17': {},
      '2026-08-18': {},
      '2026-08-19': {},
    };
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(
      JSON.stringify(String(input).includes('observation-history') ? history : results),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const state = await loadObservationData();
      const candidate = state.candidates.find((item) => item.meta.id === candidateId);
      const markup = renderObservationSection(state);
      const tbody = markup.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '';

      expect(candidate?.historyDayCount).toBe(3);
      expect(tbody).toContain('<td>3日</td>');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects a mixed results payload when one observation strategy has an invalid type', async () => {
    const invalidResults = JSON.parse(JSON.stringify(observationResults));
    invalidResults.strategies[1].meta.version = 2;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(
      JSON.stringify(
        String(input).includes('observation-results') ? invalidResults : observationHistory,
      ),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(loadObservationData()).resolves.toEqual({
        status: 'unavailable',
        candidates: [],
        historyAvailable: false,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails soft when either observation fetch cannot be completed', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('network failure'));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const state = await loadObservationData();
      const markup = renderObservationSection(state);

      expect(state).toEqual({
        status: 'unavailable',
        candidates: [],
        historyAvailable: false,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        '/data/forward/observation-results.json',
        { cache: 'no-cache' },
      );
      expect(fetchMock).toHaveBeenCalledWith(
        '/data/forward/observation-history.json',
        { cache: 'no-cache' },
      );
      expect(markup).toContain(escapeHtml('採用EAの表示は継続しています。'));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails soft on a 404 while keeping the adopted EA section available', async () => {
    const notFound = new Response('not found', { status: 404 });
    vi.spyOn(notFound, 'json').mockResolvedValue(observationResults);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => (
      String(input).includes('observation-results')
        ? notFound
        : new Response(JSON.stringify(observationHistory), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    ));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const state = await loadObservationData();
      const candidate = createObservationCandidate();
      const markup = renderPanelWithState(
        { ...createResultsWithoutMonthlySummary(), strategies: [candidate] },
        state,
      );

      expect(state.status).toBe('unavailable');
      expect(markup).toContain(escapeHtml('採用EAの表示は継続しています。'));
      expect(markup).toContain(escapeHtml('採用EA(1件)'));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('SelectionEvidenceDetails', () => {
  it('renders the passed-candidate denominator and in-sample rank', () => {
    const evidence = createSelectionEvidence({ passedCount: 27 });

    expect(renderSelectionEvidence(evidence)).toContain(escapeHtml(selectionRankLabel(evidence)));
  });

  it('keeps the legacy rank label when passedCount is absent', () => {
    const evidence = createSelectionEvidence();

    expect(renderSelectionEvidence(evidence)).toContain(escapeHtml(selectionRankLabel(evidence)));
  });

  it('renders the quarterly stability wording for all-positive and mixed quarters', () => {
    const allPositive = createSelectionEvidence();
    const mixed = createSelectionEvidence({
      quarterlyStability: { positive: 3, total: 4 },
    });

    expect(renderSelectionEvidence(allPositive)).toContain(
      escapeHtml(formatQuarterlyStability(allPositive.quarterlyStability)),
    );
    expect(renderSelectionEvidence(mixed)).toContain(
      escapeHtml(formatQuarterlyStability(mixed.quarterlyStability)),
    );
  });
});
