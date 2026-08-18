import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ForwardTestPanel,
  MonthlySummarySection,
  SelectionEvidenceDetails,
} from './ForwardTestPanel';
import {
  formatQuarterlyStability,
  selectionRankLabel,
  type ForwardResultsFile,
  type MonthlySummary,
  type MonthlySummaryMonth,
  type SelectionEvidence,
} from '../lib/forward-test';

const panelState = vi.hoisted(() => ({ values: [] as unknown[] }));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  const mockUseState = function <T>(initialState: T | (() => T)) {
    const state = panelState.values.shift();
    const fallback = typeof initialState === 'function' ? (initialState as () => T)() : initialState;
    return [state === undefined ? fallback : state as T, vi.fn()];
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

const renderPanelWithState = (results: ForwardResultsFile): string => {
  panelState.values = [results, [], null, false];
  const markup = renderToStaticMarkup(<ForwardTestPanel now={1_750_000_000} />);
  // パネル本体が実際に描画されたことの正アンカー(読込中/エラー分岐に落ちたら即RED)
  expect(markup).toContain('forward-test-stack');
  // useState の個数/順序ズレ(state注入の暗黙結合)を顕在化
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

    expect(markup).toContain('過去に運用し退役したEAの実績も含みます。');
    expect(markup).toContain('pipsはペア間で価値が異なるため参考値です');
    expect(noteIndex).toBeGreaterThanOrEqual(0);
    expect(monthRowIndex).toBeGreaterThanOrEqual(0);
    expect(noteIndex).toBeLessThan(monthRowIndex);
  });

  it('marks incomplete months as 集計中 and complete months as 確定', () => {
    expect(renderMonthlySummary(createMonthlySummary())).toContain('集計中');
    const completeMarkup = renderMonthlySummary(createCompleteMonthlySummary());
    expect(completeMarkup).not.toContain('集計中');
    expect(completeMarkup).toContain('確定');
  });

  it('marks retired strategies in the monthly breakdown', () => {
    expect(renderMonthlySummary(createMonthlySummary())).toContain('退役済み');
  });

  it('omits the section when monthly summary data is absent through ForwardTestPanel', () => {
    expect(() => renderPanelWithState(createResultsWithoutMonthlySummary())).not.toThrow();
    expect(renderPanelWithState(createResultsWithoutMonthlySummary())).not.toContain(
      'forward-monthly-summary',
    );
  });
});

describe('SelectionEvidenceDetails', () => {
  it('renders the passed-candidate denominator and in-sample rank', () => {
    const evidence = createSelectionEvidence({ passedCount: 27 });

    expect(renderSelectionEvidence(evidence)).toContain(selectionRankLabel(evidence));
  });

  it('keeps the legacy rank label when passedCount is absent', () => {
    const evidence = createSelectionEvidence();

    expect(renderSelectionEvidence(evidence)).toContain(selectionRankLabel(evidence));
  });

  it('renders the quarterly stability wording for all-positive and mixed quarters', () => {
    const allPositive = createSelectionEvidence();
    const mixed = createSelectionEvidence({
      quarterlyStability: { positive: 3, total: 4 },
    });

    expect(renderSelectionEvidence(allPositive)).toContain(
      formatQuarterlyStability(allPositive.quarterlyStability),
    );
    expect(renderSelectionEvidence(mixed)).toContain(
      formatQuarterlyStability(mixed.quarterlyStability),
    );
  });
});
