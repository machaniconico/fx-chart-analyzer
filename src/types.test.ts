import { describe, expect, it } from 'vitest';
import {
  FRESHNESS_LIMIT_HOURS,
  anyFallbackSource,
  dataSourceLabel,
  evaluateFreshness,
  isFallbackSource,
  stalenessWarningMessage,
} from './types';

const HOUR = 3600;

describe('evaluateFreshness', () => {
  it('reports fresh data as not stale', () => {
    const now = 1_000_000;
    const status = evaluateFreshness(now - 2 * HOUR, now);
    expect(status.ageHours).toBeCloseTo(2);
    expect(status.ageDays).toBeCloseTo(2 / 24);
    expect(status.isStale).toBe(false);
  });

  it('does not flag data exactly at the limit', () => {
    const now = 1_000_000;
    const status = evaluateFreshness(now - FRESHNESS_LIMIT_HOURS * HOUR, now);
    expect(status.ageHours).toBeCloseTo(FRESHNESS_LIMIT_HOURS);
    expect(status.isStale).toBe(false);
  });

  it('flags data just past the limit', () => {
    const now = 1_000_000;
    const status = evaluateFreshness(now - (FRESHNESS_LIMIT_HOURS * HOUR + 1), now);
    expect(status.isStale).toBe(true);
  });

  it('respects a custom limit', () => {
    const now = 1_000_000;
    expect(evaluateFreshness(now - 5 * HOUR, now, 4).isStale).toBe(true);
    expect(evaluateFreshness(now - 3 * HOUR, now, 4).isStale).toBe(false);
  });

  it('never warns when the latest bar time is missing or invalid', () => {
    expect(evaluateFreshness(null, 1_000_000)).toEqual({ ageHours: 0, ageDays: 0, isStale: false });
    expect(evaluateFreshness(Number.NaN, 1_000_000).isStale).toBe(false);
  });

  it('clamps negative ages (clock skew) to zero', () => {
    const now = 1_000_000;
    const status = evaluateFreshness(now + 10 * HOUR, now);
    expect(status.ageHours).toBe(0);
    expect(status.isStale).toBe(false);
  });
});

describe('stalenessWarningMessage', () => {
  it('rounds the age to whole days and keeps the warning wording', () => {
    const message = stalenessWarningMessage(7.3);
    expect(message).toContain('約7日間更新されていません');
    expect(message).toContain('最新の相場を反映していません');
    expect(message.startsWith('⚠')).toBe(true);
  });

  it('never reports fewer than one day', () => {
    expect(stalenessWarningMessage(0)).toContain('約1日間');
  });
});

describe('data source helpers', () => {
  it('labels sources, defaulting unknown to the primary source', () => {
    expect(dataSourceLabel('dukascopy')).toBe('Dukascopy');
    expect(dataSourceLabel('yahoo-fallback')).toBe('Yahoo(代替)');
    expect(dataSourceLabel(undefined)).toBe('Dukascopy');
  });

  it('detects the fallback source', () => {
    expect(isFallbackSource('yahoo-fallback')).toBe(true);
    expect(isFallbackSource('dukascopy')).toBe(false);
    expect(isFallbackSource(undefined)).toBe(false);
  });

  it('detects fallback across a set of sources', () => {
    expect(anyFallbackSource(['dukascopy', 'yahoo-fallback'])).toBe(true);
    expect(anyFallbackSource(['dukascopy', undefined])).toBe(false);
    expect(anyFallbackSource([])).toBe(false);
  });
});
