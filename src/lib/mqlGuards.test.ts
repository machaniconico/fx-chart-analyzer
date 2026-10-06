import { describe, expect, it } from 'vitest';
import { fillingChoice, reentryAllowed, stopsDistanceAllowed, tradeRetcodeOk } from './mqlGuards';

describe('stopsDistanceAllowed', () => {
  it('accepts a distance exactly equal to the stops level despite float error (3-digit, 50 points)', () => {
    // 150.010 - 149.960 = 0.04999999... in binary floating point
    expect(150.01 - 149.96).toBeLessThan(0.05);
    expect(stopsDistanceAllowed(true, 150.01, 149.96, 150.06, 0.001, 50)).toBe(true);
    expect(stopsDistanceAllowed(false, 150.01, 150.06, 149.96, 0.001, 50)).toBe(true);
  });
  it('rejects one point below the minimum', () => {
    expect(stopsDistanceAllowed(true, 150.01, 149.961, 150.06, 0.001, 50)).toBe(false);
    expect(stopsDistanceAllowed(true, 150.01, 149.96, 150.059, 0.001, 50)).toBe(false);
  });
  it('rejects SL or TP on the wrong side (signed distance)', () => {
    expect(stopsDistanceAllowed(true, 150.01, 150.2, 150.2, 0.001, 50)).toBe(false);
    expect(stopsDistanceAllowed(true, 150.01, 149.9, 149.5, 0.001, 50)).toBe(false);
    expect(stopsDistanceAllowed(false, 150.01, 149.9, 149.5, 0.001, 50)).toBe(false);
    expect(stopsDistanceAllowed(false, 150.01, 150.2, 150.2, 0.001, 50)).toBe(false);
  });
  it('rejects zero distance even when the stops level is 0', () => {
    expect(stopsDistanceAllowed(true, 1.1, 1.1, 1.2, 0.00001, 0)).toBe(false);
    expect(stopsDistanceAllowed(true, 1.1, 1.0999, 1.1001, 0.00001, 0)).toBe(true);
  });
});

describe('tradeRetcodeOk', () => {
  it('accepts DONE, DONE_PARTIAL and PLACED only', () => {
    expect([10008, 10009, 10010].every(tradeRetcodeOk)).toBe(true);
    expect([0, 10004, 10006, 10013, 10030].some(tradeRetcodeOk)).toBe(false);
  });
});

describe('fillingChoice', () => {
  it('prefers FOK, then IOC', () => {
    expect(fillingChoice(3, true)).toBe('FOK');
    expect(fillingChoice(2, true)).toBe('IOC');
  });
  it('falls back to RETURN only outside market execution', () => {
    expect(fillingChoice(0, false)).toBe('RETURN');
    expect(fillingChoice(0, true)).toBe('DEFAULT');
  });
});

describe('reentryAllowed', () => {
  // 100 hourly bars; shift 0 starts at t=99*3600.
  const total = 100;
  const barTime = (shift: number): number => (shift >= 0 && shift < total ? (total - 1 - shift) * 3600 : 0);
  const current = barTime(0);

  it('allows when there was no close', () => {
    expect(reentryAllowed(0, 0, barTime)).toBe(true);
  });
  it('blocks a close inside the current bar and exactly at its start with cooldown 0', () => {
    expect(reentryAllowed(current + 5, 0, barTime)).toBe(false);
    expect(reentryAllowed(current, 0, barTime)).toBe(false);
  });
  it('allows a close on the previous bar with cooldown 0', () => {
    expect(reentryAllowed(current - 1, 0, barTime)).toBe(true);
  });
  it('matches the bar-count cooldown: close at shift s is allowed iff s >= N + 1', () => {
    for (const cooldown of [1, 3]) {
      for (let shift = 0; shift < 10; shift += 1) {
        expect(reentryAllowed(barTime(shift) + 1800, cooldown, barTime)).toBe(shift >= cooldown + 1);
      }
    }
  });
  it('holds re-entry when a close exists but the cooldown exceeds the available bars', () => {
    expect(reentryAllowed(-86400, 500, barTime)).toBe(false);
    expect(reentryAllowed(barTime(1), 500, barTime)).toBe(false);
  });
  it('allows when there is no close even if the cooldown exceeds the available bars', () => {
    expect(reentryAllowed(0, 500, barTime)).toBe(true);
  });
  it('fails closed when no bar data exists', () => {
    expect(reentryAllowed(1000, 0, () => 0)).toBe(false);
  });
});
