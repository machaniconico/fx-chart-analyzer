import { describe, expect, it } from 'vitest';
import { normalizeCotReports } from './cot-normalize.mjs';

const baseRow = {
  report_date_as_yyyy_mm_dd: '2026-06-23T00:00:00.000',
  open_interest_all: '321000',
  noncomm_positions_long_all: '87500',
  noncomm_positions_short_all: '146000',
  comm_positions_long_all: '152000',
  comm_positions_short_all: '90500',
};

describe('COT normalization', () => {
  it('converts string numbers and report dates', () => {
    const reports = normalizeCotReports([baseRow]);

    expect(reports).toEqual([
      {
        date: Date.UTC(2026, 5, 23) / 1000,
        oi: 321000,
        noncommLong: 87500,
        noncommShort: 146000,
        noncommNet: -58500,
        commLong: 152000,
        commShort: 90500,
      },
    ]);
  });

  it('calculates noncommercial net from long minus short', () => {
    const reports = normalizeCotReports([
      {
        ...baseRow,
        noncomm_positions_long_all: '120000',
        noncomm_positions_short_all: '95000',
      },
    ]);

    expect(reports[0].noncommNet).toBe(25000);
  });

  it('skips records with missing or invalid required values', () => {
    const reports = normalizeCotReports([
      { ...baseRow, report_date_as_yyyy_mm_dd: '2026-06-02T00:00:00.000', open_interest_all: '' },
      { ...baseRow, report_date_as_yyyy_mm_dd: undefined },
      {
        ...baseRow,
        report_date_as_yyyy_mm_dd: '2026-06-09T00:00:00.000',
        comm_positions_short_all: 'not-a-number',
      },
      baseRow,
    ]);

    expect(reports).toHaveLength(1);
    expect(reports[0].date).toBe(Date.UTC(2026, 5, 23) / 1000);
  });

  it('sorts reports by date ascending', () => {
    const reports = normalizeCotReports([
      { ...baseRow, report_date_as_yyyy_mm_dd: '2026-06-30T00:00:00.000' },
      { ...baseRow, report_date_as_yyyy_mm_dd: '2026-06-16T00:00:00.000' },
    ]);

    expect(reports.map((report) => report.date)).toEqual([
      Date.UTC(2026, 5, 16) / 1000,
      Date.UTC(2026, 5, 30) / 1000,
    ]);
  });
});
