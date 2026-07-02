import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { cotCurrencyContracts, normalizeCotReports } from './cot-normalize.mjs';

const endpoint = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json';
const outputPath = resolve('public/data/cot.json');
const reportLimit = 104;

const cotUrl = (market) => {
  const url = new URL(endpoint);
  url.searchParams.set('contract_market_name', market);
  url.searchParams.set('$order', 'report_date_as_yyyy_mm_dd DESC');
  url.searchParams.set('$limit', String(reportLimit));
  return url;
};

const loadMarket = async (market) => {
  const response = await fetch(cotUrl(market), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`${market} returned ${response.status}`);
  }
  const rows = await response.json();
  const reports = normalizeCotReports(rows);
  return { market, reports };
};

const loadCurrency = async (currency, markets) => {
  const errors = [];
  for (const market of markets) {
    try {
      const result = await loadMarket(market);
      if (result.reports.length > 0) {
        return result;
      }
      errors.push(`${market}: no valid reports`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`${currency}: ${errors.join('; ')}`);
};

try {
  const currencies = {};
  for (const [currency, markets] of Object.entries(cotCurrencyContracts)) {
    const result = await loadCurrency(currency, markets);
    currencies[currency] = result;
    console.log(`Loaded ${currency} ${result.market}: ${result.reports.length} reports`);
  }

  const output = {
    updatedAt: new Date().toISOString(),
    currencies,
  };
  const json = `${JSON.stringify(output, null, 2)}\n`;
  const tempPath = `${outputPath}.tmp`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(tempPath, json, 'utf8');
  await rename(tempPath, outputPath);
  console.log(`Wrote COT data to ${outputPath}`);
} catch (error) {
  try {
    await readFile(outputPath, 'utf8');
    console.warn(`COT fetch failed; keeping existing ${outputPath}.`);
  } catch {
    console.warn(`COT fetch failed and ${outputPath} does not exist.`);
  }
  console.warn(error instanceof Error ? error.message : String(error));
}
