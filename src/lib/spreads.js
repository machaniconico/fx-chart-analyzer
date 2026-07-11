// Shared default spread table so UI backtests (src/lib/backtest.ts) and the
// published scanner statistics (scripts/build-scanner-stats.mjs) can never drift
// apart. Consumed by both TypeScript (via spreads.d.ts) and plain .mjs scripts,
// so this stays plain JS with an ESM interface, mirroring adaptive-core.js.

export const defaultSpreadPipsByPair = {
  USDJPY: 0.9,
  EURUSD: 0.7,
  GBPJPY: 1.6,
  EURJPY: 1.1,
  AUDJPY: 1.2,
  GBPUSD: 1.0,
};

export const spreadPipsForPair = (pair) => defaultSpreadPipsByPair[pair] ?? 0;
