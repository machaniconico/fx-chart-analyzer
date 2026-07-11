import { describe, expect, it } from 'vitest';
import { verifyDataPr } from './check-data-freshness.mjs';

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
