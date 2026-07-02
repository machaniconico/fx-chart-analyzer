export const cotCurrencyContracts = {
  JPY: ['JAPANESE YEN'],
  EUR: ['EURO FX'],
  GBP: ['BRITISH POUND', 'BRITISH POUND STERLING'],
  AUD: ['AUSTRALIAN DOLLAR'],
};

const parseReportDate = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) {
    return null;
  }
  const [, year, month, day] = match;
  const time = Date.UTC(Number(year), Number(month) - 1, Number(day)) / 1000;
  return Number.isFinite(time) ? time : null;
};

const parseNumber = (value) => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return null;
    }
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (typeof value !== 'number') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

export const normalizeCotReport = (raw) => {
  const date = parseReportDate(raw?.report_date_as_yyyy_mm_dd);
  const oi = parseNumber(raw?.open_interest_all);
  const noncommLong = parseNumber(raw?.noncomm_positions_long_all);
  const noncommShort = parseNumber(raw?.noncomm_positions_short_all);
  const commLong = parseNumber(raw?.comm_positions_long_all);
  const commShort = parseNumber(raw?.comm_positions_short_all);

  if (
    date === null ||
    oi === null ||
    noncommLong === null ||
    noncommShort === null ||
    commLong === null ||
    commShort === null
  ) {
    return null;
  }

  return {
    date,
    oi,
    noncommLong,
    noncommShort,
    noncommNet: noncommLong - noncommShort,
    commLong,
    commShort,
  };
};

export const normalizeCotReports = (rows) => {
  if (!Array.isArray(rows)) {
    throw new Error('COT source did not return an array');
  }

  const reportsByDate = new Map();
  for (const row of rows) {
    const report = normalizeCotReport(row);
    if (!report) {
      continue;
    }
    reportsByDate.set(report.date, report);
  }

  return [...reportsByDate.values()].sort((a, b) => a.date - b.date);
};
