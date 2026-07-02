import { describe, expect, it } from 'vitest';
import {
  reconcilePredictionJournal,
  recordPredictionJournalEntries,
  summarizePredictionJournal,
} from './journal';
import type { Bar } from '../types';

const bars: Bar[] = Array.from({ length: 8 }, (_, index) => ({
  t: index * 3600,
  o: 100 + index,
  h: 101 + index,
  l: 99 + index,
  c: 100 + index,
  v: 1000,
}));

describe('prediction journal', () => {
  it('records one entry per pair/timeframe/horizon/bar', () => {
    const first = recordPredictionJournalEntries(
      [],
      'USDJPY',
      'h1',
      bars[3],
      [{ horizon: 1, probabilityUp: 0.7 }],
      100,
    );
    const second = recordPredictionJournalEntries(
      first,
      'USDJPY',
      'h1',
      bars[3],
      [{ horizon: 1, probabilityUp: 0.8 }],
      200,
    );

    expect(second).toHaveLength(1);
    expect(second[0].probabilityUp).toBe(0.7);
  });

  it('reconciles unresolved entries when the target bar exists', () => {
    const entries = recordPredictionJournalEntries(
      [],
      'USDJPY',
      'h1',
      bars[3],
      [{ horizon: 1, probabilityUp: 0.7 }],
      100,
    );
    const reconciled = reconcilePredictionJournal(entries, bars, 'USDJPY', 'h1', 200);
    const summary = summarizePredictionJournal(reconciled, 'USDJPY', 'h1');

    expect(reconciled[0].outcome).toBe('hit');
    expect(reconciled[0].targetBarTime).toBe(bars[4].t);
    expect(summary.resolved).toBe(1);
    expect(summary.accuracy).toBe(1);
  });
});
