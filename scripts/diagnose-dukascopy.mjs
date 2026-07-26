// Minimal Dukascopy-only probe: no Yahoo fallback, no file writes.
// Use this to tell "the primary source is broken" apart from "the market was closed",
// which the daily pipeline cannot distinguish on its own — fetch-data.mjs silently
// falls back to Yahoo, so a total Dukascopy outage looks identical to a quiet weekend.
import { inspect } from 'node:util';
import { createRequire } from 'node:module';
import { getHistoricalRates } from 'dukascopy-node';

const require = createRequire(import.meta.url);
const dukascopyVersion = require('dukascopy-node/package.json').version;

// Walk back to the most recent window that is unambiguously inside trading hours:
// Mon-Fri 12:00-18:00 UTC (London/NY overlap). A weekend window returns zero rows
// legitimately, which would make a broken feed look healthy.
function lastWeekdayWindow() {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12));
  const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 18));
  return { from, to };
}

const options = {
  instrument: 'usdjpy',
  dates: lastWeekdayWindow(),
  timeframe: 'm15',
  priceType: 'bid',
  volumes: true,
  volumeUnits: 'units',
  format: 'json',
  useCache: false,
  retryCount: 0,
};

console.log(`Dukascopy diagnostic using dukascopy-node ${dukascopyVersion}`);
console.log('Dukascopy diagnostic request:', inspect(options, { depth: null }));

try {
  const rows = await getHistoricalRates(options);
  if (rows.length === 0) {
    // Reaching the feed but getting nothing back is not a pass: report it separately
    // so an empty response is never mistaken for a healthy fetch.
    console.error('Dukascopy diagnostic INCONCLUSIVE: request succeeded but returned 0 rows');
    console.error('The window above should be inside trading hours — an empty result needs investigation.');
    process.exitCode = 1;
  } else {
    const last = rows[rows.length - 1];
    console.log(`Dukascopy diagnostic OK: ${rows.length} rows`);
    console.log('Last row:', inspect(last, { depth: null }));
  }
} catch (error) {
  console.error('Dukascopy diagnostic FAILED (raw rejection):');
  console.error(inspect(error, { depth: null }));
  if (error instanceof Error) {
    console.error('stack:', error.stack);
    console.error('cause:', inspect(error.cause, { depth: null }));
  }
  process.exitCode = 1;
}
