import { SAR_CONVERGENCE_WARMUP_BARS } from './indicators';
import type {
  BollingerBandSide,
  BollingerCondition,
  BollingerConditionMode,
  CciBreakCondition,
  AdxTrendCondition,
  DonchianBreakCondition,
  EntryCondition,
  IchimokuCrossCondition,
  KeltnerBreakCondition,
  LotSizingMode,
  MaCrossCondition,
  MoneyManagementSettings,
  MacdCrossCondition,
  MovingAverageType,
  ParabolicSarCondition,
  RsiComparison,
  RsiCondition,
  StochasticCondition,
  StrategyDefinition,
} from './strategy';
import { defaultMoneyManagement } from './strategy';

const boolLiteral = (value: boolean): string => (value ? 'true' : 'false');

const numberLiteral = (value: number): string => {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot generate MQL number literal for non-finite value: ${value}`);
  }
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
};

const integerLiteral = (value: number): string => {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot generate MQL integer literal for non-finite value: ${value}`);
  }
  return String(Math.round(value));
};

const mqlString = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');

const maMethod = (type: MovingAverageType): string =>
  type === 'sma' ? 'MODE_SMA' : 'MODE_EMA';

const mirrorComparison = (comparison: RsiComparison): RsiComparison => {
  switch (comparison) {
    case 'below':
      return 'above';
    case 'above':
      return 'below';
    case 'crossBelow':
      return 'crossAbove';
    case 'crossAbove':
      return 'crossBelow';
  }
};

const mirrorBand = (band: BollingerBandSide): BollingerBandSide =>
  band === 'lower' ? 'upper' : 'lower';

const rsiCode = (
  comparison: RsiComparison,
  thresholdExpression: string,
): string => {
  switch (comparison) {
    case 'below':
      return `return current <= ${thresholdExpression};`;
    case 'above':
      return `return current >= ${thresholdExpression};`;
    case 'crossBelow':
      return `return ValueReady(previous) && previous > ${thresholdExpression} && current <= ${thresholdExpression};`;
    case 'crossAbove':
      return `return ValueReady(previous) && previous < ${thresholdExpression} && current >= ${thresholdExpression};`;
  }
};

const bbCode = (band: BollingerBandSide, mode: BollingerConditionMode): string => {
  if (band === 'upper') {
    return mode === 'touch' ? 'return high1 >= upper;' : 'return close1 >= upper;';
  }
  return mode === 'touch' ? 'return low1 <= lower;' : 'return close1 <= lower;';
};

const conditionInputLines = (condition: EntryCondition, index: number, mql5: boolean): string[] => {
  switch (condition.type) {
    case 'maCross':
      return [
        `input int InpMA${index}FastPeriod = ${integerLiteral(condition.fastPeriod)};`,
        `input int InpMA${index}SlowPeriod = ${integerLiteral(condition.slowPeriod)};`,
        mql5
          ? `input ENUM_MA_METHOD InpMA${index}FastMethod = ${maMethod(condition.fastType)};`
          : `input int InpMA${index}FastMethod = ${maMethod(condition.fastType)};`,
        mql5
          ? `input ENUM_MA_METHOD InpMA${index}SlowMethod = ${maMethod(condition.slowType)};`
          : `input int InpMA${index}SlowMethod = ${maMethod(condition.slowType)};`,
      ];
    case 'rsi':
      return [
        `input int InpRSI${index}Period = ${integerLiteral(condition.period)};`,
        `input double InpRSI${index}Threshold = ${numberLiteral(condition.threshold)};`,
      ];
    case 'bollinger':
      return [
        `input int InpBB${index}Period = ${integerLiteral(condition.period)};`,
        `input double InpBB${index}Deviation = ${numberLiteral(condition.multiplier)};`,
      ];
    case 'macdCross':
      return [
        `input int InpMACD${index}FastPeriod = ${integerLiteral(condition.fastPeriod)};`,
        `input int InpMACD${index}SlowPeriod = ${integerLiteral(condition.slowPeriod)};`,
        `input int InpMACD${index}SignalPeriod = ${integerLiteral(condition.signalPeriod)};`,
      ];
    case 'ichimokuCross':
      return [
        `input int InpIchimoku${index}ConversionPeriod = ${integerLiteral(condition.conversionPeriod)};`,
        `input int InpIchimoku${index}BasePeriod = ${integerLiteral(condition.basePeriod)};`,
        `input int InpIchimoku${index}SpanBPeriod = ${integerLiteral(condition.spanBPeriod)};`,
        `input int InpIchimoku${index}Displacement = ${integerLiteral(condition.displacement)};`,
        `input bool InpIchimoku${index}RequireCloudFilter = ${boolLiteral(condition.requireCloudFilter)};`,
      ];
    case 'donchianBreak':
      return [`input int InpDonchian${index}Period = ${integerLiteral(condition.period)};`];
    case 'keltnerBreak':
      return [
        `input int InpKeltner${index}EmaPeriod = ${integerLiteral(condition.emaPeriod)};`,
        `input int InpKeltner${index}AtrPeriod = ${integerLiteral(condition.atrPeriod)};`,
        `input double InpKeltner${index}Multiplier = ${numberLiteral(condition.multiplier)};`,
      ];
    case 'cciBreak':
      return [
        `input int InpCCI${index}Period = ${integerLiteral(condition.period)};`,
        `input double InpCCI${index}Level = ${numberLiteral(condition.level)};`,
      ];
    case 'adxTrend':
      return [
        `input int InpADX${index}Period = ${integerLiteral(condition.period)};`,
        `input double InpADX${index}Threshold = ${numberLiteral(condition.threshold)};`,
      ];
    case 'parabolicSar':
      return [
        `input double InpSAR${index}Step = ${numberLiteral(condition.step)};`,
        `input double InpSAR${index}Maximum = ${numberLiteral(condition.maximum)};`,
      ];
    case 'stochastic':
      return [
        `input int InpStoch${index}KPeriod = ${integerLiteral(condition.kPeriod)};`,
        `input int InpStoch${index}DPeriod = ${integerLiteral(condition.dPeriod)};`,
        `input int InpStoch${index}Smoothing = ${integerLiteral(condition.smoothing)};`,
        `input double InpStoch${index}Threshold = ${numberLiteral(condition.threshold)};`,
      ];
  }
};

const mql5ConditionFunction = (condition: EntryCondition, index: number): string => {
  switch (condition.type) {
    case 'maCross':
      return mql5MaCondition(condition, index);
    case 'rsi':
      return mql5RsiCondition(condition, index);
    case 'bollinger':
      return mql5BollingerCondition(condition, index);
    case 'macdCross':
      return mql5MacdCondition(condition, index);
    case 'ichimokuCross':
      return mql5IchimokuCondition(condition, index);
    case 'donchianBreak':
      // The TypeScript backtest assumes sufficient history; MQL5 skips the
      // signal during the Donchian warm-up period via the generated guard.
      return mql5DonchianCondition(condition, index);
    case 'stochastic':
      return mqlStochasticCondition(condition, index);
    case 'keltnerBreak':
      return mql5KeltnerCondition(condition, index);
    case 'cciBreak':
      return mql5CciCondition(condition, index);
    case 'adxTrend':
      return mql5AdxCondition(condition, index);
    case 'parabolicSar':
      return mql5ParabolicSarCondition(condition, index);
  }
};

const mql4ConditionFunction = (condition: EntryCondition, index: number): string => {
  switch (condition.type) {
    case 'maCross':
      return mql4MaCondition(condition, index);
    case 'rsi':
      return mql4RsiCondition(condition, index);
    case 'bollinger':
      return mql4BollingerCondition(condition, index);
    case 'macdCross':
      return mql4MacdCondition(condition, index);
    case 'ichimokuCross':
      return mql4IchimokuCondition(condition, index);
    case 'donchianBreak':
      // The TypeScript backtest assumes sufficient history; MQL4 skips the
      // signal during the Donchian warm-up period via the generated guard.
      return mql4DonchianCondition(condition, index);
    case 'stochastic':
      return mqlStochasticCondition(condition, index);
    case 'keltnerBreak':
      return mql4KeltnerCondition(condition, index);
    case 'cciBreak':
      return mql4CciCondition(condition, index);
    case 'adxTrend':
      return mql4AdxCondition(condition, index);
    case 'parabolicSar':
      return mql4ParabolicSarCondition(condition, index);
  }
};

const mql5MaCondition = (_condition: MaCrossCondition, index: number): string => `
bool Condition${index}(bool longSide)
{
  double previousFast = BufferValue(ma${index}FastHandle, 0, 2);
  double previousSlow = BufferValue(ma${index}SlowHandle, 0, 2);
  double currentFast = BufferValue(ma${index}FastHandle, 0, 1);
  double currentSlow = BufferValue(ma${index}SlowHandle, 0, 1);
  if(!ValueReady(previousFast) || !ValueReady(previousSlow) || !ValueReady(currentFast) || !ValueReady(currentSlow))
  {
    return false;
  }
  if(longSide)
  {
    return CrossedAbove(previousFast, previousSlow, currentFast, currentSlow);
  }
  return CrossedBelow(previousFast, previousSlow, currentFast, currentSlow);
}
`;

const mql4MaCondition = (_condition: MaCrossCondition, index: number): string => `
bool Condition${index}(bool longSide)
{
  double previousFast = iMA(_Symbol, _Period, InpMA${index}FastPeriod, 0, InpMA${index}FastMethod, PRICE_CLOSE, 2);
  double previousSlow = iMA(_Symbol, _Period, InpMA${index}SlowPeriod, 0, InpMA${index}SlowMethod, PRICE_CLOSE, 2);
  double currentFast = iMA(_Symbol, _Period, InpMA${index}FastPeriod, 0, InpMA${index}FastMethod, PRICE_CLOSE, 1);
  double currentSlow = iMA(_Symbol, _Period, InpMA${index}SlowPeriod, 0, InpMA${index}SlowMethod, PRICE_CLOSE, 1);
  if(!ValueReady(previousFast) || !ValueReady(previousSlow) || !ValueReady(currentFast) || !ValueReady(currentSlow))
  {
    return false;
  }
  if(longSide)
  {
    return CrossedAbove(previousFast, previousSlow, currentFast, currentSlow);
  }
  return CrossedBelow(previousFast, previousSlow, currentFast, currentSlow);
}
`;

const mql5RsiCondition = (condition: RsiCondition, index: number): string => {
  const shortComparison = mirrorComparison(condition.comparison);
  return `
bool Condition${index}(bool longSide)
{
  double previous = BufferValue(rsi${index}Handle, 0, 2);
  double current = BufferValue(rsi${index}Handle, 0, 1);
  if(!ValueReady(current))
  {
    return false;
  }
  if(longSide)
  {
    ${rsiCode(condition.comparison, `InpRSI${index}Threshold`)}
  }
  ${rsiCode(shortComparison, `100.0 - InpRSI${index}Threshold`)}
}
`;
};

const mql4RsiCondition = (condition: RsiCondition, index: number): string => {
  const shortComparison = mirrorComparison(condition.comparison);
  return `
bool Condition${index}(bool longSide)
{
  double previous = iRSI(_Symbol, _Period, InpRSI${index}Period, PRICE_CLOSE, 2);
  double current = iRSI(_Symbol, _Period, InpRSI${index}Period, PRICE_CLOSE, 1);
  if(!ValueReady(current))
  {
    return false;
  }
  if(longSide)
  {
    ${rsiCode(condition.comparison, `InpRSI${index}Threshold`)}
  }
  ${rsiCode(shortComparison, `100.0 - InpRSI${index}Threshold`)}
}
`;
};

const mql5BollingerCondition = (condition: BollingerCondition, index: number): string => {
  const shortBand = mirrorBand(condition.band);
  return `
bool Condition${index}(bool longSide)
{
  double upper = BufferValue(bb${index}Handle, 1, 1);
  double lower = BufferValue(bb${index}Handle, 2, 1);
  double close1 = iClose(_Symbol, _Period, 1);
  double high1 = iHigh(_Symbol, _Period, 1);
  double low1 = iLow(_Symbol, _Period, 1);
  if(!ValueReady(upper) || !ValueReady(lower))
  {
    return false;
  }
  if(longSide)
  {
    ${bbCode(condition.band, condition.mode)}
  }
  ${bbCode(shortBand, condition.mode)}
}
`;
};

const mql4BollingerCondition = (condition: BollingerCondition, index: number): string => {
  const shortBand = mirrorBand(condition.band);
  return `
bool Condition${index}(bool longSide)
{
  double upper = iBands(_Symbol, _Period, InpBB${index}Period, InpBB${index}Deviation, 0, PRICE_CLOSE, MODE_UPPER, 1);
  double lower = iBands(_Symbol, _Period, InpBB${index}Period, InpBB${index}Deviation, 0, PRICE_CLOSE, MODE_LOWER, 1);
  double close1 = iClose(_Symbol, _Period, 1);
  double high1 = iHigh(_Symbol, _Period, 1);
  double low1 = iLow(_Symbol, _Period, 1);
  if(!ValueReady(upper) || !ValueReady(lower))
  {
    return false;
  }
  if(longSide)
  {
    ${bbCode(condition.band, condition.mode)}
  }
  ${bbCode(shortBand, condition.mode)}
}
`;
};

const mql5DonchianCondition = (condition: DonchianBreakCondition, index: number): string =>
  mqlDonchianCondition(condition, index, 'MQL5');

const mql4DonchianCondition = (condition: DonchianBreakCondition, index: number): string =>
  mqlDonchianCondition(condition, index, 'MQL4');

const mqlDonchianCondition = (
  _condition: DonchianBreakCondition,
  index: number,
  platform: 'MQL4' | 'MQL5',
): string => `
bool Condition${index}(bool longSide)
{
  // Shift 2 is the bar immediately before the signal bar (shift 1); the signal bar is excluded.
  // Warm-up behavior differs from the TypeScript backtest: TS assumes sufficient history; ${platform} skips this signal via the guard below until period + 1 bars are available.
  int period = InpDonchian${index}Period;
  if(period < 1)
  {
    period = 1;
  }
  if(iTime(_Symbol, _Period, period + 1) == 0)
  {
    return false;
  }
  int highestShift = iHighest(_Symbol, _Period, MODE_HIGH, period, 2);
  int lowestShift = iLowest(_Symbol, _Period, MODE_LOW, period, 2);
  if(highestShift < 0 || lowestShift < 0)
  {
    return false;
  }
  double close1 = iClose(_Symbol, _Period, 1);
  double upper = iHigh(_Symbol, _Period, highestShift);
  double lower = iLow(_Symbol, _Period, lowestShift);
  if(!ValueReady(close1) || !ValueReady(upper) || !ValueReady(lower))
  {
    return false;
  }
  if(longSide)
  {
    return close1 > upper;
  }
  return close1 < lower;
}
`;

const keltnerParityComment = `
// ATR parity basis: MetaQuotes documents ATR as a moving average of True Range;
// the official MetaQuotes ATR implementation/article uses a Simple Moving Average
// of TR, not Wilder/SMMA smoothing. See https://www.mql5.com/en/articles/16931
// and https://www.mql5.com/en/code/12.
// EMA warm-up note: the TS ema() seeds with the first EMA-period SMA, while
// MT4/MT5 iMA(MODE_EMA) may converge differently during warm-up. The history
// guard below keeps the EA fail-closed until both platform indicators are ready.
`;

type KeltnerIndicatorExpressions = {
  middle: string;
  atr: string;
};

const mqlKeltnerCondition = (
  index: number,
  expressions: KeltnerIndicatorExpressions,
): string => `
${keltnerParityComment}bool Condition${index}(bool longSide)
{
  int requiredPeriod = InpKeltner${index}EmaPeriod;
  if(InpKeltner${index}AtrPeriod > requiredPeriod)
  {
    requiredPeriod = InpKeltner${index}AtrPeriod;
  }
  if(requiredPeriod < 1)
  {
    requiredPeriod = 1;
  }
  if(iTime(_Symbol, _Period, requiredPeriod + 1) == 0)
  {
    return false;
  }
  double middle = ${expressions.middle};
  double atrValue = ${expressions.atr};
  double close1 = iClose(_Symbol, _Period, 1);
  if(!ValueReady(middle) || !ValueReady(atrValue) || !ValueReady(close1))
  {
    return false;
  }
  if(atrValue <= 0.0)
  {
    return false;
  }
  double upper = middle + InpKeltner${index}Multiplier * atrValue;
  double lower = middle - InpKeltner${index}Multiplier * atrValue;
  if(!ValueReady(upper) || !ValueReady(lower))
  {
    return false;
  }
  if(longSide)
  {
    return close1 >= upper;
  }
  return close1 <= lower;
}
`;

const mql5KeltnerCondition = (_condition: KeltnerBreakCondition, index: number): string =>
  mqlKeltnerCondition(index, {
    middle: `BufferValue(keltner${index}EmaHandle, 0, 1)`,
    atr: `BufferValue(keltner${index}AtrHandle, 0, 1)`,
  });

const mql4KeltnerCondition = (_condition: KeltnerBreakCondition, index: number): string =>
  mqlKeltnerCondition(index, {
    middle: `iMA(_Symbol, _Period, InpKeltner${index}EmaPeriod, 0, MODE_EMA, PRICE_CLOSE, 1)`,
    atr: `iATR(_Symbol, _Period, InpKeltner${index}AtrPeriod, 1)`,
  });

const cciParityComment = `
// CCI parity basis: the official MetaQuotes CCI reference documents Typical
// Price, SMA, mean absolute deviation, and Lambert's 0.015 factor.
// The zero-mean-deviation result is intentionally represented as 0.0 here as
// a parity design choice for MT5 built-in behavior; positive levels keep flat
// windows fail-closed.
// Reference: https://www.mql5.com/en/code/18
`;

const mqlCciCondition = (index: number, expression: string): string => `
${cciParityComment}bool Condition${index}(bool longSide)
{
  int period = InpCCI${index}Period;
  if(period < 1)
  {
    period = 1;
  }
  if(iTime(_Symbol, _Period, period) == 0)
  {
    return false;
  }
  double current = ${expression};
  double level = InpCCI${index}Level;
  if(!ValueReady(current) || !ValueReady(level))
  {
    return false;
  }
  if(!(level > 0.0))
  {
    return false;
  }
  if(longSide)
  {
    return current >= level;
  }
  return current <= -level;
}
`;

const mql5CciCondition = (_condition: CciBreakCondition, index: number): string =>
  mqlCciCondition(index, `BufferValue(cci${index}Handle, 0, 1)`);

const mql4CciCondition = (_condition: CciBreakCondition, index: number): string =>
  mqlCciCondition(index, 'iCCI(_Symbol, _Period, period, PRICE_TYPICAL, 1)');

const adxParityComment = `
// Native iADX exposes +DI, -DI, and ADX with zero-seeded values before the
// TypeScript evaluator's warm-up boundary. The generated history guard keeps
// both platforms fail-closed until DI has period bars and ADX has 2*period bars.
// Reference: https://www.mql5.com/en/docs/indicators/iadx
`;

type AdxIndicatorExpressions = {
  plusDi: (shift: number) => string;
  minusDi: (shift: number) => string;
  main: (shift: number) => string;
};

const mqlAdxCondition = (
  index: number,
  expressions: AdxIndicatorExpressions,
): string => `
${adxParityComment}bool Condition${index}(bool longSide)
{
  int period = InpADX${index}Period;
  if(period < 2)
  {
    return false;
  }
  // The TypeScript evaluator exposes ADX from index period*2; native iADX
  // returns zero-seeded values earlier, so require the equivalent bar count.
  if(iTime(_Symbol, _Period, period * 2 + 1) == 0)
  {
    return false;
  }
  double previousPlusDi = ${expressions.plusDi(2)};
  double previousMinusDi = ${expressions.minusDi(2)};
  double previousAdx = ${expressions.main(2)};
  double currentPlusDi = ${expressions.plusDi(1)};
  double currentMinusDi = ${expressions.minusDi(1)};
  double currentAdx = ${expressions.main(1)};
  double threshold = InpADX${index}Threshold;
  if(!ValueReady(previousPlusDi) || !ValueReady(previousMinusDi) || !ValueReady(previousAdx) ||
    !ValueReady(currentPlusDi) || !ValueReady(currentMinusDi) || !ValueReady(currentAdx) ||
    !ValueReady(threshold))
  {
    return false;
  }
  if(!(threshold > 0.0) || !(threshold < 100.0))
  {
    return false;
  }
  if(currentAdx < threshold)
  {
    return false;
  }
  if(longSide)
  {
    return CrossedAbove(previousPlusDi, previousMinusDi, currentPlusDi, currentMinusDi);
  }
  return CrossedBelow(previousPlusDi, previousMinusDi, currentPlusDi, currentMinusDi);
}
`;

const mql5AdxCondition = (_condition: AdxTrendCondition, index: number): string =>
  mqlAdxCondition(index, {
    plusDi: (shift) => `BufferValue(adx${index}Handle, PLUSDI_LINE, ${shift})`,
    minusDi: (shift) => `BufferValue(adx${index}Handle, MINUSDI_LINE, ${shift})`,
    main: (shift) => `BufferValue(adx${index}Handle, MAIN_LINE, ${shift})`,
  });

const mql4AdxCondition = (_condition: AdxTrendCondition, index: number): string =>
  mqlAdxCondition(index, {
    plusDi: (shift) => `iADX(_Symbol, _Period, period, PRICE_CLOSE, MODE_PLUSDI, ${shift})`,
    minusDi: (shift) => `iADX(_Symbol, _Period, period, PRICE_CLOSE, MODE_MINUSDI, ${shift})`,
    main: (shift) => `iADX(_Symbol, _Period, period, PRICE_CLOSE, MODE_MAIN, ${shift})`,
  });

const parabolicSarParityComment = `
// Parabolic SAR parity: the TypeScript evaluator starts SHORT and flips to LONG
// when the SAR is strictly below the current high; it flips to SHORT when the
// SAR is strictly above the current low. Native iSAR places the flip value on
// the current low/high, so both platforms reconstruct the post-flip direction
// with the same strict rule: LONG iff SAR < high, otherwise SHORT. Entry flips
// are then the same two-point comparison of previous and current direction.
// The TypeScript evaluator exposes SAR only after two reversals and 100 bars
// from the first reversal. Native iSAR is seeded from full history, so the
// generated scan below applies the equivalent reversal-count/bar-distance gate.
`;

type ParabolicSarIndicatorExpressions = {
  value: (shift: string) => string;
  warmupPrelude: string;
};

const mqlParabolicSarCondition = (
  index: number,
  expressions: ParabolicSarIndicatorExpressions,
): string => `
${parabolicSarParityComment}
bool SarDirectionIsLong${index}(double sar, double high, double low)
{
  // MT SAR's invariant is that a long-state SAR is at or below the candle's
  // low, while a short-state SAR is at or above its high. Therefore the
  // evaluator's direction is reconstructed by one strict comparison: LONG
  // iff SAR < high; equality is the short-side boundary.
  return sar < high;
}

bool SarWarmupReady${index}(int signalShift)
{
${expressions.warmupPrelude}
  static datetime cachedBarTime = 0;
  static bool cachedResult = false;
  datetime currentBarTime = iTime(_Symbol, _Period, 0);
  if(currentBarTime == 0)
  {
    return false;
  }
  if(cachedBarTime == currentBarTime)
  {
    return cachedResult;
  }
  cachedBarTime = currentBarTime;
  // Cache failures as well: the same chart bar must not rescan full history.
  cachedResult = false;
  int totalBars = Bars(_Symbol, _Period);
  if(totalBars <= signalShift + 1)
  {
    return false;
  }
  int firstReversalShift = -1;
  int reversalCount = 0;
  bool previousIsLong = false;
  bool hasPrevious = false;
  for(int shift = totalBars - 1; shift >= signalShift + 1; shift--)
  {
    if(iTime(_Symbol, _Period, shift) == 0)
    {
      return false;
    }
    double sar = ${expressions.value('shift')};
    double high = iHigh(_Symbol, _Period, shift);
    double low = iLow(_Symbol, _Period, shift);
    if(!ValueReady(sar) || !MathIsValidNumber(sar) || !ValueReady(high) || !MathIsValidNumber(high) ||
      !ValueReady(low) || !MathIsValidNumber(low))
    {
      return false;
    }
    // MT4 iSAR/iHigh return 0.0 for missing history. FX prices and SAR are
    // strictly positive, so exact zero is unambiguously unavailable data and
    // must not be allowed to turn into a false LONG direction.
    if(!(sar > 0.0 && high > 0.0 && low > 0.0))
    {
      return false;
    }
    bool currentIsLong = SarDirectionIsLong${index}(sar, high, low);
    if(!hasPrevious)
    {
      // The TypeScript evaluator seeds its first SAR state as SHORT.
      hasPrevious = true;
      continue;
    }
    if(currentIsLong != previousIsLong)
    {
      reversalCount++;
      if(firstReversalShift < 0)
      {
        firstReversalShift = shift;
      }
    }
    previousIsLong = currentIsLong;
    if(reversalCount >= 2)
    {
      // firstReversalShift is already latched; Condition${index} rechecks
      // shifts 2 and 1. Stop after the second reversal to keep this per-bar
      // scan bounded without changing the warm-up meaning. Data validation of
      // bars newer than the second reversal is intentionally dropped here;
      // the signal bars themselves are revalidated in Condition${index}.
      break;
    }
  }
  if(reversalCount < 2 || firstReversalShift < 0)
  {
    return false;
  }
  // The TS signal needs both index-1 and index, so a reversal on signalShift
  // itself is not countable. Require the older point to be at least
  // ${SAR_CONVERGENCE_WARMUP_BARS} bars after the first reversal (interpolated
  // from indicators.ts so the TS gate and the generated EA cannot drift).
  cachedResult = firstReversalShift - (signalShift + 1) >= ${SAR_CONVERGENCE_WARMUP_BARS};
  return cachedResult;
}

bool Condition${index}(bool longSide)
{
  double step = InpSAR${index}Step;
  double maximum = InpSAR${index}Maximum;
  // This is exactly the TS evaluator's fail-closed domain. Registration adds
  // step >= 0.02 and both values < 1; those are pipeline policy, not evaluator
  // semantics, so the generated EA intentionally rejects only this domain.
  if(!MathIsValidNumber(step) || !MathIsValidNumber(maximum) || step <= 0.0 || maximum < step)
  {
    return false;
  }
  if(!SarWarmupReady${index}(1))
  {
    return false;
  }
  double previousSar = ${expressions.value('2')};
  double currentSar = ${expressions.value('1')};
  double previousHigh = iHigh(_Symbol, _Period, 2);
  double currentHigh = iHigh(_Symbol, _Period, 1);
  double previousLow = iLow(_Symbol, _Period, 2);
  double currentLow = iLow(_Symbol, _Period, 1);
  if(!ValueReady(previousSar) || !MathIsValidNumber(previousSar) ||
    !ValueReady(currentSar) || !MathIsValidNumber(currentSar) ||
    !ValueReady(previousHigh) || !MathIsValidNumber(previousHigh) ||
    !ValueReady(currentHigh) || !MathIsValidNumber(currentHigh) ||
    !ValueReady(previousLow) || !MathIsValidNumber(previousLow) ||
    !ValueReady(currentLow) || !MathIsValidNumber(currentLow))
  {
    return false;
  }
  if(!(previousSar > 0.0 && currentSar > 0.0 && previousHigh > 0.0 && currentHigh > 0.0 &&
    previousLow > 0.0 && currentLow > 0.0))
  {
    return false;
  }
  bool previousIsLong = SarDirectionIsLong${index}(previousSar, previousHigh, previousLow);
  bool currentIsLong = SarDirectionIsLong${index}(currentSar, currentHigh, currentLow);
  if(longSide)
  {
    return !previousIsLong && currentIsLong;
  }
  return previousIsLong && !currentIsLong;
}
`;

const mql5ParabolicSarCondition = (_condition: ParabolicSarCondition, index: number): string =>
  mqlParabolicSarCondition(index, {
    value: (shift) => `BufferValue(sar${index}Handle, 0, ${shift})`,
    warmupPrelude: '',
  });

const mql4ParabolicSarCondition = (_condition: ParabolicSarCondition, index: number): string =>
  mqlParabolicSarCondition(index, {
    value: (shift) => `iSAR(_Symbol, _Period, step, maximum, ${shift})`,
    warmupPrelude: `  double step = InpSAR${index}Step;\n  double maximum = InpSAR${index}Maximum;`,
  });

const mql4ParabolicSarOnInit = (conditions: readonly EntryCondition[]): string => {
  const warningLines = conditions.flatMap((condition, index) => {
    if (condition.type !== 'parabolicSar') {
      return [];
    }
    const conditionIndex = index + 1;
    return [
      `  if(InpSAR${conditionIndex}Step < 0.02)`,
      '  {',
      `    Print("SAR${conditionIndex} warning: step below 0.02 is outside the evaluator registration domain");`,
      '  }',
    ];
  });
  if (warningLines.length === 0) {
    return '';
  }
  return `
int OnInit()
{
${warningLines.join('\n')}
  return INIT_SUCCEEDED;
}
`;
};

const mqlStochasticCondition = (condition: StochasticCondition, index: number): string => {
  const shortComparison = mirrorComparison(condition.comparison);
  return `
// The TS evaluator computes raw %K over kPeriod, then applies a smoothing-period SMA.
// Flat high/low ranges are explicitly mapped to 50. The D period is retained as an input
// for parity with the stochastic definition; entry conditions intentionally compare %K.
double StochasticRawK${index}(int shift)
{
  int kPeriod = InpStoch${index}KPeriod;
  if(kPeriod < 1)
  {
    kPeriod = 1;
  }
  if(iTime(_Symbol, _Period, shift + kPeriod - 1) == 0)
  {
    return EMPTY_VALUE;
  }
  int highestShift = iHighest(_Symbol, _Period, MODE_HIGH, kPeriod, shift);
  int lowestShift = iLowest(_Symbol, _Period, MODE_LOW, kPeriod, shift);
  if(highestShift < 0 || lowestShift < 0)
  {
    return EMPTY_VALUE;
  }
  double highest = iHigh(_Symbol, _Period, highestShift);
  double lowest = iLow(_Symbol, _Period, lowestShift);
  double closeAtShift = iClose(_Symbol, _Period, shift);
  if(!ValueReady(highest) || !ValueReady(lowest) || !ValueReady(closeAtShift))
  {
    return EMPTY_VALUE;
  }
  double range = highest - lowest;
  if(range == 0.0)
  {
    return 50.0;
  }
  return (closeAtShift - lowest) / range * 100.0;
}

double StochasticK${index}(int shift)
{
  int smoothing = InpStoch${index}Smoothing;
  if(smoothing < 1)
  {
    smoothing = 1;
  }
  double sum = 0.0;
  for(int offset = 0; offset < smoothing; offset++)
  {
    double raw = StochasticRawK${index}(shift + offset);
    if(!ValueReady(raw))
    {
      return EMPTY_VALUE;
    }
    sum += raw;
  }
  return sum / smoothing;
}

bool Condition${index}(bool longSide)
{
  double previous = StochasticK${index}(2);
  double current = StochasticK${index}(1);
  if(!ValueReady(current))
  {
    return false;
  }
  if(longSide)
  {
    ${rsiCode(condition.comparison, `InpStoch${index}Threshold`)}
  }
  ${rsiCode(shortComparison, `100.0 - InpStoch${index}Threshold`)}
}
`;
};

const mql5MacdCondition = (_condition: MacdCrossCondition, index: number): string => `
bool Condition${index}(bool longSide)
{
  double previousMain = BufferValue(macd${index}Handle, 0, 2);
  double previousSignal = BufferValue(macd${index}Handle, 1, 2);
  double currentMain = BufferValue(macd${index}Handle, 0, 1);
  double currentSignal = BufferValue(macd${index}Handle, 1, 1);
  if(!ValueReady(previousMain) || !ValueReady(previousSignal) || !ValueReady(currentMain) || !ValueReady(currentSignal))
  {
    return false;
  }
  if(longSide)
  {
    return CrossedAbove(previousMain, previousSignal, currentMain, currentSignal);
  }
  return CrossedBelow(previousMain, previousSignal, currentMain, currentSignal);
}
`;

const mql4MacdCondition = (_condition: MacdCrossCondition, index: number): string => `
bool Condition${index}(bool longSide)
{
  double previousMain = iMACD(_Symbol, _Period, InpMACD${index}FastPeriod, InpMACD${index}SlowPeriod, InpMACD${index}SignalPeriod, PRICE_CLOSE, MODE_MAIN, 2);
  double previousSignal = iMACD(_Symbol, _Period, InpMACD${index}FastPeriod, InpMACD${index}SlowPeriod, InpMACD${index}SignalPeriod, PRICE_CLOSE, MODE_SIGNAL, 2);
  double currentMain = iMACD(_Symbol, _Period, InpMACD${index}FastPeriod, InpMACD${index}SlowPeriod, InpMACD${index}SignalPeriod, PRICE_CLOSE, MODE_MAIN, 1);
  double currentSignal = iMACD(_Symbol, _Period, InpMACD${index}FastPeriod, InpMACD${index}SlowPeriod, InpMACD${index}SignalPeriod, PRICE_CLOSE, MODE_SIGNAL, 1);
  if(!ValueReady(previousMain) || !ValueReady(previousSignal) || !ValueReady(currentMain) || !ValueReady(currentSignal))
  {
    return false;
  }
  if(longSide)
  {
    return CrossedAbove(previousMain, previousSignal, currentMain, currentSignal);
  }
  return CrossedBelow(previousMain, previousSignal, currentMain, currentSignal);
}
`;

const ichimokuParityComment = `
// Parity basis: MT4/MT5 SENKOUSPAN buffers expose the already displaced cloud
// line at the queried shift, matching TS ichimoku.leadingSpan[index].
`;

const ichimokuDisplacementWarning = (condition: IchimokuCrossCondition): string =>
  // 雲フィルタOFF時は displacement がシグナルに影響しないため警告しない(TS評価器と同じ早期return)
  condition.requireCloudFilter && condition.displacement !== condition.basePeriod
    ? `// WARNING: Ichimoku displacement ${integerLiteral(condition.displacement)} differs from basePeriod ${integerLiteral(condition.basePeriod)}. MQL iIchimoku follows its basePeriod displacement, so cloud parity with TS is not guaranteed.\n`
    : '';

const mql5IchimokuCondition = (condition: IchimokuCrossCondition, index: number): string => `
${ichimokuParityComment}${ichimokuDisplacementWarning(condition)}bool Condition${index}(bool longSide)
{
  int requiredPeriod = InpIchimoku${index}ConversionPeriod;
  if(InpIchimoku${index}BasePeriod > requiredPeriod)
  {
    requiredPeriod = InpIchimoku${index}BasePeriod;
  }
  if(InpIchimoku${index}SpanBPeriod > requiredPeriod)
  {
    requiredPeriod = InpIchimoku${index}SpanBPeriod;
  }
  if(requiredPeriod < 1)
  {
    requiredPeriod = 1;
  }
  if(iTime(_Symbol, _Period, requiredPeriod + 1) == 0)
  {
    return false;
  }
  double previousConversion = BufferValue(ichimoku${index}Handle, 0, 2);
  double previousBase = BufferValue(ichimoku${index}Handle, 1, 2);
  double currentConversion = BufferValue(ichimoku${index}Handle, 0, 1);
  double currentBase = BufferValue(ichimoku${index}Handle, 1, 1);
  if(!ValueReady(previousConversion) || !ValueReady(previousBase) || !ValueReady(currentConversion) || !ValueReady(currentBase))
  {
    return false;
  }
  bool crossed = longSide
    ? CrossedAbove(previousConversion, previousBase, currentConversion, currentBase)
    : CrossedBelow(previousConversion, previousBase, currentConversion, currentBase);
  if(!crossed || !InpIchimoku${index}RequireCloudFilter)
  {
    return crossed;
  }
  // 雲フィルタ経路の履歴要件: SENKOUSPAN は変位済みの線なので、shift 1 の雲値は
  // shift (1 + displacement) のバーから spanBPeriod 本で計算される。クロス判定用の
  // requiredPeriod ではこの displacement 分を包含しないため別途チェックする
  // (MQL4 の iIchimoku は履歴不足時に 0.0 を返し ValueReady を素通りするため fail-open になる)。
  if(iTime(_Symbol, _Period, InpIchimoku${index}SpanBPeriod + InpIchimoku${index}Displacement) == 0)
  {
    return false;
  }
  double spanA = BufferValue(ichimoku${index}Handle, 2, 1);
  double spanB = BufferValue(ichimoku${index}Handle, 3, 1);
  double close1 = iClose(_Symbol, _Period, 1);
  if(!ValueReady(spanA) || !ValueReady(spanB) || !ValueReady(close1))
  {
    return false;
  }
  return longSide ? close1 > MathMax(spanA, spanB) : close1 < MathMin(spanA, spanB);
}
`;

const mql4IchimokuCondition = (condition: IchimokuCrossCondition, index: number): string => `
${ichimokuParityComment}${ichimokuDisplacementWarning(condition)}bool Condition${index}(bool longSide)
{
  int requiredPeriod = InpIchimoku${index}ConversionPeriod;
  if(InpIchimoku${index}BasePeriod > requiredPeriod)
  {
    requiredPeriod = InpIchimoku${index}BasePeriod;
  }
  if(InpIchimoku${index}SpanBPeriod > requiredPeriod)
  {
    requiredPeriod = InpIchimoku${index}SpanBPeriod;
  }
  if(requiredPeriod < 1)
  {
    requiredPeriod = 1;
  }
  if(iTime(_Symbol, _Period, requiredPeriod + 1) == 0)
  {
    return false;
  }
  double previousConversion = iIchimoku(_Symbol, _Period, InpIchimoku${index}ConversionPeriod, InpIchimoku${index}BasePeriod, InpIchimoku${index}SpanBPeriod, MODE_TENKANSEN, 2);
  double previousBase = iIchimoku(_Symbol, _Period, InpIchimoku${index}ConversionPeriod, InpIchimoku${index}BasePeriod, InpIchimoku${index}SpanBPeriod, MODE_KIJUNSEN, 2);
  double currentConversion = iIchimoku(_Symbol, _Period, InpIchimoku${index}ConversionPeriod, InpIchimoku${index}BasePeriod, InpIchimoku${index}SpanBPeriod, MODE_TENKANSEN, 1);
  double currentBase = iIchimoku(_Symbol, _Period, InpIchimoku${index}ConversionPeriod, InpIchimoku${index}BasePeriod, InpIchimoku${index}SpanBPeriod, MODE_KIJUNSEN, 1);
  if(!ValueReady(previousConversion) || !ValueReady(previousBase) || !ValueReady(currentConversion) || !ValueReady(currentBase))
  {
    return false;
  }
  bool crossed = longSide
    ? CrossedAbove(previousConversion, previousBase, currentConversion, currentBase)
    : CrossedBelow(previousConversion, previousBase, currentConversion, currentBase);
  if(!crossed || !InpIchimoku${index}RequireCloudFilter)
  {
    return crossed;
  }
  // 雲フィルタ経路の履歴要件: SENKOUSPAN は変位済みの線なので、shift 1 の雲値は
  // shift (1 + displacement) のバーから spanBPeriod 本で計算される。クロス判定用の
  // requiredPeriod ではこの displacement 分を包含しないため別途チェックする
  // (MQL4 の iIchimoku は履歴不足時に 0.0 を返し ValueReady を素通りするため fail-open になる)。
  if(iTime(_Symbol, _Period, InpIchimoku${index}SpanBPeriod + InpIchimoku${index}Displacement) == 0)
  {
    return false;
  }
  double spanA = iIchimoku(_Symbol, _Period, InpIchimoku${index}ConversionPeriod, InpIchimoku${index}BasePeriod, InpIchimoku${index}SpanBPeriod, MODE_SENKOUSPANA, 1);
  double spanB = iIchimoku(_Symbol, _Period, InpIchimoku${index}ConversionPeriod, InpIchimoku${index}BasePeriod, InpIchimoku${index}SpanBPeriod, MODE_SENKOUSPANB, 1);
  double close1 = iClose(_Symbol, _Period, 1);
  if(!ValueReady(spanA) || !ValueReady(spanB) || !ValueReady(close1))
  {
    return false;
  }
  return longSide ? close1 > MathMax(spanA, spanB) : close1 < MathMin(spanA, spanB);
}
`;

const entrySignalFunction = (strategy: StrategyDefinition): string => {
  if (strategy.entryConditions.length === 0) {
    return `
bool EntrySignal(bool longSide)
{
  return false;
}
`;
  }
  const expression = strategy.entryConditions
    .map((_, index) => `Condition${index + 1}(longSide)`)
    .join(' && ');
  return `
bool EntrySignal(bool longSide)
{
  return ${expression};
}
`;
};

const lotSizingModeValue = (mode: LotSizingMode): number => {
  switch (mode) {
    case 'fixedLot':
      return 0;
    case 'fixedRisk':
      return 1;
    case 'compound':
      return 2;
  }
};

const moneyManagementForStrategy = (strategy: StrategyDefinition): MoneyManagementSettings =>
  strategy.moneyManagement ?? defaultMoneyManagement(strategy.lotSize);

const commonInputs = (strategy: StrategyDefinition, mql5: boolean): string[] => {
  const moneyManagement = moneyManagementForStrategy(strategy);
  return [
    `input int InpLotSizingMode = ${lotSizingModeValue(moneyManagement.lotSizingMode)}; // 0=fixed lot, 1=fixed risk %, 2=compound balance %`,
    `input double InpLots = ${numberLiteral(moneyManagement.fixedLot)};`,
    `input double InpInitialBalance = ${numberLiteral(moneyManagement.initialBalanceYen)};`,
    `input double InpRiskPercent = ${numberLiteral(moneyManagement.riskPercent)};`,
    `input double InpMaxLots = ${numberLiteral(moneyManagement.maxLot)};`,
    `input int InpMagicNumber = ${integerLiteral(strategy.magicNumber)};`,
    `input bool InpTradeLong = ${boolLiteral(strategy.direction === 'long')};`,
    `input bool InpSessionFilterEnable = ${boolLiteral(strategy.sessionFilter.enabled)};`,
    `input string InpSessionStart = "${mqlString(strategy.sessionFilter.start)}";`,
    `input string InpSessionEnd = "${mqlString(strategy.sessionFilter.end)}";`,
    ...(mql5
      ? [
          `input bool NewsFilterEnable = ${boolLiteral(strategy.newsFilter.enabled)};`,
          `input int NewsBlockMinutes = ${integerLiteral(strategy.newsFilter.blockMinutes)};`,
        ]
      : []),
    `input int InpStopLossPips = ${integerLiteral(strategy.exit.stopLossPips)};`,
    `input int InpTakeProfitPips = ${integerLiteral(strategy.exit.takeProfitPips)};`,
    `input bool InpUseTrailingStop = ${boolLiteral(Boolean(strategy.exit.trailingStopPips && strategy.exit.trailingStopPips > 0))};`,
    `input int InpTrailingStopPips = ${integerLiteral(strategy.exit.trailingStopPips ?? 0)};`,
    `input bool InpCloseOnOppositeSignal = ${boolLiteral(strategy.exit.closeOnOppositeSignal)};`,
    ...strategy.entryConditions.flatMap((condition, index) => conditionInputLines(condition, index + 1, mql5)),
  ];
};

const mql5HandleDeclarations = (conditions: readonly EntryCondition[]): string[] =>
  conditions.flatMap((condition, index) => {
    const conditionIndex = index + 1;
    switch (condition.type) {
      case 'maCross':
        return [
          `int ma${conditionIndex}FastHandle = INVALID_HANDLE;`,
          `int ma${conditionIndex}SlowHandle = INVALID_HANDLE;`,
        ];
      case 'rsi':
        return [`int rsi${conditionIndex}Handle = INVALID_HANDLE;`];
      case 'bollinger':
        return [`int bb${conditionIndex}Handle = INVALID_HANDLE;`];
      case 'macdCross':
        return [`int macd${conditionIndex}Handle = INVALID_HANDLE;`];
      case 'ichimokuCross':
        return [`int ichimoku${conditionIndex}Handle = INVALID_HANDLE;`];
      case 'keltnerBreak':
        return [
          `int keltner${conditionIndex}EmaHandle = INVALID_HANDLE;`,
          `int keltner${conditionIndex}AtrHandle = INVALID_HANDLE;`,
        ];
      case 'cciBreak':
        return [`int cci${conditionIndex}Handle = INVALID_HANDLE;`];
      case 'adxTrend':
        return [`int adx${conditionIndex}Handle = INVALID_HANDLE;`];
      case 'parabolicSar':
        return [`int sar${conditionIndex}Handle = INVALID_HANDLE;`];
      case 'donchianBreak':
      case 'stochastic':
        return [];
    }
  });

const mql5HandleInitLines = (conditions: readonly EntryCondition[]): string[] =>
  conditions.flatMap((condition, index) => {
    const conditionIndex = index + 1;
    switch (condition.type) {
      case 'maCross':
        return [
          `  ma${conditionIndex}FastHandle = iMA(_Symbol, _Period, InpMA${conditionIndex}FastPeriod, 0, InpMA${conditionIndex}FastMethod, PRICE_CLOSE);`,
          `  ma${conditionIndex}SlowHandle = iMA(_Symbol, _Period, InpMA${conditionIndex}SlowPeriod, 0, InpMA${conditionIndex}SlowMethod, PRICE_CLOSE);`,
          `  if(!EnsureIndicator(ma${conditionIndex}FastHandle, "MA${conditionIndex} fast") || !EnsureIndicator(ma${conditionIndex}SlowHandle, "MA${conditionIndex} slow"))`,
          '  {',
          '    return INIT_FAILED;',
          '  }',
        ];
      case 'rsi':
        return [
          `  rsi${conditionIndex}Handle = iRSI(_Symbol, _Period, InpRSI${conditionIndex}Period, PRICE_CLOSE);`,
          `  if(!EnsureIndicator(rsi${conditionIndex}Handle, "RSI${conditionIndex}"))`,
          '  {',
          '    return INIT_FAILED;',
          '  }',
        ];
      case 'bollinger':
        return [
          `  bb${conditionIndex}Handle = iBands(_Symbol, _Period, InpBB${conditionIndex}Period, 0, InpBB${conditionIndex}Deviation, PRICE_CLOSE);`,
          `  if(!EnsureIndicator(bb${conditionIndex}Handle, "BB${conditionIndex}"))`,
          '  {',
          '    return INIT_FAILED;',
          '  }',
        ];
      case 'macdCross':
        return [
          `  macd${conditionIndex}Handle = iMACD(_Symbol, _Period, InpMACD${conditionIndex}FastPeriod, InpMACD${conditionIndex}SlowPeriod, InpMACD${conditionIndex}SignalPeriod, PRICE_CLOSE);`,
          `  if(!EnsureIndicator(macd${conditionIndex}Handle, "MACD${conditionIndex}"))`,
          '  {',
          '    return INIT_FAILED;',
          '  }',
        ];
      case 'ichimokuCross':
        return [
          `  ichimoku${conditionIndex}Handle = iIchimoku(_Symbol, _Period, InpIchimoku${conditionIndex}ConversionPeriod, InpIchimoku${conditionIndex}BasePeriod, InpIchimoku${conditionIndex}SpanBPeriod);`,
          `  if(!EnsureIndicator(ichimoku${conditionIndex}Handle, "Ichimoku${conditionIndex}"))`,
          '  {',
          '    return INIT_FAILED;',
          '  }',
        ];
      case 'keltnerBreak':
        return [
          `  keltner${conditionIndex}EmaHandle = iMA(_Symbol, _Period, InpKeltner${conditionIndex}EmaPeriod, 0, MODE_EMA, PRICE_CLOSE);`,
          `  keltner${conditionIndex}AtrHandle = iATR(_Symbol, _Period, InpKeltner${conditionIndex}AtrPeriod);`,
          `  if(!EnsureIndicator(keltner${conditionIndex}EmaHandle, "Keltner${conditionIndex} EMA") || !EnsureIndicator(keltner${conditionIndex}AtrHandle, "Keltner${conditionIndex} ATR"))`,
          '  {',
          '    return INIT_FAILED;',
          '  }',
        ];
      case 'cciBreak':
        return [
          `  int cci${conditionIndex}Period = InpCCI${conditionIndex}Period;`,
          `  if(cci${conditionIndex}Period < 1)`,
          '  {',
          `    cci${conditionIndex}Period = 1;`,
          '  }',
          `  cci${conditionIndex}Handle = iCCI(_Symbol, _Period, cci${conditionIndex}Period, PRICE_TYPICAL);`,
          `  if(!EnsureIndicator(cci${conditionIndex}Handle, "CCI${conditionIndex}"))`,
          '  {',
          '    return INIT_FAILED;',
          '  }',
        ];
      case 'adxTrend':
        return [
          `  int adx${conditionIndex}Period = InpADX${conditionIndex}Period;`,
          `  if(adx${conditionIndex}Period < 1)`,
          '  {',
          `    adx${conditionIndex}Period = 1;`,
          '  }',
          `  adx${conditionIndex}Handle = iADX(_Symbol, _Period, adx${conditionIndex}Period);`,
          `  if(!EnsureIndicator(adx${conditionIndex}Handle, "ADX${conditionIndex}"))`,
          '  {',
          '    return INIT_FAILED;',
          '  }',
        ];
      case 'parabolicSar':
        return [
          `  if(InpSAR${conditionIndex}Step < 0.02)`,
          '  {',
          `    Print("SAR${conditionIndex} warning: step below 0.02 is outside the evaluator registration domain");`,
          '  }',
          `  if(!MathIsValidNumber(InpSAR${conditionIndex}Step) || !MathIsValidNumber(InpSAR${conditionIndex}Maximum) || InpSAR${conditionIndex}Step <= 0.0 || InpSAR${conditionIndex}Maximum < InpSAR${conditionIndex}Step)`,
          '  {',
          `    Print("SAR${conditionIndex} rejected: step must be > 0 and maximum must be >= step");`,
          '    return INIT_FAILED;',
          '  }',
          `  sar${conditionIndex}Handle = iSAR(_Symbol, _Period, InpSAR${conditionIndex}Step, InpSAR${conditionIndex}Maximum);`,
          `  if(!EnsureIndicator(sar${conditionIndex}Handle, "SAR${conditionIndex}"))`,
          '  {',
          '    return INIT_FAILED;',
          '  }',
        ];
      case 'donchianBreak':
      case 'stochastic':
        return [];
    }
  });

const mql5HandleReleaseLines = (conditions: readonly EntryCondition[]): string[] =>
  conditions.flatMap((condition, index) => {
    const conditionIndex = index + 1;
    switch (condition.type) {
      case 'maCross':
        return [
          `  ReleaseIndicator(ma${conditionIndex}FastHandle);`,
          `  ReleaseIndicator(ma${conditionIndex}SlowHandle);`,
        ];
      case 'rsi':
        return [`  ReleaseIndicator(rsi${conditionIndex}Handle);`];
      case 'bollinger':
        return [`  ReleaseIndicator(bb${conditionIndex}Handle);`];
      case 'macdCross':
        return [`  ReleaseIndicator(macd${conditionIndex}Handle);`];
      case 'ichimokuCross':
        return [`  ReleaseIndicator(ichimoku${conditionIndex}Handle);`];
      case 'keltnerBreak':
        return [
          `  ReleaseIndicator(keltner${conditionIndex}EmaHandle);`,
          `  ReleaseIndicator(keltner${conditionIndex}AtrHandle);`,
        ];
      case 'cciBreak':
        return [`  ReleaseIndicator(cci${conditionIndex}Handle);`];
      case 'adxTrend':
        return [`  ReleaseIndicator(adx${conditionIndex}Handle);`];
      case 'parabolicSar':
        return [`  ReleaseIndicator(sar${conditionIndex}Handle);`];
      case 'donchianBreak':
      case 'stochastic':
        return [];
    }
  });

export const generateMql5 = (strategy: StrategyDefinition): string => {
  const inputs = commonInputs(strategy, true).join('\n');
  const handleDeclarations = mql5HandleDeclarations(strategy.entryConditions).join('\n');
  const handleInitLines = mql5HandleInitLines(strategy.entryConditions).join('\n');
  const handleReleaseLines = mql5HandleReleaseLines(strategy.entryConditions).join('\n');
  const conditionFunctions = strategy.entryConditions
    .map((condition, index) => mql5ConditionFunction(condition, index + 1))
    .join('\n');
  const expertName = mqlString(strategy.name);

  return `#property strict
#property description "${expertName}"

// Session filter uses broker server time via TimeCurrent(); it is independent of this app's backtest UTC offset.
// In Strategy Tester, economic calendar data can be unavailable. If CalendarValueHistory fails,
// the MQL5 news filter blocks entries while NewsFilterEnable is true.

#include <Trade/Trade.mqh>
CTrade trade;

${inputs}

datetime lastBarTime = 0;
${handleDeclarations}

double PipPoint()
{
  if(_Digits == 3 || _Digits == 5)
  {
    return _Point * 10.0;
  }
  return _Point;
}

double NormalizeLots(double lots)
{
  double minLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
  double maxLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
  double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
  if(minLot <= 0.0)
  {
    minLot = 0.01;
  }
  if(maxLot <= 0.0)
  {
    maxLot = lots;
  }
  if(InpMaxLots > 0.0)
  {
    maxLot = MathMin(maxLot, InpMaxLots);
  }
  lots = MathMax(minLot, MathMin(maxLot, lots));
  if(step > 0.0)
  {
    lots = MathFloor(lots / step) * step;
  }
  return NormalizeDouble(lots, 2);
}

double LotSizeForEntry()
{
  if(InpLotSizingMode == 0)
  {
    return NormalizeLots(InpLots);
  }
  // Fixed-risk live sizing uses the current account balance and broker tick value.
  double balance = AccountInfoDouble(ACCOUNT_BALANCE);
  if(InpLotSizingMode == 2)
  {
    if(balance <= 0.0 || InpInitialBalance <= 0.0)
    {
      return NormalizeLots(InpLots);
    }
    return NormalizeLots(InpLots * balance / InpInitialBalance);
  }
  if(InpRiskPercent <= 0.0 || InpStopLossPips <= 0)
  {
    return NormalizeLots(InpLots);
  }
  double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
  double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
  double pipValuePerLot = tickSize > 0.0 ? tickValue * (PipPoint() / tickSize) : 0.0;
  if(balance <= 0.0 || pipValuePerLot <= 0.0)
  {
    return NormalizeLots(InpLots);
  }
  double riskAmount = balance * InpRiskPercent / 100.0;
  double spreadPips = (double)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD) * _Point / PipPoint();
  double riskPips = InpStopLossPips + MathMax(0.0, spreadPips);
  return NormalizeLots(riskAmount / (riskPips * pipValuePerLot));
}

bool ValueReady(double value)
{
  return value != EMPTY_VALUE && value == value;
}

bool CrossedAbove(double previousFast, double previousSlow, double currentFast, double currentSlow)
{
  return previousFast <= previousSlow && currentFast > currentSlow;
}

bool CrossedBelow(double previousFast, double previousSlow, double currentFast, double currentSlow)
{
  return previousFast >= previousSlow && currentFast < currentSlow;
}

int TimeTextToMinutes(string value)
{
  int separator = StringFind(value, ":");
  if(separator < 0)
  {
    return 0;
  }
  int hour = (int)StringToInteger(StringSubstr(value, 0, separator));
  int minute = (int)StringToInteger(StringSubstr(value, separator + 1));
  if(hour < 0)
  {
    hour = 0;
  }
  if(hour > 23)
  {
    hour = 23;
  }
  if(minute < 0)
  {
    minute = 0;
  }
  if(minute > 59)
  {
    minute = 59;
  }
  return hour * 60 + minute;
}

bool IsInTradingSession()
{
  if(!InpSessionFilterEnable)
  {
    return true;
  }
  MqlDateTime current;
  TimeToStruct(TimeCurrent(), current);
  int nowMinutes = current.hour * 60 + current.min;
  int startMinutes = TimeTextToMinutes(InpSessionStart);
  int endMinutes = TimeTextToMinutes(InpSessionEnd);
  if(startMinutes == endMinutes)
  {
    return true;
  }
  if(startMinutes < endMinutes)
  {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

string BaseCurrency()
{
  if(StringLen(_Symbol) < 6)
  {
    return "";
  }
  return StringSubstr(_Symbol, 0, 3);
}

string QuoteCurrency()
{
  if(StringLen(_Symbol) < 6)
  {
    return "";
  }
  return StringSubstr(_Symbol, 3, 3);
}

bool CurrencyHasHighImpactNews(string currency, datetime fromTime, datetime toTime)
{
  if(currency == "")
  {
    return false;
  }
  MqlCalendarValue values[];
  ResetLastError();
  if(!CalendarValueHistory(values, fromTime, toTime, NULL, currency))
  {
    return true;
  }
  int count = ArraySize(values);
  if(count <= 0)
  {
    return false;
  }
  for(int i = 0; i < count; i++)
  {
    MqlCalendarEvent eventInfo;
    if(CalendarEventById(values[i].event_id, eventInfo) && eventInfo.importance == CALENDAR_IMPORTANCE_HIGH)
    {
      return true;
    }
  }
  return false;
}

bool IsHighImpactNewsWindow()
{
  if(!NewsFilterEnable || NewsBlockMinutes <= 0)
  {
    return false;
  }
  datetime nowTime = TimeCurrent();
  datetime fromTime = nowTime - NewsBlockMinutes * 60;
  datetime toTime = nowTime + NewsBlockMinutes * 60;
  return CurrencyHasHighImpactNews(BaseCurrency(), fromTime, toTime) ||
    CurrencyHasHighImpactNews(QuoteCurrency(), fromTime, toTime);
}

bool EntryFiltersAllow()
{
  return IsInTradingSession() && !IsHighImpactNewsWindow();
}

bool EnsureIndicator(int handle, string label)
{
  if(handle != INVALID_HANDLE)
  {
    return true;
  }
  Print(label, " handle creation failed: ", GetLastError());
  return false;
}

void ReleaseIndicator(int &handle)
{
  if(handle == INVALID_HANDLE)
  {
    return;
  }
  IndicatorRelease(handle);
  handle = INVALID_HANDLE;
}

double BufferValue(int handle, int bufferIndex, int shift)
{
  if(handle == INVALID_HANDLE)
  {
    return EMPTY_VALUE;
  }
  double values[];
  ArraySetAsSeries(values, true);
  int copied = CopyBuffer(handle, bufferIndex, shift, 1, values);
  if(copied <= 0)
  {
    return EMPTY_VALUE;
  }
  return values[0];
}

int OnInit()
{
${handleInitLines}
  return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
${handleReleaseLines}
}

${conditionFunctions}
${entrySignalFunction(strategy)}

bool IsNewBar()
{
  datetime currentBarTime = iTime(_Symbol, _Period, 0);
  if(currentBarTime == 0)
  {
    return false;
  }
  if(currentBarTime == lastBarTime)
  {
    return false;
  }
  lastBarTime = currentBarTime;
  return true;
}

bool SelectCurrentPosition()
{
  for(int i = PositionsTotal() - 1; i >= 0; i--)
  {
    ulong ticket = PositionGetTicket(i);
    if(ticket == 0)
    {
      continue;
    }
    if(!PositionSelectByTicket(ticket))
    {
      continue;
    }
    if(PositionGetString(POSITION_SYMBOL) == _Symbol && (int)PositionGetInteger(POSITION_MAGIC) == InpMagicNumber)
    {
      return true;
    }
  }
  return false;
}

void OpenPosition()
{
  double pip = PipPoint();
  double lots = LotSizeForEntry();
  trade.SetExpertMagicNumber(InpMagicNumber);
  trade.SetDeviationInPoints(20);
  if(InpTradeLong)
  {
    double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
    double sl = NormalizeDouble(ask - InpStopLossPips * pip, _Digits);
    double tp = NormalizeDouble(ask + InpTakeProfitPips * pip, _Digits);
    trade.Buy(lots, _Symbol, ask, sl, tp, "${expertName}");
    return;
  }
  double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
  double sl = NormalizeDouble(bid + InpStopLossPips * pip, _Digits);
  double tp = NormalizeDouble(bid - InpTakeProfitPips * pip, _Digits);
  trade.Sell(lots, _Symbol, bid, sl, tp, "${expertName}");
}

void CloseCurrentPosition()
{
  if(!SelectCurrentPosition())
  {
    return;
  }
  ulong ticket = (ulong)PositionGetInteger(POSITION_TICKET);
  trade.PositionClose(ticket);
}

void ManageTrailingStop()
{
  if(!InpUseTrailingStop || InpTrailingStopPips <= 0)
  {
    return;
  }
  if(!SelectCurrentPosition())
  {
    return;
  }
  double pip = PipPoint();
  ulong ticket = (ulong)PositionGetInteger(POSITION_TICKET);
  double currentSL = PositionGetDouble(POSITION_SL);
  double currentTP = PositionGetDouble(POSITION_TP);
  long positionType = PositionGetInteger(POSITION_TYPE);
  if(positionType == POSITION_TYPE_BUY)
  {
    double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
    double nextSL = NormalizeDouble(bid - InpTrailingStopPips * pip, _Digits);
    if((currentSL == 0.0 || nextSL > currentSL) && nextSL < bid)
    {
      trade.PositionModify(ticket, nextSL, currentTP);
    }
    return;
  }
  double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
  double nextSL = NormalizeDouble(ask + InpTrailingStopPips * pip, _Digits);
  if((currentSL == 0.0 || nextSL < currentSL) && nextSL > ask)
  {
    trade.PositionModify(ticket, nextSL, currentTP);
  }
}

void OnTick()
{
  ManageTrailingStop();
  if(!IsNewBar())
  {
    return;
  }
  if(SelectCurrentPosition())
  {
    if(InpCloseOnOppositeSignal && EntrySignal(!InpTradeLong))
    {
      CloseCurrentPosition();
    }
    return;
  }
  if(EntryFiltersAllow() && EntrySignal(InpTradeLong))
  {
    OpenPosition();
  }
}
`;
};

export const generateMql4 = (strategy: StrategyDefinition): string => {
  const inputs = commonInputs(strategy, false).join('\n');
  const conditionFunctions = strategy.entryConditions
    .map((condition, index) => mql4ConditionFunction(condition, index + 1))
    .join('\n');
  const expertName = mqlString(strategy.name);

  return `#property strict
#property description "${expertName}"

// Session filter uses broker server time via TimeCurrent(); it is independent of this app's backtest UTC offset.

${inputs}

datetime lastBarTime = 0;
${mql4ParabolicSarOnInit(strategy.entryConditions)}
double PipPoint()
{
  if(Digits == 3 || Digits == 5)
  {
    return Point * 10.0;
  }
  return Point;
}

double NormalizeLots(double lots)
{
  double minLot = MarketInfo(_Symbol, MODE_MINLOT);
  double maxLot = MarketInfo(_Symbol, MODE_MAXLOT);
  double step = MarketInfo(_Symbol, MODE_LOTSTEP);
  if(minLot <= 0.0)
  {
    minLot = 0.01;
  }
  if(maxLot <= 0.0)
  {
    maxLot = lots;
  }
  if(InpMaxLots > 0.0)
  {
    maxLot = MathMin(maxLot, InpMaxLots);
  }
  lots = MathMax(minLot, MathMin(maxLot, lots));
  if(step > 0.0)
  {
    lots = MathFloor(lots / step) * step;
  }
  return NormalizeDouble(lots, 2);
}

double LotSizeForEntry()
{
  if(InpLotSizingMode == 0)
  {
    return NormalizeLots(InpLots);
  }
  // Fixed-risk live sizing uses the current account balance and broker tick value.
  double balance = AccountBalance();
  if(InpLotSizingMode == 2)
  {
    if(balance <= 0.0 || InpInitialBalance <= 0.0)
    {
      return NormalizeLots(InpLots);
    }
    return NormalizeLots(InpLots * balance / InpInitialBalance);
  }
  if(InpRiskPercent <= 0.0 || InpStopLossPips <= 0)
  {
    return NormalizeLots(InpLots);
  }
  double tickValue = MarketInfo(_Symbol, MODE_TICKVALUE);
  double tickSize = MarketInfo(_Symbol, MODE_TICKSIZE);
  double pipValuePerLot = tickSize > 0.0 ? tickValue * (PipPoint() / tickSize) : 0.0;
  if(balance <= 0.0 || pipValuePerLot <= 0.0)
  {
    return NormalizeLots(InpLots);
  }
  double riskAmount = balance * InpRiskPercent / 100.0;
  double spreadPips = MarketInfo(_Symbol, MODE_SPREAD) * Point / PipPoint();
  double riskPips = InpStopLossPips + MathMax(0.0, spreadPips);
  return NormalizeLots(riskAmount / (riskPips * pipValuePerLot));
}

bool ValueReady(double value)
{
  return value != EMPTY_VALUE && value == value;
}

bool CrossedAbove(double previousFast, double previousSlow, double currentFast, double currentSlow)
{
  return previousFast <= previousSlow && currentFast > currentSlow;
}

bool CrossedBelow(double previousFast, double previousSlow, double currentFast, double currentSlow)
{
  return previousFast >= previousSlow && currentFast < currentSlow;
}

int TimeTextToMinutes(string value)
{
  int separator = StringFind(value, ":");
  if(separator < 0)
  {
    return 0;
  }
  int hour = (int)StringToInteger(StringSubstr(value, 0, separator));
  int minute = (int)StringToInteger(StringSubstr(value, separator + 1));
  if(hour < 0)
  {
    hour = 0;
  }
  if(hour > 23)
  {
    hour = 23;
  }
  if(minute < 0)
  {
    minute = 0;
  }
  if(minute > 59)
  {
    minute = 59;
  }
  return hour * 60 + minute;
}

bool IsInTradingSession()
{
  if(!InpSessionFilterEnable)
  {
    return true;
  }
  MqlDateTime current;
  TimeToStruct(TimeCurrent(), current);
  int nowMinutes = current.hour * 60 + current.min;
  int startMinutes = TimeTextToMinutes(InpSessionStart);
  int endMinutes = TimeTextToMinutes(InpSessionEnd);
  if(startMinutes == endMinutes)
  {
    return true;
  }
  if(startMinutes < endMinutes)
  {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

bool EntryFiltersAllow()
{
  // MQL4 has no built-in economic calendar API, so NewsFilterEnable and NewsBlockMinutes are MQL5-only.
  return IsInTradingSession();
}

${conditionFunctions}
${entrySignalFunction(strategy)}

bool IsNewBar()
{
  datetime currentBarTime = iTime(_Symbol, _Period, 0);
  if(currentBarTime == 0)
  {
    return false;
  }
  if(currentBarTime == lastBarTime)
  {
    return false;
  }
  lastBarTime = currentBarTime;
  return true;
}

int CurrentOrderTicket()
{
  for(int i = OrdersTotal() - 1; i >= 0; i--)
  {
    if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
    {
      continue;
    }
    if(OrderSymbol() == _Symbol && OrderMagicNumber() == InpMagicNumber)
    {
      return OrderTicket();
    }
  }
  return -1;
}

bool HasPosition()
{
  return CurrentOrderTicket() >= 0;
}

void OpenPosition()
{
  RefreshRates();
  double pip = PipPoint();
  double lots = LotSizeForEntry();
  if(InpTradeLong)
  {
    double sl = NormalizeDouble(Ask - InpStopLossPips * pip, Digits);
    double tp = NormalizeDouble(Ask + InpTakeProfitPips * pip, Digits);
    int ticket = OrderSend(_Symbol, OP_BUY, lots, Ask, 20, sl, tp, "${expertName}", InpMagicNumber, 0, clrGreen);
    if(ticket < 0)
    {
      Print("OrderSend buy failed: ", GetLastError());
    }
    return;
  }
  double sl = NormalizeDouble(Bid + InpStopLossPips * pip, Digits);
  double tp = NormalizeDouble(Bid - InpTakeProfitPips * pip, Digits);
  int ticket = OrderSend(_Symbol, OP_SELL, lots, Bid, 20, sl, tp, "${expertName}", InpMagicNumber, 0, clrRed);
  if(ticket < 0)
  {
    Print("OrderSend sell failed: ", GetLastError());
  }
}

void CloseCurrentPosition()
{
  int ticket = CurrentOrderTicket();
  if(ticket < 0 || !OrderSelect(ticket, SELECT_BY_TICKET, MODE_TRADES))
  {
    return;
  }
  RefreshRates();
  if(OrderType() == OP_BUY)
  {
    if(!OrderClose(ticket, OrderLots(), Bid, 20, clrSilver))
    {
      Print("OrderClose buy failed: ", GetLastError());
    }
    return;
  }
  if(!OrderClose(ticket, OrderLots(), Ask, 20, clrSilver))
  {
    Print("OrderClose sell failed: ", GetLastError());
  }
}

void ManageTrailingStop()
{
  if(!InpUseTrailingStop || InpTrailingStopPips <= 0)
  {
    return;
  }
  int ticket = CurrentOrderTicket();
  if(ticket < 0 || !OrderSelect(ticket, SELECT_BY_TICKET, MODE_TRADES))
  {
    return;
  }
  RefreshRates();
  double pip = PipPoint();
  if(OrderType() == OP_BUY)
  {
    double buySL = NormalizeDouble(Bid - InpTrailingStopPips * pip, Digits);
    if((OrderStopLoss() == 0.0 || buySL > OrderStopLoss()) && buySL < Bid)
    {
      if(!OrderModify(ticket, OrderOpenPrice(), buySL, OrderTakeProfit(), 0, clrGreen))
      {
        Print("OrderModify buy trailing failed: ", GetLastError());
      }
    }
    return;
  }
  double sellSL = NormalizeDouble(Ask + InpTrailingStopPips * pip, Digits);
  if((OrderStopLoss() == 0.0 || sellSL < OrderStopLoss()) && sellSL > Ask)
  {
    if(!OrderModify(ticket, OrderOpenPrice(), sellSL, OrderTakeProfit(), 0, clrRed))
    {
      Print("OrderModify sell trailing failed: ", GetLastError());
    }
  }
}

void OnTick()
{
  ManageTrailingStop();
  if(!IsNewBar())
  {
    return;
  }
  if(HasPosition())
  {
    if(InpCloseOnOppositeSignal && EntrySignal(!InpTradeLong))
    {
      CloseCurrentPosition();
    }
    return;
  }
  if(EntryFiltersAllow() && EntrySignal(InpTradeLong))
  {
    OpenPosition();
  }
}
`;
};
