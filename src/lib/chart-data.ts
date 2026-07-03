import type { Bar, DataFile, Pair, Timeframe } from '../types';
import type { AdaptiveStats } from './adaptive';
import type { ScannerStats } from './recommend';

export interface AdaptiveStatsFile extends AdaptiveStats {
  pair: Pair;
  tf: Timeframe;
  sourceUpdatedAt?: string;
}

export const loadBars = async (pair: Pair, tf: Timeframe): Promise<DataFile> => {
  const response = await fetch(`/data/${pair}/${tf}.json`, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`${pair} ${tf} のデータを読み込めませんでした`);
  }
  const payload = (await response.json()) as DataFile;
  return payload;
};

export const loadAdaptiveStats = async (pair: Pair, tf: Timeframe): Promise<AdaptiveStatsFile | null> => {
  const response = await fetch(`/data/stats/${pair}/${tf}.json`, { cache: 'no-cache' });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  return (await response.json()) as AdaptiveStatsFile;
};

export const loadScannerStats = async (): Promise<ScannerStats | null> => {
  const response = await fetch('/data/stats/scanner.json', { cache: 'no-cache' });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  return (await response.json()) as ScannerStats;
};

export const pricePrecision = (pair: Pair): number => (pair.endsWith('JPY') ? 3 : 5);

export const lastBar = (bars: readonly Bar[]): Bar | null =>
  bars.length > 0 ? bars[bars.length - 1] : null;

export const formatPrice = (pair: Pair, value: number): string =>
  value.toLocaleString('ja-JP', {
    minimumFractionDigits: pricePrecision(pair),
    maximumFractionDigits: pricePrecision(pair),
  });
