import type { Pair } from '../types';

export const defaultSpreadPipsByPair: Record<Pair, number>;
export const spreadPipsForPair: (pair: Pair) => number;
