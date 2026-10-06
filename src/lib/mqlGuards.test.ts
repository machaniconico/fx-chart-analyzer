import { describe, expect, it } from 'vitest';
import { fillingChoice, stopsDistanceAllowed, tradeRetcodeOk } from './mqlGuards';

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
