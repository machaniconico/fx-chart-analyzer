export type Pair = 'USDJPY' | 'EURUSD' | 'GBPJPY' | 'EURJPY' | 'AUDJPY' | 'GBPUSD';
export type Timeframe = 'h1' | 'h4' | 'd1';

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface DataFile {
  pair: Pair;
  tf: Timeframe;
  updatedAt: string;
  bars: Bar[];
}

export const PAIRS: Pair[] = ['USDJPY', 'EURUSD', 'GBPJPY', 'EURJPY', 'AUDJPY', 'GBPUSD'];
export const TIMEFRAMES: Timeframe[] = ['h1', 'h4', 'd1'];

export const timeframeLabels: Record<Timeframe, string> = {
  h1: '1時間',
  h4: '4時間',
  d1: '日足',
};
