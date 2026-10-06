// Pure TypeScript mirrors of the order guards emitted into generated EAs, so the
// boundary rules can be unit-tested. Keep in sync with StopsDistanceAllowed,
// TradeRetcodeOk and ApplyFillingMode in mql.ts.

/** Signed SL/TP distances in whole points; reject wrong side, zero, or below the broker minimum. */
export const stopsDistanceAllowed = (
  longSide: boolean,
  referencePrice: number,
  sl: number,
  tp: number,
  point: number,
  minPoints: number,
): boolean => {
  const slPoints = Math.round((longSide ? referencePrice - sl : sl - referencePrice) / point);
  const tpPoints = Math.round((longSide ? tp - referencePrice : referencePrice - tp) / point);
  return slPoints > 0 && tpPoints > 0 && slPoints >= minPoints && tpPoints >= minPoints;
};

const TRADE_RETCODE_PLACED = 10008;
const TRADE_RETCODE_DONE = 10009;
const TRADE_RETCODE_DONE_PARTIAL = 10010;

export const tradeRetcodeOk = (retcode: number): boolean =>
  retcode === TRADE_RETCODE_DONE || retcode === TRADE_RETCODE_DONE_PARTIAL || retcode === TRADE_RETCODE_PLACED;

const SYMBOL_FILLING_FOK = 1;
const SYMBOL_FILLING_IOC = 2;

export type FillingChoice = 'FOK' | 'IOC' | 'RETURN' | 'DEFAULT';

export const fillingChoice = (fillingModeFlags: number, marketExecution: boolean): FillingChoice => {
  if ((fillingModeFlags & SYMBOL_FILLING_FOK) !== 0) return 'FOK';
  if ((fillingModeFlags & SYMBOL_FILLING_IOC) !== 0) return 'IOC';
  return marketExecution ? 'DEFAULT' : 'RETURN';
};

/**
 * Mirror of the tail of ReentryCooldownAllows: a close within the last `cooldownBars + 1` bars
 * (current bar = shift 0) blocks entry. `barTime(shift)` returns 0 when unavailable.
 */
export const reentryAllowed = (
  lastClose: number,
  cooldownBars: number,
  barTime: (shift: number) => number,
  barsAvailable: number,
): boolean => {
  if (lastClose === 0) return true;
  let boundary = barTime(cooldownBars);
  if (boundary === 0) {
    if (barsAvailable <= 0) return false;
    boundary = barTime(barsAvailable - 1);
    if (boundary === 0) return false;
  }
  return lastClose < boundary;
};
