import { describe, expect, it } from 'vitest';
import { evaluateSourceHealth, verifyDataPr } from './check-data-freshness.mjs';

const HOUR_MS = 3_600_000;
const NOW = Date.UTC(2026, 6, 10, 21, 0, 0); // fixed "now" for age assertions
const HEAD = 'a'.repeat(40);

const basePr = (overrides = {}) => ({
  number: 42,
  url: 'https://github.com/x/y/pull/42',
  state: 'OPEN',
  autoMergeRequest: { enabledAt: '2026-07-10T20:00:00Z' },
  headRefOid: HEAD,
  createdAt: new Date(NOW - HOUR_MS).toISOString(),
  ...overrides,
});

const baseHealth = (overrides = {}) => ({
  updatedAt: new Date(NOW).toISOString(),
  sources: { dukascopy: 14, 'yahoo-fallback': 10 },
  primaryOkThisRun: true,
  lastPrimarySuccessAt: new Date(NOW - HOUR_MS).toISOString(),
  ...overrides,
});

describe('evaluateSourceHealth primary-source gate', () => {
  it('passes when health.json does not exist yet', () => {
    const result = evaluateSourceHealth({ health: null, nowMs: NOW });

    expect(result.level).toBe('ok');
    expect(result.message).toMatch(/not found.*skipping/i);
  });

  it('passes when Dukascopy succeeded recently and in this run', () => {
    const result = evaluateSourceHealth({ health: baseHealth(), nowMs: NOW });

    expect(result.level).toBe('ok');
  });

  it('warns instead of failing when this run has no Dukascopy data but the last success is within the limit', () => {
    const result = evaluateSourceHealth({
      health: baseHealth({
        primaryOkThisRun: false,
        lastPrimarySuccessAt: new Date(NOW - 48 * HOUR_MS).toISOString(),
      }),
      nowMs: NOW,
    });

    expect(result.level).toBe('warn');
  });

  it('fails when the last Dukascopy success is older than 120 hours and reports its age', () => {
    const result = evaluateSourceHealth({
      health: baseHealth({
        primaryOkThisRun: false,
        lastPrimarySuccessAt: new Date(NOW - 120.1 * HOUR_MS).toISOString(),
      }),
      nowMs: NOW,
    });

    expect(result.level).toBe('fail');
    expect(result.message).toMatch(/120\.1h/);
    expect(result.message).toMatch(/120h/);
  });

  it('warns when the last Dukascopy success is unknown', () => {
    const result = evaluateSourceHealth({
      health: baseHealth({ primaryOkThisRun: false, lastPrimarySuccessAt: null }),
      nowMs: NOW,
    });

    expect(result.level).toBe('warn');
  });

  it('warns when the last Dukascopy success cannot be parsed', () => {
    const result = evaluateSourceHealth({
      health: baseHealth({ primaryOkThisRun: false, lastPrimarySuccessAt: 'not-a-date' }),
      nowMs: NOW,
    });

    expect(result.level).toBe('warn');
  });

  it('does not fail exactly at the 120-hour boundary', () => {
    const result = evaluateSourceHealth({
      health: baseHealth({
        primaryOkThisRun: false,
        lastPrimarySuccessAt: new Date(NOW - 120 * HOUR_MS).toISOString(),
      }),
      nowMs: NOW,
    });

    expect(result.level).toBe('warn');
  });

  it('fails immediately after the 120-hour boundary', () => {
    const result = evaluateSourceHealth({
      health: baseHealth({
        primaryOkThisRun: false,
        lastPrimarySuccessAt: new Date(NOW - 120 * HOUR_MS - 1).toISOString(),
      }),
      nowMs: NOW,
    });

    expect(result.level).toBe('fail');
  });

  it('does not fail on Sunday after the last Dukascopy success on Friday', () => {
    const friday = Date.UTC(2026, 6, 10, 21, 0, 0);
    const sunday = Date.UTC(2026, 6, 12, 21, 0, 0);
    const result = evaluateSourceHealth({
      health: baseHealth({
        primaryOkThisRun: false,
        lastPrimarySuccessAt: new Date(friday).toISOString(),
      }),
      nowMs: sunday,
    });

    expect(result.level).toBe('warn');
  });
});

describe('verifyDataPr head-SHA + freshness gate', () => {
  it('passes an OPEN auto-merge PR whose head matches this run and is fresh', () => {
    const result = verifyDataPr({ pr: basePr(), headSha: HEAD, nowMs: NOW });
    expect(result.ok).toBe(true);
  });

  it('passes a MERGED PR whose head matches this run', () => {
    const result = verifyDataPr({ pr: basePr({ state: 'MERGED' }), headSha: HEAD, nowMs: NOW });
    expect(result.ok).toBe(true);
  });

  it('fails a MERGED PR from a prior run (head SHA does not match)', () => {
    // gh pr view falls back to yesterday's merged PR when nothing is open today.
    const result = verifyDataPr({
      pr: basePr({ state: 'MERGED', headRefOid: 'b'.repeat(40) }),
      headSha: HEAD,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/does not match this run/);
  });

  it('fails an OPEN PR whose head does not match this run', () => {
    const result = verifyDataPr({
      pr: basePr({ headRefOid: 'c'.repeat(40) }),
      headSha: HEAD,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/does not match this run/);
  });

  it('fails an OPEN PR matching this run but with auto-merge disabled', () => {
    const result = verifyDataPr({
      pr: basePr({ autoMergeRequest: null }),
      headSha: HEAD,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/auto-merge is NOT enabled/);
  });

  it('fails an OPEN auto-merge PR older than the age limit (stuck required check)', () => {
    const result = verifyDataPr({
      pr: basePr({ createdAt: new Date(NOW - 40 * HOUR_MS).toISOString() }),
      headSha: HEAD,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/stuck/);
  });

  it('accepts an OPEN auto-merge PR right at the age boundary', () => {
    const result = verifyDataPr({
      pr: basePr({ createdAt: new Date(NOW - 26 * HOUR_MS).toISOString() }),
      headSha: HEAD,
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('fails when the current HEAD sha cannot be determined', () => {
    const result = verifyDataPr({ pr: basePr(), headSha: null, nowMs: NOW });
    expect(result.ok).toBe(false);
  });

  it('fails when no PR was found for the branch', () => {
    const result = verifyDataPr({ pr: null, headSha: HEAD, nowMs: NOW });
    expect(result.ok).toBe(false);
  });
});
