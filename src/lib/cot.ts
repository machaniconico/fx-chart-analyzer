import type { Pair } from '../types';

export const cotCurrencies = ['JPY', 'EUR', 'GBP', 'AUD'] as const;
export type CotCurrency = (typeof cotCurrencies)[number];

export interface CotReport {
  date: number;
  oi: number;
  noncommLong: number;
  noncommShort: number;
  noncommNet: number;
  commLong: number;
  commShort: number;
}

export interface CotCurrencyData {
  market: string;
  reports: CotReport[];
}

export interface CotFile {
  updatedAt: string;
  currencies: Record<CotCurrency, CotCurrencyData>;
}

const currencyNames: Record<CotCurrency, string> = {
  JPY: '円',
  EUR: 'ユーロ',
  GBP: 'ポンド',
  AUD: '豪ドル',
};

export const isCotCurrency = (value: string): value is CotCurrency =>
  cotCurrencies.includes(value as CotCurrency);

export const defaultCotCurrencyForPair = (pair: Pair): CotCurrency => {
  const base = pair.slice(0, 3);
  const quote = pair.slice(3, 6);
  if (isCotCurrency(base)) {
    return base;
  }
  if (isCotCurrency(quote)) {
    return quote;
  }
  return 'JPY';
};

export const loadCot = async (): Promise<CotFile> => {
  const response = await fetch('/data/cot.json', { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error('COTデータを読み込めませんでした');
  }
  return (await response.json()) as CotFile;
};

export const formatCotContracts = (value: number): string => {
  const abs = Math.abs(value);
  if (abs >= 1000) {
    const thousands = abs / 1000;
    const formatted =
      thousands >= 100
        ? Math.round(thousands).toLocaleString('ja-JP')
        : thousands.toLocaleString('ja-JP', { maximumFractionDigits: 1 });
    return `${value < 0 ? '-' : ''}${formatted}k`;
  }
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 0 });
};

export const formatCotDate = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toLocaleDateString('ja-JP', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

export const describeCotContext = (
  currency: CotCurrency,
  report: CotReport,
  pair: Pair,
): string => {
  const net = report.noncommNet;
  const side = net > 0 ? '買い越し' : net < 0 ? '売り越し' : '中立に近い状態';
  const currencyName = currencyNames[currency];
  const direction =
    net > 0 ? `${currencyName}高方向` : net < 0 ? `${currencyName}安方向` : `${currencyName}の方向感は限定的`;
  const magnitude = formatCotContracts(Math.abs(net));
  const base = pair.slice(0, 3);
  const quote = pair.slice(3, 6);

  if (net === 0) {
    return `${currency}大口はネットがほぼ中立です。${pair}の文脈では、COT単体から方向を読み切るよりも他の材料との併用が必要です。`;
  }

  if (currency === base) {
    const pairBias = net > 0 ? '上方向' : '下方向';
    return `${currency}大口は${magnitude}の${side}(${direction}のポジション)。${pair}の文脈では${pairBias}を意識しやすい一方、COT単体で断定はできません。`;
  }

  if (currency === quote) {
    const pairBias = net > 0 ? '下方向' : '上方向';
    const quoteContext = currency === 'JPY' ? 'USDJPY/クロス円' : pair;
    return `${currency}大口は${magnitude}の${side}(${direction}のポジション)。${quoteContext}の文脈では${currencyName}${net > 0 ? '買い' : '売り'}が${pairBias}に効きやすい見方があります。`;
  }

  return `${currency}大口は${magnitude}の${side}(${direction}のポジション)。現在の${pair}には直接含まれないため、ドル全体やリスク選好を読む補助材料として扱うのが自然です。`;
};
