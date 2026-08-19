import { SAR_CONVERGENCE_WARMUP_BARS, SAR_MIN_STEP } from './indicators';
import type {
  BollingerBandSide,
  BollingerCondition,
  BollingerConditionMode,
  CciBreakCondition,
  AdxTrendCondition,
  AlligatorCondition,
  AoCondition,
  DeMarkerCondition,
  DonchianBreakCondition,
  EnvelopeCondition,
  EntryCondition,
  IchimokuCrossCondition,
  KeltnerBreakCondition,
  LotSizingMode,
  MaCrossCondition,
  MoneyManagementSettings,
  MacdCrossCondition,
  MovingAverageType,
  MomentumCondition,
  ParabolicSarCondition,
  RviCondition,
  RsiComparison,
  RsiCondition,
  StochCrossCondition,
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
    case 'demarker':
      return [
        `input int InpDeMarker${index}Period = ${integerLiteral(condition.period)};`,
        `input double InpDeMarker${index}Threshold = ${numberLiteral(condition.threshold)};`,
      ];
    case 'bollinger':
      return [
        `input int InpBB${index}Period = ${integerLiteral(condition.period)};`,
        `input double InpBB${index}Deviation = ${numberLiteral(condition.multiplier)};`,
      ];
    case 'envelope':
      return [
        `input int InpEnvelope${index}Period = ${integerLiteral(condition.period)};`,
        `input double InpEnvelope${index}Deviation = ${numberLiteral(condition.deviation)};`,
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
    case 'momentum':
      return [`input int InpMomentum${index}Period = ${integerLiteral(condition.period)};`];
    case 'ao':
      return [
        `input int InpAO${index}FastPeriod = ${integerLiteral(condition.fastPeriod)};`,
        `input int InpAO${index}SlowPeriod = ${integerLiteral(condition.slowPeriod)};`,
      ];
    case 'rvi':
      return [`input int InpRVI${index}Period = ${integerLiteral(condition.period)};`];
    case 'stochastic':
      return [
        `input int InpStoch${index}KPeriod = ${integerLiteral(condition.kPeriod)};`,
        `input int InpStoch${index}DPeriod = ${integerLiteral(condition.dPeriod)};`,
        `input int InpStoch${index}Smoothing = ${integerLiteral(condition.smoothing)};`,
        `input double InpStoch${index}Threshold = ${numberLiteral(condition.threshold)};`,
      ];
    case 'stochCross':
      return [
        `input int InpStoch${index}KPeriod = ${integerLiteral(condition.kPeriod)};`,
        `input int InpStoch${index}DPeriod = ${integerLiteral(condition.dPeriod)};`,
        `input int InpStoch${index}Smoothing = ${integerLiteral(condition.smoothing)};`,
      ];
    case 'alligator':
      return [
        `input int InpAlligator${index}JawPeriod = ${integerLiteral(condition.jawPeriod)};`,
        `input int InpAlligator${index}TeethPeriod = ${integerLiteral(condition.teethPeriod)};`,
        `input int InpAlligator${index}LipsPeriod = ${integerLiteral(condition.lipsPeriod)};`,
        `input int InpAlligator${index}JawShift = ${integerLiteral(condition.jawShift)};`,
        `input int InpAlligator${index}TeethShift = ${integerLiteral(condition.teethShift)};`,
        `input int InpAlligator${index}LipsShift = ${integerLiteral(condition.lipsShift)};`,
      ];
  }
};

const mql5ConditionFunction = (condition: EntryCondition, index: number): string => {
  switch (condition.type) {
    case 'maCross':
      return mql5MaCondition(condition, index);
    case 'rsi':
      return mql5RsiCondition(condition, index);
    case 'demarker':
      return mqlDeMarkerCondition(condition, index);
    case 'bollinger':
      return mql5BollingerCondition(condition, index);
    case 'envelope':
      return mqlEnvelopeCondition(condition, index);
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
    case 'stochCross':
      return mqlStochCrossCondition(condition, index);
    case 'alligator':
      return mqlAlligatorCondition(condition, index);
    case 'keltnerBreak':
      return mql5KeltnerCondition(condition, index);
    case 'cciBreak':
      return mql5CciCondition(condition, index);
    case 'adxTrend':
      return mql5AdxCondition(condition, index);
    case 'parabolicSar':
      return mql5ParabolicSarCondition(condition, index);
    case 'momentum':
      return mqlMomentumCondition(condition, index);
    case 'ao':
      return mqlAoCondition(condition, index);
    case 'rvi':
      return mqlRviCondition(condition, index);
  }
};

const mql4ConditionFunction = (condition: EntryCondition, index: number): string => {
  switch (condition.type) {
    case 'maCross':
      return mql4MaCondition(condition, index);
    case 'rsi':
      return mql4RsiCondition(condition, index);
    case 'demarker':
      return mqlDeMarkerCondition(condition, index);
    case 'bollinger':
      return mql4BollingerCondition(condition, index);
    case 'envelope':
      return mqlEnvelopeCondition(condition, index);
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
    case 'stochCross':
      return mqlStochCrossCondition(condition, index);
    case 'alligator':
      return mqlAlligatorCondition(condition, index);
    case 'keltnerBreak':
      return mql4KeltnerCondition(condition, index);
    case 'cciBreak':
      return mql4CciCondition(condition, index);
    case 'adxTrend':
      return mql4AdxCondition(condition, index);
    case 'parabolicSar':
      return mql4ParabolicSarCondition(condition, index);
    case 'momentum':
      return mqlMomentumCondition(condition, index);
    case 'ao':
      return mqlAoCondition(condition, index);
    case 'rvi':
      return mqlRviCondition(condition, index);
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

const envelopeParityComment = `
// Envelope parity: the native iEnvelopes buffer is intentionally not used.
// The adopted official implementation is SMA(CLOSE, period) *
// (1 +/- deviation / 100.0), with deviation expressed as a percentage.
// MetaQuotes Envelopes.mq5: https://www.mql5.com/en/code/28
// The terminal help's /1000 formula conflicts with that source implementation;
// this generated calculation follows the source and mirrors TS operation order.
`;

const mqlEnvelopeCondition = (_condition: EnvelopeCondition, index: number): string => `
${envelopeParityComment}double EnvelopeSma${index}(int shift)
{
  int period = InpEnvelope${index}Period;
  if(period < 2 || period > 1000)
  {
    return EMPTY_VALUE;
  }
  if(iTime(_Symbol, _Period, shift + period) == 0)
  {
    return EMPTY_VALUE;
  }
  double sum = 0.0;
  // Descending MQL shifts visit the SMA window oldest-to-newest, matching the
  // TypeScript envelope() accumulation order before division by period.
  for(int offset = period - 1; offset >= 0; offset--)
  {
    double close = iClose(_Symbol, _Period, shift + offset);
    if(!ValueReady(close) || !MathIsValidNumber(close))
    {
      return EMPTY_VALUE;
    }
    sum += close;
  }
  if(!MathIsValidNumber(sum))
  {
    return EMPTY_VALUE;
  }
  double value = sum / period;
  if(!ValueReady(value) || !MathIsValidNumber(value))
  {
    return EMPTY_VALUE;
  }
  return value;
}

double EnvelopeUpper${index}(int shift)
{
  double middle = EnvelopeSma${index}(shift);
  double deviation = InpEnvelope${index}Deviation;
  if(!ValueReady(middle) || !MathIsValidNumber(middle) ||
    !MathIsValidNumber(deviation) || !(deviation > 0.0))
  {
    return EMPTY_VALUE;
  }
  double value = middle * (1.0 + deviation / 100.0);
  if(!ValueReady(value) || !MathIsValidNumber(value))
  {
    return EMPTY_VALUE;
  }
  return value;
}

double EnvelopeLower${index}(int shift)
{
  double middle = EnvelopeSma${index}(shift);
  double deviation = InpEnvelope${index}Deviation;
  if(!ValueReady(middle) || !MathIsValidNumber(middle) ||
    !MathIsValidNumber(deviation) || !(deviation > 0.0))
  {
    return EMPTY_VALUE;
  }
  double value = middle * (1.0 - deviation / 100.0);
  if(!ValueReady(value) || !MathIsValidNumber(value))
  {
    return EMPTY_VALUE;
  }
  return value;
}

bool Condition${index}(bool longSide)
{
  int period = InpEnvelope${index}Period;
  double deviation = InpEnvelope${index}Deviation;
  int signalShift = 1;
  if(period < 2 || period > 1000 || !MathIsValidNumber(deviation) || !(deviation > 0.0))
  {
    return false;
  }
  // The current envelope requires history through period + signalShift; the
  // previous envelope requires history through period + signalShift + 1.
  // Keep both gates explicit so the two-point cross cannot read a warm-up bar.
  if(iTime(_Symbol, _Period, period + signalShift) == 0)
  {
    return false;
  }
  if(iTime(_Symbol, _Period, period + signalShift + 1) == 0)
  {
    return false;
  }
  double previousUpper = EnvelopeUpper${index}(signalShift + 1);
  double currentUpper = EnvelopeUpper${index}(signalShift);
  double previousLower = EnvelopeLower${index}(signalShift + 1);
  double currentLower = EnvelopeLower${index}(signalShift);
  double previousClose = iClose(_Symbol, _Period, signalShift + 1);
  double currentClose = iClose(_Symbol, _Period, signalShift);
  if(!ValueReady(previousUpper) || !MathIsValidNumber(previousUpper) ||
    !ValueReady(currentUpper) || !MathIsValidNumber(currentUpper) ||
    !ValueReady(previousLower) || !MathIsValidNumber(previousLower) ||
    !ValueReady(currentLower) || !MathIsValidNumber(currentLower) ||
    !ValueReady(previousClose) || !MathIsValidNumber(previousClose) ||
    !ValueReady(currentClose) || !MathIsValidNumber(currentClose))
  {
    return false;
  }
  if(longSide)
  {
    return previousClose <= previousUpper && currentClose > currentUpper;
  }
  return previousClose >= previousLower && currentClose < currentLower;
}
`;

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

const momentumParityComment = `
// Momentum parity: the native iMomentum buffer is intentionally not used.
// MT implementations can evaluate price[i] * 100 / price[i-period], while
// the TypeScript evaluator evaluates (close / previousClose) * 100.0. The
// iClose calculation below preserves that operation order exactly, including
// the equality boundary at 100 for flat-price bars.
// iClose can return 0.0 when the requested history is unavailable. Positive
// close and previousClose guards keep that data gap fail-closed instead of
// treating the missing value as a sub-100 momentum reading.
`;

const mqlMomentumCondition = (_condition: MomentumCondition, index: number): string => `
${momentumParityComment}double MomentumValue${index}(int shift)
{
  int period = InpMomentum${index}Period;
  if(period < 1)
  {
    return EMPTY_VALUE;
  }
  if(iTime(_Symbol, _Period, shift + period) == 0)
  {
    return EMPTY_VALUE;
  }
  double close = iClose(_Symbol, _Period, shift);
  double previousClose = iClose(_Symbol, _Period, shift + period);
  if(!ValueReady(close) || !MathIsValidNumber(close) ||
    !ValueReady(previousClose) || !MathIsValidNumber(previousClose) ||
    !(close > 0.0 && previousClose > 0.0))
  {
    return EMPTY_VALUE;
  }
  double value = (close / previousClose) * 100.0;
  if(!ValueReady(value) || !MathIsValidNumber(value))
  {
    return EMPTY_VALUE;
  }
  return value;
}

bool Condition${index}(bool longSide)
{
  int period = InpMomentum${index}Period;
  // The TS evaluator rejects period < 1 and non-integers. This MQL input is
  // int, so non-integers are unrepresentable; OnInit rejects period < 1.
  if(period < 1)
  {
    return false;
  }
  // The signal bar is shift 1, so require its period-length lookback first.
  if(iTime(_Symbol, _Period, period + 1) == 0)
  {
    return false;
  }
  // The cross also reads shift 2, so period + 2 is the oldest close required
  // by the TypeScript evaluator's two-point comparison.
  if(iTime(_Symbol, _Period, period + 2) == 0)
  {
    return false;
  }
  double previous = MomentumValue${index}(2);
  double current = MomentumValue${index}(1);
  if(!ValueReady(previous) || !MathIsValidNumber(previous) ||
    !ValueReady(current) || !MathIsValidNumber(current))
  {
    return false;
  }
  // 0.0 is a missing-data sentinel on MT4/MT5 and must never be used in a
  // signal comparison. This mirrors the positive-price guard above and the
  // TypeScript evaluator's null result for unavailable closes.
  if(!(previous > 0.0 && current > 0.0))
  {
    return false;
  }
  // Keep the comparison operators identical to the TypeScript evaluator:
  // equality is included on the prior bar and strict on the signal bar.
  if(longSide)
  {
    return previous <= 100.0 && current > 100.0;
  }
  return previous >= 100.0 && current < 100.0;
}
`;

const aoParityComment = `
// AO parity: the native iAO buffer is intentionally not used.
// Calculate MEDIAN PRICE per bar first, then each SMA as sum / period, and
// finally subtract the slow SMA from the fast SMA. This preserves the
// TypeScript ao() order exactly: median per bar -> both SMAs -> difference.
// The first AO value is at TS index slowPeriod - 1; the first two-value
// zero-cross evaluation is therefore at TS index slowPeriod.
// The history gates protect unavailable iHigh/iLow bars; non-finite arithmetic
// fails closed as EMPTY_VALUE.
`;

const mqlAoCondition = (_condition: AoCondition, index: number): string => `
${aoParityComment}double AoMedian${index}(int shift)
{
  double high = iHigh(_Symbol, _Period, shift);
  double low = iLow(_Symbol, _Period, shift);
  if(!ValueReady(high) || !MathIsValidNumber(high) ||
    !ValueReady(low) || !MathIsValidNumber(low))
  {
    return EMPTY_VALUE;
  }
  double value = (high + low) / 2.0;
  if(!ValueReady(value) || !MathIsValidNumber(value))
  {
    return EMPTY_VALUE;
  }
  return value;
}

double AoSma${index}(int shift, int period)
{
  if(period < 1)
  {
    return EMPTY_VALUE;
  }
  double sum = 0.0;
  // Descending MQL shifts visit the TS window oldest-to-newest, preserving
  // the TypeScript accumulation order before division by the period.
  for(int offset = period - 1; offset >= 0; offset--)
  {
    double median = AoMedian${index}(shift + offset);
    if(!ValueReady(median) || !MathIsValidNumber(median))
    {
      return EMPTY_VALUE;
    }
    sum += median;
  }
  if(!ValueReady(sum) || !MathIsValidNumber(sum))
  {
    return EMPTY_VALUE;
  }
  double value = sum / period;
  if(!ValueReady(value) || !MathIsValidNumber(value))
  {
    return EMPTY_VALUE;
  }
  return value;
}

double AoValue${index}(int shift)
{
  int fastPeriod = InpAO${index}FastPeriod;
  int slowPeriod = InpAO${index}SlowPeriod;
  if(fastPeriod < 1 || slowPeriod < 1 || fastPeriod >= slowPeriod)
  {
    return EMPTY_VALUE;
  }
  // AO's slow SMA at this shift requires history through shift + slowPeriod - 1.
  if(iTime(_Symbol, _Period, shift + slowPeriod - 1) == 0)
  {
    return EMPTY_VALUE;
  }
  double fastSma = AoSma${index}(shift, fastPeriod);
  double slowSma = AoSma${index}(shift, slowPeriod);
  if(!ValueReady(fastSma) || !MathIsValidNumber(fastSma) ||
    !ValueReady(slowSma) || !MathIsValidNumber(slowSma))
  {
    return EMPTY_VALUE;
  }
  double value = fastSma - slowSma;
  if(!ValueReady(value) || !MathIsValidNumber(value))
  {
    return EMPTY_VALUE;
  }
  return value;
}

bool Condition${index}(bool longSide)
{
  int fastPeriod = InpAO${index}FastPeriod;
  int slowPeriod = InpAO${index}SlowPeriod;
  int signalShift = 1;
  if(fastPeriod < 1 || slowPeriod < 1 || fastPeriod >= slowPeriod)
  {
    return false;
  }
  // The TS evaluator first evaluates a cross at index slowPeriod. The
  // previous AO at signalShift + 1 is the oldest read and requires history
  // through slowPeriod + signalShift on the same first-eligible bar.
  if(iTime(_Symbol, _Period, slowPeriod + signalShift) == 0)
  {
    return false;
  }
  double previous = AoValue${index}(signalShift + 1);
  double current = AoValue${index}(signalShift);
  if(!ValueReady(previous) || !MathIsValidNumber(previous) ||
    !ValueReady(current) || !MathIsValidNumber(current))
  {
    return false;
  }
  if(longSide)
  {
    return previous <= 0.0 && current > 0.0;
  }
  return previous >= 0.0 && current < 0.0;
}
`;

const demarkerParityComment = `
// DeMarker parity: the native iDeMarker buffer is intentionally not used.
// This project follows the TS/MT5 form from the terminal help exactly:
// DeMax/DeMin are built from adjacent iHigh/iLow values, each SMA is divided
// by period first, and only then are the two SMA values added for the ratio.
// DeMax/DeMin need the previous bar, so the history guard includes shift+period.
// MT4/MT5 return 0.0 for unavailable OHLC history; positive finite OHLC guards
// keep those data gaps fail-closed instead of creating synthetic movement.
// A zero denominator is also fail-closed and returns EMPTY_VALUE, matching the
// TS demarker() null result rather than the terminal's 0.0 buffer convention.
`;

const mqlDeMarkerCondition = (condition: DeMarkerCondition, index: number): string => {
  const shortComparison = mirrorComparison(condition.comparison);
  return `
${demarkerParityComment}double DeMarkerDeMax${index}(int shift)
{
  double high = iHigh(_Symbol, _Period, shift);
  double previousHigh = iHigh(_Symbol, _Period, shift + 1);
  if(!ValueReady(high) || !MathIsValidNumber(high) ||
    !ValueReady(previousHigh) || !MathIsValidNumber(previousHigh) ||
    !(high > 0.0 && previousHigh > 0.0))
  {
    return EMPTY_VALUE;
  }
  double value = high > previousHigh ? high - previousHigh : 0.0;
  if(!ValueReady(value) || !MathIsValidNumber(value))
  {
    return EMPTY_VALUE;
  }
  return value;
}

double DeMarkerDeMin${index}(int shift)
{
  double low = iLow(_Symbol, _Period, shift);
  double previousLow = iLow(_Symbol, _Period, shift + 1);
  if(!ValueReady(low) || !MathIsValidNumber(low) ||
    !ValueReady(previousLow) || !MathIsValidNumber(previousLow) ||
    !(low > 0.0 && previousLow > 0.0))
  {
    return EMPTY_VALUE;
  }
  double value = low < previousLow ? previousLow - low : 0.0;
  if(!ValueReady(value) || !MathIsValidNumber(value))
  {
    return EMPTY_VALUE;
  }
  return value;
}

double DeMarkerValue${index}(int shift)
{
  int period = InpDeMarker${index}Period;
  if(period < 1)
  {
    return EMPTY_VALUE;
  }
  // TS exposes its first DeMarker at index period. The value at this MQL shift
  // reads DeMax/DeMin through shift+period, so this is the same warm-up bar.
  if(iTime(_Symbol, _Period, shift + period) == 0)
  {
    return EMPTY_VALUE;
  }
  double deMaxSum = 0.0;
  double deMinSum = 0.0;
  // Descending MQL shifts visit the TS window oldest-to-newest, preserving the
  // TS accumulation order before each SMA and the final ratio.
  for(int offset = period - 1; offset >= 0; offset--)
  {
    double deMax = DeMarkerDeMax${index}(shift + offset);
    double deMin = DeMarkerDeMin${index}(shift + offset);
    if(!ValueReady(deMax) || !MathIsValidNumber(deMax) ||
      !ValueReady(deMin) || !MathIsValidNumber(deMin))
    {
      return EMPTY_VALUE;
    }
    deMaxSum += deMax;
    deMinSum += deMin;
  }
  if(!MathIsValidNumber(deMaxSum) || !MathIsValidNumber(deMinSum))
  {
    return EMPTY_VALUE;
  }
  // Keep the TS order: SMA(DeMax), SMA(DeMin), SMA sum, then the ratio.
  double deMaxSma = deMaxSum / period;
  double deMinSma = deMinSum / period;
  double denominator = deMaxSma + deMinSma;
  if(!ValueReady(deMaxSma) || !MathIsValidNumber(deMaxSma) ||
    !ValueReady(deMinSma) || !MathIsValidNumber(deMinSma) ||
    !ValueReady(denominator) || !MathIsValidNumber(denominator) ||
    denominator == 0.0)
  {
    return EMPTY_VALUE;
  }
  double value = deMaxSma / denominator;
  if(!ValueReady(value) || !MathIsValidNumber(value))
  {
    return EMPTY_VALUE;
  }
  return value;
}

bool Condition${index}(bool longSide)
{
  int period = InpDeMarker${index}Period;
  double threshold = InpDeMarker${index}Threshold;
  // The TS evaluator's below/above comparisons read only the current value at
  // index, which maps to MQL shift 1. DeMarkerValue(1) reaches shift+period,
  // so period+1 keeps the first eligible signal on the same TS bar. Cross
  // comparisons also read shift 2; their rsiCode branch owns that extra
  // previous-value guard below.
  if(period < 1)
  {
    return false;
  }
  if(iTime(_Symbol, _Period, period + 1) == 0)
  {
    return false;
  }
  if(!ValueReady(threshold) || !MathIsValidNumber(threshold) ||
    !(threshold > 0.0) || !(threshold < 1.0))
  {
    return false;
  }
  double previous = DeMarkerValue${index}(2);
  double current = DeMarkerValue${index}(1);
  if(!ValueReady(current) || !MathIsValidNumber(current))
  {
    return false;
  }
  if(longSide)
  {
    ${rsiCode(condition.comparison, `InpDeMarker${index}Threshold`)}
  }
  ${rsiCode(shortComparison, `1.0 - InpDeMarker${index}Threshold`)}
}
`;
};

const rviParityComment = `
// RVI parity: the native iRVI buffer is intentionally not used.
// Its terminal-specific operation order can differ by 1 ULP at the equality
// boundary, so the OHLC calculation below is the shared TS/MQL contract.
// The TS evaluator and this EA must keep the same IEEE-754 operation order:
// SWMA numerator/range (including /6), SUM over period, ratio, then signal
// SWMA (including /6). Moving any division changes equality-boundary crosses.
// iOpen/iHigh/iLow/iClose return 0.0 for unavailable history on MT4/MT5.
// Every referenced OHLC value is therefore required to be finite and > 0.0,
// which is the generated equivalent of the TS null data-gap result.
// A zero SUM(RANGE) is also returned as EMPTY_VALUE, matching TS null.
`;

const mqlRviCondition = (_condition: RviCondition, index: number): string => `
${rviParityComment}struct RviBarValues${index}
{
  double open0;
  double high0;
  double low0;
  double close0;
  double open1;
  double high1;
  double low1;
  double close1;
  double open2;
  double high2;
  double low2;
  double close2;
  double open3;
  double high3;
  double low3;
  double close3;
};

bool RviBarsReady${index}(int shift, RviBarValues${index} &bars)
{
  bars.open0 = iOpen(_Symbol, _Period, shift);
  bars.high0 = iHigh(_Symbol, _Period, shift);
  bars.low0 = iLow(_Symbol, _Period, shift);
  bars.close0 = iClose(_Symbol, _Period, shift);
  bars.open1 = iOpen(_Symbol, _Period, shift + 1);
  bars.high1 = iHigh(_Symbol, _Period, shift + 1);
  bars.low1 = iLow(_Symbol, _Period, shift + 1);
  bars.close1 = iClose(_Symbol, _Period, shift + 1);
  bars.open2 = iOpen(_Symbol, _Period, shift + 2);
  bars.high2 = iHigh(_Symbol, _Period, shift + 2);
  bars.low2 = iLow(_Symbol, _Period, shift + 2);
  bars.close2 = iClose(_Symbol, _Period, shift + 2);
  bars.open3 = iOpen(_Symbol, _Period, shift + 3);
  bars.high3 = iHigh(_Symbol, _Period, shift + 3);
  bars.low3 = iLow(_Symbol, _Period, shift + 3);
  bars.close3 = iClose(_Symbol, _Period, shift + 3);
  if(!ValueReady(bars.open0) || !MathIsValidNumber(bars.open0) || !ValueReady(bars.high0) || !MathIsValidNumber(bars.high0) ||
    !ValueReady(bars.low0) || !MathIsValidNumber(bars.low0) || !ValueReady(bars.close0) || !MathIsValidNumber(bars.close0) ||
    !ValueReady(bars.open1) || !MathIsValidNumber(bars.open1) || !ValueReady(bars.high1) || !MathIsValidNumber(bars.high1) ||
    !ValueReady(bars.low1) || !MathIsValidNumber(bars.low1) || !ValueReady(bars.close1) || !MathIsValidNumber(bars.close1) ||
    !ValueReady(bars.open2) || !MathIsValidNumber(bars.open2) || !ValueReady(bars.high2) || !MathIsValidNumber(bars.high2) ||
    !ValueReady(bars.low2) || !MathIsValidNumber(bars.low2) || !ValueReady(bars.close2) || !MathIsValidNumber(bars.close2) ||
    !ValueReady(bars.open3) || !MathIsValidNumber(bars.open3) || !ValueReady(bars.high3) || !MathIsValidNumber(bars.high3) ||
    !ValueReady(bars.low3) || !MathIsValidNumber(bars.low3) || !ValueReady(bars.close3) || !MathIsValidNumber(bars.close3) ||
    !(bars.open0 > 0.0 && bars.high0 > 0.0 && bars.low0 > 0.0 && bars.close0 > 0.0 &&
      bars.open1 > 0.0 && bars.high1 > 0.0 && bars.low1 > 0.0 && bars.close1 > 0.0 &&
      bars.open2 > 0.0 && bars.high2 > 0.0 && bars.low2 > 0.0 && bars.close2 > 0.0 &&
      bars.open3 > 0.0 && bars.high3 > 0.0 && bars.low3 > 0.0 && bars.close3 > 0.0))
  {
    return false;
  }
  return true;
}

double RviNumeratorSwma${index}(RviBarValues${index} &bars)
{
  return ((bars.close0 - bars.open0) +
    2 * (bars.close1 - bars.open1) +
    2 * (bars.close2 - bars.open2) +
    (bars.close3 - bars.open3)) / 6.0;
}

double RviRangeSwma${index}(RviBarValues${index} &bars)
{
  return ((bars.high0 - bars.low0) +
    2 * (bars.high1 - bars.low1) +
    2 * (bars.high2 - bars.low2) +
    (bars.high3 - bars.low3)) / 6.0;
}

double RviValue${index}(int shift)
{
  int period = InpRVI${index}Period;
  if(period < 1)
  {
    return EMPTY_VALUE;
  }
  // TS exposes the first RVI at index period + 3. Shift indexing therefore
  // needs this exact history boundary before evaluating the SUM window.
  if(iTime(_Symbol, _Period, shift + period + 3) == 0)
  {
    return EMPTY_VALUE;
  }
  double numeratorSum = 0.0;
  double rangeSum = 0.0;
  // TS adds offsets from the oldest item in the period window to the current
  // item. Descending MQL shifts preserve that same chronological order.
  for(int offset = period - 1; offset >= 0; offset--)
  {
    RviBarValues${index} bars;
    if(!RviBarsReady${index}(shift + offset, bars))
    {
      return EMPTY_VALUE;
    }
    double numeratorAverage = RviNumeratorSwma${index}(bars);
    double rangeAverage = RviRangeSwma${index}(bars);
    if(!ValueReady(numeratorAverage) || !MathIsValidNumber(numeratorAverage) ||
      !ValueReady(rangeAverage) || !MathIsValidNumber(rangeAverage))
    {
      return EMPTY_VALUE;
    }
    numeratorSum += numeratorAverage;
    rangeSum += rangeAverage;
  }
  if(!MathIsValidNumber(numeratorSum) || !MathIsValidNumber(rangeSum) || rangeSum == 0.0)
  {
    return EMPTY_VALUE;
  }
  double value = numeratorSum / rangeSum;
  if(!ValueReady(value) || !MathIsValidNumber(value))
  {
    return EMPTY_VALUE;
  }
  return value;
}

double RviSignalValue${index}(int shift)
{
  int period = InpRVI${index}Period;
  if(period < 1)
  {
    return EMPTY_VALUE;
  }
  // TS exposes the first signal at index period + 6. Keep the signal shift in
  // the guard so the generated EA does not move the warm-up boundary by one bar.
  // NOTE: warm-up parity is structurally guaranteed by the RviValue call chain
  // (RviSignalValue(shift) reads RviValue(shift+3), whose period+3 guard lands
  // on the same bar); this guard constant alone is not load-bearing, so do not
  // assume editing only these constants can safely shift the boundary.
  if(iTime(_Symbol, _Period, shift + period + 6) == 0)
  {
    return EMPTY_VALUE;
  }
  double current = RviValue${index}(shift);
  double previous = RviValue${index}(shift + 1);
  double twoBarsAgo = RviValue${index}(shift + 2);
  double threeBarsAgo = RviValue${index}(shift + 3);
  if(!ValueReady(current) || !MathIsValidNumber(current) ||
    !ValueReady(previous) || !MathIsValidNumber(previous) ||
    !ValueReady(twoBarsAgo) || !MathIsValidNumber(twoBarsAgo) ||
    !ValueReady(threeBarsAgo) || !MathIsValidNumber(threeBarsAgo))
  {
    return EMPTY_VALUE;
  }
  double value = (current + 2 * previous + 2 * twoBarsAgo + threeBarsAgo) / 6.0;
  if(!ValueReady(value) || !MathIsValidNumber(value))
  {
    return EMPTY_VALUE;
  }
  return value;
}

bool Condition${index}(bool longSide)
{
  int period = InpRVI${index}Period;
  int signalShift = 1;
  if(period < 1)
  {
    return false;
  }
  // RviSignalValue(signalShift) reads through RviValue(signalShift + 3),
  // whose period + 3 guard requires history through period + 6 + signalShift.
  if(iTime(_Symbol, _Period, period + 6 + signalShift) == 0)
  {
    return false;
  }
  // The previous signal at signalShift + 1 requires history through period + 7 +
  // signalShift. Keep this second guard explicit, matching the two-stage
  // MomentumCondition precedent.
  if(iTime(_Symbol, _Period, period + 7 + signalShift) == 0)
  {
    return false;
  }
  double previousRvi = RviValue${index}(signalShift + 1);
  double previousSignal = RviSignalValue${index}(signalShift + 1);
  double currentRvi = RviValue${index}(signalShift);
  double currentSignal = RviSignalValue${index}(signalShift);
  if(!ValueReady(previousRvi) || !MathIsValidNumber(previousRvi) ||
    !ValueReady(previousSignal) || !MathIsValidNumber(previousSignal) ||
    !ValueReady(currentRvi) || !MathIsValidNumber(currentRvi) ||
    !ValueReady(currentSignal) || !MathIsValidNumber(currentSignal))
  {
    return false;
  }
  // Keep the evaluator's equality boundary: prior <=/>=, current >/<.
  if(longSide)
  {
    return CrossedAbove(previousRvi, previousSignal, currentRvi, currentSignal);
  }
  return CrossedBelow(previousRvi, previousSignal, currentRvi, currentSignal);
}
`;

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

// SarWarmupReady's cache assumes one call site. Adding call sites that use
// different (barTime, signalShift) keys can cause the static cache to thrash.
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
  // This cache assumes one SarWarmupReady call site. Additional call sites
  // with different (barTime, signalShift) keys can cause cache thrashing.
  static datetime cachedBarTime = 0;
  static int cachedSignalShift = -1;
  static bool cachedResult = false;
  datetime currentBarTime = iTime(_Symbol, _Period, 0);
  if(currentBarTime == 0)
  {
    return false;
  }
  if(cachedBarTime == currentBarTime && cachedSignalShift == signalShift)
  {
    return cachedResult;
  }
  cachedBarTime = currentBarTime;
  cachedSignalShift = signalShift;
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
  // step >= ${SAR_MIN_STEP} and both values < 1; those are pipeline policy, not evaluator
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

const mql4EntryConditionOnInit = (conditions: readonly EntryCondition[]): string => {
  const initGuardLines = conditions.flatMap((condition, index) => {
    const conditionIndex = index + 1;
    if (condition.type === 'parabolicSar') {
      // SAR_MIN_STEP is pipeline policy and remains warning-only below it;
      // the separate evaluator-domain guard must fail initialization.
      return [
        `  if(InpSAR${conditionIndex}Step < ${SAR_MIN_STEP})`,
        '  {',
        `    Print("SAR${conditionIndex} warning: step below ${SAR_MIN_STEP} is outside the evaluator registration domain");`,
        '  }',
        `  if(!MathIsValidNumber(InpSAR${conditionIndex}Step) || !MathIsValidNumber(InpSAR${conditionIndex}Maximum) || InpSAR${conditionIndex}Step <= 0.0 || InpSAR${conditionIndex}Maximum < InpSAR${conditionIndex}Step)`,
        '  {',
        `    Print("SAR${conditionIndex} rejected: step must be > 0 and maximum must be >= step");`,
        '    return INIT_FAILED;',
        '  }',
      ];
    }
    if (condition.type === 'momentum') {
      return [
        // The evaluator hard domain is period >= 1; input int makes
        // non-integer values unrepresentable, so reject the remaining invalid range here.
        `  if(InpMomentum${conditionIndex}Period < 1)`,
        '  {',
        `    Print("Momentum${conditionIndex} rejected: period must be an integer greater than or equal to 1");`,
        '    return INIT_FAILED;',
        '  }',
      ];
    }
    if (condition.type === 'ao') {
      return [
        // The evaluator hard domain is both periods >= 1; input int makes
        // non-integer values unrepresentable, so reject invalid ranges here.
        `  if(InpAO${conditionIndex}FastPeriod < 1 || InpAO${conditionIndex}SlowPeriod < 1 || InpAO${conditionIndex}FastPeriod >= InpAO${conditionIndex}SlowPeriod)`,
        '  {',
        `    Print("AO${conditionIndex} rejected: periods must be integers greater than or equal to 1 and fastPeriod must be smaller than slowPeriod");`,
        '    return INIT_FAILED;',
        '  }',
      ];
    }
    if (condition.type === 'rvi') {
      return [
        // The evaluator hard domain is period >= 1; input int makes
        // non-integer values unrepresentable, so reject the remaining invalid range here.
        `  if(InpRVI${conditionIndex}Period < 1)`,
        '  {',
        `    Print("RVI${conditionIndex} rejected: period must be an integer greater than or equal to 1");`,
        '    return INIT_FAILED;',
        '  }',
      ];
    }
    if (condition.type === 'envelope') {
      return [
        // The evaluator and registry share the hard period/deviation domain;
        // input int makes non-integer periods unrepresentable in MQL4.
        `  if(InpEnvelope${conditionIndex}Period < 2 || InpEnvelope${conditionIndex}Period > 1000 || !MathIsValidNumber(InpEnvelope${conditionIndex}Deviation) || !(InpEnvelope${conditionIndex}Deviation > 0.0))`,
        '  {',
        `    Print("Envelope${conditionIndex} rejected: period must be an integer between 2 and 1000 and deviation must be finite and greater than 0");`,
        '    return INIT_FAILED;',
        '  }',
      ];
    }
    if (condition.type === 'demarker') {
      return [
        // The evaluator hard domain is period >= 1; the EA intentionally adopts
        // the registration threshold domain (0 < threshold < 1) and fails closed
        // for invalid threshold values.
        `  if(InpDeMarker${conditionIndex}Period < 1 || !MathIsValidNumber(InpDeMarker${conditionIndex}Threshold) || InpDeMarker${conditionIndex}Threshold <= 0.0 || InpDeMarker${conditionIndex}Threshold >= 1.0)`,
        '  {',
        `    Print("DeMarker${conditionIndex} rejected: period must be an integer greater than or equal to 1 and threshold must be finite, greater than 0 and less than 1");`,
        '    return INIT_FAILED;',
        '  }',
      ];
    }
    if (condition.type === 'stochCross') {
      return [
        // K/D use the registration domain 2..1000; smoothing deliberately
        // follows the legacy stochastic positive-integer domain.
        `  if(InpStoch${conditionIndex}KPeriod < 2 || InpStoch${conditionIndex}KPeriod > 1000 || InpStoch${conditionIndex}DPeriod < 2 || InpStoch${conditionIndex}DPeriod > 1000 || InpStoch${conditionIndex}Smoothing < 1)`,
        '  {',
        `    Print("StochCross${conditionIndex} rejected: K and D periods must be integers between 2 and 1000 and smoothing must be an integer greater than or equal to 1");`,
        '    return INIT_FAILED;',
        '  }',
      ];
    }
    if (condition.type === 'alligator') {
      return [
        // Inputs are integers in MQL; keep the evaluator's full period/shift
        // domain and strict ordering explicit in the generated EA.
        `  if(InpAlligator${conditionIndex}JawPeriod < 2 || InpAlligator${conditionIndex}JawPeriod > 1000 || InpAlligator${conditionIndex}TeethPeriod < 2 || InpAlligator${conditionIndex}TeethPeriod > 1000 || InpAlligator${conditionIndex}LipsPeriod < 2 || InpAlligator${conditionIndex}LipsPeriod > 1000 || InpAlligator${conditionIndex}JawPeriod <= InpAlligator${conditionIndex}TeethPeriod || InpAlligator${conditionIndex}TeethPeriod <= InpAlligator${conditionIndex}LipsPeriod || InpAlligator${conditionIndex}JawShift < 0 || InpAlligator${conditionIndex}JawShift > 500 || InpAlligator${conditionIndex}TeethShift < 0 || InpAlligator${conditionIndex}TeethShift > 500 || InpAlligator${conditionIndex}LipsShift < 0 || InpAlligator${conditionIndex}LipsShift > 500 || InpAlligator${conditionIndex}JawShift <= InpAlligator${conditionIndex}TeethShift || InpAlligator${conditionIndex}TeethShift <= InpAlligator${conditionIndex}LipsShift)`,
        '  {',
        `    Print("Alligator${conditionIndex} rejected: periods must be integers between 2 and 1000 with Jaw > Teeth > Lips, and shifts must be integers between 0 and 500 with Jaw > Teeth > Lips");`,
        '    return INIT_FAILED;',
        '  }',
      ];
    }
    return [];
  });
  if (initGuardLines.length === 0) {
    return '';
  }
  return `
int OnInit()
{
${initGuardLines.join('\n')}
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

const mqlStochCrossCondition = (_condition: StochCrossCondition, index: number): string => `
// StochCross parity: calculate the same raw %K, smoothed %K, and fresh-window
// %D sequence as the TypeScript evaluator without using the terminal
// stochastic buffer. The TypeScript side recomputes all three series with
// fresh per-window oldest-to-newest sums (it does not consume the sliding
// stochastic() recurrence), so StochCrossK and StochCrossD below both sum
// oldest-to-newest to stay operation-order identical. Flat windows produce
// an exact %K=50 tie on both sides, so the cross equality edges never fire
// there.
double StochCrossRawK${index}(int shift)
{
  int kPeriod = InpStoch${index}KPeriod;
  if(kPeriod < 2 || kPeriod > 1000)
  {
    return EMPTY_VALUE;
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
  if(!ValueReady(highest) || !MathIsValidNumber(highest) ||
    !ValueReady(lowest) || !MathIsValidNumber(lowest) ||
    !ValueReady(closeAtShift) || !MathIsValidNumber(closeAtShift))
  {
    return EMPTY_VALUE;
  }
  double range = highest - lowest;
  if(!MathIsValidNumber(range))
  {
    return EMPTY_VALUE;
  }
  if(range == 0.0)
  {
    return 50.0;
  }
  double value = (closeAtShift - lowest) / range * 100.0;
  if(!ValueReady(value) || !MathIsValidNumber(value))
  {
    return EMPTY_VALUE;
  }
  return value;
}

double StochCrossK${index}(int shift)
{
  int smoothing = InpStoch${index}Smoothing;
  if(smoothing < 1)
  {
    return EMPTY_VALUE;
  }
  double sum = 0.0;
  // Sum oldest-to-newest (largest shift first) to match the TypeScript
  // freshWindowSmaFromNullable operation order exactly.
  for(int offset = smoothing - 1; offset >= 0; offset--)
  {
    double raw = StochCrossRawK${index}(shift + offset);
    if(!ValueReady(raw) || !MathIsValidNumber(raw))
    {
      return EMPTY_VALUE;
    }
    sum += raw;
  }
  if(!MathIsValidNumber(sum))
  {
    return EMPTY_VALUE;
  }
  double value = sum / smoothing;
  if(!ValueReady(value) || !MathIsValidNumber(value))
  {
    return EMPTY_VALUE;
  }
  return value;
}

double StochCrossD${index}(int shift)
{
  int dPeriod = InpStoch${index}DPeriod;
  if(dPeriod < 2 || dPeriod > 1000)
  {
    return EMPTY_VALUE;
  }
  double sum = 0.0;
  // %D is a fresh SMA of the already-smoothed %K sequence. Visit its window
  // oldest-to-newest so the sum/division order matches the dedicated
  // TypeScript fresh-window implementation exactly.
  for(int offset = dPeriod - 1; offset >= 0; offset--)
  {
    double k = StochCrossK${index}(shift + offset);
    if(!ValueReady(k) || !MathIsValidNumber(k))
    {
      return EMPTY_VALUE;
    }
    sum += k;
  }
  if(!MathIsValidNumber(sum))
  {
    return EMPTY_VALUE;
  }
  double value = sum / dPeriod;
  if(!ValueReady(value) || !MathIsValidNumber(value))
  {
    return EMPTY_VALUE;
  }
  return value;
}

bool Condition${index}(bool longSide)
{
  int kPeriod = InpStoch${index}KPeriod;
  int dPeriod = InpStoch${index}DPeriod;
  int smoothing = InpStoch${index}Smoothing;
  int signalShift = 1;
  if(kPeriod < 2 || kPeriod > 1000 || dPeriod < 2 || dPeriod > 1000 || smoothing < 1)
  {
    return false;
  }
  // The current %K requires history through signalShift + kPeriod + smoothing - 2.
  // Its %D then requires dPeriod %K values, through signalShift + kPeriod +
  // smoothing + dPeriod - 3. The previous %D is one bar older and therefore
  // requires history through the same expression plus one (dPeriod+1 %K values).
  int currentKRequiredShift = signalShift + kPeriod + smoothing - 2;
  int previousKRequiredShift = signalShift + 1 + kPeriod + smoothing - 2;
  int currentDRequiredShift = signalShift + kPeriod + smoothing + dPeriod - 3;
  int previousDRequiredShift = signalShift + 1 + kPeriod + smoothing + dPeriod - 3;
  if(iTime(_Symbol, _Period, currentKRequiredShift) == 0 ||
    iTime(_Symbol, _Period, currentDRequiredShift) == 0)
  {
    return false;
  }
  if(iTime(_Symbol, _Period, previousKRequiredShift) == 0 ||
    iTime(_Symbol, _Period, previousDRequiredShift) == 0)
  {
    return false;
  }
  double previousK = StochCrossK${index}(signalShift + 1);
  double previousD = StochCrossD${index}(signalShift + 1);
  double currentK = StochCrossK${index}(signalShift);
  double currentD = StochCrossD${index}(signalShift);
  if(!ValueReady(previousK) || !MathIsValidNumber(previousK) ||
    !ValueReady(previousD) || !MathIsValidNumber(previousD) ||
    !ValueReady(currentK) || !MathIsValidNumber(currentK) ||
    !ValueReady(currentD) || !MathIsValidNumber(currentD))
  {
    return false;
  }
  if(longSide)
  {
    return previousK <= previousD && currentK > currentD;
  }
  return previousK >= previousD && currentK < currentD;
}
`;

const alligatorParityComment = `
// Alligator parity: both generated EAs calculate median=(high+low)/2 and
// then seed each SMMA with a fresh SMA of the first N medians. In MQL series
// indexing, the largest shift in each seed window is its oldest bar; the shared
// decrementing walk therefore visits every seed oldest-to-newest before
// applying SMMA=(previous*(period-1)+median)/period toward newer bars. All
// three SMMA states share one history walk and the five requested values are
// cached for the current chart bar. For finite, positive OHLC this mirrors
// computeAlligatorSeries in strategy.ts exactly; no terminal Alligator buffer
// is consumed. MQL additionally rejects non-positive OHLC because MT4/MT5
// use 0.0 for unavailable history, while the TypeScript calculator accepts
// signed synthetic inputs for deterministic tests. Non-finite history aborts
// the MQL walk; TypeScript re-seeds only after such input. A display line at
// bar i reads the causal source SMMA at i-shift, so MQL signal shifts are
// 1+displayShift and 2+displayShift for the current and previous closed bars.
`;

const mqlAlligatorCondition = (_condition: AlligatorCondition, index: number): string => `
${alligatorParityComment}
bool AlligatorWarmupReady${index}()
{
  int jawPeriod = InpAlligator${index}JawPeriod;
  int teethPeriod = InpAlligator${index}TeethPeriod;
  int lipsPeriod = InpAlligator${index}LipsPeriod;
  int jawShift = InpAlligator${index}JawShift;
  int teethShift = InpAlligator${index}TeethShift;
  int lipsShift = InpAlligator${index}LipsShift;
  if(jawPeriod < 2 || jawPeriod > 1000 || teethPeriod < 2 || teethPeriod > 1000 ||
    lipsPeriod < 2 || lipsPeriod > 1000 || jawPeriod <= teethPeriod ||
    teethPeriod <= lipsPeriod || jawShift < 0 || jawShift > 500 ||
    teethShift < 0 || teethShift > 500 || lipsShift < 0 || lipsShift > 500 ||
    jawShift <= teethShift || teethShift <= lipsShift)
  {
    return false;
  }
  int requiredShift = 1 + jawShift + jawPeriod - 1;
  int teethRequiredShift = 2 + teethShift + teethPeriod - 1;
  int lipsRequiredShift = 2 + lipsShift + lipsPeriod - 1;
  if(teethRequiredShift > requiredShift)
  {
    requiredShift = teethRequiredShift;
  }
  if(lipsRequiredShift > requiredShift)
  {
    requiredShift = lipsRequiredShift;
  }
  // Match the existing parabolicSar generator's fail-closed history rule:
  // no signal is considered until the oldest required closed-bar source exists.
  return iTime(_Symbol, _Period, requiredShift) != 0;
}

bool AlligatorValues${index}(
  double &previousLips,
  double &previousTeeth,
  double &currentLips,
  double &currentTeeth,
  double &currentJaw)
{
  static datetime cachedBarTime = 0;
  static bool cachedResult = false;
  static double cachedPreviousLips = EMPTY_VALUE;
  static double cachedPreviousTeeth = EMPTY_VALUE;
  static double cachedCurrentLips = EMPTY_VALUE;
  static double cachedCurrentTeeth = EMPTY_VALUE;
  static double cachedCurrentJaw = EMPTY_VALUE;
  datetime currentBarTime = iTime(_Symbol, _Period, 0);
  if(currentBarTime == 0)
  {
    return false;
  }
  if(cachedBarTime == currentBarTime)
  {
    previousLips = cachedPreviousLips;
    previousTeeth = cachedPreviousTeeth;
    currentLips = cachedCurrentLips;
    currentTeeth = cachedCurrentTeeth;
    currentJaw = cachedCurrentJaw;
    return cachedResult;
  }
  cachedBarTime = currentBarTime;
  cachedResult = false;
  cachedPreviousLips = EMPTY_VALUE;
  cachedPreviousTeeth = EMPTY_VALUE;
  cachedCurrentLips = EMPTY_VALUE;
  cachedCurrentTeeth = EMPTY_VALUE;
  cachedCurrentJaw = EMPTY_VALUE;

  int jawPeriod = InpAlligator${index}JawPeriod;
  int teethPeriod = InpAlligator${index}TeethPeriod;
  int lipsPeriod = InpAlligator${index}LipsPeriod;
  int jawShift = InpAlligator${index}JawShift;
  int teethShift = InpAlligator${index}TeethShift;
  int lipsShift = InpAlligator${index}LipsShift;
  int previousLipsTarget = 2 + lipsShift;
  int previousTeethTarget = 2 + teethShift;
  int currentLipsTarget = 1 + lipsShift;
  int currentTeethTarget = 1 + teethShift;
  int currentJawTarget = 1 + jawShift;
  int minimumTargetShift = currentJawTarget;
  if(currentTeethTarget < minimumTargetShift)
  {
    minimumTargetShift = currentTeethTarget;
  }
  if(currentLipsTarget < minimumTargetShift)
  {
    minimumTargetShift = currentLipsTarget;
  }
  if(previousTeethTarget < minimumTargetShift)
  {
    minimumTargetShift = previousTeethTarget;
  }
  if(previousLipsTarget < minimumTargetShift)
  {
    minimumTargetShift = previousLipsTarget;
  }

  int totalBars = Bars(_Symbol, _Period);
  if(totalBars <= 0)
  {
    return false;
  }
  // These are the newest shifts in each line's oldest seed window. Since the
  // periods are strictly ordered, one walk can seed and then advance all
  // three states without rereading any OHLC bar.
  int jawSeedShift = totalBars - jawPeriod;
  int teethSeedShift = totalBars - teethPeriod;
  int lipsSeedShift = totalBars - lipsPeriod;
  if(jawSeedShift < currentJawTarget ||
    teethSeedShift < previousTeethTarget ||
    lipsSeedShift < previousLipsTarget)
  {
    return false;
  }

  double jawSeedSum = 0.0;
  double teethSeedSum = 0.0;
  double lipsSeedSum = 0.0;
  double jawSmma = EMPTY_VALUE;
  double teethSmma = EMPTY_VALUE;
  double lipsSmma = EMPTY_VALUE;
  // MQL series shifts decrease from the oldest bar to the newest bar. This
  // single loop is therefore both the fresh oldest-to-newest seed walk and
  // the shared recursive walk for all three lines.
  for(int currentShift = totalBars - 1; currentShift >= minimumTargetShift; currentShift--)
  {
    double high = iHigh(_Symbol, _Period, currentShift);
    double low = iLow(_Symbol, _Period, currentShift);
    if(!ValueReady(high) || !MathIsValidNumber(high) ||
      !ValueReady(low) || !MathIsValidNumber(low))
    {
      return false;
    }
    // MT4/MT5 return 0.0 for unavailable history. FX prices are strictly
    // positive, so reject zero before it can enter the median/SMMA walk.
    if(!(high > 0.0 && low > 0.0))
    {
      return false;
    }
    double median = (high + low) / 2.0;
    if(!ValueReady(median) || !MathIsValidNumber(median))
    {
      return false;
    }

    if(currentShift >= jawSeedShift)
    {
      jawSeedSum += median;
      if(currentShift == jawSeedShift)
      {
        jawSmma = jawSeedSum / jawPeriod;
      }
    }
    else
    {
      jawSmma = (jawSmma * (jawPeriod - 1) + median) / jawPeriod;
    }
    if(currentShift >= teethSeedShift)
    {
      teethSeedSum += median;
      if(currentShift == teethSeedShift)
      {
        teethSmma = teethSeedSum / teethPeriod;
      }
    }
    else
    {
      teethSmma = (teethSmma * (teethPeriod - 1) + median) / teethPeriod;
    }
    if(currentShift >= lipsSeedShift)
    {
      lipsSeedSum += median;
      if(currentShift == lipsSeedShift)
      {
        lipsSmma = lipsSeedSum / lipsPeriod;
      }
    }
    else
    {
      lipsSmma = (lipsSmma * (lipsPeriod - 1) + median) / lipsPeriod;
    }

    if(currentShift < jawSeedShift &&
      (!ValueReady(jawSmma) || !MathIsValidNumber(jawSmma)))
    {
      return false;
    }
    if(currentShift < teethSeedShift &&
      (!ValueReady(teethSmma) || !MathIsValidNumber(teethSmma)))
    {
      return false;
    }
    if(currentShift < lipsSeedShift &&
      (!ValueReady(lipsSmma) || !MathIsValidNumber(lipsSmma)))
    {
      return false;
    }

    if(currentShift == previousLipsTarget)
    {
      cachedPreviousLips = lipsSmma;
    }
    if(currentShift == previousTeethTarget)
    {
      cachedPreviousTeeth = teethSmma;
    }
    if(currentShift == currentLipsTarget)
    {
      cachedCurrentLips = lipsSmma;
    }
    if(currentShift == currentTeethTarget)
    {
      cachedCurrentTeeth = teethSmma;
    }
    if(currentShift == currentJawTarget)
    {
      cachedCurrentJaw = jawSmma;
    }
  }
  if(!ValueReady(cachedPreviousLips) || !MathIsValidNumber(cachedPreviousLips) ||
    !ValueReady(cachedPreviousTeeth) || !MathIsValidNumber(cachedPreviousTeeth) ||
    !ValueReady(cachedCurrentLips) || !MathIsValidNumber(cachedCurrentLips) ||
    !ValueReady(cachedCurrentTeeth) || !MathIsValidNumber(cachedCurrentTeeth) ||
    !ValueReady(cachedCurrentJaw) || !MathIsValidNumber(cachedCurrentJaw))
  {
    return false;
  }
  cachedResult = true;
  previousLips = cachedPreviousLips;
  previousTeeth = cachedPreviousTeeth;
  currentLips = cachedCurrentLips;
  currentTeeth = cachedCurrentTeeth;
  currentJaw = cachedCurrentJaw;
  return true;
}

bool Condition${index}(bool longSide)
{
  int jawPeriod = InpAlligator${index}JawPeriod;
  int teethPeriod = InpAlligator${index}TeethPeriod;
  int lipsPeriod = InpAlligator${index}LipsPeriod;
  int jawShift = InpAlligator${index}JawShift;
  int teethShift = InpAlligator${index}TeethShift;
  int lipsShift = InpAlligator${index}LipsShift;
  if(jawPeriod < 2 || jawPeriod > 1000 || teethPeriod < 2 || teethPeriod > 1000 ||
    lipsPeriod < 2 || lipsPeriod > 1000 || jawPeriod <= teethPeriod ||
    teethPeriod <= lipsPeriod || jawShift < 0 || jawShift > 500 ||
    teethShift < 0 || teethShift > 500 || lipsShift < 0 || lipsShift > 500 ||
    jawShift <= teethShift || teethShift <= lipsShift)
  {
    return false;
  }
  if(!AlligatorWarmupReady${index}())
  {
    return false;
  }
  double previousLips = EMPTY_VALUE;
  double previousTeeth = EMPTY_VALUE;
  double currentLips = EMPTY_VALUE;
  double currentTeeth = EMPTY_VALUE;
  double currentJaw = EMPTY_VALUE;
  if(!AlligatorValues${index}(
    previousLips,
    previousTeeth,
    currentLips,
    currentTeeth,
    currentJaw))
  {
    return false;
  }
  if(!ValueReady(previousLips) || !MathIsValidNumber(previousLips) ||
    !ValueReady(previousTeeth) || !MathIsValidNumber(previousTeeth) ||
    !ValueReady(currentLips) || !MathIsValidNumber(currentLips) ||
    !ValueReady(currentTeeth) || !MathIsValidNumber(currentTeeth) ||
    !ValueReady(currentJaw) || !MathIsValidNumber(currentJaw))
  {
    return false;
  }
  if(longSide)
  {
    return previousLips <= previousTeeth && currentLips > currentTeeth && currentTeeth > currentJaw;
  }
  return previousLips >= previousTeeth && currentLips < currentTeeth && currentTeeth < currentJaw;
}
`;

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
      case 'momentum':
        // Momentum is calculated from iClose to preserve TypeScript operation order.
        return [];
      case 'ao':
        // AO is calculated from iHigh/iLow to preserve TypeScript operation order.
        return [];
      case 'rvi':
        // RVI is calculated from OHLC to preserve TypeScript operation order.
        return [];
      case 'envelope':
        // Envelopes are calculated from iClose to preserve TypeScript operation order.
        return [];
      case 'demarker':
        // DeMarker is calculated from iHigh/iLow to preserve TypeScript operation order.
        return [];
      case 'donchianBreak':
        return [];
      case 'stochastic':
        return [];
      case 'stochCross':
        return [];
      case 'alligator':
        // Alligator is calculated directly from OHLC for operation-order parity.
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
          // SAR_MIN_STEP is pipeline policy and remains warning-only below it;
          // this separate evaluator-domain guard returns INIT_FAILED.
          `  if(InpSAR${conditionIndex}Step < ${SAR_MIN_STEP})`,
          '  {',
          `    Print("SAR${conditionIndex} warning: step below ${SAR_MIN_STEP} is outside the evaluator registration domain");`,
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
      case 'momentum':
        return [
          // The evaluator hard domain is period >= 1; input int makes
          // non-integer values unrepresentable, so reject the remaining invalid range here.
          `  if(InpMomentum${conditionIndex}Period < 1)`,
          '  {',
          `    Print("Momentum${conditionIndex} rejected: period must be an integer greater than or equal to 1");`,
          '    return INIT_FAILED;',
          '  }',
        ];
      case 'ao':
        return [
          // The evaluator hard domain is both periods >= 1; input int makes
          // non-integer values unrepresentable. Keep fastPeriod < slowPeriod
          // explicit because the AO calculation has no valid equal-period form.
          `  if(InpAO${conditionIndex}FastPeriod < 1 || InpAO${conditionIndex}SlowPeriod < 1 || InpAO${conditionIndex}FastPeriod >= InpAO${conditionIndex}SlowPeriod)`,
          '  {',
          `    Print("AO${conditionIndex} rejected: periods must be integers greater than or equal to 1 and fastPeriod must be smaller than slowPeriod");`,
          '    return INIT_FAILED;',
          '  }',
        ];
      case 'rvi':
        return [
          // The evaluator hard domain is period >= 1; input int makes
          // non-integer values unrepresentable, so reject the remaining invalid range here.
          `  if(InpRVI${conditionIndex}Period < 1)`,
          '  {',
          `    Print("RVI${conditionIndex} rejected: period must be an integer greater than or equal to 1");`,
          '    return INIT_FAILED;',
          '  }',
        ];
      case 'envelope':
        // Envelopes are calculated from iClose; the condition owns its runtime guards.
        return [];
      case 'demarker':
        return [
          // The evaluator hard domain is period >= 1; input int makes
          // non-integer values unrepresentable. The EA intentionally adopts
          // the registration threshold domain (0 < threshold < 1); the stricter
          // 2..1000 period policy remains outside this generated EA.
          `  if(InpDeMarker${conditionIndex}Period < 1 || !MathIsValidNumber(InpDeMarker${conditionIndex}Threshold) || InpDeMarker${conditionIndex}Threshold <= 0.0 || InpDeMarker${conditionIndex}Threshold >= 1.0)`,
          '  {',
          `    Print("DeMarker${conditionIndex} rejected: period must be an integer greater than or equal to 1 and threshold must be finite, greater than 0 and less than 1");`,
          '    return INIT_FAILED;',
          '  }',
        ];
      case 'donchianBreak':
        return [];
      case 'stochastic':
        return [];
      case 'stochCross':
        return [
          // The evaluator and registration policy share K/D=2..1000;
          // smoothing keeps the legacy stochastic domain (positive integer).
          `  if(InpStoch${conditionIndex}KPeriod < 2 || InpStoch${conditionIndex}KPeriod > 1000 || InpStoch${conditionIndex}DPeriod < 2 || InpStoch${conditionIndex}DPeriod > 1000 || InpStoch${conditionIndex}Smoothing < 1)`,
          '  {',
          `    Print("StochCross${conditionIndex} rejected: K and D periods must be integers between 2 and 1000 and smoothing must be an integer greater than or equal to 1");`,
          '    return INIT_FAILED;',
          '  }',
        ];
      case 'alligator':
        return [
          `  if(InpAlligator${conditionIndex}JawPeriod < 2 || InpAlligator${conditionIndex}JawPeriod > 1000 || InpAlligator${conditionIndex}TeethPeriod < 2 || InpAlligator${conditionIndex}TeethPeriod > 1000 || InpAlligator${conditionIndex}LipsPeriod < 2 || InpAlligator${conditionIndex}LipsPeriod > 1000 || InpAlligator${conditionIndex}JawPeriod <= InpAlligator${conditionIndex}TeethPeriod || InpAlligator${conditionIndex}TeethPeriod <= InpAlligator${conditionIndex}LipsPeriod || InpAlligator${conditionIndex}JawShift < 0 || InpAlligator${conditionIndex}JawShift > 500 || InpAlligator${conditionIndex}TeethShift < 0 || InpAlligator${conditionIndex}TeethShift > 500 || InpAlligator${conditionIndex}LipsShift < 0 || InpAlligator${conditionIndex}LipsShift > 500 || InpAlligator${conditionIndex}JawShift <= InpAlligator${conditionIndex}TeethShift || InpAlligator${conditionIndex}TeethShift <= InpAlligator${conditionIndex}LipsShift)`,
          '  {',
          `    Print("Alligator${conditionIndex} rejected: periods must be integers between 2 and 1000 with Jaw > Teeth > Lips, and shifts must be integers between 0 and 500 with Jaw > Teeth > Lips");`,
          '    return INIT_FAILED;',
          '  }',
        ];
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
      case 'momentum':
        return [];
      case 'ao':
        return [];
      case 'rvi':
        return [];
      case 'envelope':
        return [];
      case 'demarker':
        return [];
      case 'donchianBreak':
        return [];
      case 'stochastic':
        return [];
      case 'stochCross':
        return [];
      case 'alligator':
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
${mql4EntryConditionOnInit(strategy.entryConditions)}
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
