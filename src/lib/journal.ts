import type { Bar, Pair, Timeframe } from '../types';
import type { PredictionHorizon } from './predict';

export type PredictionJournalOutcome = 'hit' | 'miss';

export interface PredictionJournalEntry {
  id: string;
  pair: Pair;
  tf: Timeframe;
  horizon: PredictionHorizon;
  probabilityUp: number;
  lastClose: number;
  barTime: number;
  createdAt: number;
  targetBarTime?: number;
  actualClose?: number;
  resolvedAt?: number;
  outcome?: PredictionJournalOutcome;
}

export interface PredictionJournalSummary {
  total: number;
  resolved: number;
  pending: number;
  hits: number;
  misses: number;
  accuracy: number | null;
}

export interface JournalPredictionInput {
  horizon: PredictionHorizon;
  probabilityUp: number;
}

export const predictionJournalStorageKey = 'fx-chart-analyzer.prediction-journal.v1';
export const predictionJournalLimit = 1000;

const entryId = (pair: Pair, tf: Timeframe, horizon: PredictionHorizon, barTime: number): string =>
  `${pair}:${tf}:${horizon}:${barTime}`;

const isJournalEntry = (value: unknown): value is PredictionJournalEntry => {
  const entry = value as PredictionJournalEntry;
  return (
    typeof entry?.id === 'string' &&
    typeof entry.pair === 'string' &&
    typeof entry.tf === 'string' &&
    typeof entry.horizon === 'number' &&
    typeof entry.probabilityUp === 'number' &&
    typeof entry.lastClose === 'number' &&
    typeof entry.barTime === 'number' &&
    typeof entry.createdAt === 'number'
  );
};

export const loadPredictionJournal = (storage: Storage | null | undefined): PredictionJournalEntry[] => {
  if (!storage) {
    return [];
  }
  try {
    const raw = storage.getItem(predictionJournalStorageKey);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isJournalEntry) : [];
  } catch {
    return [];
  }
};

export const savePredictionJournal = (
  storage: Storage | null | undefined,
  entries: readonly PredictionJournalEntry[],
): void => {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(predictionJournalStorageKey, JSON.stringify(entries));
  } catch {
    // localStorage can be unavailable in private or restricted browser modes.
  }
};

export const capPredictionJournal = (
  entries: readonly PredictionJournalEntry[],
  limit = predictionJournalLimit,
): PredictionJournalEntry[] =>
  [...entries].sort((left, right) => left.createdAt - right.createdAt).slice(-limit);

export const reconcilePredictionJournal = (
  entries: readonly PredictionJournalEntry[],
  bars: readonly Bar[],
  pair: Pair,
  tf: Timeframe,
  resolvedAt = Date.now(),
): PredictionJournalEntry[] => {
  const indexByTime = new Map<number, number>();
  bars.forEach((bar, index) => indexByTime.set(bar.t, index));

  return entries.map((entry) => {
    if (entry.outcome || entry.pair !== pair || entry.tf !== tf) {
      return entry;
    }
    const sourceIndex = indexByTime.get(entry.barTime);
    if (sourceIndex === undefined) {
      return entry;
    }
    const target = bars[sourceIndex + entry.horizon];
    if (!target) {
      return entry;
    }

    const predictedUp = entry.probabilityUp >= 0.5;
    const actualUp = target.c > entry.lastClose;
    return {
      ...entry,
      targetBarTime: target.t,
      actualClose: target.c,
      resolvedAt,
      outcome: predictedUp === actualUp ? 'hit' : 'miss',
    };
  });
};

export const recordPredictionJournalEntries = (
  entries: readonly PredictionJournalEntry[],
  pair: Pair,
  tf: Timeframe,
  lastBar: Bar,
  predictions: readonly JournalPredictionInput[],
  createdAt = Date.now(),
): PredictionJournalEntry[] => {
  const existingIds = new Set(entries.map((entry) => entry.id));
  const additions = predictions.flatMap((prediction) => {
    const id = entryId(pair, tf, prediction.horizon, lastBar.t);
    if (existingIds.has(id)) {
      return [];
    }
    existingIds.add(id);
    return [
      {
        id,
        pair,
        tf,
        horizon: prediction.horizon,
        probabilityUp: prediction.probabilityUp,
        lastClose: lastBar.c,
        barTime: lastBar.t,
        createdAt,
      },
    ];
  });

  return capPredictionJournal([...entries, ...additions]);
};

export const summarizePredictionJournal = (
  entries: readonly PredictionJournalEntry[],
  pair?: Pair,
  tf?: Timeframe,
): PredictionJournalSummary => {
  const scoped = entries.filter(
    (entry) => (pair === undefined || entry.pair === pair) && (tf === undefined || entry.tf === tf),
  );
  const resolved = scoped.filter((entry) => entry.outcome);
  const hits = resolved.filter((entry) => entry.outcome === 'hit').length;
  const misses = resolved.filter((entry) => entry.outcome === 'miss').length;

  return {
    total: scoped.length,
    resolved: resolved.length,
    pending: scoped.length - resolved.length,
    hits,
    misses,
    accuracy: resolved.length > 0 ? hits / resolved.length : null,
  };
};

export const updatePredictionJournalForDisplay = (
  storage: Storage | null | undefined,
  pair: Pair,
  tf: Timeframe,
  bars: readonly Bar[],
  predictions: readonly JournalPredictionInput[],
  now = Date.now(),
): { entries: PredictionJournalEntry[]; summary: PredictionJournalSummary } => {
  const last = bars[bars.length - 1];
  const loaded = loadPredictionJournal(storage);
  const reconciled = reconcilePredictionJournal(loaded, bars, pair, tf, now);
  const entries = last
    ? recordPredictionJournalEntries(reconciled, pair, tf, last, predictions, now)
    : capPredictionJournal(reconciled);
  savePredictionJournal(storage, entries);
  return {
    entries,
    summary: summarizePredictionJournal(entries, pair, tf),
  };
};
