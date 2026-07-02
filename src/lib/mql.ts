import type {
  BollingerBandSide,
  BollingerCondition,
  BollingerConditionMode,
  EntryCondition,
  MaCrossCondition,
  MacdCrossCondition,
  MovingAverageType,
  RsiComparison,
  RsiCondition,
  StrategyDefinition,
} from './strategy';

const boolLiteral = (value: boolean): string => (value ? 'true' : 'false');

const numberLiteral = (value: number): string =>
  Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));

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
        `input int InpMA${index}FastPeriod = ${condition.fastPeriod};`,
        `input int InpMA${index}SlowPeriod = ${condition.slowPeriod};`,
        mql5
          ? `input ENUM_MA_METHOD InpMA${index}FastMethod = ${maMethod(condition.fastType)};`
          : `input int InpMA${index}FastMethod = ${maMethod(condition.fastType)};`,
        mql5
          ? `input ENUM_MA_METHOD InpMA${index}SlowMethod = ${maMethod(condition.slowType)};`
          : `input int InpMA${index}SlowMethod = ${maMethod(condition.slowType)};`,
      ];
    case 'rsi':
      return [
        `input int InpRSI${index}Period = ${condition.period};`,
        `input double InpRSI${index}Threshold = ${numberLiteral(condition.threshold)};`,
      ];
    case 'bollinger':
      return [
        `input int InpBB${index}Period = ${condition.period};`,
        `input double InpBB${index}Deviation = ${numberLiteral(condition.multiplier)};`,
      ];
    case 'macdCross':
      return [
        `input int InpMACD${index}FastPeriod = ${condition.fastPeriod};`,
        `input int InpMACD${index}SlowPeriod = ${condition.slowPeriod};`,
        `input int InpMACD${index}SignalPeriod = ${condition.signalPeriod};`,
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
  }
};

const mql5MaCondition = (_condition: MaCrossCondition, index: number): string => `
bool Condition${index}(bool longSide)
{
  double previousFast = MAValue(InpMA${index}FastPeriod, InpMA${index}FastMethod, 2);
  double previousSlow = MAValue(InpMA${index}SlowPeriod, InpMA${index}SlowMethod, 2);
  double currentFast = MAValue(InpMA${index}FastPeriod, InpMA${index}FastMethod, 1);
  double currentSlow = MAValue(InpMA${index}SlowPeriod, InpMA${index}SlowMethod, 1);
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
  double previous = RSIValue(InpRSI${index}Period, 2);
  double current = RSIValue(InpRSI${index}Period, 1);
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
  double upper = BandUpper(InpBB${index}Period, InpBB${index}Deviation, 1);
  double lower = BandLower(InpBB${index}Period, InpBB${index}Deviation, 1);
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

const mql5MacdCondition = (_condition: MacdCrossCondition, index: number): string => `
bool Condition${index}(bool longSide)
{
  double previousMain = MACDMain(InpMACD${index}FastPeriod, InpMACD${index}SlowPeriod, InpMACD${index}SignalPeriod, 2);
  double previousSignal = MACDSignal(InpMACD${index}FastPeriod, InpMACD${index}SlowPeriod, InpMACD${index}SignalPeriod, 2);
  double currentMain = MACDMain(InpMACD${index}FastPeriod, InpMACD${index}SlowPeriod, InpMACD${index}SignalPeriod, 1);
  double currentSignal = MACDSignal(InpMACD${index}FastPeriod, InpMACD${index}SlowPeriod, InpMACD${index}SignalPeriod, 1);
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

const commonInputs = (strategy: StrategyDefinition, mql5: boolean): string[] => [
  `input double InpLots = ${numberLiteral(strategy.lotSize)};`,
  `input int InpMagicNumber = ${strategy.magicNumber};`,
  `input bool InpTradeLong = ${boolLiteral(strategy.direction === 'long')};`,
  `input int InpStopLossPips = ${strategy.exit.stopLossPips};`,
  `input int InpTakeProfitPips = ${strategy.exit.takeProfitPips};`,
  `input bool InpUseTrailingStop = ${boolLiteral(Boolean(strategy.exit.trailingStopPips && strategy.exit.trailingStopPips > 0))};`,
  `input int InpTrailingStopPips = ${strategy.exit.trailingStopPips ?? 0};`,
  `input bool InpCloseOnOppositeSignal = ${boolLiteral(strategy.exit.closeOnOppositeSignal)};`,
  ...strategy.entryConditions.flatMap((condition, index) => conditionInputLines(condition, index + 1, mql5)),
];

export const generateMql5 = (strategy: StrategyDefinition): string => {
  const inputs = commonInputs(strategy, true).join('\n');
  const conditionFunctions = strategy.entryConditions
    .map((condition, index) => mql5ConditionFunction(condition, index + 1))
    .join('\n');
  const expertName = mqlString(strategy.name);

  return `#property strict
#property description "${expertName}"

#include <Trade/Trade.mqh>
CTrade trade;

${inputs}

datetime lastBarTime = 0;

double PipPoint()
{
  if(_Digits == 3 || _Digits == 5)
  {
    return _Point * 10.0;
  }
  return _Point;
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

double BufferValue(int handle, int bufferIndex, int shift)
{
  if(handle == INVALID_HANDLE)
  {
    return EMPTY_VALUE;
  }
  double values[];
  ArraySetAsSeries(values, true);
  if(CopyBuffer(handle, bufferIndex, shift, 1, values) <= 0)
  {
    IndicatorRelease(handle);
    return EMPTY_VALUE;
  }
  double result = values[0];
  IndicatorRelease(handle);
  return result;
}

double MAValue(int period, ENUM_MA_METHOD method, int shift)
{
  int handle = iMA(_Symbol, _Period, period, 0, method, PRICE_CLOSE);
  return BufferValue(handle, 0, shift);
}

double RSIValue(int period, int shift)
{
  int handle = iRSI(_Symbol, _Period, period, PRICE_CLOSE);
  return BufferValue(handle, 0, shift);
}

double BandUpper(int period, double deviation, int shift)
{
  int handle = iBands(_Symbol, _Period, period, 0, deviation, PRICE_CLOSE);
  return BufferValue(handle, 1, shift);
}

double BandLower(int period, double deviation, int shift)
{
  int handle = iBands(_Symbol, _Period, period, 0, deviation, PRICE_CLOSE);
  return BufferValue(handle, 2, shift);
}

double MACDMain(int fastPeriod, int slowPeriod, int signalPeriod, int shift)
{
  int handle = iMACD(_Symbol, _Period, fastPeriod, slowPeriod, signalPeriod, PRICE_CLOSE);
  return BufferValue(handle, 0, shift);
}

double MACDSignal(int fastPeriod, int slowPeriod, int signalPeriod, int shift)
{
  int handle = iMACD(_Symbol, _Period, fastPeriod, slowPeriod, signalPeriod, PRICE_CLOSE);
  return BufferValue(handle, 1, shift);
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
  trade.SetExpertMagicNumber(InpMagicNumber);
  trade.SetDeviationInPoints(20);
  if(InpTradeLong)
  {
    double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
    double sl = NormalizeDouble(ask - InpStopLossPips * pip, _Digits);
    double tp = NormalizeDouble(ask + InpTakeProfitPips * pip, _Digits);
    trade.Buy(InpLots, _Symbol, ask, sl, tp, "${expertName}");
    return;
  }
  double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
  double sl = NormalizeDouble(bid + InpStopLossPips * pip, _Digits);
  double tp = NormalizeDouble(bid - InpTakeProfitPips * pip, _Digits);
  trade.Sell(InpLots, _Symbol, bid, sl, tp, "${expertName}");
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
  if(EntrySignal(InpTradeLong))
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

${inputs}

datetime lastBarTime = 0;

double PipPoint()
{
  if(Digits == 3 || Digits == 5)
  {
    return Point * 10.0;
  }
  return Point;
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
  if(InpTradeLong)
  {
    double sl = NormalizeDouble(Ask - InpStopLossPips * pip, Digits);
    double tp = NormalizeDouble(Ask + InpTakeProfitPips * pip, Digits);
    int ticket = OrderSend(_Symbol, OP_BUY, InpLots, Ask, 20, sl, tp, "${expertName}", InpMagicNumber, 0, clrGreen);
    if(ticket < 0)
    {
      Print("OrderSend buy failed: ", GetLastError());
    }
    return;
  }
  double sl = NormalizeDouble(Bid + InpStopLossPips * pip, Digits);
  double tp = NormalizeDouble(Bid - InpTakeProfitPips * pip, Digits);
  int ticket = OrderSend(_Symbol, OP_SELL, InpLots, Bid, 20, sl, tp, "${expertName}", InpMagicNumber, 0, clrRed);
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
  if(EntrySignal(InpTradeLong))
  {
    OpenPosition();
  }
}
`;
};
